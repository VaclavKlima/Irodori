import { expect, test } from '@playwright/test'
import { neutralAdjustments, type AdjustmentParameters } from '../src/shared/adjustments'
import type { EditGestureCommit } from '../src/renderer/src/preview/edit-gesture'
import {
  HdrGestureHandoff,
  type HdrGestureEditing,
} from '../src/renderer/src/preview/hdr-gesture-handoff'
import { HdrEditQueue } from '../src/renderer/src/preview/hdr-edit-queue'

const context = 'source-a:hdr-p3:after:fit:1828x1004:ranges-off'
const parameters: AdjustmentParameters = { ...neutralAdjustments, exposureEv: 1.75 }
const pending: EditGestureCommit = {
  id: 1,
  photoId: 'photo-a',
  fromEpoch: 4,
  baseRevision: 8,
  parameters,
  phase: 'pending',
  revision: null,
}
const accepted: EditGestureCommit = { ...pending, phase: 'accepted', revision: 9 }

function fixture() {
  const handoff = new HdrGestureHandoff()
  let editing: HdrGestureEditing = {
    gesturing: false,
    epoch: 4,
    commit: null,
    confirmed: { revision: 8, settings: neutralAdjustments },
    context,
    nativePresented: true,
  }
  const update = (patch: Partial<HdrGestureEditing>) => {
    editing = { ...editing, ...patch }
    return handoff.update(editing)
  }
  update({})
  update({ gesturing: true })
  return { handoff, update }
}

test('pending own refresh holds canonical admission until the own reply and final feedback publication', () => {
  const { handoff, update } = fixture()
  expect(update({ commit: pending })).toBe(true)
  expect(handoff.plan(context, parameters)).toBe('feedback')
  handoff.queued('feedback', 1)
  expect(handoff.plan(context, parameters)).toBe('hold')
  // The event refresh wins the race against the held updateEdits reply.
  expect(update({ gesturing: false, epoch: 5, confirmed: null })).toBe(true)
  expect(handoff.authorize(1, 'refinement', context, parameters)).toBeNull()
  update({ confirmed: { revision: 9, settings: parameters } })
  expect(handoff.plan(context, parameters)).toBe('hold')
  expect(handoff.authorize(1, 'feedback', context, parameters)).toEqual({
    revision: null,
  })
  handoff.published(context, 4, parameters, true, { id: 1, stage: 'feedback', serial: 1 })
  expect(handoff.phase).toBe('awaiting-acceptance')
  expect(handoff.plan(context, parameters)).toBe('hold')
  update({ commit: accepted })
  expect(handoff.plan(context, parameters)).toBe('refinement')
  handoff.queued('refinement', 2)
  expect(handoff.authorize(1, 'refinement', context, parameters)).toEqual({ revision: 9 })
  handoff.published(context, 5, parameters, false, { id: 1, stage: 'refinement', serial: 2 })
  expect(handoff.phase).toBe('complete')
  expect(handoff.pending).toBe(false)
  expect(handoff.plan(context, parameters)).toBe('hold')
})

test('confirmation-gap queue invalidation before pending metadata arrives preserves the observed draft', () => {
  const { handoff, update } = fixture()
  // PhotoPreview updates cache confirmation before forwarding the new editing props.
  handoff.invalidateQueued()
  expect(update({ gesturing: false, epoch: 5, commit: pending, confirmed: null })).toBe(true)
  expect(handoff.plan(context, parameters)).toBe('feedback')
  expect(handoff.authorize(1, 'refinement', context, parameters)).toBeNull()
})

test('accepted unseen final input has two ordered stages in the existing one-latest queue', () => {
  const { handoff, update } = fixture(),
    queue = new HdrEditQueue<string>()
  expect(
    update({
      gesturing: false,
      epoch: 5,
      commit: accepted,
      confirmed: { revision: 9, settings: parameters },
    }),
  ).toBe(true)
  expect(handoff.plan(context, parameters)).toBe('feedback')
  handoff.queued('feedback', 1)
  queue.request('final-f32', 'interactive')
  const feedback = queue.take()!
  expect(handoff.plan(context, parameters)).toBe('hold')
  expect(queue.hasPending).toBe(false)
  expect(queue.finish(feedback)).toBe(true)
  handoff.published(context, 5, parameters, true, { id: 1, stage: 'feedback', serial: 1 })
  expect(handoff.plan(context, parameters)).toBe('refinement')
  handoff.queued('refinement', 2)
  queue.request('same-final-reference', 'refinement')
  const refinement = queue.take()!
  expect(refinement.value).toBe('same-final-reference')
  expect(handoff.plan(context, parameters)).toBe('hold')
  expect(queue.finish(refinement)).toBe(true)
  handoff.published(context, 5, parameters, false, { id: 1, stage: 'refinement', serial: 2 })
  expect(handoff.plan(context, parameters)).toBe('hold')
})

test('a final value already visibly presented by this gesture skips redundant F32 work', () => {
  const { handoff, update } = fixture()
  handoff.published(context, 4, parameters, true)
  update({ commit: pending })
  expect(handoff.plan(context, parameters)).toBe('hold')
  update({
    gesturing: false,
    epoch: 5,
    commit: accepted,
    confirmed: { revision: 9, settings: parameters },
  })
  expect(handoff.plan(context, parameters)).toBe('refinement')
})

test('fresh confirmation is required at refinement admission and completion, independently of acceptance', () => {
  const { handoff, update } = fixture()
  update({ commit: pending })
  handoff.queued('feedback', 1)
  handoff.published(context, 4, parameters, true, { id: 1, stage: 'feedback', serial: 1 })
  update({ gesturing: false, epoch: 5, commit: accepted, confirmed: null })
  expect(handoff.phase).toBe('awaiting-confirmation')
  expect(handoff.plan(context, parameters)).toBe('hold')
  update({ confirmed: { revision: 9, settings: parameters } })
  expect(handoff.plan(context, parameters)).toBe('refinement')
  handoff.queued('refinement', 2)
  update({ confirmed: null })
  expect(handoff.authorize(1, 'refinement', context, parameters)).toBeNull()
  handoff.invalidateQueued(1)
  expect(handoff.plan(context, parameters)).toBe('hold')
  update({ confirmed: { revision: 9, settings: parameters } })
  expect(handoff.plan(context, parameters)).toBe('refinement')
})

test('obsolete feedback cleanup cannot retire its freshly queued replacement or publish twice', () => {
  const { handoff, update } = fixture()
  update({ commit: pending })
  expect(handoff.queued('feedback', 1)).toBe(true)
  update({ confirmed: null })
  handoff.invalidateQueued()
  update({ gesturing: false, epoch: 5, confirmed: { revision: 9, settings: parameters } })
  expect(handoff.plan(context, parameters)).toBe('feedback')
  expect(handoff.queued('feedback', 2)).toBe(true)
  // R1 completes after R2 has replaced its invalidated pending work.
  handoff.invalidateQueued(1, 1)
  expect(handoff.plan(context, parameters)).toBe('hold')
  expect(handoff.authorize(1, 'feedback', context, parameters, 1)).toBeNull()
  expect(
    handoff.published(context, 4, parameters, true, { id: 1, stage: 'feedback', serial: 1 }),
  ).toBe(false)
  expect(handoff.authorize(1, 'feedback', context, parameters, 2)).toEqual({ revision: null })
  expect(
    handoff.published(context, 5, parameters, true, { id: 1, stage: 'feedback', serial: 2 }),
  ).toBe(true)
  expect(handoff.authorize(1, 'feedback', context, parameters, 2)).toBeNull()
  expect(
    handoff.published(context, 5, parameters, true, { id: 1, stage: 'feedback', serial: 2 }),
  ).toBe(false)
  expect(handoff.plan(context, parameters)).toBe('hold')
  expect(handoff.queued('feedback', 3)).toBe(false)
  update({ commit: accepted })
  expect(handoff.plan(context, parameters)).toBe('refinement')
})

for (const changed of [
  'source-b',
  'sdr-srgb',
  'before',
  'split',
  'pan',
  'zoom',
  'resize',
  'ranges-on',
])
  test(`a ${changed} context change retires the handoff without replay`, () => {
    const { handoff, update } = fixture()
    update({ commit: pending })
    handoff.queued('feedback', 1)
    expect(handoff.plan(changed, parameters)).toBe('ordinary')
    expect(handoff.authorize(1, 'feedback', context, parameters)).toBeNull()
    expect(
      update({
        context,
        commit: accepted,
        epoch: 5,
        gesturing: false,
        confirmed: { revision: 9, settings: parameters },
      }),
    ).toBe(false)
    expect(handoff.plan(context, parameters)).toBe('ordinary')
  })

test('cancel, external conflict and scope loss retire pending work and late successful replies', () => {
  for (const invalidation of [
    { commit: null, epoch: 5, gesturing: false },
    { confirmed: { revision: 9, settings: { ...parameters, exposureEv: -1 } } },
    { confirmed: { revision: 10, settings: parameters } },
    { nativePresented: false },
  ] satisfies Partial<HdrGestureEditing>[]) {
    const { handoff, update } = fixture()
    update({ commit: pending })
    update(invalidation)
    expect(handoff.authorize(1, 'feedback', context, parameters)).toBeNull()
    expect(
      update({
        gesturing: false,
        epoch: 5,
        commit: accepted,
        nativePresented: true,
        confirmed: { revision: 9, settings: parameters },
      }),
    ).toBe(false)
  }
})

test('new gestures, device loss and disposal cannot resurrect an older final snapshot', () => {
  const { handoff, update } = fixture()
  update({ commit: pending })
  handoff.queued('feedback', 1)
  update({
    commit: accepted,
    gesturing: false,
    epoch: 5,
    confirmed: { revision: 9, settings: parameters },
  })
  update({ gesturing: true, commit: null })
  expect(handoff.authorize(1, 'feedback', context, parameters)).toBeNull()
  const next: EditGestureCommit = { ...pending, id: 2, fromEpoch: 5, baseRevision: 9 }
  expect(update({ commit: next })).toBe(true)
  handoff.queued('feedback', 1)
  handoff.invalidateQueued(1)
  expect(handoff.plan(context, parameters)).toBe('hold')
  handoff.invalidate()
  expect(handoff.authorize(2, 'feedback', context, parameters)).toBeNull()
  expect(update({ commit: next })).toBe(false)
})

test('remount, canonical numeric/API edits and drafts without native authority retain ordinary rendering', () => {
  for (const nativePresented of [false, true]) {
    const handoff = new HdrGestureHandoff()
    handoff.update({
      gesturing: false,
      epoch: 5,
      commit: accepted,
      confirmed: { revision: 9, settings: parameters },
      context,
      nativePresented,
    })
    expect(handoff.plan(context, parameters)).toBe('ordinary')
    expect(handoff.authorize(1, 'feedback', context, parameters)).toBeNull()
  }
  const { handoff, update } = fixture()
  update({
    gesturing: false,
    epoch: 5,
    commit: null,
    confirmed: { revision: 9, settings: parameters },
  })
  expect(handoff.plan(context, parameters)).toBe('ordinary')
})

test('local final parameters are copied and exact identities cannot change under one token', () => {
  const { handoff, update } = fixture(),
    mutable = structuredClone(pending)
  update({ commit: mutable })
  mutable.parameters.exposureEv = -3
  expect(handoff.plan(context, parameters)).toBe('feedback')
  expect(handoff.authorize(1, 'feedback', context, mutable.parameters)).toBeNull()
  expect(update({ commit: { ...accepted, photoId: 'photo-b' } })).toBe(false)
  expect(handoff.plan(context, parameters)).toBe('ordinary')
})
