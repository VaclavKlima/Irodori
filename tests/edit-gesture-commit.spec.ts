import { expect, test } from '@playwright/test'
import { initialSettings, type EditState } from '../src/shared/edits'
import { neutralAdjustments, type AdjustmentParameters } from '../src/shared/adjustments'
import {
  EditGestureCommits,
  type EditGestureScope,
} from '../src/renderer/src/hooks/edit-gesture-commit'

function state(photoId = 'photo-a', revision = 4): EditState {
  return {
    photoId,
    revision,
    settings: initialSettings(),
    canUndo: true,
    canRedo: false,
  }
}
function fixture() {
  const commits = new EditGestureCommits(),
    scope: EditGestureScope = { photoId: 'photo-a', enabled: true },
    base = state(),
    parameters: AdjustmentParameters = {
      ...neutralAdjustments,
      exposureEv: 1.25,
      whiteBalance: { mode: 'custom', kelvin: 6500, tint: -7 },
    },
    next: EditState = {
      ...base,
      revision: base.revision + 1,
      settings: {
        ...base.settings,
        ...parameters,
        whiteBalance: structuredClone(parameters.whiteBalance!),
      },
    }
  commits.enter(scope)
  return { commits, scope, base, parameters, next }
}

test('a changed local write starts pending with immutable draft epoch, revision and final parameters', () => {
  const { commits, scope, base, parameters, next } = fixture()
  const commit = commits.begin(scope, base, 12, parameters)!
  expect(commits.snapshot).toEqual({
    scope,
    commit: {
      id: 1,
      photoId: base.photoId,
      fromEpoch: 12,
      baseRevision: 4,
      parameters,
      phase: 'pending',
      revision: null,
    },
  })
  expect(Object.isFrozen(commit)).toBe(true)
  expect(Object.isFrozen(commit.parameters)).toBe(true)
  expect(Object.isFrozen(commit.parameters.whiteBalance)).toBe(true)
  parameters.exposureEv = -3
  if (parameters.whiteBalance?.mode === 'custom') parameters.whiteBalance.kelvin = 2500
  expect(commit.parameters.exposureEv).toBe(1.25)
  expect(commit.parameters.whiteBalance).toEqual({ mode: 'custom', kelvin: 6500, tint: -7 })
  commits.succeeded(scope, commit.id, next)
  expect(commits.snapshot?.commit).toMatchObject({ phase: 'accepted', revision: 5, fromEpoch: 12 })
})

test('unchanged flushes allocate no token and duplicate flushes preserve the same bounded record', () => {
  const { commits, scope, base, parameters, next } = fixture()
  expect(commits.begin(scope, base, 12, base.settings)).toBeNull()
  expect(commits.snapshot).toBeNull()
  const commit = commits.begin(scope, base, 12, parameters)!
  const pending = commits.snapshot
  expect(commit.id).toBe(1)
  expect(commits.begin(scope, base, 12, parameters)).toBe(commit)
  expect(commits.snapshot).toBe(pending)
  commits.succeeded(scope, commit.id, next)
  const accepted = commits.snapshot
  expect(commits.begin(scope, base, 12, parameters)).toBe(accepted?.commit)
  expect(commits.begin(scope, next, 13, next.settings)).toBeNull()
  expect(commits.snapshot).toBe(accepted)
})

for (const refreshFirst of [true, false])
  test(`only the own reply accepts a local commit with refresh ${refreshFirst ? 'first' : 'second'}`, () => {
    const { commits, scope, base, parameters, next } = fixture()
    const commit = commits.begin(scope, base, 12, parameters)!
    if (refreshFirst) {
      const pending = commits.snapshot
      commits.observeRevision(base.photoId, next.revision)
      commits.observe(next)
      expect(commits.snapshot).toBe(pending)
      expect(commits.snapshot?.commit.phase).toBe('pending')
    }
    commits.succeeded(scope, commit.id, next)
    const accepted = commits.snapshot
    expect(accepted?.commit).toEqual({ ...commit, phase: 'accepted', revision: 5 })
    commits.observe(next)
    commits.succeeded(scope, commit.id, next)
    expect(commits.snapshot).toBe(accepted)
  })

test('matching external pixels and a failed own reply never manufacture acceptance', () => {
  const { commits, scope, base, parameters, next } = fixture()
  const commit = commits.begin(scope, base, 12, parameters)!
  commits.observe(next)
  expect(commits.snapshot?.commit.phase).toBe('pending')
  commits.failed(scope, commit.id)
  expect(commits.snapshot).toBeNull()
  commits.observe(next)
  commits.succeeded(scope, commit.id, next)
  expect(commits.snapshot).toBeNull()
})

test('a newer revision event invalidates immediately before its settings refresh arrives', () => {
  const { commits, scope, base, parameters, next } = fixture()
  const commit = commits.begin(scope, base, 12, parameters)!
  commits.observeRevision('another-photo', base.revision + 10)
  expect(commits.snapshot?.commit).toBe(commit)
  commits.observeRevision(base.photoId, base.revision + 2)
  expect(commits.snapshot).toBeNull()
  commits.succeeded(scope, commit.id, next)
  expect(commits.snapshot).toBeNull()
})

const conflictingSettings: [string, (next: EditState) => void][] = [
  ['exposure', (next) => (next.settings.exposureEv = 0.75)],
  ['contrast', (next) => next.settings.contrast++],
  ['highlights', (next) => next.settings.highlights++],
  ['shadows', (next) => next.settings.shadows++],
  ['whites', (next) => next.settings.whites++],
  ['blacks', (next) => next.settings.blacks++],
  [
    'white-balance temperature',
    (next) => {
      if (next.settings.whiteBalance.mode === 'custom') next.settings.whiteBalance.kelvin++
    },
  ],
  [
    'white-balance tint',
    (next) => {
      if (next.settings.whiteBalance.mode === 'custom') next.settings.whiteBalance.tint++
    },
  ],
  ['processing policy', (next) => (next.settings.processing = 'hdr-v1')],
  ['lens policy', (next) => (next.settings.lens.distortion = false)],
]
for (const [name, change] of conflictingSettings)
  test(`a conflicting ${name} refresh permanently invalidates a pending local commit`, () => {
    const { commits, scope, base, parameters, next } = fixture()
    const commit = commits.begin(scope, base, 12, parameters)!
    const conflicting = structuredClone(next)
    change(conflicting)
    commits.observe(conflicting)
    expect(commits.snapshot).toBeNull()
    commits.observe(next)
    commits.succeeded(scope, commit.id, next)
    expect(commits.snapshot).toBeNull()
  })

test('newer external settings invalidate accepted metadata even when numerical parameters repeat', () => {
  const { commits, scope, base, parameters, next } = fixture()
  const commit = commits.begin(scope, base, 12, parameters)!
  commits.succeeded(scope, commit.id, next)
  commits.observe({ ...next, revision: next.revision + 1 })
  expect(commits.snapshot).toBeNull()
  commits.succeeded(scope, commit.id, next)
  expect(commits.snapshot).toBeNull()
})

test('older observations and duplicate matching refreshes cannot erase or rebase accepted metadata', () => {
  const { commits, scope, base, parameters, next } = fixture()
  const commit = commits.begin(scope, base, 12, parameters)!
  commits.succeeded(scope, commit.id, next)
  const accepted = commits.snapshot
  commits.observe({ ...base, revision: base.revision - 1 })
  commits.observe(base)
  commits.observe(next)
  expect(commits.snapshot).toBe(accepted)
  expect(accepted?.commit).toMatchObject({ id: 1, fromEpoch: 12, baseRevision: 4, revision: 5 })
})

for (const phase of ['pending', 'accepted'])
  test(`invalidating ${phase} metadata also rejects queued changes and protects the next token`, () => {
    const { commits, scope, base, parameters, next } = fixture()
    const first = commits.begin(scope, base, 12, parameters)!
    if (phase === 'accepted') commits.succeeded(scope, first.id, next)
    const intent = commits.intentGeneration
    expect(commits.isActive(scope, intent)).toBe(true)
    commits.invalidate()
    expect(commits.isActive(scope, intent)).toBe(false)
    commits.succeeded(scope, first.id, next)
    expect(commits.snapshot).toBeNull()
    commits.observe(next)
    const second = commits.begin(scope, next, 13, { ...parameters, exposureEv: 2 })!
    const pending = commits.snapshot
    commits.failed(scope, first.id)
    commits.succeeded(scope, first.id, next)
    expect(commits.snapshot).toBe(pending)
    expect(second.id).toBeGreaterThan(first.id)
    commits.succeeded(scope, second.id, {
      ...next,
      revision: next.revision + 1,
      settings: { ...next.settings, exposureEv: 2 },
    })
    const accepted = commits.snapshot
    commits.failed(scope, first.id)
    commits.succeeded(scope, first.id, next)
    expect(commits.snapshot).toBe(accepted)
    expect(accepted?.commit.phase).toBe('accepted')
  })

for (const changedScope of ['photo', 'disabled cycle'])
  test(`${changedScope} replacement rejects old enabled-scope replies including an ABA return`, () => {
    const { commits, scope, base, parameters, next } = fixture()
    const first = commits.begin(scope, base, 12, parameters)!
    commits.leave(scope)
    const intermediate: EditGestureScope = {
      photoId: changedScope === 'photo' ? 'photo-b' : scope.photoId,
      enabled: changedScope === 'photo',
    }
    commits.enter(intermediate)
    expect(commits.begin(scope, base, 12, parameters)).toBeNull()
    if (!intermediate.enabled) expect(commits.begin(intermediate, base, 12, parameters)).toBeNull()
    const returned: EditGestureScope = { ...scope }
    commits.enter(returned)
    const second = commits.begin(returned, base, 14, parameters)!
    const pending = commits.snapshot
    commits.leave(scope)
    commits.succeeded(scope, first.id, next)
    commits.failed(scope, first.id)
    expect(commits.snapshot).toBe(pending)
    commits.succeeded(returned, second.id, next)
    expect(commits.snapshot?.commit).toMatchObject({
      id: second.id,
      phase: 'accepted',
      fromEpoch: 14,
    })
  })

for (const invalidReply of ['photo', 'revision', 'parameters'])
  test(`an own reply with mismatched ${invalidReply} cannot accept the pending token`, () => {
    const { commits, scope, base, parameters, next } = fixture()
    const commit = commits.begin(scope, base, 12, parameters)!
    const reply = structuredClone(next)
    if (invalidReply === 'photo') reply.photoId = 'photo-b'
    if (invalidReply === 'revision') reply.revision++
    if (invalidReply === 'parameters') reply.settings.whites++
    commits.succeeded(scope, commit.id, reply)
    expect(commits.snapshot).toBeNull()
  })
