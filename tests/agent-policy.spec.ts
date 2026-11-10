import { expect, test } from '@playwright/test'
import { AgentRequestGate } from '../src/main/agent/request-gate'
import type { EditorContextSnapshot } from '../src/shared/agent'
import { COLLECTION_CHUNK_SIZE } from '../src/shared/contracts'
import { agentSignInUrl, latestAgentSignInUrl } from '../src/main/agent/sign-in-links'
import { agentInstructions, agentTools } from '../src/main/agent/policy'

const a = 'a'.repeat(64),
  b = 'b'.repeat(64),
  session = '00000000-0000-0000-0000-000000000001'
const snapshot = (): EditorContextSnapshot => ({
  workspace: 'editor',
  activePhotoId: a,
  selectedIds: [a],
  transient: { crop: false, saving: false },
})

test('managed assistant describes relative mask color without changing global white balance', () => {
  const instructions = agentInstructions(false)
  expect(instructions).toContain('color:{temperature,tint,saturation}')
  expect(instructions).toContain('integers -100 to +100, neutral 0')
  expect(instructions).toContain('Positive temperature warms; positive tint adds magenta')
  expect(instructions).toContain('not Kelvin or camera white balance')
  expect(instructions).toContain('Global white balance is unchanged')
  expect(instructions).not.toContain('local color/clarity/dehaze remain unavailable')
})

test('managed assistant routes requested export sharpening through existing tools and keeps native evidence limits', () => {
  const instructions = agentInstructions(false)
  expect(agentTools).toEqual(
    expect.arrayContaining([
      'irodori_get_export_capabilities',
      'irodori_get_export_preferences',
      'irodori_prepare_export',
      'irodori_get_output_proof',
      'irodori_start_export',
      'irodori_get_export_results',
    ]),
  )
  expect(instructions).toContain('use Standard as the starting point')
  expect(instructions).toContain('absent sharpening remains Off')
  expect(instructions).toContain('must not change detailSharpening or other photo edits')
  expect(instructions).toContain(
    'same explicit strength and other pixel options between proof and export',
  )
  expect(instructions).toContain('effective strength and operator version')
  expect(instructions).toContain(
    'cannot establish native sharpness, halos, noise or true HDR appearance',
  )
  expect(instructions).toContain("Custom export's Output preview at 100%")
  expect(instructions).toContain('existing application destination and authorization')
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

test('a pending inspection is copied into a turn and cannot be retargeted or mutated by navigation', async () => {
  const current = snapshot()
  current.inspection = {
    photoId: a,
    gridIdentity: 'grid-a',
    region: { units: 'pixels', gridIdentity: 'grid-a', x: 10, y: 20, width: 30, height: 40 },
  }
  const gate = new AgentRequestGate(
    async () => current,
    async () => 7,
    false,
  )
  const context = await gate.begin(session, 'region')
  current.inspection.region.x = 100
  current.activePhotoId = b
  expect(context.inspection?.region.x).toBe(10)
  context.inspection!.region.x = 999
  expect(gate.context().inspection?.region.x).toBe(10)
  expect(gate.context().inspection?.photoId).toBe(a)
})

test('object-selection proposals belong to their creating turn and are consumed by acceptance', async () => {
  let revision = 4
  const gate = new AgentRequestGate(
    async () => snapshot(),
    async () => revision,
    true,
  )
  const first = await gate.begin(session, 'selection-one')
  const oldProposal = '00000000-0000-0000-0000-000000000010'
  await gate.run(
    'irodori_create_object_selection',
    { requestId: first.requestId, photoId: a, expectedRevision: revision },
    async () => ({ id: oldProposal, photoId: a, revision }),
  )
  const second = await gate.begin(session, 'selection-two')
  let commits = 0
  await expect(
    gate.run(
      'irodori_accept_object_selection',
      {
        requestId: second.requestId,
        photoId: a,
        expectedRevision: revision,
        proposalId: oldProposal,
      },
      async () => {
        commits++
        return {}
      },
    ),
  ).rejects.toThrow('current request')
  const currentProposal = '00000000-0000-0000-0000-000000000011'
  await gate.run(
    'irodori_create_object_selection',
    { requestId: second.requestId, photoId: a, expectedRevision: revision },
    async () => ({ id: currentProposal, photoId: a, revision }),
  )
  await gate.run(
    'irodori_accept_object_selection',
    {
      requestId: second.requestId,
      photoId: a,
      expectedRevision: revision,
      proposalId: currentProposal,
    },
    async () => {
      commits++
      return { photoId: a, revision: ++revision }
    },
  )
  await expect(
    gate.run(
      'irodori_accept_object_selection',
      {
        requestId: second.requestId,
        photoId: a,
        expectedRevision: revision,
        proposalId: currentProposal,
      },
      async () => {
        commits++
        return {}
      },
    ),
  ).rejects.toThrow('current request')
  expect(commits).toBe(1)
})
