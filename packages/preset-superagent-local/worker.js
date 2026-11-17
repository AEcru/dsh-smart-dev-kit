export const name = 'superagent-local-worker'
export const inject = ['tools', 'superagentLocal']

const states = ['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped']

export function apply(ctx) {
  ctx.tools.register({
    name: 'superagent_report',
    description: '回报本工单的结构化进度或交付。需要用户行动时提供具体 question。',
    parameters: {
      type: 'object', additionalProperties: false, required: ['state', 'summary'],
      properties: {
        state: { type: 'string', enum: states },
        summary: { type: 'string', minLength: 1, maxLength: 12000 },
        question: { type: ['string', 'null'], minLength: 1, maxLength: 2000 },
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute({ state, summary, question }, { agent }) {
      if (!states.includes(state) || typeof summary !== 'string' || !summary.trim() || summary.length > 12000) {
        throw new Error('报告需要有效状态和摘要。')
      }
      if (question !== undefined && question !== null && (typeof question !== 'string' || !question.trim() || question.length > 2000)) {
        throw new Error('问题必须为有效文本。')
      }
      return ctx.superagentLocal.report(agent.id, { state, summary: summary.trim(), question })
    },
  })
}
