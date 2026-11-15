import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'
import { neutralAdjustments, srgbTransform } from '../src/shared/adjustments'
import { cropGeometry, identityCrop } from '../src/shared/crop'
import {
  HDR_JPEG_SOURCE_VERSION,
  HDR_SOURCE_VERSION,
  type HdrWorkingAsset,
} from '../src/shared/hdr'
import { identityMaskGeometry } from '../src/shared/mask-geometry'
import {
  neutralMaskColor,
  neutralMaskEdge,
  neutralMaskLight,
  type ResolvedMask,
} from '../src/shared/masks'
import {
  PREPARED_MASK_STACK_CONSUMED,
  PREPARED_MASK_STACK_GRID_POLICY,
  PREPARED_MASK_STACK_POLICY,
  preparedMaskStackContext,
  preparedMaskStackKey,
  validatePreparedMaskStack,
  type PreparedMaskStack,
  type PreparedMaskStackContext,
} from '../src/main/processing/prepared-mask-stack'

const hash = (character: string) => character.repeat(64)
const path = (name: string) => resolve('managed-prepared-mask-test', name)

function root(id: string, exposureEv: number): ResolvedMask {
  return {
    id,
    name: id,
    enabled: true,
    inverted: false,
    head: null,
    gradient: {
      kind: 'radial',
      center: { x: exposureEv ? 0.3 : 0.7, y: 0.5 },
      radiusX: 0.4,
      radiusY: 0.4,
      rotation: 0,
      feather: 0.5,
    },
    light: { ...neutralMaskLight, exposureEv },
    color: { ...neutralMaskColor, saturation: 10 },
    edge: { ...neutralMaskEdge },
    strokes: [],
  }
}

function context(): PreparedMaskStackContext {
  return {
    domain: 'raster',
    parent: {
      identity: hash('a'),
      asset: {
        path: path('parent.f32'),
        width: 5,
        height: 3,
        byteLength: 5 * 3 * 16,
        sha256: hash('b'),
        transform: { ...srgbTransform },
      },
    },
    adjustments: {
      ...structuredClone(neutralAdjustments),
      exposureEv: 0.25,
      saturation: 10,
      maskGeometry: identityMaskGeometry(5, 3),
      localMasks: [root('top', 0.12), root('bottom', 0)],
    },
    textureIdentity: hash('e'),
  }
}

function receipt(current = context()): PreparedMaskStack {
  const { width, height, byteLength } = current.parent.asset
  const stack: Omit<PreparedMaskStack, 'key'> = {
    policy: PREPARED_MASK_STACK_POLICY,
    state: 'complete',
    consumed: PREPARED_MASK_STACK_CONSUMED,
    gridPolicy: PREPARED_MASK_STACK_GRID_POLICY,
    domain: current.domain,
    parent: structuredClone(current.parent),
    context: preparedMaskStackContext(current),
    textureIdentity: current.textureIdentity!,
    candidate: { path: path('candidate.f32'), width, height, byteLength, sha256: hash('c') },
    union: { path: path('union.f32'), byteLength: width * height * 4, sha256: hash('d') },
  }
  return { ...stack, key: preparedMaskStackKey(stack) }
}

test('completed stack consumption is path-free but binds the current point context', () => {
  const current = context(),
    stack = receipt(current)
  expect(() => validatePreparedMaskStack(stack, current)).not.toThrow()

  const moved = {
    ...stack,
    parent: { ...stack.parent, asset: { ...stack.parent.asset, path: path('moved-parent.f32') } },
    candidate: { ...stack.candidate, path: path('moved-candidate.f32') },
    union: { ...stack.union, path: path('moved-union.f32') },
  }
  expect(preparedMaskStackKey(moved)).toBe(stack.key)
  expect(() => validatePreparedMaskStack(moved, current)).not.toThrow()

  const renamed = structuredClone(current)
  renamed.adjustments.localMasks![0].name = 'A different authoring label'
  expect(preparedMaskStackContext(renamed)).toBe(stack.context)
})

test('verified identity crop aliases absent crop without aliasing a real cropped grid', () => {
  const current = context(),
    stack = receipt(current),
    geometry = {
      ...identityMaskGeometry(5, 3),
      crop: cropGeometry({ width: 5, height: 3 }, identityCrop),
    },
    explicit: PreparedMaskStackContext = {
      ...current,
      parent: {
        ...current.parent,
        asset: { ...current.parent.asset, maskGeometry: geometry },
      },
      adjustments: { ...current.adjustments, maskGeometry: geometry },
    }
  expect(preparedMaskStackContext(explicit)).toBe(stack.context)
  expect(preparedMaskStackKey({ ...stack, parent: explicit.parent })).toBe(stack.key)
  expect(() => validatePreparedMaskStack(stack, explicit)).not.toThrow()

  // This native 5x3 grid has the same output size but a genuinely different source origin.
  const actualCrop = {
    ...identityMaskGeometry(6, 3),
    crop: cropGeometry({ width: 6, height: 3 }, { ...identityCrop, width: 5 / 6, centerX: 7 / 12 }),
  }
  expect(actualCrop.crop.identity).toBe(false)
  const cropped: PreparedMaskStackContext = {
    ...current,
    parent: {
      ...current.parent,
      asset: { ...current.parent.asset, maskGeometry: actualCrop },
    },
    adjustments: { ...current.adjustments, maskGeometry: actualCrop },
  }
  expect(preparedMaskStackContext(cropped)).not.toBe(stack.context)
  expect(() => validatePreparedMaskStack(stack, cropped)).toThrow('does not match')

  const falseIdentity = {
    ...geometry,
    crop: { ...geometry.crop, outputToSource: [1, 0, 0, 1, 0.25, 0] as const },
  }
  expect(() =>
    preparedMaskStackContext({
      ...current,
      adjustments: { ...current.adjustments, maskGeometry: falseIdentity },
    }),
  ).toThrow('identity crop')
})

test('global edits, earlier local edits and root order invalidate a consumed stack', () => {
  const current = context(),
    stack = receipt(current),
    global = structuredClone(current),
    local = structuredClone(current),
    reordered = structuredClone(current)
  global.adjustments.exposureEv += 0.01
  local.adjustments.localMasks![1].color.saturation += 1
  reordered.adjustments.localMasks = [...reordered.adjustments.localMasks!].reverse()
  for (const changed of [global, local, reordered]) {
    expect(preparedMaskStackContext(changed)).not.toBe(stack.context)
    expect(() => validatePreparedMaskStack(stack, changed)).toThrow('does not match')
  }
  expect(() =>
    validatePreparedMaskStack(stack, { ...current, textureIdentity: hash('f') }),
  ).toThrow('does not match')
})

test('source identity, transform, geometry and white balance cannot reuse consumed pixels', () => {
  const current = context(),
    stack = receipt(current)
  const changed: PreparedMaskStackContext[] = [
    { ...current, parent: { ...current.parent, identity: hash('f') } },
    {
      ...current,
      parent: {
        ...current.parent,
        asset: { ...current.parent.asset, sha256: hash('f') },
      },
    },
    { ...current, transform: { ...srgbTransform, white: 2 } },
    { ...current, whiteBalance: [1.01, 0, 0, 0, 1, 0, 0, 0, 1] },
    {
      ...current,
      adjustments: {
        ...current.adjustments,
        maskGeometry: { ...current.adjustments.maskGeometry!, flip: 1 },
      },
    },
  ]
  for (const value of changed)
    expect(() => validatePreparedMaskStack(stack, value)).toThrow('does not match')
  const wrongSize = {
    ...current,
    adjustments: { ...current.adjustments, maskGeometry: identityMaskGeometry(6, 3) },
  }
  expect(() => validatePreparedMaskStack(stack, wrongSize)).toThrow('geometry')
})

test('pending, unknown-policy and partial-consumption receipts are refused', () => {
  const current = context(),
    stack = receipt(current)
  const invalid = [
    { ...stack, state: 'pending' },
    { ...stack, policy: 'future-policy' },
    { ...stack, gridPolicy: 'uncropped-grid' },
    { ...stack, consumed: 'globals-only' },
    { ...stack, context: '' },
    { ...stack, textureIdentity: '' },
    { ...stack, key: '' },
  ]
  for (const value of invalid)
    expect(() => validatePreparedMaskStack(value as PreparedMaskStack, current)).toThrow('receipt')
})

test('candidate and union are bound to native dimensions, bytes, hashes and distinct files', () => {
  const current = context(),
    stack = receipt(current)
  for (const changed of [
    { ...stack, candidate: { ...stack.candidate, sha256: hash('f') } },
    { ...stack, union: { ...stack.union, sha256: hash('f') } },
    { ...stack, parent: { ...stack.parent, identity: hash('f') } },
  ])
    expect(() => validatePreparedMaskStack(changed, current)).toThrow('does not match')

  for (const changed of [
    { ...stack, candidate: { ...stack.candidate, width: 3, height: 5 } },
    { ...stack, candidate: { ...stack.candidate, byteLength: stack.candidate.byteLength - 4 } },
    { ...stack, union: { ...stack.union, byteLength: stack.union.byteLength - 4 } },
    { ...stack, candidate: { ...stack.candidate, path: current.parent.asset.path } },
    { ...stack, union: { ...stack.union, path: stack.candidate.path } },
    {
      ...stack,
      parent: {
        ...stack.parent,
        asset: { ...stack.parent.asset, path: stack.candidate.path },
      },
    },
  ]) {
    const resigned = { ...changed, key: preparedMaskStackKey(changed) }
    expect(() => validatePreparedMaskStack(resigned, current)).toThrow('does not match')
  }
})

test('receipts accept raster, scene-linear and authored HDR only in their matching source domains', () => {
  const current = context(),
    asset = current.parent.asset
  const hdr: HdrWorkingAsset = {
    kind: 'hdr-working-v1',
    width: asset.width,
    height: asset.height,
    byteLength: asset.byteLength,
    sha256: asset.sha256,
    strips: [{ byteLength: asset.byteLength, sha256: asset.sha256 }],
    source: {
      version: HDR_SOURCE_VERSION,
      processing: 'hdr-v1',
      colorSpace: 'rec2020',
      whitePoint: 'D65',
      transfer: 'linear',
      alpha: 'straight',
      orientation: 'applied-once',
      decoder: 'model-test',
      cameraProfile: 'model-test',
      normalization: {
        black: [0, 0, 0, 0],
        maximum: 1,
        gains: [1, 1, 1, 1],
        restoreGain: 1,
        referenceWhite: 1,
        sourceSaturation: null,
      },
    },
  }
  const scene: PreparedMaskStackContext = {
    ...current,
    domain: 'scene-linear',
    parent: { ...current.parent, asset: { ...asset, hdr } },
  }
  const authored: PreparedMaskStackContext = {
    ...scene,
    domain: 'authored-hdr',
    parent: {
      ...scene.parent,
      asset: {
        ...scene.parent.asset,
        hdr: {
          ...hdr,
          source: {
            version: HDR_JPEG_SOURCE_VERSION,
            processing: 'hdr-v1',
            colorSpace: 'rec2020',
            whitePoint: 'D65',
            transfer: 'linear',
            alpha: 'straight',
            orientation: 'applied-once',
            decoder: 'model-test',
            display: { encoding: 'iso-21496-1-jpeg', referenceWhiteNits: 203, headroom: 4 },
            normalization: { referenceWhite: 1, sourceSaturation: null },
          },
        },
      },
    },
  }
  expect(() => validatePreparedMaskStack(receipt(current), current)).not.toThrow()
  expect(() => validatePreparedMaskStack(receipt(scene), scene)).not.toThrow()
  expect(() => validatePreparedMaskStack(receipt(authored), authored)).not.toThrow()
  expect(() => receipt({ ...current, domain: 'scene-linear' })).toThrow('unsupported source domain')
  expect(() => receipt({ ...current, domain: 'authored-hdr' })).toThrow('unsupported source domain')
  expect(() => receipt({ ...scene, domain: 'authored-hdr' })).toThrow('unsupported source domain')
  expect(() => receipt({ ...authored, domain: 'scene-linear' })).toThrow(
    'unsupported source domain',
  )
  expect(() => receipt({ ...authored, domain: 'raster' })).toThrow('unsupported source domain')
  expect(() =>
    receipt({
      ...authored,
      parent: {
        ...authored.parent,
        asset: {
          ...authored.parent.asset,
          hdr: {
            ...authored.parent.asset.hdr!,
            source: { ...hdr.source, display: { headroom: 4 } } as HdrWorkingAsset['source'],
          },
        },
      },
    }),
  ).toThrow('Invalid HDR JPEG provenance')
  expect(() =>
    receipt({
      ...scene,
      parent: {
        ...scene.parent,
        asset: {
          ...scene.parent.asset,
          maskGeometry: identityMaskGeometry(5, 3),
          hdr: { ...hdr, maskGeometry: { ...identityMaskGeometry(5, 3), flip: 1 } },
        },
      },
    }),
  ).toThrow('Conflicting')
  expect(() => receipt({ ...scene, domain: 'raster' })).toThrow('unsupported source domain')
  expect(() =>
    receipt({
      ...scene,
      parent: {
        ...scene.parent,
        asset: {
          ...scene.parent.asset,
          hdr: {
            ...hdr,
            source: { ...hdr.source, display: { headroom: 4 } } as HdrWorkingAsset['source'],
          },
        },
      },
    }),
  ).toThrow('unsupported source domain')
})

test('nonfinite point controls and malformed white balance cannot alias a serialized context', () => {
  const current = context()
  expect(() =>
    preparedMaskStackContext({
      ...current,
      adjustments: { ...current.adjustments, exposureEv: Number.NaN },
    }),
  ).toThrow('point controls')
  const local = structuredClone(current)
  local.adjustments.localMasks![0].light.exposureEv = Infinity
  expect(() => preparedMaskStackContext(local)).toThrow('point controls')
  expect(() => preparedMaskStackContext({ ...current, whiteBalance: [1, 2] })).toThrow(
    'white balance',
  )
})
