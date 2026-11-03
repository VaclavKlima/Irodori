import { build } from 'esbuild'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { promisify } from 'node:util'
import { nativeCpuExecutable } from '../src/main/native-cpu-executable'
import { NativeMaskController } from '../src/main/native-mask-controller'
import { PreviewProcess } from '../src/main/preview-process'
import { readHdrStrips } from '../src/main/processing/hdr-processing'
import { neutralAdjustments, type AdjustmentParameters } from '../src/shared/adjustments'
import {
  HDR_JPEG_SOURCE_VERSION,
  SDR_TARGET,
  type DisplayTarget,
  type HdrWorkingAsset,
} from '../src/shared/hdr'
import type { HdrAnalysisDomain } from '../src/shared/hdr-statistics'
import { automaticLensSettings } from '../src/shared/lens'
import { NATIVE_HDR_MASK_VERSION } from '../src/shared/native-hdr-mask'
import { expect, test } from './electron.fixture'
import { createOracle } from './hdr-mask-oracle.helpers'
import { controllerFixture, resourcePolicy, sha } from './native-mask-controller.helpers'

test('native mask portability preserves exact classifications in the actual Electron renderer', async ({
  irodori,
}, info) => {
  const executable = await nativeCpuExecutable(resolve('out/main'))
  test.skip(
    !(await access(executable).then(
      () => true,
      () => false,
    )),
    'Build the selected native HDR mask helper first.',
  )
  const capability = JSON.parse((await promisify(execFile)(executable, ['--capabilities'])).stdout)
  const path = resolve('out/renderer/assets', `mask-portability-${randomUUID()}.js`)
  const compiled = await build({
    stdin: {
      contents: `import { analyzeHdr, hdrStatistics } from './src/shared/hdr-statistics';
        globalThis.portabilityOracle = ({pixels,parameters,asset,target,domain}) => {
          const mask = new Uint8Array(pixels.length / 4);
          analyzeHdr(new Float32Array(pixels), parameters, asset, target, hdrStatistics(domain,target,asset), mask);
          const v = new DataView(new ArrayBuffer(8));
          v.setFloat64(0,Math.atan2(-11.507243131689393,-6.353538344650907));
          return { mask: Array.from(mask), atan2: v.getBigUint64(0).toString(16) };
        };`,
      resolveDir: resolve('.'),
    },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    write: false,
  })
  await writeFile(path, compiled.outputFiles[0].contents, { flag: 'wx' })
  const t = await controllerFixture({
    nativeExecutable: executable,
    mask: {
      arithmeticSha256: capability.mask.arithmeticSha256,
      parameters: (_record, request) => request.parameters,
    },
  })
  const receipts: unknown[] = []
  let mismatches = 0
  try {
    await irodori.page.addScriptTag({
      url: new URL(`./assets/${basename(path)}`, irodori.page.url()).href,
    })
    const source = await t.source('native-portability-three-strips', 31, 129)
    // Include representable neighbours of the exact white/headroom boundaries.
    const boundary = new Float32Array([
      1,
      1,
      1,
      1,
      1,
      1,
      1 + 2 ** -23,
      1,
      1,
      1 + 2 ** -23,
      1,
      1,
      1 + 2 ** -23,
      1,
      1,
      1,
      2,
      2,
      2,
      1,
      -0.1,
      0.4,
      0.8,
      0.5,
      0,
      0,
      0,
      0,
    ])
    const authored = await t.source('native-portability-authored-boundaries', 7, 1, boundary)
    authored.asset.source = {
      processing: 'hdr-v1',
      colorSpace: 'rec2020',
      whitePoint: 'D65',
      transfer: 'linear',
      alpha: 'straight',
      decoder: 'synthetic-authored-portability',
      orientation: 'applied-once',
      version: HDR_JPEG_SOURCE_VERSION,
      normalization: { referenceWhite: 1, sourceSaturation: null },
      display: { encoding: 'iso-21496-1-jpeg', headroom: 10, referenceWhiteNits: 203 },
    }
    for (const record of [source, authored])
      for (const domain of ['working-hdr', 'content-hdr', 'output'] as const)
        for (const colorSpace of ['srgb', 'display-p3'] as const)
          for (const parameters of [
            neutralAdjustments,
            {
              ...neutralAdjustments,
              exposureEv: 0.75,
              contrast: 20,
              highlights: -30,
              shadows: 25,
              whites: 12,
              blacks: -8,
              saturation: 35,
              vibrance: -20,
            },
          ]) {
            const target: DisplayTarget = {
              ...SDR_TARGET,
              colorSpace,
              mode: 'hdr',
              requested: 'hdr',
              peak: 2,
              headroom: 2,
            }
            const request = t.maskRequest(record, { domain, target, parameters })
            const output = await t.controller.renderMask(request)
            expect(output.kind).toBe('mask')
            if (output.kind !== 'mask') throw new Error(output.reason)
            const owner = t.controller.acquireMask(new URL(output.url))!
            try {
              const actual = await readFile(owner.path)
              const expected = await irodori.page.evaluate(
                ({ pixels, parameters, asset, target, domain }) =>
                  (
                    globalThis as unknown as {
                      portabilityOracle: (input: {
                        pixels: number[]
                        parameters: AdjustmentParameters
                        asset: HdrWorkingAsset
                        target: DisplayTarget
                        domain: HdrAnalysisDomain
                      }) => { mask: number[]; atan2: string }
                    }
                  ).portabilityOracle({ pixels, parameters, asset, target, domain }),
                {
                  pixels: Array.from(record.pixels),
                  parameters,
                  asset: record.asset,
                  target,
                  domain,
                },
              )
              const differences = [...actual.keys()].filter((i) => actual[i] !== expected.mask[i])
              mismatches += differences.length
              receipts.push({
                source: record.asset.sha256,
                domain,
                target,
                parameters,
                differentBytes: differences.length,
                firstDifferences: differences
                  .slice(0, 16)
                  .map((i) => ({ index: i, native: actual[i], renderer: expected.mask[i] })),
                rendererAtan2: expected.atan2,
              })
            } finally {
              owner.release()
              await t.controller.releaseMask(request.sessionId, output.maskId)
            }
          }
    await writeFile(
      info.outputPath('qualification.json'),
      JSON.stringify({ qualified: mismatches === 0, capability, receipts }, null, 2),
    )
    expect(
      mismatches,
      'Portability requires exact classification without a tolerance change.',
    ).toBe(0)
  } finally {
    await t.close()
    await rm(path, { force: true })
  }
})

for (const original of [
  'tests/fixtures/sony-zv1.ARW',
  'tests/fixtures/research-sony/originals/DSC03243.ARW',
])
  test(`native mask portability preserves every photographic mask mip for ${original}`, async ({
    irodori,
  }, info) => {
    test.setTimeout(300000)
    const executable = await nativeCpuExecutable(resolve('out/main'))
    test.skip(
      !(await access(executable).then(
        () => true,
        () => false,
      )),
      'Build the selected native HDR mask helper first.',
    )
    const capability = JSON.parse(
      (await promisify(execFile)(executable, ['--capabilities'])).stdout,
    )
    const directory = info.outputPath('photographic-source')
    await mkdir(directory)
    const worker = new PreviewProcess(resolve('out/main/preview-worker.js'))
    const bundle = resolve('out/renderer/assets', `mask-photo-portability-${randomUUID()}.js`)
    let controller: NativeMaskController | undefined
    let oracle: Awaited<ReturnType<typeof createOracle>> | undefined
    let phase = 'source-preparation'
    const cleanupErrors: unknown[] = []
    try {
      const metadata = await worker.inspect(resolve(original), new AbortController().signal)
      const prepared = await worker.renderFull(
        resolve(original),
        directory,
        new AbortController().signal,
        { metadata, settings: automaticLensSettings, revision: 1, workingOnly: true },
      )
      await worker.close()
      const asset = prepared.linear!.hdr!
      const sourcePath = resolve(directory, 'linear.f32')
      const ref = {
        photoId: sha(await readFile(original)),
        cacheId: randomUUID(),
        workingSha256: asset.sha256,
        renderingIdentity: `portability-${asset.sha256}`,
      }
      const parameters = {
        ...neutralAdjustments,
        exposureEv: 0.6,
        contrast: 18,
        highlights: -25,
        shadows: 20,
        whites: 12,
        blacks: -7,
        saturation: 25,
        vibrance: 35,
      }
      const target = {
        ...SDR_TARGET,
        requested: 'hdr' as const,
        mode: 'hdr' as const,
        peak: 2,
        headroom: 2,
      }
      controller = new NativeMaskController({
        root: info.outputPath('native-masks'),
        executable: async () => executable,
        foreground: async (work, signal) => {
          signal.throwIfAborted()
          return work()
        },
        mask: {
          arithmeticSha256: capability.mask.arithmeticSha256,
          checkTarget: () => {},
          acquireSource: async (request, signal) => {
            signal.throwIfAborted()
            expect(request.source).toEqual(ref)
            const file = await open(sourcePath, 'r')
            return {
              source: ref,
              asset,
              file,
              parameters,
              policy: resourcePolicy(),
              check: async (revision, active) => {
                active.throwIfAborted()
                expect(revision).toBe(1)
              },
              release: () => file.close(),
            }
          },
        },
      })
      await controller.open()
      phase = 'oracle-setup'
      const compiled = await build({
        entryPoints: ['tests/native-hdr-mask-parity.worker.ts'],
        bundle: true,
        format: 'iife',
        platform: 'browser',
        write: false,
      })
      await writeFile(bundle, compiled.outputFiles[0].contents, { flag: 'wx' })
      oracle = await createOracle(irodori.page, basename(bundle))
      const sessionId = randomUUID()
      phase = 'native-mask'
      const output = await controller.renderMask({
        version: NATIVE_HDR_MASK_VERSION,
        sessionId,
        requestId: randomUUID(),
        source: ref,
        generation: 1,
        expectedSettingsRevision: 1,
        comparison: 'after',
        domain: 'content-hdr',
        parameters,
        target,
        existingOwners: { ramBytes: 0, vramBytes: 0 },
      })
      expect(output.kind).toBe('mask')
      if (output.kind !== 'mask') throw new Error(output.reason)
      const owner = controller.acquireMask(new URL(output.url))!
      try {
        phase = 'oracle-start'
        const runtime = await oracle.handle.evaluate((o, request) => o.start(request), {
          // Oracle strips travel through the bounded test relay, never this marker URL.
          asset: { ...asset, url: output.url },
          parameters,
          target,
          nativeSha256: output.sha256,
        })
        expect(runtime.primitiveMismatches).toEqual([])
        const native = await open(owner.path, 'r')
        try {
          let index = 0
          phase = 'stream-comparison'
          for await (const pixels of readHdrStrips(sourcePath, asset)) {
            const rgba = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength),
              bytes = Buffer.alloc(pixels.length / 4)
            expect(
              (await native.read(bytes, 0, bytes.length, index * asset.width * 64)).bytesRead,
            ).toBe(bytes.length)
            await oracle.handle.evaluate((o, value) => o.source(value.index, value.bytes), {
              index,
              bytes: rgba.toString('base64'),
            })
            await oracle.handle.evaluate((o, value) => o.native(value.index, value.bytes), {
              index,
              bytes: bytes.toString('base64'),
            })
            index++
          }
          const result = await oracle.handle.evaluate((o) => o.finish())
          await writeFile(
            info.outputPath('photographic-qualification.json'),
            JSON.stringify(
              { original, sourceSha256: ref.photoId, asset, capability, runtime, result },
              null,
              2,
            ),
          )
          expect(result.differentBytes).toBe(0)
          expect(result.levels.every((level) => level.differentBytes === 0)).toBe(true)
        } finally {
          await native.close()
        }
      } finally {
        owner.release()
        await controller.releaseMask(sessionId, output.maskId)
      }
    } catch (error) {
      await writeFile(
        info.outputPath('portability-failure.json'),
        JSON.stringify(
          { phase, error: String(error), pageClosed: irodori.page.isClosed() },
          null,
          2,
        ),
      ).catch(() => undefined)
      throw error
    } finally {
      for (const cleanup of [
        () => oracle?.close(),
        () => controller?.close(),
        () => worker.close(),
        () => rm(bundle, { force: true }),
      ])
        try {
          await cleanup()
        } catch (error) {
          cleanupErrors.push(error)
        }
    }
    if (cleanupErrors.length)
      throw new AggregateError(cleanupErrors, 'Native portability cleanup failed.')
  })
