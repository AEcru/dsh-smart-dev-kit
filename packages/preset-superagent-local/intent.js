export function currentUserRequest(session, projections) {
  const start = projections.stateOf(session, 'turnBoundary')?.openTurnStartSeq
  if (typeof start !== 'number' || !session.isOwnSeq(start)) {
    throw new Error('当前轮没有可用于授权工单的用户消息。')
  }
  for (const event of session.snapshotEvents(start + 1).toReversed()) {
    if (event.type !== 'user/message' || event.surfaceOp !== 'append') continue
    const { source, content } = event.data
    if (source?.kind !== 'user' || typeof source.rpcId !== 'string' || !source.rpcId) continue
    if (content.some(block => block.type !== 'text')) {
      throw new Error('工单授权只转交文本。请用文字说明执行器需要处理的文件和任务范围。')
    }
    const text = content.map(block => block.text).join('\n').trim()
    if (!text) break
    return { requestId: `user-message:${source.rpcId}`, text }
  }
  throw new Error('当前轮没有可用于授权工单的用户消息。')
}
