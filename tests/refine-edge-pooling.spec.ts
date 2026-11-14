import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import protocol from '../assets/tests/references/refine-edge/pooling-followup.json' with { type: 'json' }
import corpus from '../assets/tests/references/object-selection/inputs.json' with { type: 'json' }
import reference from '../assets/tests/references/refine-edge/pooling-reference.json' with { type: 'json' }

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const floatBytes = (values: ArrayLike<number>) => {
  const bytes = Buffer.alloc(values.length * 4)
  for (let index = 0; index < values.length; index++) bytes.writeFloatLE(values[index], index * 4)
  return bytes
}

test('exact-pooling follow-up preserves earlier frozen protocols, crops, sources and original inputs', async () => {
  expect(hash(await readFile('assets/tests/references/refine-edge/pooling-followup.json'))).toBe(
    'c749f65b8d451eb2d2d051a40af1478978ccd6db072a13d84c754b21cfa88661',
  )
  for (const [path, expected] of [
    [protocol.preserved.protocol, protocol.preserved.protocolSha256],
    [protocol.preserved.crops, protocol.preserved.cropsSha256],
    [protocol.preserved.candidateSources, protocol.preserved.candidateSourcesSha256],
    [protocol.preserved.inputs, protocol.preserved.inputsSha256],
  ])
    expect(hash(await readFile(path))).toBe(expected)
  expect(protocol.candidate).toMatchObject({
    originalWeightsUnchanged: true,
    fast: false,
    L: 900,
    dtype: 'float32',
    opset: 17,
    imageShape: [1, 3, 600, 900],
    paddedImageShape: [1, 3, 608, 904],
  })
  expect(protocol.lowering).toMatchObject({
    route: ['Slice', 'ReduceMean', 'Concat'],
    dynamicWindowConstruction: ['Shape', 'Gather', 'Div'],
    primaryFeatureShape: [76, 113],
    outputBins: [2, 3, 6],
  })
  expect(protocol.candidate.globalGraph).toMatchObject({
    exportAttempts: 1,
    spatialAxes: 'dynamic-height-and-width',
    representativeSourceShape: [1, 3, 600, 900],
    representativePaddedShape: [1, 3, 608, 904],
    inputs: ['image', 'mask'],
  })
  expect(protocol.candidate.localGraph).toMatchObject({
    exportAttempts: 1,
    spatialAxes: 'fixed-904-by-904',
    imageShape: [1, 3, 904, 904],
    maskShape: [1, 1, 904, 904],
    interS8Shape: [1, 1, 904, 904],
    inputs: ['image', 'mask', 'inter_s8'],
    interS4: null,
  })
})

test('one native WebGPU route retains fallback refusal, Automatic resources and the next-operator stop', () => {
  expect(protocol.runtime).toMatchObject({
    provider: 'WebGpuExecutionProvider',
    heavyCpuNodes: 0,
    cpuFallbackDisabled: true,
    ortConfig: { 'session.disable_cpu_ep_fallback': '1' },
    actualDeviceRequired: true,
    resourcePolicy: 'Automatic',
    resourceOverrides: false,
  })
  expect(protocol.effortStop).toEqual({
    fullModelExportAttempts: 2,
    globalExportAttempts: 1,
    localExportAttempts: 1,
    alternateShape: false,
    alternateOpset: false,
    alternateModel: false,
    nextUnsupportedOperator: 'stop-and-retain-evidence',
    failureRepairLoop: false,
  })
  expect(protocol.numerical).toMatchObject({
    absoluteTolerance: 0.001,
    relativeTolerance: 0.001,
    maximumR8Difference: 1,
    poolingParityIsFullModelParity: false,
    fullModelParityIsPhotographicAcceptance: false,
  })
  expect(protocol.licensing).toEqual({
    weightAdoptionStatus: 'unresolved-for-adoption',
    productionIntegration: false,
    weightRedistribution: false,
    poolingCompatibilityResolvesLicensing: false,
  })
})

test('released hard cases preserve target exclusions and cannot become unseen holdouts', () => {
  expect(protocol.photographicGate).toMatchObject({
    allPreviouslySeen: true,
    unseenHoldoutClaim: false,
    retuningAfterRelease: false,
    missingEvidence: 'incomplete-never-pass',
  })
  expect(protocol.photographicGate.sentinels.map((scene) => scene.id)).toEqual([
    'd04-forest-fence',
    'd08-flamingo',
    'h11-robin',
    'd06-wig',
  ])
  for (const scene of protocol.photographicGate.sentinels)
    expect(corpus.images.find((image) => image.id === scene.id)).toBeDefined()
  expect(
    protocol.photographicGate.sentinels.find((scene) => scene.id === 'h11-robin')!.focus,
  ).toContain('explicitly exclude the held mealworm')
  expect(protocol.photographicGate.continueToTwelveScenesOnlyIf).toContain('All four hard cases')
})

test('independent original Torch pooling vectors retain their generator, shapes and exact Float32 bytes', async () => {
  expect(hash(await readFile(protocol.numerical.primaryFixture))).toBe(
    '9a491cbd2e364201a664b06384b8112209eed57cd5b67053e5049204c18af20b',
  )
  expect(hash(await readFile(reference.generator.path))).toBe(reference.generator.sha256)
  expect(reference.sourceRevision).toBe(protocol.candidate.sourceRevision)
  expect(reference.environment.packages.torch).toBe('2.8.0+cpu')
  expect(reference.featureShape).toEqual([1, 3, ...protocol.lowering.primaryFeatureShape])
  expect(reference.reference).toBe(
    'Original torch.nn.functional.adaptive_avg_pool2d, not the export lowering.',
  )
  expect(reference.inputGeneration).toMatchObject({
    type: 'procedural-coordinate-v1',
    indexOrder: 'NCHW',
  })
  expect(reference.outputs.map((output) => Number(output.name.slice(4)))).toEqual(
    protocol.lowering.outputBins,
  )
  const expectedHashes: Record<string, string> = {
    pool2: '23a43e437a54689206dfab249faf136d8b56d043b2151861dafc67e6f4f67e34',
    pool3: '1de5f8bc53d2b4a7ede90babf694a892eb15df6701677c0ed4e61440c49d3eee',
    pool6: 'ded188b83f75626ffb18186a889cd52f0d73a7726b06052788aadfe19db1dfe4',
  }
  for (const output of reference.outputs) {
    const bins = Number(output.name.slice(4))
    expect(output.shape).toEqual([1, 3, bins, bins])
    expect(output.data).toHaveLength(3 * bins * bins)
    expect(output.data.every(Number.isFinite)).toBe(true)
    expect(hash(floatBytes(output.data))).toBe(expectedHashes[output.name])
  }
})

test('odd feature extents preserve overlapping floor/ceil windows and outer-border contributions', () => {
  const [, channels, height, width] = reference.featureShape
  const input = new Float32Array(channels * height * width)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const pixel = y * width + x
      input[pixel] = ((17 * x + 31 * y) % 257) / 256
      input[height * width + pixel] = (Math.floor(x / 3) + Math.floor(y / 5)) % 2
      input[2 * height * width + pixel] =
        x === 0 || y === 0 || x === width - 1 || y === height - 1 ? 1 : 0
    }
  // This exact input-byte identity comes from the actual independent export manifest.
  expect(hash(floatBytes(input))).toBe(
    '78a3df5618d40011194721e9fb046ce58ca81af293bd39257b4f86193594b0b8',
  )
  const windows = (extent: number, bins: number) =>
    Array.from({ length: bins }, (_, index) => [
      Math.floor((index * extent) / bins),
      Math.ceil(((index + 1) * extent) / bins),
    ])
  // Width 113 requires overlapping bins. Fixed non-overlapping pooling loses these samples.
  expect(windows(width, 2)).toEqual([
    [0, 57],
    [56, 113],
  ])
  expect(windows(width, 3)).toEqual([
    [0, 38],
    [37, 76],
    [75, 113],
  ])
  expect(windows(height, 6)).toEqual([
    [0, 13],
    [12, 26],
    [25, 38],
    [38, 51],
    [50, 64],
    [63, 76],
  ])
  let samples = 0
  for (const output of reference.outputs) {
    const bins = output.shape[2]
    const rows = windows(height, bins)
    const columns = windows(width, bins)
    for (let channel = 0; channel < channels; channel++)
      for (let row = 0; row < bins; row++)
        for (let column = 0; column < bins; column++) {
          const [top, bottom] = rows[row]
          const [left, right] = columns[column]
          let total = 0
          for (let y = top; y < bottom; y++)
            for (let x = left; x < right; x++) total += input[(channel * height + y) * width + x]
          const mean = total / ((bottom - top) * (right - left))
          const expected = output.data[(channel * bins + row) * bins + column]
          expect(Math.abs(mean - expected)).toBeLessThanOrEqual(
            protocol.numerical.absoluteTolerance +
              protocol.numerical.relativeTolerance * Math.abs(expected),
          )
          expect(Math.abs(Math.round(mean * 255) - Math.round(expected * 255))).toBeLessThanOrEqual(
            protocol.numerical.maximumR8Difference,
          )
          samples++
        }
  }
  expect(samples).toBe(147)
})
