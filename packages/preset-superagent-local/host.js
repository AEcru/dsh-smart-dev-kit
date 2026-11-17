import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { AgentDelivery, Effects, Engine, HealthBoard, Later, Store, key, killJobs, latestAssignment, lockSync, messageId, runningAssignment, runningJobs, ticketStage } from './lib/upstream.mjs'
import { ensureWorktree, projectRoot, snapshotBase, worktreePath } from './worktree.js'
import { currentUserRequest } from './intent.js'
import { migrateWorkerPreset, PRESET } from './migrate.js'

export const name = 'superagent-local-runtime'
export const inject = ['agents', 'sessionController', 'sessionPersistence', 'sessionProjections', 'workspaceRegistry', 'permissionPresets']

const SOURCE = 'dsh-local'
const WORKER_SLOTS = 2
const workerId = ticketId => `superagent-local-${ticketId}`
const ticketIdFor = sessionId => /^superagent-local-([a-f\d]{32})$/.exec(sessionId)?.[1]
const ticketOwner = ticket => ticket.mandate.actor.id
const isExplicit = trigger => trigger.source === SOURCE && trigger.human === true && trigger.addressed === 'direct' && trigger.actor.source === SOURCE
const policy = {
  version: 'dsh-local-v1',
  paused: false,
  evalTimeoutMs: 30_000,
  gate: trigger => isExplicit(trigger)
    ? { admissible: true, strength: 'explicit', basis: { via: 'addressed', source: SOURCE, addressed: 'direct', sender: trigger.actor.id } }
    : { admissible: false, reason: 'explicit-user-request-required' },
  revalidate: mandate => mandate.strength === 'explicit' && mandate.basis.source === SOURCE
    && mandate.basis.sender === mandate.actor.id && mandate.actor.source === SOURCE,
  admitsInferred: () => false,
}

function requireText(text, label) {
  if (!text || text.length > 16_000) throw new Error(`${label}必须包含 1 至 16000 个字符。`)
  return text
}

function triggerFor(sessionId, commandId, threadId, text, meta = {}) {
  return {
    id: key(SOURCE, sessionId, String(commandId)), source: SOURCE,
    threads: [{ source: SOURCE, id: threadId }], actor: { source: SOURCE, id: sessionId },
    human: true, addressed: 'direct', at: new Date().toISOString(), text,
    channel: { source: SOURCE, thread: `${SOURCE}:${threadId}`, address: { sessionId } }, meta,
  }
}

function compact(ticket) {
  const { stage, action } = ticketStage(ticket)
  const label = { ended: '已结束', person: '待处理', idle: '等待输入', working: '执行中' }[stage]
  const detail = { queued: '已排队', delivery: '投递失败', answer: '待答复', review: '待审阅', blocked: '遇到阻塞', failed: '执行失败' }[action]
  return `${ticket.id}  ${label}${detail ? ` · ${detail}` : ''}  ${ticket.title}`
}

export function apply(ctx) {
  const profile = ctx.get('profileContext')?.name || process.env.DSH_PROFILE || 'default'
  const stateDir = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'), 'superagent-local', profile)
  const lifetime = new AbortController()
  const signal = lifetime.signal
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const release = lockSync(stateDir, { stale: 30_000, onCompromised(error) { lifetime.abort(error); ctx.logger.warn(error) } })
  let store
  try { store = new Store(join(stateDir, 'tickets.sqlite'), error => ctx.logger.warn(error)) }
  catch (error) { release(); throw error }
  const effects = new Effects(store, new HealthBoard())
  const delivery = new AgentDelivery(ctx)
  const sessionController = ctx.sessionController
  const persistence = ctx.sessionPersistence
  const projections = ctx.sessionProjections
  const workspaceRegistry = ctx.workspaceRegistry
  const permissionPresets = ctx.permissionPresets
  const agents = ctx.agents
  const logger = ctx.logger
  const stopping = new Map()
  function stopJobs(id, reason) {
    const task = Promise.resolve(stopping.get(id)).then(() => killJobs(ctx, id, reason))
      .catch(error => logger.warn(error)).finally(() => { if (stopping.get(id) === task) stopping.delete(id) })
    stopping.set(id, task)
  }
  const engine = new Engine({
    repo: store, policy: () => policy,
    scope: { scope: trigger => trigger.source === SOURCE ? { listened: true, observed: false } : { listened: false, reason: 'source-not-supported' } },
    assessor: { request() {} },
    executor: {
      start(ticket, assignment) {
        effects.enqueue('launch', assignment.id, { ticketId: ticket.id, assignmentId: assignment.id })
      },
      deliver(ticket) { effects.enqueue('delivery', ticket.id, { ticketId: ticket.id }) },
      stop(ticket, assignment) {
        effects.cancel('launch', assignment.id)
        effects.cancel('delivery', ticket.id)
        store.afterCommit(() => {
          const id = workerId(ticket.id)
          if (ticket.ended?.by !== 'executor') agents.get(id)?.cancel({ kind: 'user' }, { keepInbox: false })
          stopJobs(id, 'Superagent 工单已结束')
        })
      },
    },
    outbox: {
      send(message) { if (store.receipts.add(message)) effects.enqueue('reply', message.id, {}) },
      status: id => store.receipts.get(id)?.status,
      withdraw(id) { if (store.receipts.withdraw(id)) effects.cancel('reply', id) },
    },
  })

  function own(sessionId, id) {
    const ticket = store.tickets.get(id)
    if (!ticket || ticketOwner(ticket) !== sessionId) throw new Error('当前会话没有这张工单，请核对工单 ID。')
    return ticket
  }

  function currentWorker(sessionId) {
    if (signal.aborted) return undefined
    const id = ticketIdFor(sessionId)
    const ticket = id && store.tickets.get(id)
    return ticket && !ticket.ended && runningAssignment(ticket) ? ticket : undefined
  }

  function describe(ticket) {
    const report = latestAssignment(ticket)?.report
    const origin = store.triggers.get(ticket.origin.triggerId)
    return [compact(ticket), `授权范围：${ticket.mandate.scope}`, `授权策略：${ticket.mandate.policyVersion}`,
      `基线：${origin.meta.base}`, `执行会话：${workerId(ticket.id)}`, `工作树：${worktreePath(stateDir, ticket.id)}`,
      ticket.ended && `结果：${ticket.ended.outcome}`, ticket.attention && `待答复：${ticket.attention.question}`,
      report && `执行报告：${report.summary}`, ticket.delivery && `投递错误：${ticket.delivery.error}`,
      `执行分配：${ticket.assignments.length} 次`].filter(Boolean).join('\n')
  }

  function publishReport(ticket, report) {
    const id = ticket.id
    return store.atomic(() => {
      engine.report(id, report)
      if (report.state === 'ready' || report.state === 'dropped') {
        engine.reply({ purpose: 'result', ticketId: id, text: report.summary })
      } else if (report.question) {
        engine.reply({ purpose: 'attention', ticketId: id, question: report.question, text: report.question })
      }
      return '已记录工单报告。'
    })
  }

  const triggerIdOf = (sessionId, requestId) => key(SOURCE, sessionId, String(requestId))
  const migrate = id => migrateWorkerPreset(persistence, agents, id, signal)
  const migration = (async () => {
    for (const ticket of store.tickets.list()) {
      if (signal.aborted) return
      await migrate(workerId(ticket.id)).catch(error => { if (!signal.aborted) logger.warn(error) })
    }
  })()

  const runtime = {
    async submit(agent, requestId, text, commandSignal, origin = 'command') {
      requireText(text, '任务描述')
      const threadId = key('thread', agent.id, String(requestId))
      const combined = AbortSignal.any([signal, commandSignal].filter(Boolean))
      combined.throwIfAborted()
      const triggerId = triggerIdOf(agent.id, requestId)
      const previous = store.triggers.disposition(triggerId)
      const priorDecision = previous?.decisionId && store.decisions.get(previous.decisionId)
      if (priorDecision?.ticketId) return describe(own(agent.id, priorDecision.ticketId))
      if (store.triggers.get(triggerId)) throw new Error('这条消息已作为工单答复处理。请另发一条消息交办新任务。')
      const root = await projectRoot(workspaceRegistry, agent, combined)
      const base = await snapshotBase(root, combined)
      combined.throwIfAborted()
      const trigger = triggerFor(agent.id, requestId, threadId, text, { root, base, origin })
      const ticket = store.atomic(() => {
        if (engine.receive(trigger) === 'duplicate' && store.triggers.get(trigger.id)?.threads[0]?.id !== threadId) {
          throw new Error('这条消息已作为工单答复处理。')
        }
        const decision = engine.decide(trigger.id, { kind: 'accept', title: text.replace(/\s+/g, ' ').slice(0, 80),
          scope: text, reason: origin === 'message' ? '用户在 DSH 对话中明确交办本地任务。' : '用户通过 DSH 命令提交本地工单。',
          acknowledgement: '工单已建立。' })
        if (!decision.ticketId) throw new Error('请求未产生工单。')
        return store.tickets.get(decision.ticketId)
      })
      return `${compact(ticket)}\n用 /superagent status ${ticket.id} 查看状态。`
    },
    list: sessionId => store.tickets.list().filter(ticket => ticketOwner(ticket) === sessionId).slice(0, 30).map(compact).join('\n'),
    status: (sessionId, id) => describe(own(sessionId, id)),
    async delegate(agent, commandSignal) {
      const request = currentUserRequest(agent.session, projections)
      return runtime.submit(agent, request.requestId, request.text, commandSignal, 'message')
    },
    followUp(agent, id) {
      const request = currentUserRequest(agent.session, projections)
      const explicitIds = new Set(request.text.toLowerCase().match(/\b[a-f\d]{32}\b/g) || [])
      if (explicitIds.size > 1 || (explicitIds.size === 1 && !explicitIds.has(id))) {
        throw new Error('请明确指定这条补充信息对应的一张工单。')
      }
      if (explicitIds.size === 0) {
        const active = store.tickets.open().filter(ticket => ticketOwner(ticket) === agent.id)
        if (active.length !== 1 || active[0].id !== id) throw new Error('请让用户在消息中指定要跟进的工单 ID。')
      }
      return runtime.reply(agent.id, request.requestId, id, request.text)
    },
    reply(sessionId, requestId, id, text) {
      signal.throwIfAborted()
      const ticket = own(sessionId, id)
      requireText(text, '答复')
      if (ticket.ended?.by === 'human') throw new Error('工单已停止。请用 start 建立新的授权。')
      const origin = store.triggers.get(ticket.origin.triggerId)
      const trigger = triggerFor(sessionId, requestId, origin.threads[0].id, text, { replyTo: id })
      const previous = store.triggers.get(trigger.id)
      if (previous && previous.meta.replyTo !== id) throw new Error('这条消息已用于另一项工单操作。')
      engine.receive(trigger)
      return describe(own(sessionId, id))
    },
    isWorker: sessionId => !!ticketIdFor(sessionId),
    retry(sessionId, id) {
      signal.throwIfAborted()
      own(sessionId, id)
      const ticket = engine.retryTicket(id)
      agents.get(workerId(id))?.cancel({ kind: 'user' }, { keepInbox: false })
      stopJobs(workerId(id), 'Superagent 工单正在重试')
      return describe(ticket)
    },
    stop(sessionId, id) {
      signal.throwIfAborted()
      own(sessionId, id)
      return describe(engine.stopTicket(id, '用户在 DSH 中停止工单'))
    },
    canRun: sessionId => !!currentWorker(sessionId),
    report(sessionId, report) {
      const ticket = currentWorker(sessionId)
      if (!ticket) throw new Error('当前执行会话没有在运行的工单。')
      return publishReport(ticket, report)
    },
  }
  ctx.provide('superagentLocal', runtime)

  const resolveAgent = async id => {
    const result = await sessionController.resolveAgent(id)
    if ('error' in result) throw result.error
    return result.agent
  }

  function liveAssignment(ticketId, assignmentId) {
    const ticket = store.tickets.get(ticketId)
    const latest = ticket && latestAssignment(ticket)
    return ticket && !ticket.ended && latest?.id === assignmentId && latest.state !== 'ended' ? ticket : undefined
  }

  effects.handle('launch', async ({ ticketId, assignmentId }) => {
    const ticket = liveAssignment(ticketId, assignmentId)
    if (!ticket) return
    const busy = store.tickets.open().filter(item => item.id !== ticketId && runningAssignment(item) && ticketStage(item).stage === 'working')
    if (busy.length >= WORKER_SLOTS) throw new Later('执行会话已满，等待空闲名额。')
    const origin = store.triggers.get(ticket.origin.triggerId)
    const { root, base } = origin.meta
    const id = workerId(ticketId)
    try {
      signal.throwIfAborted()
      await stopping.get(id)
      await migration
      await migrate(id)
      const cwd = await ensureWorktree(stateDir, ticketId, root, base, signal)
      signal.throwIfAborted()
      if (!liveAssignment(ticketId, assignmentId)) return
      let agent
      try { agent = await resolveAgent(id) }
      catch (error) {
        if (error.code !== 'session/not-found') throw error
        const workspace = await workspaceRegistry.create(cwd)
        signal.throwIfAborted()
        if (!liveAssignment(ticketId, assignmentId)) return
        const created = await sessionController.create({ sessionId: id, workspaceId: workspace.id, agentPreset: PRESET })
        if (created.sessionId !== id) throw new Error('执行会话 ID 与工单绑定不一致。')
        agent = await resolveAgent(id)
        await sessionController.rename({ sessionId: id, title: `Superagent · ${ticket.title}` })
      }
      signal.throwIfAborted()
      if (!liveAssignment(ticketId, assignmentId)) return
      if (!permissionPresets.names.includes('workspace-write')) throw new Error('当前 DSH 缺少工作区写入权限预设。')
      permissionPresets.set(agent.session, 'workspace-write')
      await delivery.send(agent, key('launch', assignmentId), [
        `工单 ${ticketId}`, `授权范围：${ticket.mandate.scope}`, `原始任务：${origin.text}`,
        `当前工作树：${cwd}`, `Git 基线：${base}`, '从工作树现状开始，保留已有修改。完成验证后使用 superagent_report。',
      ].join('\n'), 'queue', signal, () => {
        if (!liveAssignment(ticketId, assignmentId)) throw new Error('工单已停止或换任。')
        engine.assignmentStarted(ticketId, assignmentId)
      })
    } catch (error) {
      if (signal.aborted || /inactive context|disposed|shutting down/i.test(String(error?.message))) throw error
      if (liveAssignment(ticketId, assignmentId)) {
        const detail = error?.stderr?.trim() || error?.message || error?.code || String(error)
        const summary = `执行器未能启动：${detail}`.slice(0, 2000)
        publishReport(ticket, { state: 'failed', summary, question: '请检查工单状态中的启动错误，解决后使用 retry。' })
      }
    }
  }, { ordered: true })

  effects.handle('delivery', async ({ ticketId }) => {
    const ticket = store.tickets.get(ticketId)
    const assignment = ticket && !ticket.ended && runningAssignment(ticket)
    if (!assignment) return
    try {
      const agent = await resolveAgent(workerId(ticketId))
      for (const input of ticket.inputs.filter(item => ticket.undelivered.includes(item.id))) {
        if (!liveAssignment(ticketId, assignment.id)) return
        const text = input.kind === 'trigger' ? store.triggers.get(input.triggerId)?.text
          : input.kind === 'text' || input.kind === 'note' ? '恢复或重试工单。先检查现有工作树与已完成的验证，再继续。' : undefined
        if (text) {
          await delivery.send(agent, input.id, `工单 ${ticketId} 的补充信息。原授权范围仍然有效。\n${text}`, 'steer', signal, () => {
            if (!liveAssignment(ticketId, assignment.id)) throw new Error('工单已停止或换任。')
          })
        }
        engine.inputsDelivered(ticketId, assignment.id, [input.id])
      }
    } catch (error) {
      if (!signal.aborted && liveAssignment(ticketId, assignment.id)) engine.deliveryFailed(ticketId, assignment.id, error.message || String(error))
      throw error
    }
  })

  effects.handle('reply', async (_payload, id) => {
    const receipt = store.receipts.get(id)
    if (receipt?.status !== 'pending') return
    if (receipt.channel.source !== SOURCE) { store.receipts.settle(receipt, 'channelIgnored'); return }
    try {
      const agent = await resolveAgent(receipt.channel.address.sessionId)
      const mode = receipt.kind === 'acknowledgement' ? { inject: 'SuperAgent 工单通知' } : 'queue'
      await delivery.send(agent, id, `SuperAgent 工单 ${receipt.ticketId}\n${receipt.text}`, mode, signal)
      store.receipts.settle(receipt, 'sent')
    } catch (error) {
      if (error.code !== 'session/not-found') throw error
      store.receipts.settle(receipt, 'channelGone')
    }
  }, { ordered: true })

  ctx.on('session/event', (session, event) => {
    if (signal.aborted) return
    const ticket = currentWorker(session.id)
    if (!ticket) return
    const assignment = runningAssignment(ticket)
    if (event.type === 'user/message') {
      const input = ticket.inputs.find(item => messageId(item.id) === event.data.id)
      if (input) engine.inputsRead(ticket.id, [input.id])
    }
    if (event.type !== 'turn/end') return
    engine.turnEnded(ticket.id, assignment.id)
    if (runningJobs(ctx, session.id).length) return
    const report = assignment.report
    if (report && (!assignment.deliveredAt || report.at >= assignment.deliveredAt) && report.state !== 'progress') return
    if (['error', 'blocked'].includes(event.data.reason?.kind)) {
      publishReport(ticket, { state: 'failed', summary: '执行会话以错误结束。', question: '请打开执行会话查看错误，再决定是否重试。' })
    } else {
      publishReport(ticket, { state: 'waiting', summary: '执行器暂未提交最终报告，可继续补充信息。' })
    }
  })

  for (const ticket of store.tickets.open()) {
    const assignment = runningAssignment(ticket)
    if (assignment) engine.assignmentInterrupted(ticket.id, assignment.id)
  }
  void migration.then(() => { if (!signal.aborted) effects.start() })
  const timer = setInterval(() => effects.kick(), 1000).unref()
  ctx.effect(() => async () => {
    lifetime.abort()
    clearInterval(timer)
    await migration
    await effects.drain()
    await Promise.allSettled(stopping.values())
    store.close()
    try { release() } catch (error) { logger.warn(error) }
  }, 'superagent-local lifecycle')
}
