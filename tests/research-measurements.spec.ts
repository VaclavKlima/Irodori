import { expect, test } from '@playwright/test'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { buildNative } from '../scripts/research/build-native.mjs'
import { NativeService } from '../scripts/research/pipeline/native-service'
import { GraphExecutor } from '../scripts/research/pipeline/graph'
import { operations } from '../scripts/research/pipeline/operations'
import { imageSpec, workloads } from '../scripts/research/pipeline/workloads'
import { whole } from '../scripts/research/pipeline/contract'
import { detail, distribution } from '../scripts/research/pipeline/metrics'
import { PreviewLut } from '../scripts/research/pipeline/lut'
import { renderDisplay, type RenderingRGB } from '../src/shared/display-rendering'
import { provenance, sampleProcesses } from '../scripts/research/pipeline/provenance'
import sharp from 'sharp'
import { attachResearchEvidence } from './research.helpers'

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test.afterEach(async ({}, info) => attachResearchEvidence(info))

const evidenceSources = [
  'scripts/research/native/pointwise.cpp',
  'scripts/research/rust/src/main.rs',
  'scripts/research/pipeline/graph.ts',
  'scripts/research/pipeline/operations.ts',
]
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('thirty warmed graph observations per extensibility workload record bounded memory and cached upstream reuse', async ({}, info) => {
  const w = workloads(undefined, imageSpec(256, 192)),
    observations: Record<string, unknown> = {}
  const cpuStart = process.cpuUsage()
  for (const [name, original] of Object.entries(w.recipes)) {
    const engine = new GraphExecutor(operations, w.assets, 8 * 1024 ** 2, 64)
    const input = {
      purpose: 'preview' as const,
      region: whole(original.nodes.find((n) => n.id === original.output)!.output),
      revision: 1,
      scale: 1,
      approximation: 'exact' as const,
    }
    const cold = performance.now()
    engine.render(original, input)
    const firstJobMs = performance.now() - cold
    const times: number[] = []
    for (let i = 0; i < 30; i++) {
      const recipe = structuredClone(original)
      const grade = [...recipe.nodes].reverse().find((node) => node.operation === 'grading')
      if (grade) grade.parameters.amount = (i + 1) / 40
      const start = performance.now()
      engine.render(recipe, { ...input, revision: i + 2 })
      times.push(performance.now() - start)
    }
    observations[name] = {
      firstJobMs,
      warmedMs: distribution(times),
      stats: { ...engine.stats },
      memoryBudgetBytes: engine.budgetBytes,
      sourceBytesOutsideTileBudget: w.data.byteLength,
      classification: 'synthetic graph calibration; cached repeats when no grading node exists',
    }
    expect(engine.stats.peakBytes).toBeLessThanOrEqual(engine.budgetBytes)
    engine.clear()
  }
  await writeFile(
    info.outputPath('graph-measurements.json'),
    JSON.stringify(
      {
        provenance: await provenance(evidenceSources),
        dimensions: w.spec,
        observations,
        orchestratorCpuUs: process.cpuUsage(cpuStart),
        processPeakRssBytes: process.resourceUsage().maxRSS * 1024,
        gpu: 'not used',
        logicalDiskTraffic: 'none during evaluation; evidence writes excluded',
      },
      null,
      2,
    ),
  )
})
for (const candidate of ['cpp', 'rust'] as const)
  // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
  test(`${candidate} CPU service: five launches, thirty warmed jobs, bounded threads and one/two photographs`, async ({}, info) => {
    test.setTimeout(120000)
    const built =
      candidate === 'cpp' ? buildNative('pointwise', info.outputPath('build')) : undefined
    const binary =
      built?.binary ??
      process.env.LUMA_RESEARCH_RUST_BINARY ??
      resolve('artifacts/research-rust/release/luma-pipeline-research')
    test.skip(
      !existsSync(binary),
      'Rust/Rayon is not built. Install Rust, build the isolated Cargo manifest, and supply LUMA_RESEARCH_RUST_BINARY. Architecture comparison remains incomplete.',
    )
    const w = workloads(undefined, imageSpec(1024, 768)),
      freshLaunches: unknown[] = []
    const ev = 0.5,
      amount = 0.25
    const reference = new Float32Array(w.data.length)
    const cpuStart = performance.now()
    for (let i = 0; i < reference.length; i++) {
      if (i % 4 === 3) {
        reference[i] = w.data[i]
        continue
      }
      const v = Math.fround(w.data[i] * 2 ** ev)
      reference[i] = v + (amount * v * Math.abs(v)) / (1 + Math.abs(v))
    }
    const jsSingleJobMs = performance.now() - cpuStart
    for (let launch = 0; launch < 5; launch++) {
      const at = performance.now(),
        service = new NativeService(binary, 1)
      try {
        const result = await service.process(w.data, 1024, 768, launch)
        freshLaunches.push({
          launch,
          workerLaunchThroughResponseMs: performance.now() - at,
          endToEndMs: result.endToEndMs,
          computeMs: result.computeMs,
          ownedBytes: result.ownedBytes,
        })
        expect(Buffer.from(result.data.buffer).equals(Buffer.from(reference.buffer))).toBe(true)
      } finally {
        await service.close()
      }
    }
    const cases: unknown[] = []
    for (const totalThreads of [1, 2, 4])
      for (const inFlight of [1, 2]) {
        if (totalThreads < inFlight) continue
        const threadsPerService = totalThreads / inFlight
        const services = Array.from(
          { length: inFlight },
          () => new NativeService(binary, threadsPerService),
        )
        const samples: number[] = [],
          compute: number[] = [],
          owned: number[] = []
        try {
          for (const service of services) await service.process(w.data, 1024, 768, 0)
          const resources = await sampleProcesses([
            process.pid,
            ...services.map((s) => s.child.pid!),
          ])
          const batchStart = performance.now(),
            batchRepetitions: number[] = []
          for (let repetition = 0; repetition < 3; repetition++) {
            const repetitionStart = performance.now()
            for (let i = 0; i < 30; i += inFlight) {
              // Independent photographs overlap only in this explicitly bounded experiment.
              const jobs = await Promise.all(
                services.map((service, slot) => service.process(w.data, 1024, 768, i + slot)),
              )
              for (const result of jobs) {
                samples.push(result.endToEndMs)
                compute.push(result.computeMs)
                owned.push(result.ownedBytes)
                expect(Buffer.from(result.data.buffer).equals(Buffer.from(reference.buffer))).toBe(
                  true,
                )
              }
            }
            batchRepetitions.push(performance.now() - repetitionStart)
          }
          const wallMs = performance.now() - batchStart
          let settled = false,
            outcome = 'pending'
          const pending = services[0].process(w.data, 1024, 768, 99).then(
            () => {
              settled = true
              outcome = 'completed'
            },
            () => {
              settled = true
              outcome = 'cancelled'
            },
          )
          await new Promise((resolve) => setTimeout(resolve, 1))
          const outstandingAtCancellation = !settled
          const cancelAt = performance.now()
          await Promise.all(services.map((service) => service.close()))
          await pending
          cases.push({
            totalComputeThreads: totalThreads,
            inFlight,
            threadsPerService,
            endToEndMs: distribution(samples),
            computeMs: distribution(compute),
            wallMs,
            batchRepetitionsMs: batchRepetitions,
            jobsPerSecond: (samples.length / wallMs) * 1000,
            ownedBytes: Math.max(...owned) * inFlight,
            transferredBytesPerPhoto: w.data.byteLength * 2 + 64,
            cancellationOfOutstandingRequestMs: performance.now() - cancelAt,
            outstandingAtCancellation,
            cancellationOutcome: outcome,
            resources,
            peakRam: null,
            peakVram: null,
            aggregatePerJobCpuTime: null,
            limitation:
              'Repeated fixture calibration; includes pipe copies. Resource sample is not a peak. Cancellation covers an outstanding request including transport, not a kernel-only stop.',
          })
        } finally {
          await Promise.all(services.map((service) => service.close()))
        }
      }
    await writeFile(
      info.outputPath(`${candidate}-measurements.json`),
      JSON.stringify(
        {
          provenance: await provenance(evidenceSources),
          build:
            built?.manifest ??
            (existsSync(`${binary}.json`)
              ? JSON.parse(await readFile(`${binary}.json`, 'utf8'))
              : { unverifiedBuildManifest: binary }),
          dimensions: w.spec,
          sourceHash: w.sourceHash,
          jsSingleJobMs,
          freshLaunches,
          cases,
          acceptance:
            'CPU transport calibration only; not export, application first-load, or an architecture winner',
        },
        null,
        2,
      ),
    )
  })
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('exact ACES versus labeled preview-only LUT reports numerical/detail errors on patterns and a real fixture', async ({}, info) => {
  test.setTimeout(120000)
  const target = { mode: 'hdr' as const, peak: 10, colorSpace: 'rec2020' as const },
    cases: unknown[] = []
  const photograph = await sharp('tests/fixtures/photos/alpine-lake.jpg')
    .resize(192, 128, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer()
  for (const edge of [17, 33]) {
    const buildAt = performance.now(),
      lut = new PreviewLut(edge, target),
      buildMs = performance.now() - buildAt
    for (const source of ['fine-pattern', 'real-photograph']) {
      const width = 192,
        height = 128,
        w = workloads(undefined, imageSpec(width, height))
      const input =
        source === 'fine-pattern'
          ? w.data
          : Float32Array.from(photograph, (v, i) => (i % 4 === 3 ? v / 255 : (v / 255) ** 2.2 * 4))
      const exact = new Float32Array(input.length),
        approximate = new Float32Array(input.length),
        exactTimes: number[] = [],
        lutTimes: number[] = []
      for (let run = 0; run < 30; run++) {
        let at = performance.now()
        for (let i = 0; i < input.length; i += 4) {
          exact.set(
            renderDisplay(Array.from(input.subarray(i, i + 3)) as RenderingRGB, target).rgb,
            i,
          )
          exact[i + 3] = input[i + 3]
        }
        exactTimes.push(performance.now() - at)
        at = performance.now()
        for (let i = 0; i < input.length; i += 4) {
          approximate.set(lut.sample(Array.from(input.subarray(i, i + 3)) as RenderingRGB), i)
          approximate[i + 3] = input[i + 3]
        }
        lutTimes.push(performance.now() - at)
      }
      const metrics = detail(exact, approximate, width, height)
      for (const [label, data] of [
        ['exact', exact],
        ['preview-lut', approximate],
      ] as const) {
        const display = Buffer.from(
          Array.from(data, (v, i) =>
            i % 4 === 3
              ? Math.round(v * 255)
              : Math.round(Math.max(0, Math.min(1, v / 10)) ** (1 / 2.2) * 255),
          ),
        )
        await sharp(display, { raw: { width, height, channels: 4 } })
          .png()
          .toFile(info.outputPath(`${edge}-${source}-${label}-SDR-contact-proof.png`))
      }
      cases.push({
        source,
        sourceInterpretation:
          source === 'real-photograph'
            ? 'sRGB fixture converted with power 2.2 and scaled 4x for calibration, not RAW color validation'
            : 'signed linear fine pattern and 16x impulse',
        edge,
        buildMs,
        identity: lut.identity,
        bytes: lut.data.byteLength,
        exactMs: distribution(exactTimes),
        lutMs: distribution(lutTimes),
        metrics,
        fallbackCount: lut.fallbackCount,
        visualAcceptance: 'not granted; SDR contact proofs require separate review',
      })
      expect(exact.every(Number.isFinite)).toBe(true)
      expect(approximate.every(Number.isFinite)).toBe(true)
    }
    expect(() => lut.sample([0, 0, 0], 'export')).toThrow('forbidden')
    expect(lut.sample([100, -1, 0])).toEqual(renderDisplay([100, -1, 0], target).rgb)
  }
  await writeFile(
    info.outputPath('lut-measurements.json'),
    JSON.stringify(
      {
        provenance: await provenance([
          'src/shared/display-rendering.ts',
          'src/shared/aces-core.ts',
          'scripts/research/pipeline/lut.ts',
          'tests/fixtures/photos/alpine-lake.jpg',
        ]),
        cases,
        productionExactThresholds: 'unchanged',
        approximationApproval: false,
      },
      null,
      2,
    ),
  )
})
