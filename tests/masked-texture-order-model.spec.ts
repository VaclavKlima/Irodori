import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { selectPlan, suites } from '../scripts/verification-plan'
import { cropGeometry, mapCropAffine, type CropSettings } from '../src/shared/crop'
import { validatePatch } from '../src/shared/edits'
import { validateMaskColor, validateMaskLight } from '../src/shared/masks'

interface Root {
  id: string
  enabled: boolean
  amount: number
  light: Record<string, number>
  color: Record<string, number>
  coverage: number[]
}
interface OrderedCase {
  id: string
  width: number
  height: number
  primaries: string
  rgba: number[]
  globals: Record<string, number>
  white: number
  roots: Root[]
  expectedGlobal: number[]
  steps: {
    rootId: string
    amount: number
    skipped: boolean
    expectedUnblended: number[]
    expected: number[]
    exactPreviousWordIndices: number[]
    alphaWordIndices: number[]
    textureHiddenWordIndices: number[]
  }[]
  expected: number[]
  withoutTextureExpected: number[]
  unionCoverage: number[]
  crop?: {
    sourceWidth: number
    sourceHeight: number
    sourceRgba: number[]
    settings: CropSettings
    expectedGeometry: {
      width: number
      height: number
      source: { width: number; height: number }
      outputToSource: number[]
      pixelAligned: boolean
    }
  }
}
interface Protocol {
  id: string
  algorithmReference: { file: string; sha256: string }
  reference: { file: string; sha256: string; generator: string; generatorSha256: string }
  gates: { absolute: number; relative: number }
  runtime: { maxReferenceBytes: number }
  photo: {
    globals: Record<string, number>
    roots: { id: string; light: Record<string, number>; color: Record<string, number> }[]
  }
}
interface NegativeControl {
  caseId: string
  kind: string
  index: number
  expected: number
  actual: number
}
interface Reference {
  provenance: { sources: { file: string; sha256: string }[] }
  cases: OrderedCase[]
  negativeControls: NegativeControl[]
  refusals: { id: string }[]
}

const protocolPath = 'assets/tests/references/masked-texture/order-protocol-v2.json'
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const words = (frame: number[]) => new Uint32Array(Float32Array.from(frame).buffer)
let protocol: Protocol, reference: Reference
test.beforeAll(async () => {
  protocol = JSON.parse(await readFile(protocolPath, 'utf8')) as Protocol
  const bytes = await readFile(protocol.reference.file)
  expect(hash(bytes)).toBe(protocol.reference.sha256)
  reference = JSON.parse(bytes.toString()) as Reference
})

test('ordered proof binds its independent oracle to the unchanged frozen Texture operator', async () => {
  expect(hash(await readFile(protocolPath))).toBe(
    'fbdc719275c03cf307a71b5e3e80fde30b77af88ec5ce42f7a886fe3aba96601',
  )
  expect(protocol.id).toBe('masked-texture-order-proof-v2')
  expect(protocol.algorithmReference.file).toBe(
    'assets/tests/references/masked-texture/protocol.json',
  )
  expect(protocol.algorithmReference.sha256).toBe(
    'f8aa5bc91184276ee3c8fe1115bafa427c4476736db850cc053c0cd1e901f399',
  )
  expect(hash(await readFile(protocol.algorithmReference.file))).toBe(
    protocol.algorithmReference.sha256,
  )
  expect(hash(await readFile(protocol.reference.generator))).toBe(
    protocol.reference.generatorSha256,
  )
  expect(protocol.gates).toMatchObject({ absolute: 2e-6, relative: 2e-5 })
  for (const source of reference.provenance.sources)
    expect(hash(await readFile(source.file))).toBe(source.sha256)
  expect((await readFile(protocol.reference.file)).byteLength).toBeLessThanOrEqual(
    protocol.runtime.maxReferenceBytes,
  )
})

test('all numerical, refusal and photographic controls pass actual application validators before GPU work', () => {
  for (const entry of [...reference.cases, ...reference.refusals] as {
    id: string
    globals: Record<string, number>
    roots: Root[]
  }[]) {
    expect(() => validatePatch(entry.globals), `${entry.id}/global`).not.toThrow()
    for (const root of entry.roots) {
      expect(() => validateMaskLight(root.light), `${entry.id}/${root.id}/light`).not.toThrow()
      expect(() => validateMaskColor(root.color), `${entry.id}/${root.id}/color`).not.toThrow()
    }
  }
  expect(() => validatePatch(protocol.photo.globals), 'photo/global').not.toThrow()
  for (const root of protocol.photo.roots) {
    expect(() => validateMaskLight(root.light), `photo/${root.id}/light`).not.toThrow()
    expect(() => validateMaskColor(root.color), `photo/${root.id}/color`).not.toThrow()
  }
})

test('v2 preserves the failed v1 study and corrects only unsupported exposure precision', async () => {
  const oldProtocolBytes = await readFile(
      'assets/tests/references/masked-texture/order-protocol-v1.json',
    ),
    oldReferenceBytes = await readFile(
      'assets/tests/references/masked-texture/order-reference-v1.json',
    )
  expect(hash(oldProtocolBytes)).toBe(
    '1830817ee8b6daf8e97a320c85269596d15e76e19e6f8f6d2237190bd88f58a4',
  )
  expect(hash(oldReferenceBytes)).toBe(
    '109685c82217a61d6e44b63a8829bf3dca569ed323d86f6baba66daeff0645ff',
  )
  const oldProtocol = JSON.parse(oldProtocolBytes.toString()) as Protocol,
    oldReference = JSON.parse(oldReferenceBytes.toString()) as Reference
  expect(protocol.algorithmReference).toEqual(oldProtocol.algorithmReference)
  expect(protocol.gates).toEqual(oldProtocol.gates)
  expect(protocol.photo).toEqual(oldProtocol.photo)
  expect(reference.refusals).toEqual(oldReference.refusals)
  expect(reference.cases.map((entry) => entry.id)).toEqual(
    oldReference.cases.map((entry) => entry.id),
  )
  const input = (entry: OrderedCase) => ({
    id: entry.id,
    width: entry.width,
    height: entry.height,
    primaries: entry.primaries,
    white: entry.white,
    rgba: entry.rgba,
    globals: entry.globals,
    roots: entry.roots,
    crop: entry.crop,
  })
  let correctedFields = 0,
    correctedCases = 0
  for (const old of oldReference.cases) {
    const current = reference.cases.find((entry) => entry.id === old.id)!,
      globals = { ...old.globals }
    let changed = false
    if (globals.exposureEv === 0.125) {
      expect(() => validatePatch(globals)).toThrow('steps of 0.01 EV')
      globals.exposureEv = 0.12
      correctedFields++
      changed = true
    }
    const roots = old.roots.map((root) => {
      const light = { ...root.light }
      if (light.exposureEv === 0.125) {
        expect(() => validateMaskLight(light)).toThrow('Invalid local Light value')
        light.exposureEv = 0.12
        correctedFields++
        changed = true
      }
      return { ...root, light }
    })
    expect(input(current)).toEqual({ ...input(old), globals, roots })
    if (changed) correctedCases++
  }
  expect(correctedFields).toBe(8)
  expect(correctedCases).toBe(4)
})

test('small independent sequences retain complete native Float32 domains and bottom-to-top roots', () => {
  expect(reference.cases.length).toBeGreaterThanOrEqual(6)
  expect(new Set(reference.cases.map((entry) => entry.id)).size).toBe(reference.cases.length)
  expect(new Set(reference.cases.map((entry) => entry.primaries))).toEqual(
    new Set(['srgb', 'rec2020']),
  )
  let activeGlobals = 0,
    activeLocalColor = 0,
    overlappingSpatialRoots = 0
  for (const entry of reference.cases) {
    expect(Number.isSafeInteger(entry.width) && entry.width > 0 && entry.width <= 33).toBe(true)
    expect(Number.isSafeInteger(entry.height) && entry.height > 0 && entry.height <= 25).toBe(true)
    expect(entry.white).toBe(1)
    expect(entry.steps.map((step) => step.rootId)).toEqual(
      [...entry.roots].reverse().map((root) => root.id),
    )
    for (const frame of [
      entry.rgba,
      entry.expectedGlobal,
      entry.expected,
      entry.withoutTextureExpected,
      ...entry.steps.flatMap((step) => [step.expectedUnblended, step.expected]),
    ]) {
      expect(frame).toHaveLength(entry.width * entry.height * 4)
      expect(frame.every((value) => Number.isFinite(value) && Math.fround(value) === value)).toBe(
        true,
      )
    }
    if (Object.values(entry.globals).some((value) => value !== 0)) activeGlobals++
    for (const root of entry.roots) {
      expect(root.coverage).toHaveLength(entry.width * entry.height)
      expect(
        root.coverage.every(
          (value) =>
            Number.isFinite(value) && value >= 0 && value <= 1 && Math.fround(value) === value,
        ),
      ).toBe(true)
      expect([-25, 0, 25]).toContain(root.amount)
      if (Object.values(root.color).some((value) => value !== 0)) activeLocalColor++
    }
    const spatial = entry.roots.filter((root) => root.enabled && root.amount !== 0)
    if (
      spatial.length > 1 &&
      entry.unionCoverage.some(
        (_, pixel) => spatial.filter((root) => root.coverage[pixel] > 0).length > 1,
      )
    )
      overlappingSpatialRoots++
  }
  expect(activeGlobals).toBeGreaterThan(0)
  expect(activeLocalColor).toBeGreaterThan(0)
  expect(overlappingSpatialRoots).toBeGreaterThan(0)
})

test('per-root references keep one blend, exact zero coverage and unchanged alpha independently of Texture', () => {
  let partialChanged = 0,
    hiddenPointEdited = 0
  for (const entry of reference.cases) {
    let previous = entry.expectedGlobal
    const source = words(entry.rgba)
    for (const step of entry.steps) {
      const root = entry.roots.find((candidate) => candidate.id === step.rootId)!
      const before = words(previous),
        after = words(step.expected),
        unblended = words(step.expectedUnblended)
      expect(step.amount).toBe(root.amount)
      for (let pixel = 0; pixel < root.coverage.length; pixel++) {
        const offset = pixel * 4
        expect(after[offset + 3]).toBe(source[offset + 3])
        expect(unblended[offset + 3]).toBe(source[offset + 3])
        if (!root.enabled || root.coverage[pixel] === 0 || step.skipped)
          expect(Array.from(after.slice(offset, offset + 4))).toEqual(
            Array.from(before.slice(offset, offset + 4)),
          )
        if (root.amount === 0 || previous[offset + 3] === 0 || !root.enabled)
          expect(Array.from(unblended.slice(offset, offset + 4))).toEqual(
            Array.from(before.slice(offset, offset + 4)),
          )
        if (
          root.enabled &&
          root.coverage[pixel] > 0 &&
          root.coverage[pixel] < 1 &&
          after[offset] !== before[offset]
        )
          partialChanged++
        if (
          previous[offset + 3] === 0 &&
          root.enabled &&
          root.coverage[pixel] > 0 &&
          after[offset] !== before[offset]
        )
          hiddenPointEdited++
      }
      for (const index of step.exactPreviousWordIndices) expect(after[index]).toBe(before[index])
      for (const index of step.alphaWordIndices) expect(after[index]).toBe(before[index])
      for (const index of step.textureHiddenWordIndices)
        expect(unblended[index]).toBe(before[index])
      previous = step.expected
    }
    expect(words(entry.expected)).toEqual(words(previous))
  }
  expect(partialChanged).toBeGreaterThan(0)
  expect(hiddenPointEdited).toBeGreaterThan(0)
})

test('Texture coverage union contains every published spatial change but preserves point-only hidden edits', () => {
  let zeroCoverage = 0,
    transparent = 0
  for (const entry of reference.cases) {
    const final = words(entry.expected),
      legacy = words(entry.withoutTextureExpected)
    const union = Array.from({ length: entry.width * entry.height }, (_, pixel) =>
      Math.max(
        0,
        ...entry.roots
          .filter((root) => root.enabled && root.amount !== 0)
          .map((root) => root.coverage[pixel]),
      ),
    )
    expect(entry.unionCoverage).toEqual(union)
    for (let pixel = 0; pixel < union.length; pixel++) {
      if (union[pixel] === 0) zeroCoverage++
      if (entry.rgba[pixel * 4 + 3] === 0) transparent++
      if (union[pixel] === 0 || entry.rgba[pixel * 4 + 3] === 0)
        expect(Array.from(final.slice(pixel * 4, pixel * 4 + 4))).toEqual(
          Array.from(legacy.slice(pixel * 4, pixel * 4 + 4)),
        )
    }
  }
  expect(zeroCoverage).toBeGreaterThan(0)
  expect(transparent).toBeGreaterThan(0)
})

test('independent wrong-order, double-blend and repeated-global witnesses fail unchanged numerical gates', () => {
  const kinds = new Set(reference.negativeControls.map((control) => control.kind))
  expect(kinds).toEqual(new Set(['double-coverage', 'double-global', 'reversed-order']))
  for (const control of reference.negativeControls) {
    const entry = reference.cases.find((candidate) => candidate.id === control.caseId)!
    expect(entry).toBeDefined()
    expect(
      Number.isSafeInteger(control.index) &&
        control.index >= 0 &&
        control.index < entry.expected.length &&
        control.index % 4 !== 3,
    ).toBe(true)
    expect(control.expected).toBe(entry.expected[control.index])
    expect(Number.isFinite(control.actual)).toBe(true)
    expect(Math.abs(control.actual - control.expected)).toBeGreaterThan(
      protocol.gates.absolute + protocol.gates.relative * Math.abs(control.expected),
    )
  }
  expect(reference.refusals.length).toBeGreaterThanOrEqual(2)
  expect(new Set(reference.refusals.map((entry) => entry.id)).size).toBe(reference.refusals.length)
})

test('crop-local references preserve native pitch, canonical geometry and exact integer permutations', () => {
  const cropped = reference.cases.filter((entry) => entry.crop)
  expect(cropped.map((entry) => entry.id)).toEqual([
    'crop-odd-origin',
    'crop-quarter-turn',
    'crop-fractional-straighten',
  ])
  for (const entry of cropped) {
    const crop = entry.crop!,
      geometry = cropGeometry({ width: crop.sourceWidth, height: crop.sourceHeight }, crop.settings)
    expect(geometry).toMatchObject({
      width: crop.expectedGeometry.width,
      height: crop.expectedGeometry.height,
      source: crop.expectedGeometry.source,
      pixelAligned: crop.expectedGeometry.pixelAligned,
    })
    expect([entry.width, entry.height]).toEqual([geometry.width, geometry.height])
    for (let index = 0; index < geometry.outputToSource.length; index++)
      expect(geometry.outputToSource[index]).toBeCloseTo(
        crop.expectedGeometry.outputToSource[index],
        12,
      )
    const [xx, xy, yx, yy] = geometry.outputToSource
    expect(xx * xx + yx * yx).toBeCloseTo(1, 12)
    expect(xy * xy + yy * yy).toBeCloseTo(1, 12)
    expect(xx * xy + yx * yy).toBeCloseTo(0, 12)
    expect(crop.sourceRgba).toHaveLength(crop.sourceWidth * crop.sourceHeight * 4)
    if (geometry.pixelAligned)
      for (let y = 0; y < entry.height; y++)
        for (let x = 0; x < entry.width; x++) {
          const point = mapCropAffine(geometry.outputToSource, { x: x + 0.5, y: y + 0.5 })
          const sourceOffset = (Math.floor(point.y) * crop.sourceWidth + Math.floor(point.x)) * 4
          expect(
            words(entry.rgba.slice((y * entry.width + x) * 4, (y * entry.width + x + 1) * 4)),
          ).toEqual(words(crop.sourceRgba.slice(sourceOffset, sourceOffset + 4)))
        }
  }
})

test('ordered model and GPU suites are deliberate unique targets outside default selections', () => {
  for (const [target, group] of [
    ['masked-texture-order-model', 'node'],
    ['masked-texture-order-gpu', 'raw-gpu'],
  ] as const) {
    const matching = suites.filter((suite) => suite.target === target)
    expect(matching).toHaveLength(1)
    expect(matching[0]).toMatchObject({ group, scopes: [], explicitOnly: true })
    expect(
      selectPlan(['--target', target]).groups.flatMap((selection) => selection.files),
    ).toContain(`tests/${target}.spec.ts`)
    expect(selectPlan(['--fast']).groups.flatMap((selection) => selection.files)).not.toContain(
      `tests/${target}.spec.ts`,
    )
  }
})
