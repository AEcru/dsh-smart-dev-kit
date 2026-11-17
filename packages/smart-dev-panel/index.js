/**
 * Host half of dsh-smart-dev-panel.
 *
 * Serves `POST /api/dsh-smart-dev-panel/snapshot` to the browser half:
 * a per-session, per-task read model assembled from
 *   - existing client projections (`todos`, `tokenUsage`, `contextPressure`,
 *     `contextBreakdown`, `sessionStats`, `subagentCatalog`);
 *   - a light fold over the session log (title, preset, running, tool calls,
 *     subagent settle/message notices) for values no projection exposes.
 *
 * The fold is rebuilt from `snapshotEvents()` on each request; sessions hold
 * at most a few thousand events and the client polls every few seconds.
 */
export const name = 'dsh-smart-dev-panel'

export const inject = [
  'connection',
  'sessionQuery',
  'sessions',
  'sessionProjectionCache',
  'sessionProjections',
]

const ROUTE = '/api/dsh-smart-dev-panel/snapshot'
const PARENT_KEYS = [
  'todos',
  'tokenUsage',
  'contextPressure',
  'contextBreakdown',
  'sessionStats',
  'subagentCatalog',
]
const CHILD_KEYS = ['tokenUsage', 'sessionStats']

const DELEGATE_TOOLS = new Set(['subagent', 'subagent_fork', 'spawn_teammate', 'workflow'])
const MAX_TOOLS = 80
const MAX_JOBS = 60
const MAX_TEXT = 220
const MAX_ERROR_ROWS = 30
const MAX_TOOL_STATS = 12

const json = (value) =>
  Response.json(value, { headers: { 'cache-control': 'no-store' } })
const fail = (code, message) => json({ ok: false, error: { code, message } })

const text = (value) => (typeof value === 'string' ? value : '')
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
const clip = (value, max = MAX_TEXT) => {
  const s = text(value)
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/** Extract the first text block of a content array. */
function contentText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
}

/** Parse a tool call's JSON arguments without failing on malformed input. */
function argsOf(raw) {
  if (typeof raw !== 'string' || raw === '') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** Label a delegation call from its arguments. */
function delegationLabel(name, args) {
  if (typeof args.description === 'string' && args.description.trim() !== '') {
    return clip(args.description.trim(), 80)
  }
  if (typeof args.name === 'string' && args.name.trim() !== '') return clip(args.name.trim(), 60)
  if (typeof args.prompt === 'string') {
    const first = args.prompt.trim().split('\n')[0]
    if (first) return clip(first.replace(/^#+\s*/, ''), 80)
  }
  return name
}

/** One-line summary of a tool call's arguments for its list row. */
function toolLabel(name, args) {
  const first = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim().replace(/\s+/g, ' ') : '')
  const candidate =
    first(args.command) ||
    first(args.file_path) ||
    first(args.path) ||
    first(args.url) ||
    first(args.query) ||
    first(args.queries) ||
    first(args.description) ||
    first(args.prompt) ||
    first(args.jobId) ||
    first(args.skill) ||
    first(args.name)
  return candidate ? clip(candidate, 140) : ''
}

/** Session events, or an empty array when a session exposes none. */
function eventsOf(session) {
  try {
    if (typeof session?.snapshotEvents === 'function') {
      const events = session.snapshotEvents()
      if (Array.isArray(events)) return events
    }
    if (Array.isArray(session?.log)) return session.log
  } catch {
    // fall through to an empty fold
  }
  return []
}

/** Fold the session log into the panel's light read model. */
function foldSession(session) {
  const state = {
    asOfSeq: 0,
    title: '',
    preset: null,
    model: null,
    running: false,
    turns: 0,
    steps: 0,
    toolCalls: 0,
    tools: [],
    delegations: [],
    children: new Map(),
    jobs: [],
    jobIndex: new Map(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: undefined,
    provider: null,
    reasoningEffort: null,
    toolCount: 0,
    toolNames: new Set(),
    mcpServers: new Set(),
    permissions: { preset: null, sandbox: null, approvalPolicy: null },
    approvals: { pending: new Map(), last: null },
    retries: { count: 0, last: null },
    errors: [],
    skills: new Map(),
    files: new Map(),
    compaction: { count: 0, prunedTokens: 0, lastAt: null, lastSummary: '' },
    goals: new Map(),
    schedules: new Map(),
  }
  const toolsByCall = new Map()

  for (const event of eventsOf(session)) {
    const seq = num(event?.seq)
    if (seq !== undefined && seq >= state.asOfSeq) state.asOfSeq = seq + 1
    const data = event?.data ?? {}
    switch (event?.type) {
      case 'session/title':
        if (typeof data.title === 'string') state.title = data.title
        break
      case 'agent-preset/selected':
        if (typeof data.agentPreset === 'string') state.preset = data.agentPreset
        break
      case 'request/context':
        if (typeof data.provider === 'string') state.provider = data.provider
        if (typeof data.model === 'string') state.model = data.model
        if (num(data.contextWindow) !== undefined) state.contextWindow = num(data.contextWindow)
        break
      case 'request/header': {
        const requestHeader = data.header ?? {}
        const config = requestHeader.config ?? {}
        if (typeof config.provider === 'string') state.provider = config.provider
        if (typeof config.model === 'string' && !state.model) state.model = config.model
        if (typeof config.reasoningEffort === 'string') state.reasoningEffort = config.reasoningEffort
        if (Array.isArray(requestHeader.tools)) {
          state.toolCount = requestHeader.tools.length
          for (const tool of requestHeader.tools) {
            const name = text(tool?.name)
            if (!name) continue
            state.toolNames.add(name)
            if (name.startsWith('mcp__')) {
              const server = name.split('__')[1]
              if (server) state.mcpServers.add(server)
            }
          }
        }
        break
      }
      case 'permission/preset':
        if (typeof data.preset === 'string') state.permissions.preset = data.preset
        break
      case 'sandbox/mode':
        if (typeof data.mode === 'string') state.permissions.sandbox = data.mode
        break
      case 'approval/policy':
        if (typeof data.policy === 'string') state.permissions.approvalPolicy = data.policy
        break
      case 'approval/asked': {
        const id = text(data.id)
        const item = {
          id,
          toolName: text(data.toolName),
          reason: clip(text(data.reason), 200),
          at: num(event.time) ?? Date.now(),
        }
        if (id) state.approvals.pending.set(id, item)
        state.approvals.last = item
        break
      }
      case 'approval/decided': {
        const id = text(data.id)
        if (id) state.approvals.pending.delete(id)
        state.approvals.last = {
          ...(state.approvals.last ?? {}),
          outcome: text(data.outcome),
          decidedAt: num(event.time) ?? Date.now(),
        }
        break
      }
      case 'llm/retry': {
        const failure = data.failure ?? {}
        state.retries.count += 1
        state.retries.last = {
          code: text(failure.code),
          message: clip(text(failure.message), 200),
          delayMs: num(data.delayMs),
          provider: text(data.provider),
          at: num(event.time) ?? Date.now(),
        }
        break
      }
      case 'compaction/start':
        state.compaction.count += 1
        state.compaction.lastAt = num(event.time) ?? Date.now()
        break
      case 'compaction/prune':
        state.compaction.prunedTokens += num(data.shadowedTokenCount) ?? 0
        break
      case 'compaction/summary':
        state.compaction.lastSummary = clip(contentText(data.summary), 200)
        state.compaction.lastAt = num(event.time) ?? Date.now()
        break
      case 'turn/start':
        state.running = true
        state.turns += 1
        break
      case 'turn/end':
        state.running = false
        break
      case 'step/start':
        state.steps += 1
        break
      case 'assistant/message': {
        const usage = data.usage ?? data.message?.usage
        if (usage && typeof usage === 'object') {
          state.usage.input += num(usage.inputTokens) ?? 0
          state.usage.output += num(usage.outputTokens) ?? 0
          state.usage.cacheRead += num(usage.cacheReadTokens) ?? 0
          state.usage.cacheWrite += num(usage.cacheWriteTokens) ?? 0
        }
        break
      }
      case 'tool/call': {
        state.toolCalls += 1
        const args = argsOf(data.arguments)
        const entry = {
          callId: text(data.callId),
          name: text(data.name),
          at: num(event.time) ?? Date.now(),
          turn: num(data.turn),
          step: num(data.step),
          status: 'running',
          arguments: clip(text(data.arguments), 320),
          label: DELEGATE_TOOLS.has(data.name)
            ? delegationLabel(data.name, args)
            : toolLabel(data.name, args),
        }
        state.tools.push(entry)
        if (state.tools.length > MAX_TOOLS) state.tools.shift()
        if (entry.callId) toolsByCall.set(entry.callId, entry)
        if (data.name === 'skill') {
          const skillName = text(args.skill) || text(args.name) || text(args.id)
          if (skillName) {
            const current = state.skills.get(skillName) ?? { name: skillName, count: 0 }
            state.skills.set(skillName, { ...current, count: current.count + 1, at: entry.at })
          }
        }
        if (data.name === 'write' || data.name === 'edit') {
          const path = text(args.file_path) || text(args.path) || text(args.file)
          if (path) {
            const current = state.files.get(path) ?? { path, count: 0 }
            state.files.set(path, { ...current, count: current.count + 1, at: entry.at })
          }
        }
        if (DELEGATE_TOOLS.has(data.name)) {
          state.delegations.push({ ...entry, childId: undefined })
        }
        break
      }
      case 'tool/result': {
        const message = data.message ?? {}
        const callId = text(message.toolCallId ?? data.callId)
        const entry = callId ? toolsByCall.get(callId) : undefined
        const failed = message.isError === true
        const body = contentText(message.content)
        const resultAt = num(event.time) ?? Date.now()
        if (entry) {
          entry.status = failed ? 'failed' : 'ok'
          entry.finishedAt = resultAt
          entry.result = clip(body, 420)
          if (entry.at !== undefined) entry.durationMs = Math.max(0, resultAt - entry.at)
          if (failed) {
            entry.error = clip(body || 'tool failed', 240)
            state.errors.push({ callId, name: entry.name, at: resultAt, message: entry.error })
            if (state.errors.length > MAX_ERROR_ROWS) state.errors.shift()
          }
        }
        const delegation = callId
          ? state.delegations.find((item) => item.callId === callId)
          : undefined
        if (delegation) delegation.status = failed ? 'failed' : 'ok'
        const started = /started subagent ([0-9a-z-]{8,})/i.exec(body)
        if (started && delegation) delegation.childId = started[1]
        if (failed && delegation && body) delegation.result = clip(body, 140)
        break
      }
      case 'subagent/catalog': {
        const childId = text(data.childId)
        if (!childId) break
        const current = state.children.get(childId) ?? { messages: 0 }
        state.children.set(childId, {
          ...current,
          childId,
          label: text(data.label) || current.label,
          mode: text(data.mode) || current.mode,
          createdAt: num(data.childCreatedAt) ?? current.createdAt,
        })
        const delegation = state.delegations.find(
          (item) =>
            !item.childId &&
            Math.abs((num(item.at) ?? 0) - (num(data.childCreatedAt) ?? 0)) < 15000,
        )
        if (delegation) delegation.childId = childId
        break
      }
      case 'job/registered': {
        const jobId = text(data.jobId)
        if (!jobId) break
        state.jobIndex.set(jobId, state.jobs.length)
        state.jobs.push({
          jobId,
          kind: text(data.kind),
          label: clip(text(data.label), 420),
          startedAt: num(data.startedAt) ?? num(event.time),
          status: 'running',
          owner: text(data.owner),
          toolCallId: text(data.toolCall?.callId),
        })
        break
      }
      case 'job/settled': {
        const jobId = text(data.jobId)
        const index = state.jobIndex.get(jobId)
        if (index === undefined) break
        const entry = state.jobs[index]
        state.jobs[index] = {
          ...entry,
          status: text(data.status) || 'settled',
          finishedAt: num(data.finishedAt) ?? num(event.time),
          detail: clip(text(data.detail), 420),
        }
        break
      }
      case 'user/message': {
        const source = data.source ?? {}
        const sender = text(source.senderSessionId)
        if (!sender) break
        const current = state.children.get(sender) ?? { messages: 0 }
        if (source.kind === 'subagent-settled') {
          state.children.set(sender, { ...current, childId: sender, settledAt: num(event.time) })
          break
        }
        if (source.kind === 'agent-message') {
          const body = contentText(data.content)
          state.children.set(sender, {
            ...current,
            childId: sender,
            messages: (num(current.messages) ?? 0) + 1,
            lastMessage: body ? clip(body, 160) : current.lastMessage,
            lastMessageAt: num(event.time) ?? Date.now(),
          })
        }
        break
      }
      default:
        break
    }
    if (typeof event?.type === 'string') {
      if (event.type.startsWith('goal/')) {
        const title = text(data.title) || text(data.objective) || text(data.subject)
        const id = text(data.goalId) || text(data.id) || title
        if (id) {
          const current = state.goals.get(id) ?? { id, title: '', status: '' }
          state.goals.set(id, {
            ...current,
            title: title || current.title,
            status: text(data.status) || current.status,
            progress: num(data.progress) ?? current.progress,
            updatedAt: num(event.time) ?? Date.now(),
          })
        }
      } else if (event.type.startsWith('schedule/')) {
        const title = text(data.title) || text(data.prompt)
        const id = text(data.taskId) || text(data.id) || title
        if (id) {
          const current = state.schedules.get(id) ?? { id, title: '', status: '' }
          state.schedules.set(id, {
            ...current,
            title: title ? clip(title, 100) : current.title,
            status: text(data.status) || current.status,
            nextAt: num(data.nextAt) ?? current.nextAt,
            updatedAt: num(event.time) ?? Date.now(),
          })
        }
      }
    }
  }
  state.usageAsUsage = () => ({
    inputTokens: state.usage.input,
    outputTokens: state.usage.output,
    cacheReadTokens: state.usage.cacheRead,
    cacheWriteTokens: state.usage.cacheWrite,
  })
  return state
}

/** Read a projection snapshot for a live session, or a cached one for a cold session. */
function readProjections(ctx, sessionId, header, keys) {
  const projections = ctx.get('sessionProjections')
  const cache = ctx.get('sessionProjectionCache')
  const sessions = ctx.get('sessions')
  try {
    const live = sessions?.get?.(sessionId)
    if (live) {
      const snapshot = projections?.snapshot?.(live, keys)
      if (snapshot && typeof snapshot === 'object') return snapshot.values ?? {}
    }
    const cached = cache?.cachedSnapshot?.(header, keys)
    if (cached && typeof cached === 'object') return cached.values ?? {}
  } catch {
    // degrade to the fold only
  }
  return {}
}

function totalsOf(tokenUsage) {
  if (!tokenUsage || typeof tokenUsage !== 'object') return undefined
  const input = num(tokenUsage.uncachedInputTokens) ?? 0
  const output = num(tokenUsage.outputTokens) ?? 0
  const cacheRead = num(tokenUsage.cacheReadTokens) ?? 0
  const cacheWrite = num(tokenUsage.cacheWriteTokens) ?? 0
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite }
}

function pressureOf(value) {
  if (!value || typeof value !== 'object') return undefined
  return {
    contextWindow: num(value.contextWindow),
    pressureTokens: num(value.pressureTokens),
    projectedTokens: num(value.projectedTokens),
    surfaceTokens: num(value.surfaceTokens),
  }
}

function breakdownOf(value) {
  if (!value || typeof value !== 'object') return undefined
  return {
    systemTokens: num(value.systemTokens),
    toolsTokens: num(value.toolsTokens),
    messageTokens: num(value.messageTokens),
  }
}

function statsOf(value, fold) {
  const stats = value && typeof value === 'object' ? value : {}
  const merged = {
    turns: num(stats.turns) ?? fold.turns,
    steps: num(stats.steps) ?? fold.steps,
    toolCalls: fold.toolCalls,
    llmMs: num(stats.llmMs),
    toolMs: num(stats.toolMs),
    ttftMs: num(stats.ttftMs),
    decodeMs: num(stats.decodeMs),
    decodeTokens: num(stats.decodeTokens),
  }
  return merged
}

/** Aggregate tool calls by name for the distribution list. */
function toolStatsOf(tools) {
  const map = new Map()
  for (const tool of tools) {
    const name = text(tool?.name)
    if (!name) continue
    const row = map.get(name) ?? { name, calls: 0, failed: 0, totalMs: 0, timed: 0 }
    row.calls += 1
    if (tool.status === 'failed') row.failed += 1
    if (typeof tool.durationMs === 'number') {
      row.totalMs += tool.durationMs
      row.timed += 1
    }
    map.set(name, row)
  }
  return [...map.values()]
    .map((row) => ({
      name: row.name,
      calls: row.calls,
      failed: row.failed,
      avgMs: row.timed > 0 ? Math.round(row.totalMs / row.timed) : undefined,
    }))
    .sort((a, b) => b.calls - a.calls || b.failed - a.failed)
    .slice(0, MAX_TOOL_STATS)
}

/** Short git status of the session cwd; read-only, time-boxed and cached. */
const gitCache = new Map()
async function gitStatusFor(cwd) {
  if (!cwd) return undefined
  const now = Date.now()
  const cached = gitCache.get(cwd)
  if (cached && now - cached.at < 8000) return cached.value
  let value
  try {
    const { execFile } = await import('node:child_process')
    const output = await new Promise((resolve) => {
      execFile(
        'git',
        ['status', '--porcelain=v1', '-b'],
        { cwd, timeout: 2500, windowsHide: true, maxBuffer: 128 * 1024 },
        (error, stdout) => resolve(error ? '' : String(stdout ?? '')),
      )
    })
    if (output) {
      const lines = output.split('\n').filter((line) => line.trim() !== '')
      const head = lines[0] && lines[0].startsWith('## ') ? lines[0].slice(3) : ''
      const branch = head.split('...')[0].split(' ')[0] || undefined
      const changed = lines.slice(1)
      value = {
        branch,
        dirty: changed.length,
        files: changed.slice(0, 12).map((line) => clip(line.trim(), 100)),
      }
    }
  } catch {
    // git missing, not a repository, or not permitted: the panel simply omits it
    value = undefined
  }
  gitCache.set(cwd, { at: now, value })
  return value
}

/** Header map from the session catalog. */
async function sessionHeaders(ctx) {
  const map = new Map()
  try {
    const rows = await ctx.get('sessionQuery').listSessions()
    for (const row of Array.isArray(rows) ? rows : []) {
      const header = row?.header ?? row
      if (header && typeof header.id === 'string') map.set(header.id, header)
    }
  } catch {
    // an empty catalog still serves the current session
  }
  return map
}

/** Build the full panel payload for one session. */
async function panelPayload(ctx, sessionId) {
  const headers = await sessionHeaders(ctx)
  const header = headers.get(sessionId) ?? { id: sessionId }
  const sessions = ctx.get('sessions')
  const live = sessions?.get?.(sessionId)
  const fold = live ? foldSession(live) : foldSession(undefined)
  const preset = fold.preset ?? (typeof header.agentPreset === 'string' ? header.agentPreset : null)
  const values = readProjections(ctx, sessionId, header, PARENT_KEYS)

  const catalog = Array.isArray(values.subagentCatalog) ? values.subagentCatalog : []
  const childRows = catalog.map((row) => {
    const childId = text(row?.id)
    const childHeader = headers.get(childId) ?? { id: childId }
    const childLive = sessions?.get?.(childId)
    const childFold = childLive ? foldSession(childLive) : foldSession(undefined)
    const childValues = readProjections(ctx, childId, childHeader, CHILD_KEYS)
    const notice = fold.children.get(childId) ?? {}
    return {
      id: childId,
      label:
        text(row?.label) ||
        text(childFold.title) ||
        text(childHeader.title) ||
        childId.slice(0, 8),
      mode: text(row?.mode) || 'one-shot',
      createdAt: num(row?.createdAt) ?? num(row?.childCreatedAt) ?? notice.createdAt,
      running: childLive !== undefined && notice.settledAt === undefined,
      settledAt: notice.settledAt,
      messages: num(notice.messages) ?? 0,
      lastMessage: notice.lastMessage,
      lastMessageAt: notice.lastMessageAt,
      tokens: totalsOf(childValues.tokenUsage) ?? totalsOf(childFold.usageAsUsage()),
      stats: statsOf(childValues.sessionStats, childFold),
    }
  })

  const jobRows = fold.jobs
    .map((job) => ({
      ...job,
      durationMs:
        job.startedAt !== undefined && job.finishedAt !== undefined
          ? Math.max(0, job.finishedAt - job.startedAt)
          : undefined,
    }))
    .sort((a, b) => {
      const aRunning = a.status === 'running' ? 0 : 1
      const bRunning = b.status === 'running' ? 0 : 1
      if (aRunning !== bRunning) return aRunning - bRunning
      return (b.finishedAt ?? b.startedAt ?? 0) - (a.finishedAt ?? a.startedAt ?? 0)
    })
    .slice(0, MAX_JOBS)
  const jobSummary = {
    total: fold.jobs.length,
    running: fold.jobs.filter((job) => job.status === 'running').length,
    failed: fold.jobs.filter((job) => job.status === 'failed' || job.status === 'error').length,
  }

  const usage = totalsOf(values.tokenUsage) ?? totalsOf(fold.usageAsUsage())
  const cacheHitRate =
    usage && usage.cacheRead + usage.input > 0 ? usage.cacheRead / (usage.cacheRead + usage.input) : undefined
  const git = await gitStatusFor(text(header.cwd))

  // Optional worktree-ticket channel: read-only, only when the runtime bundle is installed.
  let tickets = []
  try {
    const local = ctx.get('superagentLocal')
    if (local && typeof local.list === 'function') {
      const raw = local.list(sessionId)
      const lines = typeof raw === 'string' ? raw.split('\n').map((line) => line.trim()).filter(Boolean) : []
      tickets = lines.slice(0, 20).map((line) => {
        const match = /^([a-f\d]{32})\s{2,}(.*)$/.exec(line)
        const id = match ? match[1] : ''
        const summary = match ? match[2] : line
        let detail
        if (id) {
          try {
            const described = local.status(sessionId, id)
            if (typeof described === 'string') detail = described.slice(0, 1400)
          } catch {
            // tickets owned by another session cannot be described here
          }
        }
        return { id, summary: clip(summary, 160), detail }
      })
    }
  } catch {
    tickets = []
  }

  return {
    sessionId,
    title: fold.title || text(header.title) || '未命名任务',
    preset,
    model: fold.model,
    modelInfo: {
      provider: fold.provider,
      name: fold.model,
      contextWindow: fold.contextWindow,
      reasoningEffort: fold.reasoningEffort,
      toolCount: fold.toolCount,
      mcpServers: [...fold.mcpServers],
    },
    running: fold.running,
    asOfSeq: fold.asOfSeq,
    updatedAt: Date.now(),
    todos: Array.isArray(values.todos) ? values.todos : null,
    tokens: usage,
    cache: { read: usage?.cacheRead ?? 0, write: usage?.cacheWrite ?? 0, hitRate: cacheHitRate },
    pressure: pressureOf(values.contextPressure) ?? (fold.contextWindow !== undefined ? { contextWindow: fold.contextWindow } : undefined),
    breakdown: breakdownOf(values.contextBreakdown),
    stats: statsOf(values.sessionStats, fold),
    permissions: fold.permissions,
    approvals: {
      pending: [...fold.approvals.pending.values()].slice(-10),
      last: fold.approvals.last,
    },
    retries: fold.retries,
    errors: fold.errors.slice(-20).reverse(),
    toolStats: toolStatsOf(fold.tools),
    skills: [...fold.skills.values()].sort((a, b) => b.count - a.count).slice(0, 20),
    workspace: { cwd: text(header.cwd) || undefined, git },
    files: [...fold.files.values()].sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, 24),
    compaction: fold.compaction,
    goals: [...fold.goals.values()].slice(0, 10),
    schedules: [...fold.schedules.values()].slice(0, 10),
    tickets,
    children: childRows,
    jobs: jobRows,
    jobSummary,
    recentTools: fold.tools.slice(-MAX_TOOLS).reverse(),
  }
}

/** Register the Host HTTP route used by the browser half. */
export function apply(ctx) {
  const warn = (message, error) => {
    try {
      console.warn(`dsh-smart-dev-panel: ${message}`, error)
    } catch {
      // logging must never break activation
    }
  }

  try {
    const connection = ctx.get('connection')
    const register =
      typeof connection?.fetch?.register === 'function'
        ? connection.fetch.register.bind(connection.fetch)
        : undefined
    if (!register) {
      // Fallback: the panel cannot read data in this profile, but the rest of
      // the profile must keep working, so skip silently with a warning.
      warn('connection fetch registry unavailable; panel data route skipped', undefined)
      return
    }

    const handler = async (request) => {
      let body
      try {
        body = await request.json()
      } catch {
        return fail('bad-request', 'body is not JSON')
      }
      const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
      if (!sessionId) return fail('bad-request', 'sessionId is required')
      try {
        if (body?.light === true) {
          const headers = await sessionHeaders(ctx)
          const header = headers.get(sessionId) ?? { id: sessionId }
          const live = ctx.get('sessions')?.get?.(sessionId)
          const fold = live ? foldSession(live) : foldSession(undefined)
          const preset =
            fold.preset ?? (typeof header.agentPreset === 'string' ? header.agentPreset : null)
          return json({
            ok: true,
            value: {
              sessionId,
              title: fold.title || text(header.title) || '未命名任务',
              preset,
              running: fold.running,
              smartDev: preset === 'smart-dev',
            },
          })
        }
        return json({ ok: true, value: await panelPayload(ctx, sessionId) })
      } catch (error) {
        return fail('internal', error instanceof Error ? error.message : String(error))
      }
    }

    ctx.effect(
      () => {
        try {
          return register({ path: ROUTE, methods: ['POST'], requestBody: 'buffered', fetch: handler })
        } catch (error) {
          warn('snapshot route registration failed; panel data unavailable', error)
          return () => {}
        }
      },
      'dsh-smart-dev-panel: snapshot route',
    )
  } catch (error) {
    warn('host plugin setup failed; other plugins are unaffected', error)
  }
}
