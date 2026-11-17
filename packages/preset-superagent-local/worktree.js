import { execFile } from 'node:child_process'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

async function git(cwd, args, signal) {
  const hooks = process.platform === 'win32' ? 'NUL' : '/dev/null'
  const { stdout } = await run('git', ['-c', `core.hooksPath=${hooks}`, ...args], {
    cwd, signal, timeout: 90_000, windowsHide: true, encoding: 'utf8',
  })
  return stdout.trim()
}

export async function projectRoot(workspaceRegistry, agent, signal) {
  const cwd = workspaceRegistry.list().find(workspace => workspace.sessionIds.includes(agent.id))?.path
    ?? agent.session.header.cwd
  if (!cwd || !isAbsolute(cwd)) throw new Error('请先在 DSH 中打开一个本地 Git 工作区。')
  try {
    return await realpath(await git(cwd, ['rev-parse', '--show-toplevel'], signal))
  } catch (error) {
    signal?.throwIfAborted()
    throw new Error('当前工作区需要已初始化且可访问的 Git 仓库。', { cause: error })
  }
}

export async function snapshotBase(root, signal) {
  const commit = await git(root, ['rev-parse', '--verify', 'HEAD^{commit}'], signal)
  if (!/^[a-f\d]{40,64}$/.test(commit)) throw new Error('无法确定工单的 Git 基线提交。')
  return commit
}

export function worktreePath(stateDir, ticketId) {
  if (!/^[a-f\d]{32}$/.test(ticketId)) throw new Error('无效的工单 ID。')
  return join(stateDir, 'worktrees', ticketId)
}

export async function ensureWorktree(stateDir, ticketId, root, base, signal) {
  const destination = worktreePath(stateDir, ticketId)
  const parent = join(stateDir, 'worktrees')
  await mkdir(parent, { recursive: true })
  const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  const pathKey = path => resolve(path)
  const registered = (await git(root, ['worktree', 'list', '--porcelain', '-z'], signal))
    .split('\0').some(field => field.startsWith('worktree ') && samePath(pathKey(field.slice(9)), pathKey(destination)))
  if (registered) {
    const existing = await realpath(destination)
    const expected = join(await realpath(parent), ticketId)
    const worktree = await realpath(await git(existing, ['rev-parse', '--show-toplevel'], signal))
    if (!samePath(existing, expected) || !samePath(existing, worktree)) throw new Error('工单工作树路径已改变。')
    return existing
  }
  const existing = await lstat(destination).catch(error => {
    if (error.code !== 'ENOENT') throw error
  })
  if (existing) throw new Error('工单工作树路径已被占用。')
  await git(root, ['worktree', 'add', '--detach', '--', destination, base], signal)
  return realpath(destination)
}
