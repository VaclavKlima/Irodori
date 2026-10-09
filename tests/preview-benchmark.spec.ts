import { build } from 'esbuild'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PreviewProcess } from '../src/main/preview-process'
import type { PreviewPresenter } from '../src/renderer/src/preview/presenter'
import { automaticLensSettings } from '../src/shared/lens'
import { expect, test } from './electron.fixture'
import { recordBenchmark } from './benchmark.helpers'

test('benchmarks RAW processing and actual Electron frame presentation', async ({ luma }, info) => {
  test.skip(
    process.env.LUMA_PREVIEW_BENCHMARK !== '1',
    'Run npm run benchmark:preview for the hardware benchmark.',
  )
  // Direct CPU ACES proofs are deliberately included; preserve every cold/revisit sample.
  test.setTimeout(600_000)
  const root = info.outputPath('frames')
  await mkdir(root, { recursive: true })
  const legacyPath = join(root, 'legacy.mjs')
  await writeFile(
    legacyPath,
    `
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { LibRaw } from '@colorhythm/libraw-wasm';
sharp.concurrency(1); sharp.cache({memory:32,files:0,items:20});
process.on('message',async ({path,output,type})=>{
 if(type==='close') process.exit(0);
 if(type==='release') return;
 try {
  await LibRaw.initialize(); const d=new LibRaw(); await d.waitUntilReady();
  const b=await readFile(path); d.open(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength));
  d.setHalfSize(0);d.setDemosaic(3);d.setUseCameraWb(1);d.setOutputColor(1);
  d.setGamma(0,1/2.4);d.setGamma(1,12.92);d.setOutputBps(8);d.unpack();d.dcrawProcess();
  const pixels=d.dcrawMakeMemImage();d.dispose();
  await sharp(pixels.data,{raw:{width:pixels.width,height:pixels.height,channels:3}})
   .withIccProfile('srgb').toColourspace('srgb').png({compressionLevel:3,palette:false}).toFile(join(output,'legacy.png'));
  process.send({result:{width:pixels.width,height:pixels.height}});
 } catch(e) {process.send({error:String(e)});}
});
`,
  )
  const legacy = new PreviewProcess(legacyPath)
  const cpuPath = join(root, 'cpu.mjs')
  await writeFile(
    cpuPath,
    `process.env.LUMA_PREVIEW_BACKEND = 'cpu';\nawait import(${JSON.stringify(pathToFileURL(resolve('out/main/preview-worker.js')).href)});\n`,
  )
  const cpu = new PreviewProcess(cpuPath)
  const current = new PreviewProcess(resolve('out/main/preview-worker.js'))
  const correctedCpu = new PreviewProcess(cpuPath)
  const correctedGpu = new PreviewProcess(resolve('out/main/preview-worker.js'))
  const sample = resolve(process.env.LUMA_RAW_BENCHMARK_FILE ?? 'tests/fixtures/sony-zv1.ARW')
  const metadataReader = new PreviewProcess(resolve('out/main/preview-worker.js'))
  const metadata = await metadataReader.inspect(sample, new AbortController().signal)
  await metadataReader.close()
  const options = { metadata, settings: automaticLensSettings, revision: 0 }
  // The isolated benchmark serves only its two output files. Production handlers and
  // user libraries are never involved. Both formats use the same streamed transport.
  await luma.app.evaluate(({ protocol }, root) => {
    const fs = process.getBuiltinModule('fs')
    const streams = process.getBuiltinModule('stream')
    const path = process.getBuiltinModule('path')
    protocol.unhandle('luma-photo')
    protocol.handle('luma-photo', async (request) => {
      const match = new URL(request.url).pathname.match(
        /^\/(legacy|current)\/([0-3])-(legacy|cpu|gpu|cpu-corrected|gpu-corrected)$/,
      )
      if (!match) return new Response('Not found', { status: 404 })
      const legacy = match[1] === 'legacy'
      const file = path.join(
        root,
        `${match[2]}-${match[3]}`,
        match[1] === 'legacy' ? 'legacy.png' : 'full.rgba',
      )
      return new Response(
        streams.Readable.toWeb(fs.createReadStream(file)) as ReadableStream<Uint8Array>,
        {
          headers: {
            'Content-Type': legacy ? 'image/png' : 'application/octet-stream',
            'Content-Length': String(fs.statSync(file).size),
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-store',
          },
        },
      )
    })
  }, root)
  await luma.page.reload()
  const presenterBundle = await build({
    entryPoints: ['src/renderer/src/preview/presenter.ts'],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'LumaBenchmark',
    define: { 'import.meta.url': JSON.stringify('file:///unused-benchmark-worker.js') },
  })
  await luma.page.evaluate(
    `${presenterBundle.outputFiles[0].text}; globalThis.lumaBenchmark = LumaBenchmark;`,
  )

  const results: {
    kind: string
    generationMs: number
    presentationMs: number
    totalMs: number
    correctionMs?: number
  }[] = []
  try {
    for (let repetition = 0; repetition < 4; repetition++)
      for (const kind of ['legacy', 'cpu', 'gpu', 'cpu-corrected', 'gpu-corrected']) {
        const processor =
          kind === 'legacy'
            ? legacy
            : kind === 'cpu'
              ? cpu
              : kind === 'gpu'
                ? current
                : kind === 'cpu-corrected'
                  ? correctedCpu
                  : correctedGpu
        processor.releaseFrame()
        const directory = join(root, `${repetition}-${kind}`)
        await mkdir(directory)
        const start = performance.now()
        const result = await processor.renderFull(
          sample,
          directory,
          new AbortController().signal,
          kind.endsWith('-corrected') ? options : undefined,
        )
        const generationMs = performance.now() - start
        if (kind !== 'legacy')
          expect(result.diagnostics?.backend, JSON.stringify(result.diagnostics)).toBe(
            kind.split('-')[0],
          )
        // Warm presentation is only a few milliseconds. Sample multiple revisits so
        // one compositor delay or collection does not dominate the comparison.
        for (let cached = 0; cached <= 8; cached++) {
          const presentationMs = await luma.page.evaluate(
            async ({ kind, result, cached, repetition }) => {
              // Start on the same animation-frame boundary. Otherwise the short warm
              // samples mostly measure a random wait until the next refresh.
              await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
              const start = performance.now()
              const canvas = document.createElement('canvas')
              canvas.width = result.width
              canvas.height = result.height
              canvas.style.cssText = 'position:fixed;inset:0;width:800px;height:auto;z-index:10000'
              let presenter: PreviewPresenter | undefined
              if (kind === 'legacy') {
                const image = new Image()
                image.src = `luma-photo://library/legacy/${repetition}-${kind}`
                await image.decode()
                canvas.getContext('2d', { colorSpace: 'srgb' })!.drawImage(image, 0, 0)
              } else {
                const cache = window as unknown as { benchmarkBitmap?: ImageBitmap }
                if (!cached || !cache.benchmarkBitmap) {
                  const response = await fetch(
                    `luma-photo://library/current/${repetition}-${kind}`,
                    {
                      cache: 'no-store',
                    },
                  )
                  const bytes = await response.arrayBuffer()
                  const digest = await crypto.subtle.digest('SHA-256', bytes)
                  const hash = [...new Uint8Array(digest)]
                    .map((v) => v.toString(16).padStart(2, '0'))
                    .join('')
                  if (hash !== result.sha256) throw new Error('Frame integrity mismatch')
                  cache.benchmarkBitmap?.close()
                  cache.benchmarkBitmap = await createImageBitmap(
                    new ImageData(new Uint8ClampedArray(bytes), result.width, result.height, {
                      colorSpace: 'srgb',
                    }),
                  )
                }
                const Constructor = (
                  window as unknown as {
                    lumaBenchmark: { PreviewPresenter: typeof PreviewPresenter }
                  }
                ).lumaBenchmark.PreviewPresenter
                // Match the application: present RGBA immediately through Canvas2D, then
                // prepare the WebGL editing surface after first display (measured below).
                presenter = new Constructor(canvas, true, () => {
                  throw new Error('Benchmark context lost')
                })
                presenter.setBitmap(cache.benchmarkBitmap)
                canvas.style.cssText =
                  'position:fixed;inset:0;width:800px;height:600px;z-index:10000'
                presenter.draw(
                  result,
                  { width: 800, height: 600 },
                  {
                    fit: true,
                    scale: Math.min(800 / result.width, 600 / result.height),
                    x: 0,
                    y: 0,
                  },
                  { shadows: 0, whites: 0, blacks: 0, exposureEv: 0, contrast: 0, highlights: 0 },
                )
              }
              document.body.append(canvas)
              await new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
              )
              presenter?.dispose()
              canvas.remove()
              canvas.width = 0
              canvas.height = 0
              return performance.now() - start
            },
            { kind, result, cached, repetition },
          )
          results.push({
            kind: `${kind}${cached ? '-cached' : ''}`,
            correctionMs: cached ? undefined : result.diagnostics?.timings.correctionMs,
            generationMs: cached ? 0 : generationMs,
            presentationMs,
            totalMs: (cached ? 0 : generationMs) + presentationMs,
          })
        }
        await rm(directory, { recursive: true, force: true })
      }
    const median = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b)
      const middle = Math.floor(sorted.length / 2)
      return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
    }
    const medians = Object.fromEntries(
      [
        'legacy',
        'cpu',
        'gpu',
        'cpu-corrected',
        'gpu-corrected',
        'legacy-cached',
        'cpu-cached',
        'gpu-cached',
        'cpu-corrected-cached',
        'gpu-corrected-cached',
      ].map((kind) => [kind, median(results.filter((r) => r.kind === kind).map((r) => r.totalMs))]),
    )
    console.log({ sample: basename(sample), medians })
    await writeFile(
      info.outputPath('benchmark.json'),
      JSON.stringify({ sample: basename(sample), medians, results }, null, 2),
    )
    const baseline = process.env.LUMA_PREVIEW_BASELINE
      ? JSON.parse(await readFile(process.env.LUMA_PREVIEW_BASELINE, 'utf8'))
      : undefined
    await recordBenchmark(info, {
      family: 'preview',
      measurements: {
        sample: basename(sample),
        medians,
        coldSamplesPerBackend: 4,
        cachedSamplesPerBackend: 32,
        ...(baseline
          ? {
              uncorrectedRegressionPercent: Object.fromEntries(
                ['cpu', 'gpu'].map((kind) => [
                  kind,
                  (medians[kind] / baseline.medians[kind] - 1) * 100,
                ]),
              ),
            }
          : {}),
      },
      gates: [
        { metric: 'gpu-corrected', operator: '<', limit: medians['cpu-corrected'] },
        { metric: 'gpu', operator: '<', limit: Math.min(medians.legacy, medians.cpu) },
        { metric: 'gpu-cached', operator: '<', limit: medians['legacy-cached'] * 1.15 },
        ...(baseline
          ? ['cpu', 'gpu'].map((kind) => ({
              metric: kind,
              operator: '<' as const,
              limit: baseline.medians[kind] * 1.15,
            }))
          : []),
      ],
      evidence: [info.outputPath('benchmark.json')],
    })
    expect(medians['gpu-corrected']).toBeLessThan(medians['cpu-corrected'])
    if (baseline) {
      for (const kind of ['cpu', 'gpu'])
        expect(medians[kind], `${kind} uncorrected regression`).toBeLessThan(
          baseline.medians[kind] * 1.15,
        )
    }
    expect(medians.gpu).toBeLessThan(medians.legacy)
    expect(medians.gpu).toBeLessThan(medians.cpu)
    expect(medians['gpu-cached']).toBeLessThan(medians['legacy-cached'] * 1.15)
  } finally {
    await legacy.close()
    await cpu.close()
    await current.close()
    await correctedCpu.close()
    await correctedGpu.close()
  }
})
