import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { prepareMaskMutation } from '../src/main/mask-store'
import { sameAdjustments, neutralAdjustments, snapshotAdjustments } from '../src/shared/adjustments'
import { initialSettings, type EditState } from '../src/shared/edits'
import { cropGeometry, identityCrop } from '../src/shared/crop'
import { identityMaskGeometry } from '../src/shared/mask-geometry'
import { maskBaseReference, resolveMasks, neutralMaskLight } from '../src/shared/masks'
import {
  confirmedAdjustments,
  confirmedGestureCommit,
} from '../src/renderer/src/preview/confirmed-adjustments'
import type { EditGestureCommit } from '../src/renderer/src/preview/edit-gesture'
import { generatedMask } from './helpers/generated-mask'

function fixture() {
  const photoId = 'a'.repeat(64),
    root = randomUUID(),
    object = randomUUID(),
    base = generatedMask(8, 6, (x) => (x < 4 ? 255 : 0)),
    geometry = identityMaskGeometry(8, 6),
    gradient = {
      kind: 'linear' as const,
      start: { x: 0.1, y: 0.2 },
      end: { x: 0.8, y: 0.9 },
    },
    stroke = {
      mode: 'add' as const,
      radius: 0.1,
      feather: 0.5,
      points: [{ x: 0.3, y: 0.4 }],
    }
  const { stack, chunks } = prepareMaskMutation([], {
    operations: [
      { kind: 'create', id: root, name: 'Water', gradient },
      { kind: 'update', id: root, light: { exposureEv: -1 } },
      {
        kind: 'component-add',
        id: root,
        componentId: object,
        name: 'Protected object',
        operator: 'subtract',
        stroke,
      },
      { kind: 'component-update', id: root, componentId: object, edge: { featherPx: 3 } },
      { kind: 'stroke', id: root, stroke: { ...stroke, mode: 'subtract' } },
    ],
  })
  stack[0].operands![0].base = maskBaseReference(base)
  const state: EditState = {
    photoId,
    revision: 9,
    settings: { ...initialSettings(), processing: 'hdr-v1', maskStack: stack },
    maskContent: chunks,
    maskBases: [base],
    canUndo: true,
    canRedo: false,
  }
  return { state, root, object, stroke, gradient, source: { photoId, maskGeometry: geometry } }
}

test('confirmed render parameters resolve the persisted mask tree and match prepared coverage without changing edits', () => {
  const f = fixture(),
    original = structuredClone(f.state),
    parameters = confirmedAdjustments(f.state, f.state.photoId, f.source)!
  const rendered = {
    ...neutralAdjustments,
    curves: structuredClone(f.state.settings.curves),
    colorMixer: structuredClone(f.state.settings.colorMixer),
    colorGrading: structuredClone(f.state.settings.colorGrading),
    maskGeometry: structuredClone(f.source.maskGeometry),
    localMasks: resolveMasks(f.state.settings.maskStack, f.state.maskContent!, f.state.maskBases!),
  }
  rendered.localMasks[0].operands![0].preparedCoverage = {
    ...generatedMask(8, 6, () => 128),
    key: 'c'.repeat(64),
  }
  // Raw saved settings cannot authorize rendered masks; the resolved snapshot can.
  expect(sameAdjustments(f.state.settings, rendered)).toBe(false)
  expect(sameAdjustments(parameters, rendered)).toBe(true)
  expect(parameters.localMasks?.[0]).toMatchObject({
    id: f.root,
    gradient: f.gradient,
    light: { exposureEv: -1 },
    operands: [{ id: f.object, operator: 'subtract', edge: { featherPx: 3 }, strokes: [f.stroke] }],
  })
  expect(parameters.localMasks?.[0].resultStrokes).toHaveLength(1)
  expect(f.state).toEqual(original)
})

for (const kind of ['brush', 'gradient'] as const) {
  test(`a same-revision ${kind} draft remains different from the confirmed render snapshot`, () => {
    const f = fixture(),
      confirmed = confirmedAdjustments(f.state, f.state.photoId, f.source)!,
      draft = prepareMaskMutation(f.state.settings.maskStack, {
        operations:
          kind === 'brush'
            ? [{ kind: 'stroke', id: f.root, stroke: f.stroke }]
            : [
                {
                  kind: 'update',
                  id: f.root,
                  gradient: { ...f.gradient, end: { x: 0.6, y: 0.7 } },
                },
              ],
      }),
      parameters = {
        ...confirmed,
        localMasks: resolveMasks(
          draft.stack,
          [...f.state.maskContent!, ...draft.chunks],
          f.state.maskBases,
        ),
      }
    expect(f.state.revision).toBe(9)
    expect(sameAdjustments(confirmed, parameters)).toBe(false)
    expect(confirmedAdjustments(f.state, f.state.photoId, f.source)).toEqual(confirmed)
  })
}

test('confirmation rejects another photo, an unbound source and invalid mask geometry', () => {
  const f = fixture()
  expect(confirmedAdjustments(null, f.state.photoId, f.source)).toBeNull()
  expect(confirmedAdjustments(f.state, undefined, f.source)).toBeNull()
  expect(confirmedAdjustments(f.state, 'b'.repeat(64), f.source)).toBeNull()
  expect(
    confirmedAdjustments(f.state, f.state.photoId, { ...f.source, photoId: 'b'.repeat(64) }),
  ).toBeNull()
  expect(confirmedAdjustments(f.state, f.state.photoId)).toBeNull()
  expect(confirmedAdjustments(f.state, f.state.photoId, { photoId: f.state.photoId })).toBeNull()
  expect(
    confirmedAdjustments(f.state, f.state.photoId, {
      ...f.source,
      maskGeometry: { ...f.source.maskGeometry, canonicalWidth: 0 },
    }),
  ).toBeNull()
  expect(
    confirmedAdjustments(f.state, f.state.photoId, {
      ...f.source,
      maskGeometry: {
        ...f.source.maskGeometry,
        crop: cropGeometry({ width: 16, height: 12 }, identityCrop),
      },
    }),
  ).toBeNull()
})

test('a newer nonspatial edit can confirm the unchanged grid from an older cached source revision', () => {
  const f = fixture(),
    cachedSource = { ...f.source, settingsRevision: 8 }
  f.state.settings.exposureEv = 0.7
  const parameters = confirmedAdjustments(f.state, f.state.photoId, cachedSource)!
  expect(f.state.revision).toBeGreaterThan(cachedSource.settingsRevision)
  expect(parameters.exposureEv).toBe(0.7)
  expect(parameters.maskGeometry).toEqual(cachedSource.maskGeometry)
  expect(sameAdjustments(parameters, { ...parameters, exposureEv: 0 })).toBe(false)
})

test('the confirmed snapshot owns its geometry and mask content independently of later input mutation', () => {
  const f = fixture(),
    confirmed = confirmedAdjustments(f.state, f.state.photoId, f.source)!,
    original = structuredClone(confirmed)
  ;(f.source.maskGeometry as { canonicalWidth: number }).canonicalWidth = 16
  f.state.settings.maskStack[0].gradient = { ...f.gradient, end: { x: 0.5, y: 0.6 } }
  f.state.maskContent![0].stroke.points[0].x = 0.8
  expect(confirmed).toEqual(original)
})

test('empty and inactive masks preserve confirmation without requiring an unused native grid', () => {
  const empty: EditState = {
    photoId: 'a'.repeat(64),
    revision: 0,
    settings: initialSettings(),
    canUndo: false,
    canRedo: false,
  }
  expect(sameAdjustments(confirmedAdjustments(empty, empty.photoId)!, empty.settings)).toBe(true)
  for (const inactive of ['disabled', 'neutral'] as const) {
    const f = fixture()
    if (inactive === 'disabled') f.state.settings.maskStack[0].enabled = false
    else f.state.settings.maskStack[0].light = { ...neutralMaskLight }
    const parameters = confirmedAdjustments(f.state, f.state.photoId)!
    expect(parameters).not.toBeNull()
    expect(sameAdjustments(parameters, { ...f.state.settings, localMasks: [] })).toBe(true)
  }
})

for (const phase of ['pending', 'accepted'] as const) {
  test(`binding ${phase === 'accepted' ? 'an' : 'a'} ${phase} gesture token preserves its captured mask coverage and acceptance phase`, () => {
    const f = fixture(),
      parameters = snapshotAdjustments({
        ...f.state.settings,
        exposureEv: 1.25,
        localMasks: resolveMasks(
          f.state.settings.maskStack,
          f.state.maskContent!,
          f.state.maskBases!,
        ),
      }),
      captured = structuredClone(parameters),
      commit: EditGestureCommit = {
        id: 4,
        photoId: f.state.photoId,
        fromEpoch: 3,
        baseRevision: f.state.revision,
        parameters,
        ...(phase === 'pending'
          ? { phase, revision: null }
          : { phase, revision: f.state.revision + 1 }),
      }
    const bound = confirmedGestureCommit(commit, f.state.photoId, f.source)!
    expect(bound).toMatchObject({
      id: commit.id,
      phase: commit.phase,
      revision: commit.revision,
      baseRevision: commit.baseRevision,
      parameters: { ...captured, maskGeometry: f.source.maskGeometry },
    })
    expect(commit.parameters.maskGeometry).toBeUndefined()
    expect(confirmedGestureCommit(commit, 'b'.repeat(64), f.source)).toBeNull()
    expect(
      confirmedGestureCommit(commit, f.state.photoId, { ...f.source, photoId: 'b'.repeat(64) }),
    ).toBeNull()
    expect(confirmedGestureCommit(commit, f.state.photoId)).toBeNull()
  })
}
