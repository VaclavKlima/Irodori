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

test('managed assistant chooses a coherent fresh edit and asks before replacing an existing look', () => {
  const instructions = agentInstructions(false)
  expect(instructions).toContain('choose and apply a coherent natural or expressive direction')
  expect(instructions).toContain('strong artistic changes are welcome')
  expect(instructions).toContain('ask whether to refine the current look or create a new one')
  expect(instructions).toContain(
    'An explicit style change or precise follow-up already gives direction',
  )
  expect(instructions).toContain('Preserve unrelated settings and existing work')
})

test('managed assistant uses discoverable operator guidance and confirmed visual evidence', () => {
  const instructions = agentInstructions(false)
  expect(agentTools).toEqual(
    expect.arrayContaining([
      'irodori_get_editing_guidance',
      'irodori_get_photo_presentation_context',
      'irodori_get_mask_preview',
    ]),
  )
  expect(new Set(agentTools).size).toBe(agentTools.length)
  expect(instructions).toContain('Live capabilities and complete typed schemas are authoritative')
  expect(instructions).toContain('do not guess successive payload shapes')
  expect(instructions).toContain('coherent partial patches or mask-operation batches')
  expect(instructions).toContain('compare it with that captured starting image')
  expect(instructions).toContain('not a historical revision')
  expect(instructions).toContain(
    'native regions when judging noise, texture, sharpness, mask edges',
  )
  expect(instructions).toContain('never silently replace a stale region with the whole image')
})

test('managed assistant reviews subject readability, preserves lighting and justifies local edits and crops', () => {
  const instructions = agentInstructions(false)
  expect(instructions).toContain('At the intended viewing size, check important faces')
  expect(instructions).toContain('readable detail and subject separation')
  expect(instructions).toContain('Preserve the lighting mood and natural darkness')
  expect(instructions).toContain(
    'For an observed regional problem, prefer a justified local adjustment',
  )
  expect(instructions).toContain('Crop only for a clear compositional benefit')
  expect(instructions).toContain(
    'Before calling the edit finished, compare the confirmed result with the captured starting image',
  )
  expect(instructions).toContain('verify that the intended improvement is visible')
})

test('managed assistant respects actual SDR proofing, missing capabilities and production feature requests', () => {
  const instructions = agentInstructions(false)
  expect(instructions).toContain('An explicit SDR deliverable takes precedence')
  expect(instructions).toContain('use an actual SDR output proof')
  expect(instructions).toContain('preserving the HDR master and workspace preference')
  expect(instructions).toContain('SDR images of an HDR source remain SDR evidence')
  expect(instructions).toContain('Complete independent supported parts')
  expect(instructions).toContain('Make one concrete relevant feature request in this conversation')
  expect(instructions).toContain('including normal production use')
  expect(instructions).toContain('Do not substitute global changes for a requested spatial edit')
  expect(instructions).not.toContain('This is development mode')
  expect(agentInstructions(true)).toContain('This is development mode')
})

test('managed assistant keeps ownership, conflict, deletion and restricted-tool rules in standing instructions', () => {
  const instructions = agentInstructions(false)
  expect(instructions).toContain('fresh requestId and frozen editor context')
  expect(instructions).toContain('Pass that exact requestId to EVERY tool')
  expect(instructions).toContain("review and trust Irodori's hooks in /hooks")
  expect(instructions).toContain('refresh and retry at most once')
  expect(instructions).toContain('A second conflict requires pausing for the user')
  expect(instructions).toContain('Never change a crop while a transient crop session is open')
  expect(instructions).toContain('explicit user deletion request or a later in-Console agreement')
  expect(instructions).toContain('otherwise name it, ask and wait')
  expect(instructions).toContain(
    'Shell execution, file editing, web/browser/computer control, unrelated MCP servers, plugins and delegation are unavailable',
  )
  expect(instructions).toContain('never invent paths')
  expect(Buffer.byteLength(instructions, 'utf8')).toBeLessThan(8 * 1024)
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
