import { expect, test } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { createTileStudy, type TileRequest } from '../scripts/research/pipeline/gpu-study'
import { imageSpec, pattern } from '../scripts/research/pipeline/workloads'
import { detail, distribution } from '../scripts/research/pipeline/metrics'
import { provenance } from '../scripts/research/pipeline/provenance'
import { renderDisplay } from '../src/shared/display-rendering'
import { attachResearchEvidence } from './research.helpers'
import { SRGB_TO_2020 } from '../src/shared/hdr'
import sharp from 'sharp'

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test.afterEach(async ({}, info) => attachResearchEvidence(info))

let retainedGpu: GPU | undefined
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('native Dawn separates sharp/draft tile batches, completion fences, histogram readback, invalidation and retained navigation', async ({}, info) => {
  test.setTimeout(240000)
  const { create, globals } = await import('webgpu')
  Object.assign(globalThis, globals)
  retainedGpu = create([])
  const adapter = await retainedGpu.requestAdapter()
  test.skip(
    !adapter || adapter.info.isFallbackAdapter,
    'A hardware Dawn adapter is required; software adapters are not timing evidence.',
  )
  const device = await adapter!.requestDevice()
  const errors: string[] = []
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message))
  const spec = imageSpec(1024, 684),
    study = await createTileStudy(device, { ...spec, data: pattern(spec) })
  const parameters = new Array<number>(44).fill(0)
  const base: TileRequest = {
    viewport: { width: 914, height: 502 },
    view: { fit: false, scale: 1, x: 0, y: 0 },
    dpr: 2,
    parameters,
    identity: 'neutral',
    quality: 'normal',
    batchSize: 8,
    waitAfterBatch: true,
    histogram: true,
  }
  const cases: unknown[] = []
  try {
    for (const quality of ['draft', 'normal'] as const)
      for (const batchSize of [8, 32, 128])
        for (const withHistogram of [false, true]) {
          const samples: number[] = [],
            stageSamples: Record<string, number[]> = {},
            observations = []
          for (let i = 0; i < 30; i++) {
            parameters[8] = (i - 15) / 20
            const result = await study.render({
              ...base,
              parameters,
              identity: `${quality}:${batchSize}:${i}`,
              quality,
              batchSize,
              waitAfterBatch: batchSize === 8,
              histogram: withHistogram,
            })
            if (result.cancelled)
              throw new Error('Unexpected cancellation in completed-work calibration.')
            samples.push(result.totalMs)
            observations.push(result)
            for (const name of [
              'invalidationMs',
              'submissionMs',
              'batchWaitMs',
              'completionFenceMs',
              'histogramSubmissionMs',
              'histogramMapMs',
            ] as const)
              (stageSamples[name] ??= []).push(result[name])
            if (withHistogram)
              expect(result.histogramCount).toBe(quality === 'draft' ? 8192 : 65536)
          }
          cases.push({
            quality,
            batchSize,
            waitPolicy: batchSize === 8 ? 'each batch plus final fence' : 'final fence',
            histogram: withHistogram,
            totalMs: distribution(samples),
            stagesMs: Object.fromEntries(
              Object.entries(stageSamples).map(([key, values]) => [key, distribution(values)]),
            ),
            observations,
            target33ms: distribution(samples).p95 <= 33,
            limitation: 'completed hardware work; no Electron or physical presentation',
          })
        }
    const navigation = []
    for (const cold of [true, false])
      for (let i = 0; i < 30; i++)
        navigation.push(
          await study.render({
            ...base,
            quality: 'normal',
            batchSize: 32,
            waitAfterBatch: false,
            histogram: false,
            identity: 'same-sharp-revision',
            cold,
            view: { ...base.view, x: i % 2 ? 3 : -3 },
          }),
        )
    const retained = navigation.slice(31).filter((value) => !value.cancelled && value.retainedSharp)
    expect(retained.length).toBeGreaterThan(20)
    await writeFile(
      info.outputPath('gpu-components.json'),
      JSON.stringify(
        {
          provenance: await provenance([
            'scripts/research/pipeline/gpu-study.ts',
            'src/renderer/src/preview/hdr-presenter.ts',
            'src/renderer/src/preview/hdr-render-cache.ts',
            'src/shared/aces-wgsl.ts',
          ]),
          adapter: {
            vendor: adapter!.info.vendor,
            architecture: adapter!.info.architecture,
            device: adapter!.info.device,
            description: adapter!.info.description,
            isFallbackAdapter: adapter!.info.isFallbackAdapter,
          },
          backend: 'native Dawn via webgpu',
          source: spec,
          viewport: base.viewport,
          dpr: base.dpr,
          uploadAndMipsMs: study.uploadAndMipsMs,
          allocatedGpuBytes: study.allocatedGpuBytes,
          actualPeakVramBytes: null,
          cases,
          navigation,
          productionThresholds: 'unchanged',
          gpuTimestampQueries:
            'not collected; wall fences prove completed work but are not hardware-duration queries',
          logicalDiskTraffic: 'none during frame evaluation',
          cacheConditions: 'source and pipelines warm; edits invalidate rendered After tiles',
        },
        null,
        2,
      ),
    )
    expect(errors).toEqual([])
  } finally {
    study.destroy()
    device.destroy()
  }
})
for (const source of ['fine-pattern', 'real-photograph'])
  // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
  test(`${source}: normal-detail tiles preserve exact ACES references while bounded drafts report detail errors`, async ({}, info) => {
    test.setTimeout(90000)
    const { create, globals } = await import('webgpu')
    Object.assign(globalThis, globals)
    retainedGpu = create([])
    const adapter = await retainedGpu.requestAdapter()
    test.skip(
      !adapter || adapter.info.isFallbackAdapter,
      'Hardware adapter unavailable; exact GPU proof is incomplete.',
    )
    const device = await adapter!.requestDevice(),
      spec = imageSpec(192, 128)
    let input = pattern(spec)
    if (source === 'real-photograph') {
      const bytes = await sharp('tests/fixtures/photos/alpine-lake.jpg')
        .resize(spec.width, spec.height, { fit: 'fill' })
        .toColourspace('srgb')
        .ensureAlpha()
        .raw()
        .toBuffer()
      input = new Float32Array(bytes.length)
      for (let p = 0; p < bytes.length; p += 4) {
        const linear = Array.from(bytes.subarray(p, p + 3), (v) => {
          const x = v / 255
          return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
        })
        for (let c = 0; c < 3; c++)
          input[p + c] = linear.reduce((sum, v, i) => sum + v * SRGB_TO_2020[c * 3 + i], 0) * 4
        input[p + 3] = bytes[p + 3] / 255
      }
    }
    const study = await createTileStudy(device, { ...spec, data: input })
    const request: TileRequest = {
      viewport: { width: 192, height: 128 },
      view: { fit: false, scale: 1, x: 0, y: 0 },
      dpr: 1,
      parameters: new Array<number>(44).fill(0),
      identity: 'exact',
      quality: 'normal',
      batchSize: 32,
      waitAfterBatch: false,
      histogram: false,
    }
    try {
      await study.render(request)
      const normal = await study.readProof()
      await study.render({ ...request, quality: 'draft' })
      const draft = await study.readProof()
      const reference = new Float32Array(input.length)
      let maximumRatio = 0
      for (let i = 0; i < input.length; i += 4) {
        const rgb = renderDisplay([input[i], input[i + 1], input[i + 2]], {
          mode: 'hdr',
          peak: 10,
          colorSpace: 'rec2020',
        }).rgb
        reference.set([...rgb, input[i + 3]], i)
        for (let c = 0; c < 3; c++)
          maximumRatio = Math.max(
            maximumRatio,
            Math.abs(normal[i + c] - rgb[c]) / (2e-6 + Math.abs(rgb[c]) * 2e-5),
          )
      }
      const normalMetrics = detail(reference, normal, spec.width, spec.height),
        draftMetrics = detail(reference, draft, spec.width, spec.height)
      await writeFile(
        info.outputPath(`sharp-detail-${source}.json`),
        JSON.stringify(
          {
            provenance: await provenance([
              'src/shared/aces-wgsl.ts',
              'scripts/research/pipeline/gpu-study.ts',
              'tests/fixtures/photos/alpine-lake.jpg',
            ]),
            source: { name: source, ...spec },
            photographPreparation:
              '192x128 sRGB raster -> exact sRGB EOTF -> linear Rec.2020 -> 4x calibration exposure; not RAW tone/color acceptance',
            maximumExactToleranceRatio: maximumRatio,
            exactTolerance: '2e-6 + 2e-5 * abs(reference); unchanged existing ACES limit',
            normalMetrics,
            draftMetrics,
            visualAcceptance: 'not granted; numerical/detail proof only',
          },
          null,
          2,
        ),
      )
      expect(maximumRatio).toBeLessThanOrEqual(1)
      if (source === 'fine-pattern')
        expect(draftMetrics.edgeEnergyRatio).toBeLessThan(normalMetrics.edgeEnergyRatio * 0.7)
    } finally {
      study.destroy()
      device.destroy()
    }
  })
