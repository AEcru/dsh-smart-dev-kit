export const PRESET = 'superagent-local'
const LEGACY_WORKER = 'superagent-local-worker'

export async function migrateWorkerPreset(persistence, agents, id, signal) {
  signal.throwIfAborted()
  // Live Agents retain their mounted generation. Change the persisted binding once they are cold.
  if (agents.get(id)) return
  let handle
  try { handle = await persistence.open(id, 'write', { signal }) }
  catch (error) {
    if (error.name === 'SessionPersistenceNotFoundError') return
    throw error
  }
  try {
    let preset = handle.header.agentPreset
    let offset = 0
    for (;;) {
      const { events } = await handle.read(offset, 512, { signal })
      for (const event of events) {
        if (event.type === 'agent-preset/selected') preset = event.data.agentPreset
      }
      offset += events.length
      if (events.length < 512) break
    }
    if (preset === LEGACY_WORKER) {
      await handle.append([{ type: 'agent-preset/selected', seq: offset, time: Date.now(), data: { agentPreset: PRESET } }], { signal })
      await handle.flush()
    }
  } finally {
    await handle.close()
  }
}
