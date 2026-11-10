import { openPreviewOptions } from './preview-options.helpers'
import { build } from 'esbuild'
import sharp from 'sharp'
import { writeFile } from 'node:fs/promises'
import type { JSHandle } from '@playwright/test'
import { expect, test } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { HDR_CACHE_MAX_TILES } from '../src/renderer/src/preview/hdr-render-cache'
import { observeNativeCpuReplies } from './retired-presentation.helpers'
import { observeAdjustmentHalfReadback } from './adjustment-half-readback.helpers'

export function rendererAgreement(fixtures: readonly ('synthetic' | 'raster' | 'raw')[]) {
  for (const fixture of fixtures)
    test(`${fixture} ${fixture === 'raw' ? 'WebGPU' : 'WebGL'} combined adjustments match CPU, reuses the working texture and coalesces edits after GPU retry`, async ({
      irodori,
    }, info) => {
      test.setTimeout(fixture === 'raw' ? 240000 : 120000)
      const { page } = irodori
      let source =
        fixture === 'raw' ? 'tests/fixtures/sony-zv1.ARW' : 'tests/fixtures/photos/alpine-lake.jpg'
      if (fixture === 'synthetic') {
        source = info.outputPath('ramp.png')
        const pixels = Buffer.alloc(256 * 256 * 4)
        for (let y = 0; y < 256; y++)
          for (let x = 0; x < 256; x++) {
            const offset = (y * 256 + x) * 4
            pixels.set([x, y, (x + y) >> 1, x < 100 ? 128 : 255], offset)
          }
        await sharp(pixels, { raw: { width: 256, height: 256, channels: 4 } })
          .png()
          .toFile(source)
      }
      const halfReadback = fixture === 'raw' ? await observeAdjustmentHalfReadback(page) : null
      await importPhotos(irodori.app, page, [source])
      const preview = page.getByTestId('main-preview')
      await expect(preview).toHaveAttribute('data-editing', 'ready', { timeout: 40000 })
      const id = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id
      if (fixture === 'raw') {
        await openPreviewOptions(page)
        await page.getByLabel('Preview display mode').selectOption('sdr')
        await expect(preview).toHaveAttribute('data-backend', 'webgpu-hdr')
        await expect(preview).toHaveAttribute('data-quality', 'normal')
      }
      const compiled = await build({
        stdin: {
          contents: `export { renderAdjustments, neutralAdjustments } from './src/shared/adjustments'; export { adjustHdr, outputHdr, hdrAdjustmentMatrix, encodeHdr, SDR_TARGET } from './src/shared/hdr'`,
          resolveDir: process.cwd(),
        },
        bundle: true,
        format: 'iife',
        globalName: 'highlightsReference',
        write: false,
      })
      await page.evaluate(compiled.outputFiles[0].text)
      await page.evaluate(async (id) => {
        const parentRequestId = document.querySelector<HTMLCanvasElement>(
          '[data-testid="main-preview"]',
        )?.dataset.previewRequestId
        if (!parentRequestId) throw new Error('The presented source request is unavailable.')
        const result = await window.irodori.requestEditingPreview(
          id,
          crypto.randomUUID(),
          parentRequestId,
        )
        const bytes = await (await fetch(result.linear!.url!)).arrayBuffer()
        const target = window as unknown as { highlightsTest: unknown }
        const state = {
          frame: result,
          data: new Float32Array(bytes),
          uploads: 0,
          uploadStacks: [] as string[],
          readback: undefined as
            { data: Uint8ClampedArray; width: number; height: number; serial: string } | undefined,
        }
        target.highlightsTest = state
        if (result.linear!.hdr) {
          const upload = GPUQueue.prototype.writeTexture
          GPUQueue.prototype.writeTexture = function (
            ...args: Parameters<GPUQueue['writeTexture']>
          ) {
            state.uploads++
            return Reflect.apply(upload, this, args)
          }
          const draw = CanvasRenderingContext2D.prototype.drawImage
          let publication: MutationObserver | undefined
          CanvasRenderingContext2D.prototype.drawImage = function (...args: unknown[]) {
            Reflect.apply(draw, this, args)
            const source = args[0]
            if (!(source instanceof HTMLCanvasElement) || source.dataset.backend !== 'webgpu-hdr')
              return
            const configuration = source.getContext('webgpu')?.getConfiguration()
            if (!configuration) return
            // The presenter copies each completed frame before WebGPU discards its drawing buffer.
            // Read the same completed frame at full canvas size and in its configured primaries.
            const copy = new OffscreenCanvas(source.width, source.height).getContext('2d', {
              colorSpace: configuration.colorSpace,
              willReadFrequently: true,
            })!
            copy.drawImage(source, 0, 0)
            publication?.disconnect()
            const beforePublication = source.dataset.presentationSerial
            const pixels = copy.getImageData(0, 0, source.width, source.height, {
              colorSpace: configuration.colorSpace,
            })
            const captured = {
              data: pixels.data,
              width: source.width,
              height: source.height,
              serial: '',
              colorSpace: pixels.colorSpace,
              sourceConfiguration: {
                colorSpace: configuration.colorSpace,
                toneMapping: configuration.toneMapping,
              },
              sourceTestId: source.dataset.testid,
              sameCanvas: source === document.querySelector('[data-testid="main-preview"]'),
            }
            state.readback = captured
            // The retained copy precedes the final blit fence. Stamp these pixels
            // only when this same canvas publishes its completed presentation.
            const completed = new MutationObserver(() => {
              const serial = source.dataset.presentationSerial
              if (serial === beforePublication || !serial) return
              if (state.readback === captured) captured.serial = serial
              completed.disconnect()
            })
            publication = completed
            completed.observe(source, {
              attributes: true,
              attributeFilter: ['data-presentation-serial'],
            })
          }
        } else {
          const upload = WebGL2RenderingContext.prototype.texImage2D
          WebGL2RenderingContext.prototype.texImage2D = function (...args: unknown[]) {
            state.uploads++
            state.uploadStacks.push(
              `${args
                .slice(0, 9)
                .map((v) => (typeof v === 'number' ? v : typeof v))
                .join(',')}\n${new Error().stack}`,
            )
            return Reflect.apply(upload, this, args)
          }
        }
        await window.irodori.releaseFullPreview(result.requestId)
      }, id)
      await page.getByRole('combobox', { name: 'Preview zoom' }).selectOption('1')
      const compare = () =>
        page.evaluate(async (halfReadback) => {
          const test = window as unknown as {
            highlightsTest: {
              data: Float32Array
              frame: import('../src/shared/contracts').FullPreview
              uploads: number
              uploadStacks: string[]
              readback?: { data: Uint8ClampedArray; width: number; height: number; serial: string }
            }
            highlightsReference: typeof import('../src/shared/adjustments') &
              typeof import('../src/shared/hdr')
          }
          const { frame, data } = test.highlightsTest
          const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')!
          const viewport = canvas.parentElement!
          const box = viewport.getBoundingClientRect()
          const parameters = {
            saturation: Number(canvas.dataset.saturation),
            vibrance: Number(canvas.dataset.vibrance),
            whiteBalance: JSON.parse(canvas.dataset.whiteBalance!),
            shadows: Number(canvas.dataset.shadows),
            whites: Number(canvas.dataset.whites),
            blacks: Number(canvas.dataset.blacks),
            exposureEv: Number(canvas.dataset.exposure),
            highlights: Number(canvas.dataset.highlights),
            contrast: Number(canvas.dataset.contrast),
          }
          const gl = canvas.dataset.backend === 'webgl2' ? canvas.getContext('webgl2') : null
          const hdrTarget =
            canvas.dataset.backend === 'webgpu-hdr'
              ? await window.irodori.getDisplayState()
              : test.highlightsReference.SDR_TARGET
          let max = 0
          const samples: unknown[] = []
          for (const dx of [-48, 0, 48]) {
            const x = Math.floor(canvas.width / 2 + dx * devicePixelRatio)
            const y = Math.floor(canvas.height / 2)
            const sx = Math.floor(
              (x + 0.5) / devicePixelRatio -
                box.width / 2 -
                Number(viewport.dataset.panX) +
                frame.width / 2,
            )
            const sy = Math.floor(
              (y + 0.5) / devicePixelRatio -
                box.height / 2 -
                Number(viewport.dataset.panY) +
                frame.height / 2,
            )
            const offset = (sy * frame.width + sx) * 4
            const selected =
              canvas.dataset.comparison === 'before' ||
              (canvas.dataset.comparison === 'split' &&
                (x + 0.5) / devicePixelRatio < box.width / 2)
                ? test.highlightsReference.neutralAdjustments
                : parameters
            const expected = frame.linear!.hdr
              ? new Uint8ClampedArray([
                  ...test.highlightsReference
                    .outputHdr(
                      test.highlightsReference.adjustHdr(
                        [data[offset], data[offset + 1], data[offset + 2]],
                        selected,
                        test.highlightsReference.hdrAdjustmentMatrix(
                          selected,
                          frame.linear!.hdr.whiteBalance,
                        ) ?? undefined,
                      ),
                      hdrTarget,
                    )
                    .rgb.map((value) =>
                      Math.round(test.highlightsReference.encodeHdr(value) * 255),
                    ),
                  Math.round(data[offset + 3] * 255),
                ])
              : test.highlightsReference.renderAdjustments(
                  data.slice(offset, offset + 4),
                  selected,
                  frame.linear!.transform,
                )
            const actual = new Uint8Array(4)
            if (gl) gl.readPixels(x, canvas.height - 1 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, actual)
            else if (canvas.dataset.backend === 'webgpu-hdr') {
              const readback = halfReadback?.readback() ?? test.highlightsTest.readback
              if (
                !readback ||
                readback.serial !== canvas.dataset.presentationSerial ||
                readback.width !== canvas.width ||
                readback.height !== canvas.height
              )
                return {
                  max: Infinity,
                  uploads: test.highlightsTest.uploads,
                  halfReadback: halfReadback?.state(),
                }
              const at = (y * canvas.width + x) * 4
              if ('format' in readback && readback.format === 'rgba16float') {
                if (!readback.sourceIdentity.endsWith(`:${frame.linear!.hdr!.sha256}`))
                  throw new Error('The actual half-plane does not match the reference source.')
                // The GPU surface already contains display-encoded target primaries.
                // Apply only 8-bit quantization; expected pixels encodeHdr exactly once above.
                actual.set(
                  Array.from({ length: 4 }, (_, channel) => {
                    const value = readback.data[at + channel]
                    if (!Number.isFinite(value) || (channel === 3 && value !== 1))
                      throw new Error('The actual opaque half-plane pixel is invalid.')
                    return Math.max(0, Math.min(255, Math.round(value * 255)))
                  }),
                )
              } else
                actual.set(Array.from({ length: 4 }, (_, channel) => readback.data[at + channel]))
            } else actual.set(canvas.getContext('2d')!.getImageData(x, y, 1, 1).data)
            samples.push({
              x,
              y,
              sx,
              sy,
              input: Array.from(data.subarray(offset, offset + 4)),
              actual: Array.from(actual),
              expected: Array.from(expected),
              neighbors: [-1, 0, 1].flatMap((dy) =>
                [-1, 0, 1].map((dx) => {
                  const at = ((sy + dy) * frame.width + sx + dx) * 4
                  return { dx, dy, rgba: Array.from(data.subarray(at, at + 4)) }
                }),
              ),
            })
            for (let c = 0; c < 4; c++) max = Math.max(max, Math.abs(actual[c] - expected[c]))
          }
          const config =
            canvas.dataset.backend === 'webgpu-hdr'
              ? canvas.getContext('webgpu')?.getConfiguration()
              : undefined
          return {
            max,
            uploads: test.highlightsTest.uploads,
            uploadStacks: test.highlightsTest.uploadStacks,
            samples,
            parameters,
            target: hdrTarget,
            configuration: config && {
              colorSpace: config.colorSpace,
              format: config.format,
              alphaMode: config.alphaMode,
              toneMapping: config.toneMapping,
            },
            readback:
              test.highlightsTest.readback &&
              Object.fromEntries(
                Object.entries(test.highlightsTest.readback).filter(([key]) => key !== 'data'),
              ),
            geometry: {
              width: canvas.width,
              height: canvas.height,
              viewport: { width: box.width, height: box.height },
              dpr: devicePixelRatio,
              panX: viewport.dataset.panX,
              panY: viewport.dataset.panY,
              frame: { width: frame.width, height: frame.height },
            },
          }
        }, halfReadback)
      const agree = async (limit: number, timeout?: number) => {
        try {
          await expect
            .poll(async () => (await compare()).max, { timeout })
            .toBeLessThanOrEqual(limit)
        } catch (error) {
          const diagnostic = await compare()
          const path = info.outputPath('pixel-agreement.json')
          await writeFile(path, JSON.stringify(diagnostic, null, 2))
          await info.attach('pixel-agreement', {
            path,
            contentType: 'application/json',
          })
          throw error
        }
      }
      if (fixture === 'raw') {
        await page.evaluate(async (id) => {
          const state = await window.irodori.getEdits(id)
          await window.irodori.updateEdits(id, { shadows: 100 }, state.revision)
        }, id)
        await expect(preview).toHaveAttribute('data-shadows', '100')
        await agree(1)
        // Exercise software presentation primaries independently of the physical panel gamut.
        // Chromium must discard the old drawing-buffer color space in both directions.
        for (const [index, p3] of [true, false, true, false].entries()) {
          const target = await page.evaluate(
            async ({ p3, unconfigured }) => {
              const state = await window.irodori.getDisplayState()
              // Source reloads unconfigure the reused canvas before its next presentation.
              if (unconfigured)
                document
                  .querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')!
                  .getContext('webgpu')!
                  .unconfigure()
              return window.irodori.reportDisplayCapabilities({ ...state.capabilities!, p3 })
            },
            { p3, unconfigured: index >= 2 },
          )
          await expect(preview).toHaveAttribute('data-target-generation', String(target.generation))
          await agree(1)
        }
      }
      for (const [
        exposureEv,
        contrast,
        highlights,
        shadows = 0,
        whites = 0,
        blacks = 0,
        saturation = 0,
        vibrance = 0,
      ] of [
        [0, 0, 0, 0, 0, 0, -100, 100],
        [0, 0, 0, 0, 0, 0, 100, 100],
        [0.75, 35, -65, 80, -40, 25, 35, -60],
        [0, 0, 0, -100, 0, 0],
        [0, 0, 0, 100, 0, 0],
        [0, 0, 0, 0, -100, 0],
        [0, 0, 0, 0, 100, 0],
        [0, 0, 0, 0, 0, -100],
        [0, 0, 0, 0, 0, 100],
        [0.75, 35, -65, 80, -40, 25],
        [-0.5, -35, 40, -80, 60, -30],
        [0, 35, -100],
        [0, -100, 0],
        [0, 35, 100],
        [0, 100, 0],
        [-1.25, 35, 50],
        [-1.25, 50, 0],
        [1, 35, -35],
        [1, -35, 0],
        [0, 35, 0],
        [0, 0, 0],
      ]) {
        await page.evaluate(
          async ({
            id,
            exposureEv,
            contrast,
            highlights,
            shadows,
            whites,
            blacks,
            saturation,
            vibrance,
            fixture,
          }) => {
            const state = await window.irodori.getEdits(id)
            await window.irodori.updateEdits(
              id,
              {
                shadows,
                whites,
                blacks,
                exposureEv,
                contrast,
                highlights,
                saturation,
                vibrance,
                whiteBalance:
                  fixture === 'raw' && exposureEv !== 0
                    ? { mode: 'custom', kelvin: 8000, tint: 25 }
                    : { mode: 'as-shot' },
              },
              state.revision,
            )
          },
          {
            shadows,
            whites,
            blacks,
            saturation,
            vibrance,
            id,
            exposureEv,
            contrast,
            highlights,
            fixture,
          },
        )
        await expect(preview).toHaveAttribute('data-shadows', String(shadows))
        await expect(preview).toHaveAttribute('data-whites', String(whites))
        await expect(preview).toHaveAttribute('data-blacks', String(blacks))
        await expect(preview).toHaveAttribute('data-contrast', String(contrast))
        await expect(preview).toHaveAttribute('data-highlights', String(highlights))
        await expect(preview).toHaveAttribute('data-exposure', String(exposureEv))
        await expect(preview).toHaveAttribute('data-saturation', String(saturation))
        await expect(preview).toHaveAttribute('data-vibrance', String(vibrance))
        await agree(1)
      }
      await page.evaluate(async (id) => {
        const state = await window.irodori.getEdits(id)
        await window.irodori.updateEdits(id, { exposureEv: 1 }, state.revision)
      }, id)
      await expect(preview).toHaveAttribute('data-exposure', '1')
      await preview.focus()
      await preview.press('\\')
      await expect(preview).toHaveAttribute('data-comparison', 'before')
      await agree(1)
      await preview.press('y')
      await expect(preview).toHaveAttribute('data-comparison', 'split')
      await agree(1)
      await preview.press('y')
      const uploadEvidence = await compare()
      expect(uploadEvidence.uploads, JSON.stringify(uploadEvidence.uploadStacks)).toBe(0)
      const sourceBeforeLoss = await preview.getAttribute('data-src'),
        native = await observeNativeCpuReplies(irodori.app),
        retiredWorkers: string[] = []
      expect(sourceBeforeLoss).toBeTruthy()
      page.on('worker', (worker) => {
        if (/\/(?:hdr-)?presentation-worker-/.test(worker.url())) retiredWorkers.push(worker.url())
      })
      let gpuOverride: JSHandle<{ restore: () => void }> | undefined
      if (fixture === 'raw') {
        await expect(preview).toHaveAttribute('data-source-uploads', '1')
        const cachedTiles = Number(await preview.getAttribute('data-cached-tiles'))
        expect(cachedTiles).toBeGreaterThan(0)
        expect(cachedTiles).toBeLessThanOrEqual(HDR_CACHE_MAX_TILES)
        gpuOverride = await page.evaluateHandle(() => {
          const element = document.querySelector<HTMLCanvasElement>(
              '[data-testid="main-preview"]',
            )!,
            device = element.getContext('webgpu')!.getConfiguration()!.device,
            descriptor = Object.getOwnPropertyDescriptor(navigator, 'gpu')
          Object.defineProperty(navigator, 'gpu', {
            value: { requestAdapter: async () => null },
            configurable: true,
          })
          device.destroy()
          return {
            restore: () => {
              if (descriptor) Object.defineProperty(navigator, 'gpu', descriptor)
              else Reflect.deleteProperty(navigator, 'gpu')
            },
          }
        })
      } else {
        const supported = await preview.evaluate((element) => {
          const extension = (element as HTMLCanvasElement)
            .getContext('webgl2')!
            .getExtension('WEBGL_lose_context')
          extension?.loseContext()
          return !!extension
        })
        expect(supported, 'The real context-loss extension is required for this proof.').toBe(true)
      }
      const error = page.getByTestId('preview-gpu-error')
      await expect(error).toHaveAttribute('role', 'alert')
      await expect(error).toContainText('GPU preview unavailable')
      await expect(preview).toHaveAttribute('data-presentation-error', /.+/)
      await expect(preview).toHaveAttribute('data-editing', 'unavailable')
      await expect(preview).toBeHidden()
      expect(retiredWorkers).toEqual([])
      expect((await native.evaluate((control) => control.state())).requests).toEqual([])
      if (gpuOverride) {
        await gpuOverride.evaluate((control) => control.restore())
        await gpuOverride.dispose()
      }
      await error.getByRole('button', { name: 'Retry GPU', exact: true }).click()
      await expect(error).toHaveCount(0)
      await expect(preview).toHaveAttribute(
        'data-backend',
        fixture === 'raw' ? 'webgpu-hdr' : 'webgl2',
      )
      await expect(preview).toHaveAttribute('data-editing', 'ready', { timeout: 60000 })
      await expect(preview).toBeVisible()
      await expect(preview).toHaveAttribute('data-src', sourceBeforeLoss!)
      if (fixture === 'raw') await expect(preview).toHaveAttribute('data-quality', 'normal')
      await agree(1)
      // Deliberately queue updates without waiting for the GPU's previous frame.
      await page.evaluate(async (id) => {
        for (const highlights of [-100, 100, -50, 80, 25]) {
          const state = await window.irodori.getEdits(id)
          await window.irodori.updateEdits(
            id,
            {
              highlights,
              contrast: -highlights,
              shadows: -highlights,
              whites: highlights,
              blacks: -highlights,
              saturation: highlights,
              vibrance: -highlights,
            },
            state.revision,
          )
        }
      }, id)
      await expect(preview).toHaveAttribute('data-highlights', '25')
      await expect(preview).toHaveAttribute('data-shadows', '-25')
      await expect(preview).toHaveAttribute('data-whites', '25')
      await expect(preview).toHaveAttribute('data-blacks', '-25')
      if (fixture === 'raw')
        await expect(preview).toHaveAttribute('data-quality', 'normal', { timeout: 180000 })
      await agree(2, 30000)
      await preview.focus()
      await preview.press('y')
      await expect(preview).toHaveAttribute('data-comparison', 'split')
      await agree(2, 30000)
      expect(retiredWorkers).toEqual([])
      expect((await native.evaluate((control) => control.close())).requests).toEqual([])
      await native.dispose()
    })
}
