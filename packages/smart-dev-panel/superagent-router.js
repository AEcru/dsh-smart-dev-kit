/**
 * Smart-dev × Superagent bridge.
 *
 * Exposes the optional worktree-ticket channel inside the smart-dev preset
 * without loading the bundle's own router plugin (that plugin rewrites the
 * preset toolset down to three tools, which would break smart-dev).
 *
 * The `superagentLocal` runtime is optional: when the
 * `dsh-preset-superagent-local` bundle is not installed, the tools explain how
 * to enable it and the rest of the preset still works.
 */
export const name = 'smartdev-superagent-bridge'
export const inject = ['tools', 'systemPrompt']

const channelPrompt = `# 重型工单通道（可选）
当任务满足「L3 重型、需要隔离、工作在 Git 仓库内」时，可以把任务交给工单通道：
- 只有用户明确交办、且本轮消息是纯文本时，才调用 smartdev_delegate；用户原文就是授权范围，不要自行扩大。
- 先调用 smartdev_ticket_status 查看已有工单，避免重复建单；同一条用户消息只会建一张工单。
- 工单在独立 git worktree 中执行，不污染当前工作区；完成后结果会回到本会话，工作树路径在状态里，由用户自行审阅合入。
- 普通问答、L1/L2 任务、非 git 工作区、含附件/图片的消息不要建单，按原流程直接处理。
- 工单通道不可用（未安装运行时、非 git 仓库、消息非纯文本）时，降级为当前流程，并用一句话说明原因。`

const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }

export function apply(ctx) {
  const runtime = () => ctx.get('superagentLocal')

  ctx.systemPrompt.section({
    name: 'smartdev:superagent-channel',
    order: 240,
    text: () => channelPrompt,
  })

  ctx.tools.register({
    name: 'smartdev_delegate',
    description:
      '把用户本轮明确交办的 Git 项目任务（L3 重型、需要隔离）建立为独立工单，在 git worktree 中执行。普通问答、非 git 工作区、含附件消息不要调用。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output,
    async execute(_args, { agent, signal, parent }) {
      const local = runtime()
      if (!local || typeof local.delegate !== 'function') {
        throw new Error('工单运行时未安装（dsh-preset-superagent-local）。')
      }
      if (parent || local.isWorker(agent?.id)) throw new Error('只有协调会话可以委派工单。')
      return local.delegate(agent, signal)
    },
  })

  ctx.tools.register({
    name: 'smartdev_ticket_status',
    description: '只读查看当前会话的工单；省略 ticket_id 时列出最近工单。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { ticket_id: { type: 'string' } },
    },
    output,
    execute({ ticket_id }, { agent }) {
      const local = runtime()
      if (!local) throw new Error('工单运行时未安装（dsh-preset-superagent-local）。')
      return ticket_id ? local.status(agent.id, ticket_id) : local.list(agent.id) || '当前会话还没有工单。'
    },
  })
}
