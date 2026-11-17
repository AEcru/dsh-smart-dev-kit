/**
 * Browser half of dsh-smart-dev-panel.
 *
 * Registers a right-sidebar tab type plus its pane body, and a session-header
 * watcher that opens the pane automatically for sessions running the
 * `smart-dev` agent preset. Pane data comes from the host route
 * `POST /api/dsh-smart-dev-panel/snapshot`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-smart-dev-panel',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'dsh-smart-dev-panel'
    const ROUTE = 'api/dsh-smart-dev-panel/snapshot'

    const zh = {
      'tab.title': '智能开发',
      'guide.title': '智能开发面板',
      'guide.description': '按任务查看工单待办、子代理调用、步骤统计与 token/上下文消耗。',
      'empty.session': '未获取到当前任务，请打开一个会话。',
      'empty.todos': '本任务还没有工单计划。',
      'empty.children': '还没有派发子代理。',
      'empty.tasks': '还没有子代理或后台任务。',
      'empty.tools': '还没有工具调用。',
      'section.todos': '工单计划',
      'section.children': '子代理',
      'section.tokens': 'Token 与上下文',
      'section.steps': '步骤与耗时',
      'section.tools': '最近工具调用',
      'progress': '完成 {done}/{total}',
      'tokens.input': '输入',
      'tokens.output': '输出',
      'tokens.cacheRead': '缓存读',
      'tokens.cacheWrite': '缓存写',
      'tokens.total': '合计',
      'context.usage': '上下文占用',
      'stats.turns': '轮次',
      'stats.steps': '步骤',
      'stats.toolCalls': '工具调用',
      'stats.llm': '模型耗时',
      'stats.tool': '工具耗时',
      'child.tokens': '{n} tokens',
      'child.steps': '{n} 步',
      'child.mode.one-shot': '一次性',
      'child.mode.continuable': '可继续',
      'child.mode.external': '外部',
      'child.mode.unknown': '未知',
      'status.running': '运行中',
      'status.settled': '已结束',
      'status.failed': '失败',
      'status.ok': '成功',
      'state.awaiting': '连接中…',
      'state.error': '读取失败：{message}',
      'footer.auto': '每 2.5 秒自动刷新',
      'footer.updated': '更新于 {time}',
      'refresh': '刷新',
      'unavailable': '数据不可用',
      'expandAll': '全部展开',
      'collapseAll': '全部收起',
      'section.tasks': '任务管理',
      'tasks.subagents': '子代理拓扑',
      'tasks.jobs': '后台任务',
      'empty.jobs': '没有后台任务。',
      'jobs.total': '任务',
      'jobs.running': '运行中',
      'jobs.failed': '失败',
      'job.status.running': '运行中',
      'job.status.completed': '完成',
      'job.status.failed': '失败',
      'job.status.error': '失败',
      'job.status.stopped': '已停止',
      'job.detail': '详情',
      'child.messages': '{n} 条消息',
      'list.more': '加载更多（还有 {n} 条）',
      'todo.status.completed': '已完成',
      'todo.status.in_progress': '进行中',
      'todo.status.pending': '待处理',
      'detail.copyId': '调用 ID',
      'detail.kind': '类型',
      'detail.status': '状态',
      'detail.duration': '耗时',
      'detail.started': '开始',
      'detail.finished': '结束',
      'detail.exit': '退出信息',
      'detail.command': '命令',
      'detail.jobId': '任务 ID',
      'detail.mode': '模式',
      'detail.tokens': 'Token',
      'detail.steps': '步数',
      'detail.messages': '消息',
      'detail.created': '创建',
      'detail.settled': '结束',
      'detail.sessionId': '会话 ID',
      'detail.lastMessage': '最近回报',
      'detail.arguments': '参数',
      'detail.result': '结果',
      'detail.error': '错误',
      'detail.turn': '轮次',
      'detail.step': '步骤',
      'detail.time': '时间',
      'section.model': '模型与缓存',
      'section.toolStats': '工具调用分布',
      'section.errors': '失败与重试',
      'section.skills': '技能使用',
      'section.workspace': '工作区与变更',
      'section.ranking': '子代理消耗',
      'section.targets': '目标、审批与上下文',
      'model.provider': '提供方',
      'model.name': '模型',
      'model.reasoning': '推理档位',
      'model.window': '上下文窗口',
      'model.tools': '可用工具',
      'model.mcp': 'MCP 服务',
      'cache.hit': '缓存命中率',
      'cache.read': '缓存读',
      'cache.write': '缓存写',
      'perf.ttft': '首字延迟',
      'perf.decode': '解码速度',
      'breakdown.system': '系统提示',
      'breakdown.tools': '工具 schema',
      'breakdown.messages': '消息',
      'stats.ttft': '首字延迟',
      'stats.decode': '解码速度',
      'toolstat.calls': '{n} 次',
      'toolstat.failed': '{n} 次失败',
      'toolstat.avg': '均 {ms}',
      'skills.uses': '{n} 次',
      'files.touches': '{n} 次改动',
      'workspace.cwd': '工作目录',
      'workspace.branch': '分支',
      'workspace.dirty': '未提交 {n} 项',
      'workspace.clean': '工作区干净',
      'workspace.notGit': '未检测到 git 仓库',
      'retry.summary': '模型重试 {n} 次',
      'retry.last': '最近：{code}',
      'approval.pending': '等待确认 · {tool}',
      'approval.none': '没有等待中的确认',
      'goals.none': '没有进行中的目标',
      'schedules.none': '没有定时任务',
      'compaction.summary': '上下文压缩 {n} 次',
      'compaction.pruned': '已裁剪 {n} tokens',
      'compaction.none': '尚未压缩',
      'ranking.tokens': '{n} tokens',
      'ranking.steps': '{n} 步',
      'empty.skills': '本任务还没有使用 skill。',
      'empty.files': '还没有产生文件改动。',
      'empty.errors': '没有失败记录。',
      'empty.toolStats': '还没有工具调用。',
      'empty.ranking': '还没有派发子代理。',
      'empty.targets': '没有目标、审批或压缩记录。',
      'empty.model': '还没有模型请求信息。',
      'main.context': '上下文占用',
      'main.tokens': 'Token 合计',
      'main.children': '子代理',
      'main.failures': '失败',
      'badge.permission': '权限',
      'badge.preset': '模式',
      'badge.model': '模型',
      'badge.seq': '面板数据序号（已折叠到的会话事件位置）',
      'help.tokens': '本任务的 token 消耗、缓存与上下文占用；展开任意行可看精确数值与上下文构成。',
      'help.model': '当前提供方 / 模型 / 推理档位、缓存命中率，以及首字延迟与解码速度。',
      'help.todos': '工单 / 待办计划与完成进度，点击行可看完整内容与状态。',
      'help.tasks': '子代理拓扑与后台任务；点击行可看模式、token、耗时、退出详情。',
      'help.toolStats': '按工具名聚合的调用次数、失败数与平均耗时。',
      'help.tools': '最近工具调用及状态；点击行可看参数标签与调用 ID。',
      'help.errors': '工具失败与模型重试记录，用于定位卡住、格式错误等问题。',
      'help.steps': '轮次、步骤、工具调用次数，以及模型耗时与工具耗时。',
      'help.skills': '本任务加载过的 skill 及使用次数。',
      'help.workspace': 'git 分支、未提交项、工作目录，以及本任务写入 / 编辑过的文件。',
      'help.ranking': '按 token 消耗排序的子代理，用于判断哪个派工在消耗预算。',
      'help.targets': '目标、定时任务、等待确认的审批，以及上下文压缩记录。',
      'section.tickets': '工单通道',
      'help.tickets': '可选的重型执行通道：L3 任务在独立 git worktree 中执行，授权、工作树与报告都留痕；未安装或未使用时为空。',
      'empty.tickets': '还没有工单（L3 重型任务可走工单通道）。',
      'detail.worktree': '工作树',
      'settings': '设置',
      'settings.title': '面板设置',
      'settings.hint': '常开 · 排序',
      'settings.reset': '恢复默认',
      'settings.openOn': '常开',
      'settings.openOff': '收起',
      'settings.note': '收起的分区自动排到下方；设置保存在本机浏览器。',
      'settings.up': '上移',
      'settings.down': '下移',
      'settings.drag': '拖拽排序',
    }

    const en = {
      'tab.title': 'Smart dev',
      'guide.title': 'Smart dev panel',
      'guide.description': 'Per-task tickets, subagent delegations, step stats and token/context usage.',
      'empty.session': 'No session selected.',
      'empty.todos': 'No ticket plan for this task yet.',
      'empty.children': 'No subagents dispatched yet.',
      'empty.tasks': 'No subagents or background jobs yet.',
      'empty.tools': 'No tool calls yet.',
      'section.todos': 'Ticket plan',
      'section.children': 'Subagents',
      'section.tokens': 'Tokens and context',
      'section.steps': 'Steps and timing',
      'section.tools': 'Recent tool calls',
      'progress': '{done}/{total} done',
      'tokens.input': 'Input',
      'tokens.output': 'Output',
      'tokens.cacheRead': 'Cache read',
      'tokens.cacheWrite': 'Cache write',
      'tokens.total': 'Total',
      'context.usage': 'Context usage',
      'stats.turns': 'Turns',
      'stats.steps': 'Steps',
      'stats.toolCalls': 'Tool calls',
      'stats.llm': 'Model time',
      'stats.tool': 'Tool time',
      'child.tokens': '{n} tokens',
      'child.steps': '{n} steps',
      'child.mode.one-shot': 'one-shot',
      'child.mode.continuable': 'continuable',
      'child.mode.external': 'external',
      'child.mode.unknown': 'unknown',
      'status.running': 'running',
      'status.settled': 'settled',
      'status.failed': 'failed',
      'status.ok': 'ok',
      'state.awaiting': 'Connecting…',
      'state.error': 'Read failed: {message}',
      'footer.auto': 'Refreshes every 2.5 s',
      'footer.updated': 'Updated {time}',
      'refresh': 'Refresh',
      'unavailable': 'unavailable',
      'expandAll': 'Expand all',
      'collapseAll': 'Collapse all',
      'section.tasks': 'Task manager',
      'tasks.subagents': 'Subagent topology',
      'tasks.jobs': 'Background jobs',
      'empty.jobs': 'No background jobs.',
      'jobs.total': 'jobs',
      'jobs.running': 'running',
      'jobs.failed': 'failed',
      'job.status.running': 'running',
      'job.status.completed': 'completed',
      'job.status.failed': 'failed',
      'job.status.error': 'failed',
      'job.status.stopped': 'stopped',
      'job.detail': 'details',
      'child.messages': '{n} messages',
      'list.more': 'Load more ({n} left)',
      'todo.status.completed': 'completed',
      'todo.status.in_progress': 'in progress',
      'todo.status.pending': 'pending',
      'detail.copyId': 'Call ID',
      'detail.kind': 'Kind',
      'detail.status': 'Status',
      'detail.duration': 'Duration',
      'detail.started': 'Started',
      'detail.finished': 'Finished',
      'detail.exit': 'Exit info',
      'detail.command': 'Command',
      'detail.jobId': 'Job ID',
      'detail.mode': 'Mode',
      'detail.tokens': 'Tokens',
      'detail.steps': 'Steps',
      'detail.messages': 'Messages',
      'detail.created': 'Created',
      'detail.settled': 'Settled',
      'detail.sessionId': 'Session ID',
      'detail.lastMessage': 'Last report',
      'detail.arguments': 'Arguments',
      'detail.result': 'Result',
      'detail.error': 'Error',
      'detail.turn': 'Turn',
      'detail.step': 'Step',
      'detail.time': 'Time',
      'section.model': 'Model and cache',
      'section.toolStats': 'Tool distribution',
      'section.errors': 'Failures and retries',
      'section.skills': 'Skills used',
      'section.workspace': 'Workspace and changes',
      'section.ranking': 'Subagent spend',
      'section.targets': 'Goals, approvals, context',
      'model.provider': 'Provider',
      'model.name': 'Model',
      'model.reasoning': 'Reasoning',
      'model.window': 'Context window',
      'model.tools': 'Tools',
      'model.mcp': 'MCP servers',
      'cache.hit': 'Cache hit',
      'cache.read': 'Cache read',
      'cache.write': 'Cache write',
      'perf.ttft': 'TTFT',
      'perf.decode': 'Decode',
      'breakdown.system': 'System prompt',
      'breakdown.tools': 'Tool schemas',
      'breakdown.messages': 'Messages',
      'stats.ttft': 'TTFT',
      'stats.decode': 'Decode',
      'toolstat.calls': '{n} calls',
      'toolstat.failed': '{n} failed',
      'toolstat.avg': 'avg {ms}',
      'skills.uses': '{n} uses',
      'files.touches': '{n} edits',
      'workspace.cwd': 'Working dir',
      'workspace.branch': 'Branch',
      'workspace.dirty': '{n} uncommitted',
      'workspace.clean': 'clean tree',
      'workspace.notGit': 'no git repository',
      'retry.summary': '{n} model retries',
      'retry.last': 'last: {code}',
      'approval.pending': 'Waiting for approval · {tool}',
      'approval.none': 'No pending approvals',
      'goals.none': 'No active goals',
      'schedules.none': 'No scheduled tasks',
      'compaction.summary': '{n} compactions',
      'compaction.pruned': '{n} tokens pruned',
      'compaction.none': 'Not compacted',
      'ranking.tokens': '{n} tokens',
      'ranking.steps': '{n} steps',
      'empty.skills': 'No skills used in this task yet.',
      'empty.files': 'No file changes yet.',
      'empty.errors': 'No failures.',
      'empty.toolStats': 'No tool calls yet.',
      'empty.ranking': 'No subagents dispatched yet.',
      'empty.targets': 'No goals, approvals or compactions.',
      'empty.model': 'No model request info yet.',
      'main.context': 'Context',
      'main.tokens': 'Tokens',
      'main.children': 'Subagents',
      'main.failures': 'Failures',
      'badge.permission': 'Permission',
      'badge.preset': 'Preset',
      'badge.model': 'Model',
      'badge.seq': 'Panel data sequence (last folded session event)',
      'help.tokens': 'Task token spend, cache and context pressure; expand a row for exact values and the context breakdown.',
      'help.model': 'Provider, model, reasoning effort, cache hit rate, TTFT and decode speed.',
      'help.todos': 'Ticket/plan rows with completion progress; click a row for its full text and status.',
      'help.tasks': 'Subagent topology and background jobs; click a row for mode, tokens, timing and exit details.',
      'help.toolStats': 'Calls, failures and average duration aggregated per tool.',
      'help.tools': 'Recent tool calls and their status; click a row for its label and call id.',
      'help.errors': 'Tool failures and model retries — useful when a step gets stuck or output is malformed.',
      'help.steps': 'Turns, steps, tool call count, and model versus tool time.',
      'help.skills': 'Skills loaded by this task and how often they ran.',
      'help.workspace': 'Git branch, uncommitted items, working directory, and files written or edited by this task.',
      'help.ranking': 'Subagents ranked by token spend, to see which delegation is consuming the budget.',
      'help.targets': 'Goals, scheduled tasks, pending approvals and context compaction records.',
      'section.tickets': 'Ticket channel',
      'help.tickets': 'Optional heavy-execution channel: L3 tasks run in an isolated git worktree with mandate, tree and reports kept on record; empty when unused.',
      'empty.tickets': 'No tickets yet (L3 heavy tasks can use the ticket channel).',
      'detail.worktree': 'Worktree',
      'settings': 'Settings',
      'settings.title': 'Panel settings',
      'settings.hint': 'open · order',
      'settings.reset': 'Reset',
      'settings.openOn': 'open',
      'settings.openOff': 'closed',
      'settings.note': 'Closed sections sink to the bottom; saved in this browser.',
      'settings.up': 'Up',
      'settings.down': 'Down',
      'settings.drag': 'Drag to reorder',
    }

    const T = {
      bg1: 'var(--dsw-alias-bg-layer-1, #17181c)',
      bg2: 'var(--dsw-alias-bg-layer-2, #1f2126)',
      border: 'var(--dsw-alias-border-l2, #33363d)',
      borderL4: 'var(--dsw-alias-border-l4, #4a4e57)',
      text: 'var(--dsw-alias-label-primary, #e6e7ea)',
      muted: 'var(--dsw-alias-label-secondary, #a4a8b1)',
      faint: 'var(--dsw-alias-label-tertiary, #7d818b)',
      ok: 'var(--dsw-alias-state-success-primary, #4cc38a)',
      warn: 'var(--dsw-alias-state-warning-primary, #e0a458)',
      err: 'var(--dsw-alias-state-error-primary, #e5675f)',
      brand: 'var(--dsw-alias-brand-primary, #4d6bfe)',
    }

    /** Accent colour per panel section: the colour band on each card. */
    const A = {
      tokens: '#5b8cff',
      model: '#a78bfa',
      plan: '#8b5cf6',
      tasks: '#f5a524',
      tools: '#22d3ee',
      errors: '#f0555a',
      perf: '#3ddc97',
      skills: '#f472b6',
      workspace: '#fb923c',
      targets: '#2dd4bf',
      brand: '#4d6bfe',
    }
    const tint = (hex, alpha) => {
      const raw = hex.replace('#', '')
      const r = parseInt(raw.slice(0, 2), 16)
      const g = parseInt(raw.slice(2, 4), 16)
      const b = parseInt(raw.slice(4, 6), 16)
      return `rgba(${r}, ${g}, ${b}, ${alpha})`
    }
    const PANEL_CSS = `
.sd-panel { scrollbar-width: thin; scrollbar-color: rgba(125,129,139,.28) transparent; }
.sd-panel::-webkit-scrollbar { width: 6px; height: 6px; }
.sd-panel::-webkit-scrollbar-thumb { background: rgba(125,129,139,.28); border-radius: 999px; }
.sd-panel::-webkit-scrollbar-track { background: transparent; }
.sd-card { position: relative; transition: border-color .18s ease, box-shadow .18s ease, transform .18s ease; }
.sd-card:hover { box-shadow: 0 6px 20px rgba(0,0,0,.22); }
.sd-row { transition: background .14s ease; border-radius: 6px; }
.sd-row:hover { background: rgba(125,129,139,.10); }
.sd-btn { transition: color .15s ease, border-color .15s ease, background .15s ease; }
.sd-btn:hover { color: var(--dsw-alias-label-primary, #e6e7ea); background: rgba(125,129,139,.14); }
.sd-pill { transition: border-color .15s ease, background .15s ease, filter .15s ease; }
.sd-pill:hover { filter: brightness(1.18); }
.sd-btn svg { transition: transform .15s ease; }
.sd-btn:hover svg { transform: translateY(-1px); }
.sd-list { overflow-x: hidden !important; scrollbar-width: thin; scrollbar-color: var(--sd-list-thumb, rgba(125,129,139,.3)) transparent; }
.sd-list::-webkit-scrollbar { width: 2px; height: 2px; }
.sd-list::-webkit-scrollbar-thumb {
  background: linear-gradient(180deg, transparent, var(--sd-list-thumb, rgba(125,129,139,.3)) 18%, var(--sd-list-thumb, rgba(125,129,139,.3)) 82%, transparent);
  border-radius: 999px;
  box-shadow: 0 0 6px var(--sd-list-thumb, rgba(125,129,139,.3)), 0 0 2px var(--sd-list-thumb, rgba(125,129,139,.3));
}
.sd-list::-webkit-scrollbar-track { background: transparent; }
.sd-list * { overflow-wrap: anywhere; }
.sd-help { position: relative; display: inline-flex; align-items: center; flex: none; }
.sd-help-tip { position: absolute; top: 20px; right: 0; z-index: 60; width: 232px; padding: 8px 10px; border-radius: 8px; font-size: 10px; line-height: 1.55; text-align: left; box-shadow: 0 8px 24px rgba(0,0,0,.4); pointer-events: none; }
.sd-progress { height: 6px; border-radius: 999px; overflow: hidden; }
.sd-progress > i { display: block; height: 100%; border-radius: 999px; transition: width .35s ease; box-shadow: 0 0 8px currentColor; }
.sd-metric { transition: transform .16s ease, box-shadow .16s ease, filter .16s ease; cursor: pointer; }
.sd-metric:hover { transform: translateY(-2px); filter: brightness(1.1); }
.sd-metric:active { transform: translateY(0); }
.sd-opt-row { transition: background .12s ease, box-shadow .12s ease; border-radius: 6px; }
.sd-opt-row:hover { background: rgba(125,129,139,.08); }
.sd-opt-dragging { opacity: .45; }
.sd-drag-over { box-shadow: inset 0 2px 0 var(--sd-flash, rgba(77,107,254,.8)); background: rgba(125,129,139,.12); }
.sd-grip { cursor: grab; }
.sd-grip:active { cursor: grabbing; }
.sd-opt-arrows { opacity: .35; transition: opacity .15s ease; }
.sd-opt-row:hover .sd-opt-arrows { opacity: 1; }
@keyframes sdFlash {
  0%, 100% { box-shadow: 0 0 0 0 transparent; }
  18%, 62% { box-shadow: 0 0 0 2px var(--sd-flash, rgba(77,107,254,.75)), 0 0 22px var(--sd-flash, rgba(77,107,254,.45)); }
}
.sd-flash { animation: sdFlash 1.6s ease; }
@keyframes sdPulse { 0%, 100% { opacity: 1 } 50% { opacity: .4 } }
.sd-pulse { animation: sdPulse 1.8s ease-in-out infinite; }
`

    // Section registry: the settings popover and the render order both use it.
    const SECTION_META = [
      { key: 'tokens', titleKey: 'section.tokens' },
      { key: 'model', titleKey: 'section.model' },
      { key: 'todos', titleKey: 'section.todos' },
      { key: 'tasks', titleKey: 'section.tasks' },
      { key: 'tickets', titleKey: 'section.tickets' },
      { key: 'toolStats', titleKey: 'section.toolStats' },
      { key: 'tools', titleKey: 'section.tools' },
      { key: 'errors', titleKey: 'section.errors' },
      { key: 'stats', titleKey: 'section.steps' },
      { key: 'skills', titleKey: 'section.skills' },
      { key: 'workspace', titleKey: 'section.workspace' },
      { key: 'ranking', titleKey: 'section.ranking' },
      { key: 'targets', titleKey: 'section.targets' },
    ]
    const DEFAULT_PREFS = {
      order: SECTION_META.map((section) => section.key),
      // Everything is expanded by default; users can collapse sections in settings.
      open: Object.fromEntries(SECTION_META.map((section) => [section.key, true])),
    }
    // v2: defaults changed to all-expanded, so earlier saved defaults are retired.
    const PREFS_KEY = 'dsh-smart-dev-panel:prefs:v2'

    function sanitizePrefs(raw) {
      const order = []
      const open = { ...DEFAULT_PREFS.open }
      try {
        if (raw && Array.isArray(raw.order)) {
          for (const key of raw.order) {
            if (SECTION_META.some((section) => section.key === key) && !order.includes(key)) order.push(key)
          }
        }
        for (const section of SECTION_META) if (!order.includes(section.key)) order.push(section.key)
        if (raw && raw.open && typeof raw.open === 'object') {
          for (const section of SECTION_META) {
            if (typeof raw.open[section.key] === 'boolean') open[section.key] = raw.open[section.key]
          }
        }
      } catch {
        // fall back to defaults
      }
      return { order, open }
    }

    function loadPrefs() {
      try {
        if (typeof localStorage === 'undefined') return sanitizePrefs(undefined)
        const raw = localStorage.getItem(PREFS_KEY)
        return sanitizePrefs(raw ? JSON.parse(raw) : undefined)
      } catch {
        return sanitizePrefs(undefined)
      }
    }

    function savePrefs(prefs) {
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
      } catch {
        // persistence is best-effort
      }
    }

    const panelStyle = {
      gap: '10px',
      padding: '10px 12px 16px',
      color: T.text,
      fontSize: '12px',
      lineHeight: 1.5,
      height: '100%',
      overflowY: 'auto',
      background: 'transparent',
      boxSizing: 'border-box',
      width: '100%',
      minWidth: 0,
    }
    const cardStyle = {
      background: T.bg1,
      border: `1px solid ${T.border}`,
      borderRadius: '10px',
      padding: '10px 12px',
      minWidth: 0,
      width: '100%',
      boxSizing: 'border-box',
    }
    const titleRowStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      minWidth: 0,
      marginBottom: '8px',
    }
    const sectionTitleStyle = {
      fontSize: '11px',
      fontWeight: 650,
      letterSpacing: '.02em',
      color: T.muted,
      textTransform: 'uppercase',
    }
    const chipStyle = {
      border: `1px solid ${T.border}`,
      borderRadius: '999px',
      padding: '0 7px',
      lineHeight: '18px',
      fontSize: '10px',
      color: T.muted,
      whiteSpace: 'nowrap',
      flex: 'none',
      background: T.bg2,
    }
    const rowStyle = {
      display: 'flex',
      alignItems: 'baseline',
      gap: '8px',
      minWidth: 0,
      padding: '3px 0',
    }
    const ellipsis = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }
    const numStyle = { fontVariantNumeric: 'tabular-nums', flex: 'none', color: T.muted }
    const smallButtonStyle = {
      border: `1px solid ${T.border}`,
      borderRadius: '6px',
      padding: '0 6px',
      height: '20px',
      background: 'transparent',
      color: T.muted,
      font: 'inherit',
      fontSize: '10px',
      cursor: 'pointer',
      flex: 'none',
    }
    const miniLabelStyle = { color: T.faint, fontSize: '10px', letterSpacing: '.02em', margin: '2px 0' }

    function fmtTokens(value) {
      const n = typeof value === 'number' && Number.isFinite(value) ? value : 0
      if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M`
      if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 1 : 2)}k`
      return String(n)
    }
    function fmtMs(value) {
      const ms = typeof value === 'number' && Number.isFinite(value) ? value : 0
      if (ms <= 0) return '—'
      if (ms < 1000) return `${Math.round(ms)}ms`
      if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)}s`
      const min = Math.floor(ms / 60000)
      const sec = Math.round((ms % 60000) / 1000)
      return `${min}m${sec < 10 ? '0' : ''}${sec}s`
    }
    function fmtTime(value) {
      if (!value) return '—'
      const d = new Date(value)
      if (Number.isNaN(d.getTime())) return '—'
      const pad = (n) => String(n).padStart(2, '0')
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    }
    function fmtDateTime(value) {
      if (!value) return '—'
      const d = new Date(value)
      if (Number.isNaN(d.getTime())) return '—'
      const pad = (n) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    }
    function fill(template, values) {
      return template.replace(/\{(\w+)\}/g, (_, key) => (values[key] === undefined ? '' : String(values[key])))
    }

    function StatusDot({ color, pulse }) {
      return h('span', {
        style: {
          width: '7px',
          height: '7px',
          borderRadius: '50%',
          background: color,
          flex: 'none',
          boxShadow: pulse ? `0 0 0 3px color-mix(in srgb, ${color} 22%, transparent)` : 'none',
          marginTop: '1px',
        },
      })
    }

    function GuideIcon() {
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: 16, height: 16, 'aria-hidden': true, style: { display: 'block' } },
        h('rect', { x: 3, y: 3, width: 18, height: 18, rx: 4, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }),
        h('rect', { x: 6.5, y: 7, width: 11, height: 2, rx: 1, fill: 'currentColor' }),
        h('rect', { x: 6.5, y: 11, width: 7, height: 2, rx: 1, fill: 'currentColor' }),
        h('rect', { x: 6.5, y: 15, width: 9, height: 2, rx: 1, fill: 'currentColor' }),
      )
    }

    /** Inline stroke icon set used by pills and buttons. */
    const ICON_PATHS = {
      gear: [
        'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
        'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c0 .68.4 1.28 1 1.51H21a2 2 0 1 1 0 4h-.09c-.6.23-1 .83-1 1.49Z',
      ],
      expand: ['M6 9l6 6 6-6'],
      collapse: ['M6 15l6-6 6 6'],
      refresh: ['M21 12a9 9 0 1 1-2.64-6.36', 'M21 3v6h-6'],
      layers: ['M12 2 2 7l10 5 10-5-10-5Z', 'M2 17l10 5 10-5', 'M2 12l10 5 10-5'],
      cpu: ['M9 9h6v6H9Z', 'M4 9V4h5', 'M20 9V4h-5', 'M4 15v5h5', 'M20 15v5h-5'],
      hash: ['M4 9h16', 'M4 15h16', 'M10 3 8 21', 'M16 3l-2 18'],
      shield: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z'],
      help: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z', 'M9.09 9a3 3 0 1 1 5.83 1c0 2-3 3-3 3', 'M12 17h.01'],
      up: ['M12 19V5', 'M5 12l7-7 7 7'],
      down: ['M12 5v14', 'M19 12l-7 7-7-7'],
    }

    function Icon({ name, size = 12, color = 'currentColor' }) {
      const paths = ICON_PATHS[name] || ICON_PATHS.hash
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: color,
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block', flex: 'none' },
        },
        ...paths.map((path, index) => h('path', { key: `p-${index}`, d: path })),
      )
    }

    /** Header identity pill: icon + label, tinted by its own accent colour. */
    function Pill({ icon, label, accent, strong = false, title }) {
      return h(
        'span',
        {
          className: 'sd-pill',
          title: title || label,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            maxWidth: '100%',
            minWidth: 0,
            height: '20px',
            padding: '0 8px 0 6px',
            borderRadius: '999px',
            border: `1px solid ${tint(accent, strong ? 0.6 : 0.38)}`,
            background: `linear-gradient(180deg, ${tint(accent, 0.24)}, ${tint(accent, 0.06)})`,
            color: strong ? T.text : T.muted,
            fontSize: '10px',
            lineHeight: '18px',
            whiteSpace: 'nowrap',
          },
        },
        strong ? h('span', { style: { width: '5px', height: '5px', borderRadius: '50%', background: accent, boxShadow: `0 0 6px ${accent}`, flex: 'none' } }) : h(Icon, { name: icon, size: 11, color: accent }),
        h('span', { style: { ...ellipsis, maxWidth: '150px' } }, label),
      )
    }

    /** Small coloured KPI tile for the panel header; click jumps to its section. */
    function MetricTile({ label, value, sub, accent, onClick, hint }) {
      return h(
        'div',
        {
          className: 'sd-metric',
          role: onClick ? 'button' : undefined,
          tabIndex: onClick ? 0 : undefined,
          title: hint,
          onClick,
          onKeyDown: onClick
            ? (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onClick()
                }
              }
            : undefined,
          style: {
            flex: '1 1 0',
            minWidth: 0,
            padding: '7px 9px',
            borderRadius: '10px',
            border: `1px solid ${tint(accent, 0.32)}`,
            background: `linear-gradient(180deg, ${tint(accent, 0.16)}, ${tint(accent, 0.03)})`,
            boxShadow: `inset 0 1px 0 ${tint(accent, 0.22)}`,
          },
        },
        h(
          'div',
          { style: { color: T.faint, fontSize: '9px', letterSpacing: '.05em', textTransform: 'uppercase', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
          label,
        ),
        h('div', { style: { fontWeight: 750, fontSize: '15px', fontVariantNumeric: 'tabular-nums', color: T.text, lineHeight: 1.35 } }, value),
        sub
          ? h('div', { style: { color: T.muted, fontSize: '9px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, sub)
          : null,
      )
    }

    /**
     * One panel section. The header toggles the body; every section is
     * collapsible on its own, and the panel header offers expand/collapse all.
     * The accent colour paints the card's top band and title marker; the "?"
     * button shows a hover/focus tooltip explaining the section.
     */
    function SectionCard({ title, chips, open = true, onToggle, fullWidth = false, accent = A.brand, help, order, hidden = false, sectionKey, children }) {
      const [helpOpen, setHelpOpen] = React.useState(false)
      return h(
        'div',
        {
          className: 'sd-card',
          'data-sd-section': sectionKey,
          style: {
            ...cardStyle,
            ...(fullWidth ? { gridColumn: '1 / -1' } : null),
            ...(order !== undefined ? { order } : null),
            ...(hidden ? { display: 'none' } : null),
            ...(open ? null : { alignSelf: 'start', padding: '8px 12px' }),
            '--sd-list-thumb': tint(accent, 0.6),
            '--sd-flash': tint(accent, 0.8),
            borderColor: tint(accent, 0.3),
            background: `linear-gradient(180deg, ${tint(accent, 0.09)} 0%, ${T.bg1} 48%)`,
          },
        },
        h('div', {
          style: {
            position: 'absolute',
            left: 0,
            right: 0,
            top: 0,
            height: '2px',
            borderTopLeftRadius: '10px',
            borderTopRightRadius: '10px',
            background: `linear-gradient(90deg, ${accent}, ${tint(accent, 0.08)})`,
          },
        }),
        h(
          'div',
          {
            style: {
              ...titleRowStyle,
              paddingTop: '2px',
              marginBottom: open ? '8px' : 0,
              cursor: onToggle ? 'pointer' : 'default',
              userSelect: 'none',
            },
            role: onToggle ? 'button' : undefined,
            tabIndex: onToggle ? 0 : undefined,
            'aria-expanded': onToggle ? open : undefined,
            onClick: onToggle,
            onKeyDown: onToggle
              ? (event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onToggle()
                  }
                }
              : undefined,
          },
          h('span', {
            style: {
              width: '6px',
              height: '6px',
              borderRadius: '2px',
              background: accent,
              boxShadow: `0 0 8px ${tint(accent, 0.65)}`,
              flex: 'none',
            },
          }),
          h(
            'span',
            {
              style: {
                ...sectionTitleStyle,
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                minWidth: 0,
                flex: '1 1 auto',
              },
            },
            onToggle
              ? h('span', { style: { color: T.faint, fontSize: '9px', width: '8px', flex: 'none' } }, open ? '▾' : '▸')
              : null,
            h('span', { style: { ...ellipsis } }, title),
          ),
          h(
            'span',
            {
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                marginLeft: 'auto',
                minWidth: 0,
                maxWidth: '58%',
                flex: 'none',
              },
            },
            h(
              'span',
              {
                style: {
                  display: 'inline-flex',
                  gap: '4px',
                  flexWrap: 'nowrap',
                  justifyContent: 'flex-end',
                  minWidth: 0,
                  overflow: 'hidden',
                },
              },
              ...(chips ?? []).map((chip, index) => h('span', { key: `chip-${index}`, style: { ...chipStyle, borderColor: tint(accent, 0.32), background: tint(accent, 0.08) } }, chip)),
            ),
            help
              ? h(
                  'span',
                  {
                    className: 'sd-help',
                    onMouseEnter: () => setHelpOpen(true),
                    onMouseLeave: () => setHelpOpen(false),
                    onClick: (event) => {
                      event.stopPropagation()
                      setHelpOpen((value) => !value)
                    },
                  },
                  h(
                    'span',
                    {
                      style: {
                        width: '15px',
                        height: '15px',
                        borderRadius: '50%',
                        border: `1px solid ${tint(accent, 0.5)}`,
                        background: tint(accent, 0.12),
                        color: T.muted,
                        fontSize: '9px',
                        fontWeight: 700,
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'help',
                        flex: 'none',
                      },
                    },
                    h(Icon, { name: 'help', size: 10, color: T.muted }),
                  ),
                  helpOpen
                    ? h(
                        'span',
                        {
                          className: 'sd-help-tip',
                          style: {
                            background: T.bg2,
                            border: `1px solid ${tint(accent, 0.55)}`,
                            color: T.muted,
                          },
                        },
                        help,
                      )
                    : null,
                )
              : null,
          ),
        ),
        open ? h('div', { style: { minWidth: 0 } }, children) : null,
      )
    }

    function ProgressBar({ done, total }) {
      const pct = total > 0 ? Math.round((done / total) * 100) : 0
      return h(
        'div',
        { style: { height: '5px', borderRadius: '999px', background: T.bg2, overflow: 'hidden', margin: '2px 0 8px' } },
        h('div', {
          style: {
            width: `${Math.min(100, Math.max(0, pct))}%`,
            height: '100%',
            background: T.ok,
            borderRadius: '999px',
            transition: 'width .3s ease',
          },
        }),
      )
    }

    function TodoRow({ item }) {
      const status = item && item.status
      const icon = status === 'completed' ? '✓' : status === 'in_progress' ? '▶' : '○'
      const color = status === 'completed' ? T.ok : status === 'in_progress' ? T.warn : T.faint
      return h(
        'div',
        { style: rowStyle },
        h('span', { style: { color, flex: 'none', width: '12px', fontSize: '11px' } }, icon),
        h(
          'span',
          {
            style: {
              ...ellipsis,
              color: status === 'completed' ? T.faint : T.text,
              textDecoration: status === 'completed' ? 'line-through' : 'none',
            },
          },
          (item && item.content) || '',
        ),
      )
    }

    const LIST_HEIGHT = 190

    /**
     * Fixed-height list body shared by every section: all rows live inside the
     * same height and scroll vertically, so cards stay perfectly aligned and
     * expanding a row never grows the card.
     */
    function RowList({ items, t, emptyText, height = LIST_HEIGHT, renderRow }) {
      const [open, setOpen] = React.useState({})
      const toggle = (key) => setOpen((prev) => ({ ...prev, [key]: !prev[key] }))
      const frameStyle = {
        minWidth: 0,
        height: `${height}px`,
        overflowY: 'auto',
        overflowX: 'hidden',
        paddingRight: '2px',
      }
      if (!items.length) return h('div', { className: 'sd-list', style: { ...frameStyle, color: T.faint } }, emptyText)
      return h(
        'div',
        { className: 'sd-list', style: frameStyle },
        ...items.map((item, index) => {
          const key = item && item.key !== undefined ? item.key : index
          return h(
            'div',
            { key: `row-${key}`, style: { minWidth: 0 } },
            renderRow(item, open[key] === true, () => toggle(key), index),
          )
        }),
      )
    }

    /** Two-column label/value grid used by expanded row details. */
    function DetailGrid({ rows }) {
      const items = []
      let index = 0
      for (const row of rows) {
        if (!row) continue
        const [label, value] = row
        if (value === undefined || value === null || value === '') continue
        items.push(h('span', { key: `dl-${index}`, style: { color: T.faint, fontSize: '10px', whiteSpace: 'nowrap' } }, label))
        items.push(
          h(
            'span',
            { key: `dv-${index}`, style: { color: T.muted, fontSize: '10.5px', wordBreak: 'break-word', overflowWrap: 'anywhere' } },
            value,
          ),
        )
        index += 1
      }
      if (!items.length) return null
      return h(
        'div',
        { style: { display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', gap: '2px 8px', marginTop: '4px', alignItems: 'baseline' } },
        ...items,
      )
    }

    /** One expandable list row: title + meta + value, details under it. */
    function DataRow({ open, onToggle, color, title, meta, value, detail }) {
      return h(
        'div',
        { style: { borderTop: `1px dashed ${T.border}`, paddingTop: '5px', marginTop: '5px' } },
        h(
          'div',
          {
            role: 'button',
            tabIndex: 0,
            'aria-expanded': open,
            onClick: onToggle,
            className: 'sd-row',
            style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0, cursor: 'pointer', padding: '2px 5px', margin: '0 -5px' },
          },
          color ? h(StatusDot, { color }) : null,
          h('span', { style: { ...ellipsis, fontSize: '11px', fontWeight: 600 } }, title),
          meta ? h('span', { style: { ...ellipsis, color: T.muted, fontSize: '11px' } }, meta) : null,
          value !== undefined && value !== null
            ? h(
                'span',
                {
                  style: {
                    ...numStyle,
                    marginLeft: 'auto',
                    fontSize: '11px',
                    color: T.text,
                    flex: 'none',
                    maxWidth: '46%',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  },
                },
                value,
              )
            : null,
        ),
        open
          ? h(
              'div',
              { style: { color: T.muted, fontSize: '11px', marginTop: '3px', wordBreak: 'break-word', overflowWrap: 'anywhere' } },
              detail,
            )
          : null,
      )
    }

    function ChildRow({ child, open, onToggle, t }) {
      const modeKey = `child.mode.${child.mode || 'unknown'}`
      const mode = t(modeKey) === modeKey ? child.mode : t(modeKey)
      const status = child.running ? t('status.running') : child.settledAt ? t('status.settled') : ''
      const color = child.running ? T.ok : child.settledAt ? T.faint : T.warn
      return h(
        'div',
        { style: { borderTop: `1px dashed ${T.border}`, paddingTop: '5px', marginTop: '5px' } },
        h(
          'div',
          {
            style: { ...rowStyle, cursor: 'pointer', alignItems: 'center', padding: '2px 5px', margin: '0 -5px' },
            role: 'button',
            tabIndex: 0,
            'aria-expanded': open,
            onClick: onToggle,
            className: 'sd-row',
          },
          h(StatusDot, { color, pulse: child.running }),
          h('span', { style: { ...ellipsis, fontWeight: 600, fontSize: '11px' } }, child.label || child.id.slice(0, 8)),
          h('span', { style: { ...chipStyle, marginLeft: 'auto' } }, mode),
          h('span', { style: { ...numStyle, marginLeft: '6px', fontSize: '10px' } }, fmtTokens(child.tokens && child.tokens.total)),
        ),
        open
          ? h(
              'div',
              { style: { marginTop: '2px' } },
              h(DetailGrid, {
                rows: [
                  [t('detail.mode'), mode],
                  [t('detail.status'), status || '—'],
                  [
                    t('detail.tokens'),
                    `${fmtTokens(child.tokens && child.tokens.total)}（${t('tokens.input')} ${fmtTokens(child.tokens && child.tokens.input)} / ${t('tokens.output')} ${fmtTokens(child.tokens && child.tokens.output)}）`,
                  ],
                  [t('detail.steps'), String((child.stats && child.stats.steps) ?? 0)],
                  [t('detail.messages'), String(child.messages ?? 0)],
                  [t('detail.created'), child.createdAt ? fmtDateTime(child.createdAt) : '—'],
                  [t('detail.settled'), child.settledAt ? fmtDateTime(child.settledAt) : child.running ? '…' : '—'],
                  [t('detail.duration'), child.createdAt && child.settledAt ? fmtMs(child.settledAt - child.createdAt) : '—'],
                  [t('detail.sessionId'), child.id || '—'],
                  [t('detail.lastMessage'), child.lastMessage || '—'],
                ],
              }),
            )
          : null,
      )
    }

    function JobRow({ job, open, onToggle, t }) {
      const failed = job.status === 'failed' || job.status === 'error'
      const running = job.status === 'running'
      const color = running ? T.warn : failed ? T.err : T.ok
      const statusKey = `job.status.${job.status || 'completed'}`
      const status = t(statusKey) === statusKey ? job.status || '' : t(statusKey)
      return h(
        'div',
        { style: { borderTop: `1px dashed ${T.border}`, paddingTop: '5px', marginTop: '5px' } },
        h(
          'div',
          {
            style: { ...rowStyle, cursor: 'pointer', alignItems: 'center', padding: '2px 5px', margin: '0 -5px' },
            role: 'button',
            tabIndex: 0,
            'aria-expanded': open,
            onClick: onToggle,
            className: 'sd-row',
          },
          h(StatusDot, { color, pulse: running }),
          h(
            'span',
            {
              style: {
                ...ellipsis,
                fontFamily: 'var(--ds-font-family-code, ui-monospace, monospace)',
                fontSize: '11px',
                flex: 'none',
              },
            },
            job.kind || 'job',
          ),
          h('span', { style: { ...ellipsis, color: T.muted, fontSize: '11px' }, title: job.label }, job.label || ''),
          h(
            'span',
            { style: { ...numStyle, marginLeft: 'auto', fontSize: '10px', flex: 'none' } },
            job.durationMs ? fmtMs(job.durationMs) : '',
          ),
          h('span', { style: { ...chipStyle, color, flex: 'none' } }, status),
        ),
        open
          ? h(
              'div',
              { style: { marginTop: '2px' } },
              job.label
                ? h(
                    'div',
                    { style: { color: T.muted, fontSize: '10.5px', marginTop: '3px', wordBreak: 'break-word', overflowWrap: 'anywhere' } },
                    h('span', { style: { color: T.faint } }, `${t('detail.command')}: `),
                    job.label,
                  )
                : null,
              h(DetailGrid, {
                rows: [
                  [t('detail.kind'), job.kind || '—'],
                  [t('detail.status'), status],
                  [t('detail.duration'), job.durationMs !== undefined ? fmtMs(job.durationMs) : '—'],
                  [t('detail.started'), job.startedAt ? fmtDateTime(job.startedAt) : '—'],
                  [t('detail.finished'), job.finishedAt ? fmtDateTime(job.finishedAt) : '…'],
                  [t('detail.exit'), job.detail || '—'],
                  [t('detail.jobId'), job.jobId || '—'],
                  [t('detail.sessionId'), job.owner || '—'],
                ],
              }),
            )
          : null,
      )
    }

    function TokenCells({ tokens, t }) {
      const cells = [
        [t('tokens.input'), tokens.input],
        [t('tokens.output'), tokens.output],
        [t('tokens.cacheRead'), tokens.cacheRead],
        [t('tokens.cacheWrite'), tokens.cacheWrite],
      ]
      return h(
        'div',
        null,
        h(
          'div',
          { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' } },
          ...cells.map(([label, value], index) =>
            h(
              'div',
              { key: `cell-${index}`, style: { background: T.bg2, borderRadius: '8px', padding: '6px 8px', minWidth: 0 } },
              h('div', { style: { color: T.faint, fontSize: '10px' } }, label),
              h('div', { style: { fontVariantNumeric: 'tabular-nums', fontWeight: 650 } }, fmtTokens(value)),
            ),
          ),
        ),
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'baseline',
              gap: '6px',
              marginTop: '8px',
              borderTop: `1px dashed ${T.border}`,
              paddingTop: '6px',
            },
          },
          h('span', { style: { color: T.faint, fontSize: '10px' } }, t('tokens.total')),
          h('span', { style: { fontVariantNumeric: 'tabular-nums', fontWeight: 700, marginLeft: 'auto' } }, fmtTokens(tokens.total)),
        ),
      )
    }

    function ContextBar({ pressure, t }) {
      if (!pressure || !pressure.contextWindow) return null
      const used = pressure.pressureTokens ?? pressure.projectedTokens
      if (typeof used !== 'number' || !Number.isFinite(used)) return null
      const pct = Math.min(100, Math.max(0, (used / pressure.contextWindow) * 100))
      const color = pct >= 85 ? T.err : pct >= 65 ? T.warn : A.tokens
      return h(
        'div',
        { style: { marginTop: '4px', minWidth: 0 } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', gap: '6px', marginBottom: '5px', minWidth: 0 } },
          h('span', { style: { color: T.faint, fontSize: '10px', flex: 'none' } }, t('context.usage')),
          h(
            'span',
            {
              style: {
                marginLeft: 'auto',
                fontVariantNumeric: 'tabular-nums',
                color: pct >= 65 ? color : T.muted,
                fontSize: '10px',
                fontWeight: pct >= 65 ? 650 : 400,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
            },
            `${fmtTokens(used)} / ${fmtTokens(pressure.contextWindow)} · ${pct.toFixed(1)}%`,
          ),
        ),
        h(
          'div',
          { className: 'sd-progress', style: { background: T.bg2 } },
          h('i', {
            style: {
              width: `${pct}%`,
              background: `linear-gradient(90deg, ${A.tokens}, ${color})`,
              color,
            },
          }),
        ),
      )
    }

    function StatRow({ label, value }) {
      const shown = value === undefined || value === null || value === '' ? '—' : value
      return h(
        'div',
        { style: { display: 'flex', alignItems: 'baseline', gap: '8px', padding: '1px 0' } },
        h('span', { style: { color: T.faint, fontSize: '11px' } }, label),
        h(
          'span',
          {
            style: {
              marginLeft: 'auto',
              textAlign: 'right',
              color: T.text,
              fontVariantNumeric: 'tabular-nums',
              fontWeight: 600,
            },
          },
          shown,
        ),
      )
    }

    function ToolRow({ tool, t }) {
      const color = tool.status === 'failed' ? T.err : tool.status === 'ok' ? T.ok : T.warn
      return h(
        'div',
        { style: { ...rowStyle, alignItems: 'center' } },
        h(StatusDot, { color }),
        h('span', { style: { ...ellipsis, fontFamily: 'var(--ds-font-family-code, ui-monospace, monospace)', fontSize: '11px' } }, tool.name),
        tool.label ? h('span', { style: { ...ellipsis, color: T.muted, fontSize: '11px' } }, tool.label) : null,
        h('span', { style: { ...numStyle, marginLeft: 'auto', fontSize: '10px' } }, fmtTime(tool.at)),
      )
    }

    function Panel({ sessionId, t }) {
      const [state, setState] = React.useState({ data: null, error: null })
      const [tick, setTick] = React.useState(0)
      const [prefs, setPrefs] = React.useState(loadPrefs)
      // Initial collapse state comes from the saved preferences (common sections open).
      const [collapsed, setCollapsed] = React.useState(() => {
        const initial = {}
        for (const section of SECTION_META) if (!prefs.open[section.key]) initial[section.key] = true
        return initial
      })
      const [settingsOpen, setSettingsOpen] = React.useState(false)
      const [dragSection, setDragSection] = React.useState(null)
      const [dragOverSection, setDragOverSection] = React.useState(null)
      const [wide, setWide] = React.useState(true)
      const rootRef = React.useRef(null)

      // Wide panes get a two-column card grid (paired sections), narrow panes a
      // single column. Measured on the panel itself so the sidebar width decides;
      // the threshold is the content box (padding excluded) needed for two usable
      // cards, and starts wide so the first paint already fills the pane.
      React.useEffect(() => {
        const element = rootRef.current
        if (!element || typeof ResizeObserver !== 'function') return undefined
        const observer = new ResizeObserver((entries) => {
          const entry = entries[0]
          const width = entry && entry.contentRect ? entry.contentRect.width : 0
          if (width > 0) setWide(width >= 500)
        })
        observer.observe(element)
        return () => observer.disconnect()
      }, [])

      React.useEffect(() => {
        if (!sessionId) return undefined
        let alive = true
        let timer = null

        const load = async () => {
          try {
            const response = await fetch(ROUTE, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId }),
            })
            const payload = await response.json()
            if (!alive) return
            if (payload && payload.ok) setState({ data: payload.value, error: null })
            else setState((prev) => ({ data: prev.data, error: (payload && payload.error && payload.error.message) || 'unknown error' }))
          } catch (error) {
            if (alive) setState((prev) => ({ data: prev.data, error: error instanceof Error ? error.message : String(error) }))
          }
          if (alive) timer = setTimeout(load, 2500)
        }
        load()
        return () => {
          alive = false
          if (timer) clearTimeout(timer)
        }
      }, [sessionId, tick])

      if (!sessionId) return h('div', { style: panelStyle }, h('div', { style: { color: T.muted } }, t('empty.session')))

      const data = state.data
      const tokens = (data && data.tokens) || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      const todos = (data && data.todos) || []
      const done = todos.filter((item) => item && item.status === 'completed').length
      const children = (data && data.children) || []
      const jobs = (data && data.jobs) || []
      const jobSummary = (data && data.jobSummary) || { total: jobs.length, running: 0, failed: 0 }
      const tools = (data && data.recentTools) || []
      const stats = (data && data.stats) || {}
      const preset = data && data.preset

      const isOpen = (key) => collapsed[key] !== true
      const toggle = (key) => setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }))
      const expandAll = () => setCollapsed({})
      const collapseAll = () =>
        setCollapsed({
          tokens: true,
          model: true,
          todos: true,
          tasks: true,
          tickets: true,
          toolStats: true,
          tools: true,
          errors: true,
          stats: true,
          skills: true,
          workspace: true,
          ranking: true,
          targets: true,
        })

      const applyPrefs = (next, options = {}) => {
        setPrefs(next)
        savePrefs(next)
        if (options.resetCollapsed === false) return
        const nextCollapsed = {}
        for (const section of SECTION_META) if (!next.open[section.key]) nextCollapsed[section.key] = true
        setCollapsed(nextCollapsed)
      }
      const toggleDefaultOpen = (key) =>
        applyPrefs({ ...prefs, open: { ...prefs.open, [key]: !prefs.open[key] } })
      const moveSection = (key, delta) => {
        const index = prefs.order.indexOf(key)
        const targetIndex = index + delta
        if (index < 0 || targetIndex < 0 || targetIndex >= prefs.order.length) return
        const order = prefs.order.slice()
        order[index] = order[targetIndex]
        order[targetIndex] = key
        applyPrefs({ ...prefs, order }, { resetCollapsed: false })
      }
      const reorderSections = (fromKey, toKey) => {
        if (!fromKey || !toKey || fromKey === toKey) return
        const order = prefs.order.slice()
        const from = order.indexOf(fromKey)
        const to = order.indexOf(toKey)
        if (from < 0 || to < 0) return
        order.splice(from, 1)
        order.splice(to, 0, fromKey)
        applyPrefs({ ...prefs, order }, { resetCollapsed: false })
      }
      const resetPrefs = () => applyPrefs(sanitizePrefs(undefined))
      // Open sections keep the configured order; collapsed ones sink to the bottom.
      const orderOf = (key) =>
        (prefs.open[key] ? 0 : 100) + Math.max(0, prefs.order.indexOf(key))

      // Clicking a KPI tile expands the target section, scrolls to it and flashes it.
      const focusSection = (key) => {
        setCollapsed((prev) => ({ ...prev, [key]: false }))
        const run = () => {
          const root = rootRef.current
          if (!root) return
          const target = root.querySelector(`[data-sd-section="${key}"]`)
          if (!target) return
          try {
            target.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
          } catch {
            try { target.scrollIntoView() } catch {}
          }
          target.classList.remove('sd-flash')
          void target.offsetWidth
          target.classList.add('sd-flash')
          setTimeout(() => {
            try { target.classList.remove('sd-flash') } catch {}
          }, 1700)
        }
        setTimeout(run, 60)
      }

      const taskChips = []
      if (children.length) taskChips.push(String(children.length))
      if (jobSummary.running) taskChips.push(`${jobSummary.running} ${t('jobs.running')}`)
      if (jobSummary.total) taskChips.push(`${jobSummary.total} ${t('jobs.total')}`)

      // Every section is the same fixed-height, scrollable, row-expandable list.
      const pressure = data && data.pressure
      const contextUsed = pressure ? (pressure.pressureTokens ?? pressure.projectedTokens) : undefined
      const contextPct =
        typeof contextUsed === 'number' && pressure && pressure.contextWindow
          ? Math.min(100, Math.max(0, (contextUsed / pressure.contextWindow) * 100))
          : undefined
      const modelInfo = (data && data.modelInfo) || {}
      const cache = (data && data.cache) || {}
      const permissions = (data && data.permissions) || {}
      const approvals = (data && data.approvals) || {}
      const retries = (data && data.retries) || { count: 0 }
      const errorRowsData = (data && data.errors) || []
      const toolStats = (data && data.toolStats) || []
      const skills = (data && data.skills) || []
      const workspace = (data && data.workspace) || {}
      const touchedFiles = (data && data.files) || []
      const compaction = (data && data.compaction) || { count: 0 }
      const goals = (data && data.goals) || []
      const schedules = (data && data.schedules) || []
      const tickets = (data && data.tickets) || []
      const breakdown = (data && data.breakdown) || {}
      const cacheHit = typeof cache.hitRate === 'number' ? `${(cache.hitRate * 100).toFixed(1)}%` : '—'

      const tokenRows = [
        { key: 'input', title: t('tokens.input'), value: fmtTokens(tokens.input), detail: `${t('tokens.input')}: ${tokens.input}` },
        { key: 'output', title: t('tokens.output'), value: fmtTokens(tokens.output), detail: `${t('tokens.output')}: ${tokens.output}` },
        { key: 'cacheRead', title: t('tokens.cacheRead'), value: fmtTokens(tokens.cacheRead), detail: `${t('tokens.cacheRead')}: ${tokens.cacheRead}` },
        { key: 'cacheWrite', title: t('tokens.cacheWrite'), value: fmtTokens(tokens.cacheWrite), detail: `${t('tokens.cacheWrite')}: ${tokens.cacheWrite}` },
        { key: 'total', title: t('tokens.total'), value: fmtTokens(tokens.total), detail: `${t('tokens.total')}: ${tokens.total}` },
        {
          key: 'context',
          title: t('context.usage'),
          value:
            typeof contextUsed === 'number' && pressure && pressure.contextWindow
              ? `${fmtTokens(contextUsed)} / ${fmtTokens(pressure.contextWindow)} · ${contextPct.toFixed(1)}%`
              : t('unavailable'),
          detail: h(ContextBar, { pressure: pressure, t }),
        },
      ]
      if (breakdown.systemTokens !== undefined || breakdown.toolsTokens !== undefined || breakdown.messageTokens !== undefined) {
        if (breakdown.systemTokens !== undefined) {
          tokenRows.push({ key: 'bdSystem', title: t('breakdown.system'), value: fmtTokens(breakdown.systemTokens), detail: `${t('breakdown.system')}: ${breakdown.systemTokens}` })
        }
        if (breakdown.toolsTokens !== undefined) {
          tokenRows.push({ key: 'bdTools', title: t('breakdown.tools'), value: fmtTokens(breakdown.toolsTokens), detail: `${t('breakdown.tools')}: ${breakdown.toolsTokens}` })
        }
        if (breakdown.messageTokens !== undefined) {
          tokenRows.push({ key: 'bdMessages', title: t('breakdown.messages'), value: fmtTokens(breakdown.messageTokens), detail: `${t('breakdown.messages')}: ${breakdown.messageTokens}` })
        }
      }

      const modelRows = []
      if (modelInfo.provider) modelRows.push({ key: 'provider', title: t('model.provider'), value: modelInfo.provider })
      if (modelInfo.name) modelRows.push({ key: 'name', title: t('model.name'), value: modelInfo.name })
      if (modelInfo.reasoningEffort) modelRows.push({ key: 'reasoning', title: t('model.reasoning'), value: modelInfo.reasoningEffort })
      if (modelInfo.contextWindow) modelRows.push({ key: 'window', title: t('model.window'), value: fmtTokens(modelInfo.contextWindow) })
      if (modelInfo.toolCount) {
        modelRows.push({
          key: 'tools',
          title: t('model.tools'),
          value: String(modelInfo.toolCount),
          detail: Array.isArray(modelInfo.mcpServers) && modelInfo.mcpServers.length ? `${t('model.mcp')}: ${modelInfo.mcpServers.join(', ')}` : '',
        })
      }
      modelRows.push({
        key: 'cacheHit',
        title: t('cache.hit'),
        value: cacheHit,
        detail: `${t('cache.read')}: ${fmtTokens(cache.read)} · ${t('cache.write')}: ${fmtTokens(cache.write)}`,
      })
      modelRows.push({ key: 'ttft', title: t('perf.ttft'), value: fmtMs(stats.ttftMs) })
      const decodeSpeed =
        typeof stats.decodeTokens === 'number' && typeof stats.decodeMs === 'number' && stats.decodeMs > 0
          ? `${Math.round((stats.decodeTokens / stats.decodeMs) * 1000)} tok/s`
          : undefined
      modelRows.push({ key: 'decode', title: t('perf.decode'), value: decodeSpeed || fmtMs(stats.decodeMs) })

      const statsRows = [
        { key: 'turns', title: t('stats.turns'), value: stats.turns ?? 0, detail: `${t('stats.turns')}: ${stats.turns ?? 0}` },
        { key: 'steps', title: t('stats.steps'), value: stats.steps ?? 0, detail: `${t('stats.steps')}: ${stats.steps ?? 0}` },
        { key: 'toolCalls', title: t('stats.toolCalls'), value: stats.toolCalls ?? 0, detail: `${t('stats.toolCalls')}: ${stats.toolCalls ?? 0}` },
        {
          key: 'llm',
          title: t('stats.llm'),
          value: fmtMs(stats.llmMs),
          detail: stats.llmMs !== undefined ? `${t('stats.llm')}: ${Math.round(stats.llmMs)} ms` : t('unavailable'),
        },
        {
          key: 'tool',
          title: t('stats.tool'),
          value: fmtMs(stats.toolMs),
          detail: stats.toolMs !== undefined ? `${t('stats.tool')}: ${Math.round(stats.toolMs)} ms` : t('unavailable'),
        },
      ]

      const toolStatRows = toolStats.map((row) => ({ key: row.name, row }))
      const errorRows = []
      if (retries.count > 0) {
        errorRows.push({
          key: 'retry',
          retry: true,
          title: fill(t('retry.summary'), { n: retries.count }),
          meta: retries.last && retries.last.code ? fill(t('retry.last'), { code: retries.last.code }) : '',
          detail: (retries.last && (retries.last.message || retries.last.code)) || '—',
        })
      }
      for (const [index, error] of errorRowsData.entries()) {
        errorRows.push({
          key: error.callId || `err-${index}`,
          error: true,
          title: error.name || 'tool',
          meta: fmtTime(error.at),
          detail: error.message,
        })
      }

      const skillRows = skills.map((skill) => ({ key: skill.name, skill }))
      const fileRows = []
      if (workspace.git) {
        fileRows.push({ key: 'branch', title: t('workspace.branch'), value: workspace.git.branch || '—' })
        fileRows.push({
          key: 'dirty',
          title: workspace.git.dirty ? fill(t('workspace.dirty'), { n: workspace.git.dirty }) : t('workspace.clean'),
          value: String(workspace.git.dirty ?? 0),
          detail: workspace.git.files && workspace.git.files.length ? workspace.git.files.join('\n') : '',
        })
      } else if (workspace.cwd) {
        fileRows.push({ key: 'git', title: t('workspace.notGit'), value: '—' })
      }
      if (workspace.cwd) fileRows.push({ key: 'cwd', title: t('workspace.cwd'), value: '', detail: workspace.cwd })
      for (const file of touchedFiles) {
        fileRows.push({
          key: file.path,
          file: true,
          title: file.path,
          value: fill(t('files.touches'), { n: file.count }),
          detail: `${file.path} · ${fmtTime(file.at)}`,
        })
      }

      const rankRows = [...children]
        .sort((a, b) => ((b.tokens && b.tokens.total) || 0) - ((a.tokens && a.tokens.total) || 0))
        .map((child) => ({ key: child.id, child }))

      const targetRows = []
      for (const goal of goals) {
        targetRows.push({
          key: `goal-${goal.id}`,
          kind: 'goal',
          title: goal.title || goal.id,
          value: goal.status || '',
          detail: goal.progress !== undefined ? `${goal.progress}%` : goal.status || '',
        })
      }
      for (const schedule of schedules) {
        targetRows.push({
          key: `schedule-${schedule.id}`,
          kind: 'schedule',
          title: schedule.title || schedule.id,
          value: schedule.status || '',
          detail: schedule.nextAt ? fmtTime(schedule.nextAt) : '',
        })
      }
      for (const approval of approvals.pending || []) {
        targetRows.push({
          key: `approval-${approval.id}`,
          kind: 'approval',
          title: fill(t('approval.pending'), { tool: approval.toolName || 'tool' }),
          value: fmtTime(approval.at),
          detail: approval.reason || '',
        })
      }
      targetRows.push({
        key: 'compaction',
        kind: 'compaction',
        title: fill(t('compaction.summary'), { n: compaction.count || 0 }),
        value: compaction.prunedTokens ? fill(t('compaction.pruned'), { n: fmtTokens(compaction.prunedTokens) }) : '',
        detail: compaction.lastSummary || t('compaction.none'),
      })
      // Only surface the aggregate row when there is something to show.
      if (!compaction.count && !compaction.prunedTokens && !compaction.lastSummary) targetRows.pop()

      // Empty optional sections are hidden instead of painting blank cards.
      const sectionHidden = {
        tickets: tickets.length === 0,
        toolStats: toolStats.length === 0,
        errors: errorRows.length === 0,
        skills: skills.length === 0,
        workspace: fileRows.length === 0,
        ranking: rankRows.length < 2,
        targets: targetRows.length === 0,
      }

      const todoStatus = (status) => {
        const key = `todo.status.${status || 'pending'}`
        const label = t(key)
        return label === key ? status || 'pending' : label
      }
      const toolStatus = (status) => {
        const key = `status.${status === 'failed' ? 'failed' : status === 'ok' ? 'ok' : 'running'}`
        const label = t(key)
        return label === key ? status || '' : label
      }

      // Header KPI tiles.
      const childrenRunning = children.filter((child) => child.running).length
      const permissionText =
        [permissions.preset, permissions.sandbox, permissions.approvalPolicy].filter(Boolean).join(' · ') || '—'
      const headerButton = (label, onClick, icon, accent = A.brand) =>
        h(
          'button',
          {
            type: 'button',
            onClick,
            className: 'sd-btn',
            title: label,
            style: {
              ...smallButtonStyle,
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              padding: '0 7px',
              borderColor: tint(accent, 0.42),
              background: tint(accent, 0.1),
              color: T.muted,
            },
          },
          h(Icon, { name: icon, size: 11, color: accent }),
          h('span', { style: { fontSize: '10px' } }, label),
        )

      return h(
        'div',
        {
          ref: rootRef,
          className: 'sd-panel',
          style: {
            ...panelStyle,
            display: 'grid',
            gridTemplateColumns: wide ? 'minmax(0, 1fr) minmax(0, 1fr)' : 'minmax(0, 1fr)',
            alignItems: 'stretch',
          },
        },
        h('style', { key: 'sd-css' }, PANEL_CSS),
        state.error
          ? h(
              'div',
              {
                style: {
                  gridColumn: '1 / -1',
                  border: `1px solid ${T.err}`,
                  borderRadius: '8px',
                  padding: '6px 9px',
                  color: T.err,
                  fontSize: '11px',
                  background: T.bg2,
                },
              },
              fill(t('state.error'), { message: state.error }),
            )
          : null,

        // Header card: gradient hero with KPI tiles
        h(
          'div',
          {
            className: 'sd-card',
            style: {
              ...cardStyle,
              order: -1,
              gridColumn: '1 / -1',
              borderColor: tint(A.brand, 0.34),
              background: `linear-gradient(130deg, ${tint(A.brand, 0.22)} 0%, ${tint(A.brand, 0.05)} 42%, ${T.bg1} 100%)`,
              padding: '12px 14px',
            },
          },
          h('div', {
            style: {
              position: 'absolute',
              left: 0,
              right: 0,
              top: 0,
              height: '2px',
              background: `linear-gradient(90deg, ${A.brand}, ${tint(A.brand, 0.05)})`,
            },
          }),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '7px', minWidth: 0 } },
            h(StatusDot, { color: data && data.running ? T.ok : T.faint, pulse: data && data.running }),
            h(
              'span',
              { style: { ...ellipsis, flex: '1 1 auto', fontWeight: 700, fontSize: '14px', letterSpacing: '.01em' } },
              (data && data.title) || t('state.awaiting'),
            ),
            h(
              'span',
              { style: { marginLeft: 'auto', display: 'inline-flex', gap: '4px', flex: 'none' } },
              headerButton(t('settings'), () => setSettingsOpen((value) => !value), 'gear', A.model),
              headerButton(t('expandAll'), expandAll, 'expand', A.perf),
              headerButton(t('collapseAll'), collapseAll, 'collapse', A.tasks),
              headerButton(t('refresh'), () => setTick((value) => value + 1), 'refresh', A.tools),
            ),
          ),
          h(
            'div',
            { style: { display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '7px' } },
            preset
              ? h(Pill, {
                  icon: 'layers',
                  label: preset,
                  accent: preset === 'smart-dev' ? A.perf : A.brand,
                  strong: preset === 'smart-dev',
                  title: `${t('badge.preset')}: ${preset}`,
                })
              : null,
            data && data.model
              ? h(Pill, { icon: 'cpu', label: data.model, accent: A.model, title: `${t('badge.model')}: ${data.model}` })
              : null,
            data && data.asOfSeq
              ? h(Pill, { icon: 'hash', label: `#${data.asOfSeq}`, accent: A.tools, title: t('badge.seq') })
              : null,
            h(Pill, {
              icon: 'shield',
              label: `${t('badge.permission')} ${permissionText}`,
              accent:
                permissions.sandbox === 'danger-full-access'
                  ? T.err
                  : permissions.approvalPolicy === 'ask' || permissions.approvalPolicy === 'never'
                    ? T.warn
                    : A.perf,
              title: `${t('badge.permission')}: ${permissionText}`,
            }),
            tickets.length
              ? h(Pill, {
                  icon: 'layers',
                  label: `${t('section.tickets')} ${tickets.length}`,
                  accent: A.targets,
                  title: t('help.tickets'),
                })
              : null,
          ),
          h(
            'div',
            {
              style: {
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(112px, 1fr))',
                gap: '6px',
                marginTop: '10px',
              },
            },
            h(MetricTile, {
              label: t('main.context'),
              value: contextPct !== undefined ? `${contextPct.toFixed(1)}%` : '—',
              sub:
                pressure && pressure.contextWindow
                  ? `${fmtTokens(contextUsed || 0)} / ${fmtTokens(pressure.contextWindow)}`
                  : t('unavailable'),
              accent: A.tokens,
              onClick: () => focusSection('tokens'),
              hint: `${t('main.context')} → ${t('section.tokens')}`,
            }),
            h(MetricTile, {
              label: t('main.tokens'),
              value: fmtTokens(tokens.total),
              sub: `${t('cache.hit')} ${cacheHit}`,
              accent: A.model,
              onClick: () => focusSection('tokens'),
              hint: `${t('main.tokens')} → ${t('section.tokens')}`,
            }),
            h(MetricTile, {
              label: t('main.children'),
              value: String(children.length),
              sub: childrenRunning ? `${childrenRunning} ${t('status.running')}` : '',
              accent: A.tasks,
              onClick: () => focusSection('tasks'),
              hint: `${t('main.children')} → ${t('section.tasks')}`,
            }),
            h(MetricTile, {
              label: t('main.failures'),
              value: String(errorRowsData.length),
              sub: retries.count ? fill(t('retry.summary'), { n: retries.count }) : '',
              accent: A.errors,
              onClick: errorRowsData.length || retries.count > 0 ? () => focusSection('errors') : undefined,
              hint: errorRowsData.length || retries.count > 0 ? `${t('main.failures')} → ${t('section.errors')}` : undefined,
            }),
          ),
          settingsOpen
            ? h(
                'div',
                {
                  style: {
                    position: 'absolute',
                    top: '38px',
                    right: '10px',
                    zIndex: 80,
                    width: '272px',
                    maxHeight: '332px',
                    overflowY: 'auto',
                    background: T.bg2,
                    border: `1px solid ${tint(A.brand, 0.5)}`,
                    borderRadius: '10px',
                    boxShadow: '0 12px 32px rgba(0,0,0,.45)',
                    padding: '8px',
                  },
                },
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' } },
                  h('span', { style: { fontWeight: 700, fontSize: '11px', color: T.text } }, t('settings.title')),
                  h('span', { style: { color: T.faint, fontSize: '9px' } }, t('settings.hint')),
                  h(
                    'button',
                    { type: 'button', onClick: resetPrefs, className: 'sd-btn', title: t('settings.reset'), style: { ...smallButtonStyle, marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: '4px' } },
                    h(Icon, { name: 'refresh', size: 10, color: A.brand }),
                    h('span', { style: { fontSize: '10px' } }, t('settings.reset')),
                  ),
                ),
                ...SECTION_META.map((section) => {
                  const opened = prefs.open[section.key] === true
                  const dragging = dragSection === section.key
                  const over = dragOverSection === section.key && dragSection !== section.key
                  return h(
                    'div',
                    {
                      key: section.key,
                      className: `sd-opt-row${dragging ? ' sd-opt-dragging' : ''}${over ? ' sd-drag-over' : ''}`,
                      draggable: true,
                      onDragStart: (event) => {
                        setDragSection(section.key)
                        try {
                          event.dataTransfer.effectAllowed = 'move'
                          event.dataTransfer.setData('text/plain', section.key)
                        } catch {
                          // dataTransfer is best-effort
                        }
                      },
                      onDragOver: (event) => {
                        event.preventDefault()
                        try {
                          event.dataTransfer.dropEffect = 'move'
                        } catch {
                          // dataTransfer is best-effort
                        }
                        if (dragOverSection !== section.key) setDragOverSection(section.key)
                      },
                      onDragLeave: () => setDragOverSection((prev) => (prev === section.key ? null : prev)),
                      onDrop: (event) => {
                        event.preventDefault()
                        let fromKey = dragSection
                        if (!fromKey) {
                          try {
                            fromKey = event.dataTransfer.getData('text/plain')
                          } catch {
                            fromKey = null
                          }
                        }
                        reorderSections(fromKey, section.key)
                        setDragSection(null)
                        setDragOverSection(null)
                      },
                      onDragEnd: () => {
                        setDragSection(null)
                        setDragOverSection(null)
                      },
                      style: {
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        padding: '3px 2px',
                        borderTop: `1px dashed ${T.border}`,
                        cursor: 'grab',
                      },
                    },
                    h(
                      'span',
                      {
                        className: 'sd-grip',
                        title: t('settings.drag'),
                        style: {
                          display: 'grid',
                          gridTemplateColumns: '2px 2px',
                          gridAutoRows: '2px',
                          gap: '2px',
                          flex: 'none',
                          marginRight: '2px',
                        },
                      },
                      ...Array.from({ length: 6 }, (_, index) =>
                        h('span', {
                          key: `dot-${index}`,
                          style: { width: '2px', height: '2px', borderRadius: '50%', background: T.faint },
                        }),
                      ),
                    ),
                    h('span', { style: { ...ellipsis, flex: '1 1 auto', minWidth: 0, fontSize: '11px', color: T.text } }, t(section.titleKey)),
                    h(
                      'span',
                      { className: 'sd-opt-arrows', style: { display: 'inline-flex', gap: '2px', flex: 'none' } },
                      h(
                        'button',
                        {
                          type: 'button',
                          title: t('settings.up'),
                          onClick: () => moveSection(section.key, -1),
                          className: 'sd-btn',
                          style: { ...smallButtonStyle, width: '18px', height: '18px', padding: 0, borderColor: 'transparent', background: 'transparent' },
                        },
                        h(Icon, { name: 'up', size: 10, color: T.muted }),
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          title: t('settings.down'),
                          onClick: () => moveSection(section.key, 1),
                          className: 'sd-btn',
                          style: { ...smallButtonStyle, width: '18px', height: '18px', padding: 0, borderColor: 'transparent', background: 'transparent' },
                        },
                        h(Icon, { name: 'down', size: 10, color: T.muted }),
                      ),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        onClick: () => toggleDefaultOpen(section.key),
                        className: 'sd-btn',
                        'aria-pressed': opened,
                        title: opened ? t('settings.openOn') : t('settings.openOff'),
                        style: {
                          ...smallButtonStyle,
                          minWidth: '40px',
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: '3px',
                          color: opened ? T.ok : T.muted,
                          borderColor: opened ? tint(A.perf, 0.5) : T.border,
                          background: opened ? tint(A.perf, 0.1) : 'transparent',
                        },
                      },
                      h('span', {
                        style: {
                          width: '5px',
                          height: '5px',
                          borderRadius: '50%',
                          background: opened ? T.ok : T.faint,
                          flex: 'none',
                        },
                      }),
                      opened ? t('settings.openOn') : t('settings.openOff'),
                    ),
                  )
                }),
                h(
                  'div',
                  { style: { color: T.faint, fontSize: '9px', marginTop: '6px', lineHeight: 1.5 } },
                  t('settings.note'),
                ),
              )
            : null,
        ),

        // Tokens & context | Model & cache
        h(
          SectionCard,
          {
            title: t('section.tokens'),
            open: isOpen('tokens'),
            onToggle: () => toggle('tokens'),
            help: t('help.tokens'),
            order: orderOf('tokens'),
            sectionKey: 'tokens',
            accent: A.tokens,
            chips: [fmtTokens(tokens.total)],
          },
          h(RowList, {
            items: tokenRows,
            t,
            emptyText: t('unavailable'),
            height: 190,
            renderRow: (row, open, onToggle) =>
              h(DataRow, {
                key: row.key,
                open,
                onToggle,
                title: row.title,
                value: row.value,
                detail: row.detail,
              }),
          }),
        ),
        h(
          SectionCard,
          {
            title: t('section.model'),
            open: isOpen('model'),
            onToggle: () => toggle('model'),
            help: t('help.model'),
            order: orderOf('model'),
            sectionKey: 'model',
            accent: A.model,
            chips: [modelInfo.name || '—'],
          },
          h(RowList, {
            items: modelRows,
            t,
            emptyText: t('empty.model'),
            height: 190,
            renderRow: (row, open, onToggle) =>
              h(DataRow, { key: row.key, open, onToggle, title: row.title, value: row.value, detail: row.detail }),
          }),
        ),

        // Tickets | Task manager
        h(
          SectionCard,
          {
            title: t('section.todos'),
            chips: todos.length ? [fill(t('progress'), { done, total: todos.length })] : [],
            open: isOpen('todos'),
            onToggle: () => toggle('todos'),
            help: t('help.todos'),
            order: orderOf('todos'),
            sectionKey: 'todos',
            accent: A.plan,
          },
          h(RowList, {
            items: todos.map((item, index) => ({ key: `todo-${index}`, item })),
            t,
            emptyText: t('empty.todos'),
            height: 190,
            renderRow: (row, open, onToggle) => {
              const item = row.item || {}
              const status = item.status || 'pending'
              const color = status === 'completed' ? T.ok : status === 'in_progress' ? T.warn : T.faint
              return h(DataRow, {
                key: row.key,
                open,
                onToggle,
                color,
                title: item.content || '—',
                meta: todoStatus(status),
                detail: h(
                  'div',
                  null,
                  h('div', { style: { color: T.text } }, item.content || ''),
                  h('div', { style: { color: T.faint, marginTop: '2px' } }, todoStatus(status)),
                ),
              })
            },
          }),
        ),
        h(
          SectionCard,
          {
            title: t('section.tasks'),
            chips: taskChips,
            open: isOpen('tasks'),
            onToggle: () => toggle('tasks'),
            help: t('help.tasks'),
            order: orderOf('tasks'),
            sectionKey: 'tasks',
            accent: A.tasks,
          },
          h(RowList, {
            items: [
              ...children.map((child) => ({ key: `child-${child.id}`, kind: 'child', child })),
              ...jobs.map((job, index) => ({ key: `job-${job.jobId || index}`, kind: 'job', job })),
            ],
            t,
            emptyText: t('empty.tasks'),
            height: 190,
            renderRow: (row, open, onToggle) =>
              row.kind === 'child'
                ? h(ChildRow, { key: row.key, child: row.child, t, open, onToggle })
                : h(JobRow, { key: row.key, job: row.job, t, open, onToggle }),
          }),
        ),

        // Worktree ticket channel (superagent bundle, optional)
        h(
          SectionCard,
          {
            title: t('section.tickets'),
            chips: tickets.length ? [String(tickets.length)] : [],
            open: isOpen('tickets'),
            onToggle: () => toggle('tickets'),
            help: t('help.tickets'),
            order: orderOf('tickets'),
            sectionKey: 'tickets',
            hidden: sectionHidden.tickets,
            accent: A.targets,
          },
          h(RowList, {
            items: tickets.map((ticket, index) => ({ key: ticket.id || `ticket-${index}`, ticket })),
            t,
            emptyText: t('empty.tickets'),
            height: 190,
            renderRow: (row, open, onToggle) => {
              const ticket = row.ticket || {}
              const summary = ticket.summary || ''
              const color = /失败|failed/i.test(summary)
                ? T.err
                : /阻塞|blocked/i.test(summary)
                  ? T.warn
                  : /执行中|working/i.test(summary)
                    ? T.ok
                    : A.targets
              return h(DataRow, {
                key: row.key,
                open,
                onToggle,
                color,
                title: summary,
                meta: ticket.id ? ticket.id.slice(0, 8) : '',
                detail: h(
                  'div',
                  { style: { marginTop: '2px' } },
                  h(DetailGrid, {
                    rows: [
                      [t('detail.jobId'), ticket.id || '—'],
                      [t('detail.worktree'), '见状态文本'],
                    ],
                  }),
                  ticket.detail
                    ? h(
                        'div',
                        {
                          style: {
                            color: T.muted,
                            fontSize: '10.5px',
                            marginTop: '3px',
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                            overflowWrap: 'anywhere',
                          },
                        },
                        ticket.detail,
                      )
                    : null,
                ),
              })
            },
          }),
        ),

        // Tool distribution | Recent tools
        h(
          SectionCard,
          {
            title: t('section.toolStats'),
            chips: toolStats.length ? [String(toolStats.length)] : [],
            open: isOpen('toolStats'),
            onToggle: () => toggle('toolStats'),
            help: t('help.toolStats'),
            order: orderOf('toolStats'),
            sectionKey: 'toolStats',
            hidden: sectionHidden.toolStats,
            accent: A.tools,
          },
          h(RowList, {
            items: toolStatRows,
            t,
            emptyText: t('empty.toolStats'),
            height: 190,
            renderRow: (row, open, onToggle) => {
              const item = row.row || {}
              return h(DataRow, {
                key: row.key,
                open,
                onToggle,
                color: item.failed ? T.err : A.tools,
                title: item.name,
                meta: fill(t('toolstat.calls'), { n: item.calls }),
                value: item.avgMs !== undefined ? fill(t('toolstat.avg'), { ms: fmtMs(item.avgMs) }) : '',
                detail: h(
                  'div',
                  null,
                  h('div', null, fill(t('toolstat.failed'), { n: item.failed })),
                  item.avgMs !== undefined
                    ? h('div', { style: { color: T.faint, marginTop: '2px' } }, fill(t('toolstat.avg'), { ms: fmtMs(item.avgMs) }))
                    : null,
                ),
              })
            },
          }),
        ),
        h(
          SectionCard,
          {
            title: t('section.tools'),
            chips: tools.length ? [String(tools.length)] : [],
            open: isOpen('tools'),
            onToggle: () => toggle('tools'),
            help: t('help.tools'),
            order: orderOf('tools'),
            sectionKey: 'tools',
            accent: A.tools,
          },
          h(RowList, {
            items: tools.map((tool, index) => ({ key: tool.callId || `tool-${index}`, tool })),
            t,
            emptyText: t('empty.tools'),
            height: 190,
            renderRow: (row, open, onToggle) => {
              const tool = row.tool || {}
              const failed = tool.status === 'failed'
              const ok = tool.status === 'ok'
              const color = failed ? T.err : ok ? T.ok : T.warn
              return h(DataRow, {
                key: row.key,
                open,
                onToggle,
                color,
                title: tool.name || 'tool',
                meta: tool.label || '',
                value: fmtTime(tool.at),
                detail: h(
                  'div',
                  { style: { marginTop: '2px' } },
                  h(DetailGrid, {
                    rows: [
                      [t('detail.status'), toolStatus(tool.status)],
                      [t('detail.duration'), tool.durationMs !== undefined ? fmtMs(tool.durationMs) : '—'],
                      [t('detail.turn'), tool.turn !== undefined ? String(tool.turn) : '—'],
                      [t('detail.step'), tool.step !== undefined ? String(tool.step) : '—'],
                      [t('detail.time'), tool.at ? fmtDateTime(tool.at) : '—'],
                      [t('detail.callId'), tool.callId || '—'],
                    ],
                  }),
                  tool.arguments
                    ? h(
                        'div',
                        { style: { color: T.muted, fontSize: '10.5px', marginTop: '4px', wordBreak: 'break-word', overflowWrap: 'anywhere' } },
                        h('span', { style: { color: T.faint } }, `${t('detail.arguments')}: `),
                        tool.arguments,
                      )
                    : null,
                  tool.error
                    ? h(
                        'div',
                        { style: { color: T.err, fontSize: '10.5px', marginTop: '3px', wordBreak: 'break-word', overflowWrap: 'anywhere' } },
                        h('span', { style: { color: T.faint } }, `${t('detail.error')}: `),
                        tool.error,
                      )
                    : tool.result
                      ? h(
                          'div',
                          { style: { color: T.muted, fontSize: '10.5px', marginTop: '3px', wordBreak: 'break-word', overflowWrap: 'anywhere' } },
                          h('span', { style: { color: T.faint } }, `${t('detail.result')}: `),
                          tool.result,
                        )
                      : null,
                ),
              })
            },
          }),
        ),

        // Failures & retries | Steps & timing
        h(
          SectionCard,
          {
            title: t('section.errors'),
            chips: errorRows.length ? [String(errorRows.length)] : [],
            open: isOpen('errors'),
            onToggle: () => toggle('errors'),
            help: t('help.errors'),
            order: orderOf('errors'),
            sectionKey: 'errors',
            hidden: sectionHidden.errors,
            accent: A.errors,
          },
          h(RowList, {
            items: errorRows,
            t,
            emptyText: t('empty.errors'),
            height: 190,
            renderRow: (row, open, onToggle) =>
              h(DataRow, {
                key: row.key,
                open,
                onToggle,
                color: row.retry ? T.warn : T.err,
                title: row.title || 'tool',
                meta: row.meta || '',
                detail: h(
                  'div',
                  null,
                  h('div', { style: { whiteSpace: 'pre-wrap' } }, row.detail || ''),
                  row.error && row.key
                    ? h('div', { style: { color: T.faint, marginTop: '2px' } }, `${t('detail.copyId')}: ${row.key}`)
                    : null,
                ),
              }),
          }),
        ),
        h(
          SectionCard,
          {
            title: t('section.steps'),
            open: isOpen('stats'),
            onToggle: () => toggle('stats'),
            help: t('help.stats'),
            order: orderOf('stats'),
            sectionKey: 'stats',
            accent: A.perf,
          },
          h(RowList, {
            items: statsRows,
            t,
            emptyText: t('unavailable'),
            height: 190,
            renderRow: (row, open, onToggle) =>
              h(DataRow, { key: row.key, open, onToggle, title: row.title, value: row.value, detail: row.detail }),
          }),
        ),

        // Skills | Workspace & changes
        h(
          SectionCard,
          {
            title: t('section.skills'),
            chips: skillRows.length ? [String(skillRows.length)] : [],
            open: isOpen('skills'),
            onToggle: () => toggle('skills'),
            help: t('help.skills'),
            order: orderOf('skills'),
            sectionKey: 'skills',
            hidden: sectionHidden.skills,
            accent: A.skills,
          },
          h(RowList, {
            items: skillRows,
            t,
            emptyText: t('empty.skills'),
            height: 190,
            renderRow: (row, open, onToggle) =>
              h(DataRow, {
                key: row.key,
                open,
                onToggle,
                color: A.skills,
                title: row.skill.name,
                value: fill(t('skills.uses'), { n: row.skill.count }),
                detail: row.skill.at ? fmtTime(row.skill.at) : '',
              }),
          }),
        ),
        h(
          SectionCard,
          {
            title: t('section.workspace'),
            open: isOpen('workspace'),
            onToggle: () => toggle('workspace'),
            help: t('help.workspace'),
            order: orderOf('workspace'),
            sectionKey: 'workspace',
            hidden: sectionHidden.workspace,
            accent: A.workspace,
            chips: workspace.git && workspace.git.dirty ? [fill(t('workspace.dirty'), { n: workspace.git.dirty })] : [],
          },
          h(RowList, {
            items: fileRows,
            t,
            emptyText: t('empty.files'),
            height: 190,
            renderRow: (row, open, onToggle) =>
              h(DataRow, {
                key: row.key,
                open,
                onToggle,
                color: row.key === 'dirty' && workspace.git && workspace.git.dirty ? T.warn : A.workspace,
                title: row.title,
                value: row.value,
                detail: row.detail || '',
              }),
          }),
        ),

        // Subagent spend | Goals, approvals & context
        h(
          SectionCard,
          {
            title: t('section.ranking'),
            chips: rankRows.length ? [String(rankRows.length)] : [],
            open: isOpen('ranking'),
            onToggle: () => toggle('ranking'),
            help: t('help.ranking'),
            order: orderOf('ranking'),
            sectionKey: 'ranking',
            hidden: sectionHidden.ranking,
            accent: A.tasks,
          },
          h(RowList, {
            items: rankRows,
            t,
            emptyText: t('empty.ranking'),
            height: 190,
            renderRow: (row, open, onToggle) => {
              const child = row.child || {}
              const total = (child.tokens && child.tokens.total) || 0
              return h(DataRow, {
                key: row.key,
                open,
                onToggle,
                color: A.tasks,
                title: child.label || child.id.slice(0, 8),
                value: fill(t('ranking.tokens'), { n: fmtTokens(total) }),
                meta: fill(t('ranking.steps'), { n: (child.stats && child.stats.steps) ?? 0 }),
                detail: h(
                  'div',
                  null,
                  h('div', null, fill(t('child.messages'), { n: child.messages ?? 0 })),
                  child.lastMessage ? h('div', { style: { color: T.faint, marginTop: '2px' } }, child.lastMessage) : null,
                ),
              })
            },
          }),
        ),
        h(
          SectionCard,
          {
            title: t('section.targets'),
            chips: targetRows.length ? [String(targetRows.length)] : [],
            open: isOpen('targets'),
            onToggle: () => toggle('targets'),
            help: t('help.targets'),
            order: orderOf('targets'),
            sectionKey: 'targets',
            hidden: sectionHidden.targets,
            accent: A.targets,
          },
          h(RowList, {
            items: targetRows,
            t,
            emptyText: t('empty.targets'),
            height: 190,
            renderRow: (row, open, onToggle) =>
              h(DataRow, {
                key: row.key,
                open,
                onToggle,
                color:
                  row.kind === 'approval'
                    ? T.warn
                    : row.kind === 'goal'
                      ? A.targets
                      : row.kind === 'schedule'
                        ? A.brand
                        : T.faint,
                title: row.title,
                value: row.value,
                meta: row.kind || '',
                detail: row.detail || '',
              }),
          }),
        ),

        h(
          'div',
          {
            style: {
              order: 2000,
              gridColumn: '1 / -1',
              color: T.faint,
              fontSize: '10px',
              display: 'flex',
              gap: '8px',
              justifyContent: 'space-between',
            },
          },
          h('span', null, t('footer.auto')),
          data && data.updatedAt ? h('span', null, fill(t('footer.updated'), { time: fmtTime(data.updatedAt) })) : null,
        ),
      )
    }

    /**
     * Optional enhancement: open the pane once per session when the session runs
     * the smart-dev preset. It observes the sidebar controller's on-screen-session
     * observable (`ctx.sidebarRight.mounted`) instead of registering into any
     * shared slot, and contains every failure so the tab type and pane keep
     * working when the enhancement cannot start.
     */
    function startAutoOpen(sidebarCtx, ctx) {
      const opened = new Set()
      const teamAttempted = new Set()
      let disposed = false
      let timer = null
      let unsubscribe = null

      const warn = (message, error) => {
        try {
          console.warn(`dsh-smart-dev-panel: ${message}`, error)
        } catch {
          // never let logging break the plugin
        }
      }

      const currentSession = () => {
        try {
          const mounted = sidebarCtx.sidebarRight && sidebarCtx.sidebarRight.mounted
          if (!mounted || typeof mounted.getSnapshot !== 'function') return undefined
          return mounted.getSnapshot() || undefined
        } catch (error) {
          warn('reading the on-screen session failed', error)
          return undefined
        }
      }

      const teamService = () => {
        try {
          const remote = ctx.get('remote')
          if (remote && remote.agentTeams && typeof remote.agentTeams.setEnabled === 'function') return remote.agentTeams
        } catch {
          // remote service is optional
        }
        try {
          const service = ctx.get('remote.agentTeams')
          if (service && typeof service.setEnabled === 'function') return service
        } catch {
          // nested remote service is optional
        }
        return undefined
      }
      const enableTeamMode = (sessionId) => {
        const service = teamService()
        if (!service) return
        try {
          Promise.resolve(service.setEnabled(sessionId, true))
            .then((response) => {
              if (response && response.ok === false) warn('team collaboration default failed', response.error?.message)
            })
            .catch((error) => warn('team collaboration default failed', error))
        } catch (error) {
          warn('team collaboration default failed', error)
        }
      }

      const maybeOpen = async () => {
        if (disposed) return
        try {
          const sessionId = currentSession()
          if (!sessionId) return
          const needTeam = !teamAttempted.has(sessionId)
          if (opened.has(sessionId) && !needTeam) return
          const response = await fetch(ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, light: true }),
          })
          const payload = await response.json()
          if (disposed) return
          if (!payload || payload.ok !== true || !payload.value || payload.value.smartDev !== true) return
          if (needTeam) {
            teamAttempted.add(sessionId)
            enableTeamMode(sessionId)
          }
          if (opened.has(sessionId)) return
          opened.add(sessionId)
          try {
            if (sidebarCtx.sidebarRight && typeof sidebarCtx.sidebarRight.openTab === 'function') {
              sidebarCtx.sidebarRight.openTab(NS)
            }
          } catch (error) {
            warn('opening the pane failed (continuing without auto-open)', error)
          }
        } catch (error) {
          warn('preset probe failed (continuing without auto-open)', error)
        }
      }

      try {
        const mounted = sidebarCtx.sidebarRight && sidebarCtx.sidebarRight.mounted
        if (mounted && typeof mounted.subscribe === 'function') {
          unsubscribe = mounted.subscribe(() => {
            void maybeOpen()
          })
        }
        void maybeOpen()
        timer = setInterval(() => {
          void maybeOpen()
        }, 5000)
      } catch (error) {
        warn('auto-open setup failed (pane stays available manually)', error)
      }

      return () => {
        disposed = true
        if (timer) {
          clearInterval(timer)
          timer = null
        }
        if (typeof unsubscribe === 'function') {
          try {
            unsubscribe()
          } catch (error) {
            warn('auto-open unsubscribe failed', error)
          }
        }
        unsubscribe = null
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const safe = (label, action) => {
          try {
            action()
          } catch (error) {
            try {
              console.warn(`dsh-smart-dev-panel: ${label} failed (feature skipped, others keep working)`, error)
            } catch {
              // logging must never break activation
            }
          }
        }

        safe('locale registration', () => ctx.effect(() => ctx.locale.register(NS, { zh, en }), `${NS}: dictionaries`))
        let t = (key) => key
        try {
          t = ctx.locale.bind(NS)
        } catch (error) {
          safe('locale binding', () => {
            throw error
          })
        }


        safe('optional sidebar services', () =>
          ctx.inject(['sidebarRight', 'sidebarRightTabs'], (sidebarCtx) => {
            // Core feature 1: the tab type and its guide entry.
            safe('tab type registration', () =>
              sidebarCtx.effect(
                () =>
                  sidebarCtx.sidebarRightTabs.register({
                    id: NS,
                    kind: NS,
                    title: () => t('tab.title'),
                    guide: [
                      {
                        order: 60,
                        title: () => t('guide.title'),
                        description: () => t('guide.description'),
                        icon: GuideIcon,
                      },
                    ],
                  }),
                `${NS}: sidebar tab type`,
              ),
            )

            // Core feature 2: the pane body.
            safe('pane registration', () =>
              sidebarCtx.effect(
                () =>
                  sidebarCtx.slots.inject('sidebar.right.pane.tab', () =>
                    sidebarCtx.slots.register(
                      { name: 'sidebar.right.pane.tab', key: NS, locale: NS },
                      Panel,
                    ),
                  ),
                `${NS}: sidebar pane`,
              ),
            )

            // Optional enhancement 3: auto-open. Takes no shared slot and is
            // fully contained, so a failure here cannot disable the features above.
            safe('auto-open watcher', () =>
              sidebarCtx.effect(() => startAutoOpen(sidebarCtx, ctx), `${NS}: auto-open watcher`),
            )
          }),
        )
      },
    }
  },
})
