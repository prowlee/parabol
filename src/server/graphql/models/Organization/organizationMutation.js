import getRethink from 'server/database/rethinkDriver';
import {UpdateOrgInput} from './organizationSchema';
import {
  GraphQLNonNull,
  GraphQLBoolean,
  GraphQLID,
  GraphQLInt,
  GraphQLString,
} from 'graphql';
import {requireOrgLeader, requireOrgLeaderOfUser, requireWebsocket} from 'server/utils/authorization';
import updateOrgServerSchema from 'universal/validation/updateOrgServerSchema';
import {errorObj, handleSchemaErrors, getOldVal, validateAvatarUpload} from 'server/utils/utils';
import getS3PutUrl from 'server/utils/getS3PutUrl';
import stripe from 'server/billing/stripe';
import {
  PAUSE_USER,
  REMOVE_USER,
  MAX_MONTHLY_PAUSES
} from 'server/utils/serverConstants';
import adjustUserCount from 'server/billing/helpers/adjustUserCount';
import {GraphQLURLType} from '../../types';
import shortid from 'shortid';
import addOrg from 'server/graphql/models/Organization/addOrg/addOrg'
import addBilling from 'server/graphql/models/Organization/addBilling/addBilling';

export default {
  updateOrg: {
    type: GraphQLBoolean,
    description: 'Update an with a change in name, avatar',
    args: {
      updatedOrg: {
        type: new GraphQLNonNull(UpdateOrgInput),
        description: 'the updated org including the id, and at least one other field'
      }
    },
    async resolve(source, {updatedOrg}, {authToken, socket}) {
      const r = getRethink();

      // AUTH
      requireWebsocket(socket);
      await requireOrgLeader(authToken, updatedOrg.id);

      // VALIDATION
      const schema = updateOrgServerSchema();
      const {errors, data: {id: orgId, ...org}} = schema(updatedOrg);
      handleSchemaErrors(errors);

      // RESOLUTION
      const now = new Date();
      const newAction = {
        ...org,
        updatedAt: now
      };
      await r.table('Organization').get(orgId).update(newAction);
      return true;
    }
  },
  removeBillingLeader: {
    type: GraphQLBoolean,
    description: 'Remove a billing leader from an org',
    args: {
      orgId: {
        type: new GraphQLNonNull(GraphQLID),
        description: 'the org to remove the billing leader from'
      },
      userId: {
        type: new GraphQLNonNull(GraphQLID),
        description: 'The billing leader userId to remove from the org'
      }
    },
    async resolve(source, {orgId, userId}, {authToken, socket}) {
      const r = getRethink();

      // AUTH
      requireWebsocket(socket);
      await requireOrgLeader(authToken, orgId);

      // RESOLUTION
      const now = new Date();
      await r.table('User').get(orgId)
        .update((user) => {
          return user.merge({
            billingLeaderOrgs: user('billingLeaderOrgs').filter((id) => id.ne(orgId)),
            updatedAt: now
          });
        });
      return true;
    }
  },
  addBilling,
  inactivateUser: {
    type: GraphQLBoolean,
    description: 'pauses the subscription for a single user',
    args: {
      userId: {
        type: new GraphQLNonNull(GraphQLID),
        description: 'the user to pause'
      }
    },
    async resolve(source, {userId}, {authToken, socket}) {
      const r = getRethink();

      // AUTH
      await requireOrgLeaderOfUser(authToken, userId);
      const res = await r.table('User').get(userId)
        .update({
          inactive: true
        }, {returnChanges: true});
      const userDoc = getOldVal(res);
      if (!userDoc) {
        // no userDoc means there were no changes, which means inactive was already true
        throw errorObj({_error: `${userId} is already inactive. cannot inactivate twice`})
      }
      const {orgs: orgIds} = userDoc;
      const orgDocs = await r.table('Organization').getAll(r.args(orgIds), {index: 'id'});

      const hookPromises = orgDocs.map((orgDoc) => {
        const {stripeSubscriptionId, id: orgId} = orgDoc;
        return stripe.subscriptions.retrieve(stripeSubscriptionId)
          .then((subscription) => {
            const {current_period_start: startAt, current_period_end: endAt} = subscription;
            return r.table('InvoiceItemHook')
              .between([startAt, orgId], [endAt, orgId])
              .filter({userId, type: PAUSE_USER})
              .count()
          })
      });
      const pausesByOrg = await Promise.all(hookPromises);
      const triggeredPauses = Math.max(...pausesByOrg);
      if (triggeredPauses >= MAX_MONTHLY_PAUSES) {
        throw errorObj({_error: 'Max monthly pauses exceeded for this user'});
      }

      // RESOLUTION
      await adjustUserCount(userId, orgIds, PAUSE_USER);
      return true;
    }
  },
  removeOrgUser: {
    type: GraphQLBoolean,
    description: 'Remove a user from an org',
    args: {
      userId: {
        type: new GraphQLNonNull(GraphQLID),
        description: 'the user to remove'
      }
      ,
      orgId: {
        type: new GraphQLNonNull(GraphQLID),
        description: 'the org that does not want them anymore'
      }
    },
    async resolve(source, {orgId, userId}, {authToken}){
      const r = getRethink();

      // AUTH
      await requireOrgLeader(authToken, orgId);

      // RESOLUTION
      const now = new Date();
      const userRes = await r.table('User').get(userId)
        .update((row) => ({
          orgs: row('orgs').filter((id) => id.ne(orgId)),
          billingLeaderOrgs: row('billingLeaderOrgs').filter((id) => id.ne(orgId)),
          updatedAt: now
        }), {returnChanges: true});

      const userDoc = getOldVal(userRes);
      if (!userDoc) {
        throw errorObj({_error: `${userId} does not exist`});
      }
      const {orgs} = userDoc;
      if (!orgs.includes(orgId)) {
        throw errorObj({_error: `${userId} is not a part of org ${orgId}`});
      }
      await adjustUserCount(userId, orgId, REMOVE_USER);
      return true;
    }
  },
  createOrgPicturePutUrl: {
    type: GraphQLURLType,
    description: 'Create a PUT URL on the CDN for an organization\'s profile picture',
    args: {
      contentType: {
        type: GraphQLString,
        description: 'user-supplied MIME content type'
      },
      contentLength: {
        type: new GraphQLNonNull(GraphQLInt),
        description: 'user-supplied file size'
      },
      orgId: {
        type: new GraphQLNonNull(GraphQLID),
        description: 'The organization id to update'
      }
    },
    async resolve(source, {orgId, contentType, contentLength}, {authToken}) {
      // AUTH
      await requireOrgLeader(authToken, orgId);

      // VALIDATION
      const ext = validateAvatarUpload(contentType, contentLength);

      // RESOLUTION
      const partialPath = `Organization/${orgId}/picture/${shortid.generate()}.${ext}`;
      return await getS3PutUrl(contentType, contentLength, partialPath);
    }
  },
  addOrg
};
