import {
  GraphQLBoolean,
  GraphQLID,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString
} from 'graphql'
import GraphQLISO8601Type from 'server/graphql/types/GraphQLISO8601Type'
import RetroPhaseItem from 'server/graphql/types/RetroPhaseItem'

const ReflectTemplate = new GraphQLObjectType({
  name: 'ReflectTemplate',
  description: 'The team-specific templates for the reflection prompts',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLID)
    },
    createdAt: {
      type: new GraphQLNonNull(GraphQLISO8601Type)
    },
    isActive: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'True if template can be used, else false'
    },
    lastUsedAt: {
      type: GraphQLISO8601Type,
      description: 'The time of the meeting the template was last used'
    },
    name: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'The name of the template'
    },
    prompts: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(RetroPhaseItem))),
      description: 'The prompts that are part of this template',
      resolve: async ({id: promptTemplateId, teamId}, _args, {dataLoader}) => {
        const phaseItems = await dataLoader.get('customPhaseItemsByTeamId').load(teamId)
        return phaseItems.filter(({templateId}) => templateId === promptTemplateId)
      }
    },
    teamId: {
      type: new GraphQLNonNull(GraphQLID),
      description: '*Foreign key. The team this template belongs to'
    },
    updatedAt: {
      type: new GraphQLNonNull(GraphQLISO8601Type)
    }
  })
})

export default ReflectTemplate
