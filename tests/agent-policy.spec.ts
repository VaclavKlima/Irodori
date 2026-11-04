import { expect, test } from '@playwright/test'
import { AgentRequestGate } from '../src/main/agent/request-gate'
import type { EditorContextSnapshot } from '../src/shared/agent'
import { COLLECTION_CHUNK_SIZE } from '../src/shared/contracts'
import { agentSignInUrl, latestAgentSignInUrl } from '../src/main/agent/sign-in-links'

const a = 'a'.repeat(64),
  b = 'b'.repeat(64),
  session = '00000000-0000-0000-0000-000000000001'
const snapshot = (): EditorContextSnapshot => ({
  workspace: 'editor',
  activePhotoId: a,
  selectedIds: [a],
  transient: { crop: false, saving: false },
})

test('sign-in opens the exact OSC hyperlink and rejects reconstructed, duplicated and unrelated URLs', () => {
  const link =
    'https://auth.openai.com/oauth/authorize?client_id=fixture&state=fixture&code_challenge=fixture&redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback'
  const output = `\x1b]8;;${link}\x1b\\${link.slice(0, 90)}\x1b]8;;\x1b\\`
  expect(agentSignInUrl(link, output)).toBe(link)
  expect(latestAgentSignInUrl(output)).toBe(link)
  expect(() => agentSignInUrl(`${link}&client_id=duplicate`, output)).toThrow()
  for (const invalid of [
    'https://example.com/',
    'file:///etc/passwd',
    link.replace('127.0.0.1', 'example.com'),
    `${link}&client_id=duplicate`,
  ])
    expect(() => agentSignInUrl(invalid, `\x1b]8;;${invalid}\x1b\\`)).toThrow()
})

test('request targets and paged selection remain frozen after navigation, and unsupported tools cannot run', async () => {
  const current = snapshot()
  current.selectedIds = Array.from({ length: COLLECTION_CHUNK_SIZE + 3 }, (_, i) =>
    i.toString(16).padStart(64, '0'),
  )
  const gate = new AgentRequestGate(
    async () => current,
    async () => 7,
    true,
  )
  const context = await gate.begin(session, 'one')
  expect(context.selection).toHaveLength(COLLECTION_CHUNK_SIZE)
  expect(context.development).toBe(true)
  current.activePhotoId = b
  current.selectedIds = [b]
  current.workspace = 'library'
  expect(gate.context().active).toEqual({ photoId: a, revision: 7 })
  expect(gate.context(context.nextOffset!).selection).toHaveLength(3)
  let executed = false
  const execute = async () => {
    executed = true
    return {}
  }
  await expect(
    gate.run('irodori_update_edits', { requestId: context.requestId, photoId: b }, execute),
  ).rejects.toThrow('frozen targets')
  await expect(gate.run('exec_command', { requestId: context.requestId }, execute)).rejects.toThrow(
    'unavailable',
  )
  await expect(
    gate.run('irodori_get_edits', { requestId: 'old', photoId: a }, execute),
  ).rejects.toThrow('stale')
  expect(executed).toBe(false)
})

test('one revision refresh is allowed and a second manual conflict pauses without overwriting', async () => {
  let revision = 0
  const gate = new AgentRequestGate(
    async () => snapshot(),
    async () => revision,
    false,
  )
  const { requestId } = await gate.begin(session, 'one')
  const args = { requestId, photoId: a, expectedRevision: 0 }
  let writes = 0
  const update = async () => {
    writes++
    return { photoId: a, revision: ++revision }
  }
  revision++
  await expect(gate.run('irodori_update_edits', args, update)).rejects.toThrow('Refresh')
  await gate.run('irodori_get_edits', { requestId, photoId: a }, async () => ({
    photoId: a,
    revision,
  }))
  await gate.run('irodori_update_edits', { ...args, expectedRevision: 1 }, update)
  expect(writes).toBe(1)
  revision++
  await expect(
    gate.run('irodori_update_edits', { ...args, expectedRevision: 2 }, update),
  ).rejects.toThrow('Paused')
  await expect(
    gate.run('irodori_get_edits', { requestId, photoId: a }, async () => ({})),
  ).rejects.toThrow('paused')
  expect(writes).toBe(1)
})

test('conversation stop fences queued calls and drains accepted calls without cancelling accepted jobs', async () => {
  const gate = new AgentRequestGate(
    async () => snapshot(),
    async () => 0,
    false,
  )
  const { requestId } = await gate.begin(session, 'one')
  let settle!: () => void
  const entered = new Promise<void>((resolve) => {
    settle = resolve
  })
  const accepted = gate.run('irodori_get_edits', { requestId, photoId: a }, async () => {
    await entered
    return {}
  })
  await Promise.resolve()
  await Promise.resolve()
  gate.stop()
  let drained = false
  const draining = gate.drain().then(() => {
    drained = true
  })
  await Promise.resolve()
  expect(drained).toBe(false)
  await expect(gate.run('irodori_get_edits', { requestId }, async () => ({}))).rejects.toThrow(
    'stale',
  )
  settle()
  await accepted
  await draining
  expect(drained).toBe(true)
})

test('transient crop and ended turns refuse requests; preparations and tasks cannot cross ownership', async () => {
  const current = snapshot()
  const gate = new AgentRequestGate(
    async () => current,
    async () => 0,
    false,
  )
  current.transient.crop = true
  await expect(gate.begin(session, 'crop')).rejects.toThrow('crop')
  current.transient.crop = false
  const { requestId } = await gate.begin(session, 'first')
  expect(gate.context().development).toBe(false)
  await expect(
    gate.run(
      'irodori_start_export',
      { requestId, exportRequest: { preparationId: 'foreign' } },
      async () => ({}),
    ),
  ).rejects.toThrow('preparation')
  await expect(
    gate.run('irodori_cancel_task', { requestId, taskId: 'foreign' }, async () => ({})),
  ).rejects.toThrow('conversation')
  gate.end(session, 'earlier-turn')
  expect(gate.context().requestId).toBe(requestId)
  gate.end(session, 'first')
  expect(() => gate.context()).toThrow('trusted prompt')
  const next = await gate.begin(session, 'second')
  expect(next.requestId).not.toBe(requestId)
})
