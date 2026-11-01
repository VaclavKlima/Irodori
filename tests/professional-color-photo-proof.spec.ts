import { execFile } from 'node:child_process'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import sharp from 'sharp'
import type { FullPreview } from '../src/shared/contracts'
import type { EditSettings } from '../src/shared/edits'
import { neutralColorMixer, COLOR_MIXER_VERSION } from '../src/shared/color-mixer'
import { neutralColorGrading, COLOR_GRADING_VERSION } from '../src/shared/color-grading'
import { PREVIEW_ASSET_VERSION } from '../src/shared/preview-frame'
import { test, expect } from './electron.fixture'
import { activateButton } from './button.helpers'
import { importPhotos } from './import.helpers'
import { nativeOriginalHash } from './professional-editor-native.helpers'
import { foregroundTest } from './foreground'
import { focusPreviewWindow } from './preview-pan.helpers'

const run = promisify(execFile)
const bundle = 'assets/tests/images/raster/wikimedia/forearm-hair'
const input = {
  path: `${bundle}/originals/ArmHair.jpg`,
  sha256: '02f590a33003698f750166798552a63b038456c008e9f3a220ed3544b79db4b8',
  bytes: 2054629,
  width: 4272,
  height: 2848,
} as const
const attribution = {
  author: 'Zephyris',
  credit: 'Zephyris, ArmHair.jpg (2010 archived original), Wikimedia Commons, CC BY-SA 3.0.',
  source: 'https://commons.wikimedia.org/w/index.php?title=File:ArmHair.jpg&oldid=801603795',
  license: 'https://creativecommons.org/licenses/by-sa/3.0/',
  changes:
    'Native centre crop and the declared Irodori color edits; generated photographic derivatives remain licensed under CC BY-SA 3.0.',
} as const
const mixer = {
  ...structuredClone(neutralColorMixer),
  ranges: {
    ...structuredClone(neutralColorMixer.ranges),
    red: { hue: 2, saturation: 4, luminance: 0 },
    orange: { hue: 4, saturation: 8, luminance: 2 },
  },
}
const grading = {
  ...structuredClone(neutralColorGrading),
  tones: {
    shadows: { hue: 220, saturation: 5, luminance: 0 },
    midtones: { hue: 32, saturation: 4, luminance: 0 },
    highlights: { hue: 42, saturation: 3, luminance: 0 },
  },
}
const recipes = [
  {
    id: 'baseline',
    label: 'Baseline',
    patch: {
      saturation: 0,
      vibrance: 0,
      colorMixer: neutralColorMixer,
      colorGrading: neutralColorGrading,
    },
  },
  {
    id: 'mixer',
    label: 'Moderate mixer only',
    patch: { saturation: 0, vibrance: 0, colorMixer: mixer, colorGrading: neutralColorGrading },
  },
  {
    id: 'grading',
    label: 'Moderate grading only',
    patch: { saturation: 0, vibrance: 0, colorMixer: neutralColorMixer, colorGrading: grading },
  },
  {
    id: 'combined',
    label: 'Combined intensity, mixer and grading',
    patch: { saturation: 6, vibrance: 10, colorMixer: mixer, colorGrading: grading },
  },
] as const
const sourceFiles = [
  'src/renderer/src/preview/presenter.ts',
  'src/shared/creative-color-glsl.ts',
  'src/shared/color-mixer.ts',
  'src/shared/color-grading.ts',
]
const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

const nativeCaptureReason =
  'Composited WebGL photographic capture requires a mapped Wayland surface; the hidden capture times out on Bazzite.'

test(
  'an approved untagged SDR photograph produces four source-bound native WebGL color review crops',
  foregroundTest(nativeCaptureReason),
  async ({ irodori }, info) => {
    test.setTimeout(180000)
    const { app, page, userDataDir } = irodori,
      browserWindow = await app.browserWindow(page),
      proofs: Record<string, unknown>[] = [],
      manifest: Record<string, unknown> = {
        version: 'professional-color-photo-proof-v1',
        input,
        attribution,
        operatorVersions: { mixer: COLOR_MIXER_VERSION, grading: COLOR_GRADING_VERSION },
        purpose:
          'Four actual application GPU preview crops for subsequent human photographic review. Passing verifies source/settings/view/capture ownership only; it does not certify arithmetic, skin accuracy, photographic quality, RAW color, sharpening, denoising, export or broader Goal 1 acceptance.',
        profile:
          'Processed authored JPEG; the original has no embedded ICC or EXIF ColorSpace. The application assumes uncalibrated sRGB. No camera profile or measured physical color reference is claimed.',
        capture:
          'Foreground mapped-window BrowserWindow.capturePage with stayHidden/stayAwake from the hardware WebGL2 presentation. Legacy raster preparation remains separate. No WebGL framebuffer read or artifact resampling. One image pixel per CSS pixel, DPR 1. Integer CSS capture coordinates and their exact continuous decoded-source coordinates are retained; centring can introduce a half-pixel coordinate phase.',
      }
    let failure: string | undefined
    const tracked = [
      input.path,
      `${bundle}/manifest.json`,
      `${bundle}/README.md`,
      `${bundle}/LICENSE.md`,
    ]
    await run('git', ['ls-files', '--error-unmatch', '--', ...tracked])
    await run('git', ['diff', '--quiet', 'HEAD', '--', ...tracked])
    expect(await nativeOriginalHash(input.path)).toBe(input.sha256)
    expect((await stat(input.path)).size).toBe(input.bytes)
    const provenance = JSON.parse(await readFile(`${bundle}/manifest.json`, 'utf8')) as {
        files: {
          path: string
          sha256: string
          bytes: number
          width: number
          height: number
          source: { author: string; license: { identifier: string } }
          technicalMetadata: { embeddedIccProfile: boolean; exifColorSpaceDeclaration: boolean }
        }[]
      },
      originalMetadata = await sharp(input.path).metadata(),
      sourceHashes = await Promise.all(
        sourceFiles.map(async (path) => ({ path, sha256: await nativeOriginalHash(path) })),
      )
    expect(provenance.files).toContainEqual(
      expect.objectContaining({
        path: 'originals/ArmHair.jpg',
        sha256: input.sha256,
        bytes: input.bytes,
        width: input.width,
        height: input.height,
      }),
    )
    expect(provenance.files[0].source).toMatchObject({
      author: attribution.author,
      license: { identifier: 'CC-BY-SA-3.0' },
    })
    expect(provenance.files[0].technicalMetadata).toMatchObject({
      embeddedIccProfile: false,
      exifColorSpaceDeclaration: false,
    })
    expect(originalMetadata).toMatchObject({
      format: 'jpeg',
      width: input.width,
      height: input.height,
    })
    expect(originalMetadata.icc).toBeUndefined()
    manifest.provenance = {
      manifestSha256: await nativeOriginalHash(`${bundle}/manifest.json`),
      originalMetadata: {
        format: originalMetadata.format,
        width: originalMetadata.width,
        height: originalMetadata.height,
        space: originalMetadata.space,
        hasIcc: Boolean(originalMetadata.icc),
      },
      sourceHashes,
    }
    await browserWindow.evaluate((window) => {
      window.unmaximize()
      window.setContentSize(1440, 1000)
    })
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([1440, 1000])
    await focusPreviewWindow(app, page)
    const dpr = await page.evaluate(() => devicePixelRatio)
    test.skip(
      dpr !== 1,
      `Native photo crops require actual DPR 1; observed ${dpr}. Other-DPR verification is incomplete.`,
    )
    const gpuFeatures = await app.evaluate(({ app }) => app.getGPUFeatureStatus())
    manifest.gpuFeatures = gpuFeatures
    test.skip(
      !['enabled', 'enabled_force', 'enabled_readback'].includes(gpuFeatures.webgl),
      'Hardware WebGL is unavailable; GPU photographic verification is incomplete.',
    )
    await page.evaluate(() => window.irodori.setPreviewPreference('sdr'))
    if ((await page.getByTestId('console-toggle').getAttribute('aria-expanded')) === 'true')
      await activateButton(page.getByTestId('console-toggle'))
    // Observe only replies requested by the application; never prepare a substitute frame.
    const observed = await app.evaluateHandle(({ ipcMain }) => {
      type Handler = (...args: unknown[]) => unknown
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })
          ._invokeHandlers,
        originals = new Map<string, Handler>(),
        wrappers = new Map<string, Handler>(),
        frames: { channel: string; preview: FullPreview }[] = []
      let dropped = 0
      for (const channel of [
        'preview:hdr',
        'preview:cached',
        'preview:request',
        'preview:editing',
      ]) {
        const original = handlers.get(channel)
        if (!original) throw new Error('A real application preview handler is unavailable.')
        originals.set(channel, original)
        const wrapper: Handler = async (...args) => {
          const result = await original(...args),
            preview = (result as { preview?: FullPreview | null } | undefined)?.preview
          if (preview) {
            if (frames.length < 32) frames.push({ channel, preview: structuredClone(preview) })
            else dropped++
          }
          return result
        }
        wrappers.set(channel, wrapper)
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, wrapper)
      }
      return {
        frame(requestId: string) {
          return frames
            .slice()
            .reverse()
            .find((frame) => frame.preview.requestId === requestId)
        },
        working(photoId: string) {
          return frames
            .slice()
            .reverse()
            .find(
              (frame) => frame.channel === 'preview:editing' && frame.preview.photoId === photoId,
            )
        },
        close() {
          for (const [channel, wrapper] of wrappers)
            if (handlers.get(channel) === wrapper) {
              ipcMain.removeHandler(channel)
              ipcMain.handle(channel, originals.get(channel)!)
            }
          return { frames, dropped }
        },
      }
    })
    await importPhotos(app, page, [resolve(input.path)], false, 'keyboard')
    const photos = await page.evaluate(() => window.irodori.listPhotos()),
      id = photos.photos[0].id,
      managedOriginal = join(userDataDir, 'library', 'originals', id, 'original.jpg'),
      state = () => page.evaluate((id) => window.irodori.getEdits(id), id),
      history = () => page.evaluate((id) => window.irodori.getEditHistory(id), id),
      canvas = page.getByTestId('main-preview'),
      viewport = page.getByTestId('preview-viewport')
    expect(photos.total).toBe(1)
    expect(id).toBe(input.sha256)
    expect(await nativeOriginalHash(managedOriginal)).toBe(input.sha256)
    await expect(canvas).toHaveAttribute('data-editing', 'ready', { timeout: 120000 })
    await expect(canvas).toHaveAttribute('data-backend', 'webgl2')
    await expect(viewport).toHaveAttribute('data-resolution', 'full')
    await page.getByRole('combobox', { name: 'Preview zoom', exact: true }).selectOption('1')
    await expect(viewport).toHaveAttribute('data-scale', '1')
    await expect(viewport).toHaveAttribute('data-mode', 'manual')
    const initialHistory = await history(),
      expected: EditSettings[] = []
    expect(initialHistory).toMatchObject({
      revision: 0,
      settings: {
        processing: 'display-referred-v1',
        noiseReduction: { luminance: 0, chroma: 0 },
        detailSharpening: { amount: 0 },
      },
    })
    expect(initialHistory.snapshots).toHaveLength(1)
    async function snapshot() {
      return canvas.evaluate(async (element) => {
        const viewport = document.querySelector<HTMLElement>('[data-testid="preview-viewport"]')!,
          rect = viewport.getBoundingClientRect(),
          canvasRect = element.getBoundingClientRect(),
          gl = (element as HTMLCanvasElement).getContext('webgl2'),
          debug = gl?.getExtension('WEBGL_debug_renderer_info')
        return {
          sourceUrl: element.getAttribute('data-src'),
          requestId: element.getAttribute('data-preview-request-id'),
          backend: element.getAttribute('data-backend'),
          editing: element.getAttribute('data-editing'),
          geometryRevision: Number(element.getAttribute('data-frame-geometry-revision')),
          colorProgram: element.getAttribute('data-color-program'),
          comparison: element.getAttribute('data-comparison'),
          visible: getComputedStyle(element).visibility,
          parameters: {
            saturation: Number(element.getAttribute('data-saturation')),
            vibrance: Number(element.getAttribute('data-vibrance')),
            colorMixer: JSON.parse(element.getAttribute('data-color-mixer') ?? 'null'),
            colorGrading: JSON.parse(element.getAttribute('data-color-grading') ?? 'null'),
          },
          view: {
            mode: viewport.dataset.mode,
            scale: Number(viewport.dataset.scale),
            panX: Number(viewport.dataset.panX),
            panY: Number(viewport.dataset.panY),
            width: Number(viewport.dataset.imageWidth),
            height: Number(viewport.dataset.imageHeight),
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            canvas: {
              x: canvasRect.x,
              y: canvasRect.y,
              width: canvasRect.width,
              height: canvasRect.height,
              pixelWidth: (element as HTMLCanvasElement).width,
              pixelHeight: (element as HTMLCanvasElement).height,
            },
            dpr: devicePixelRatio,
          },
          renderer: gl && debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : null,
          target: await window.irodori.getDisplayState(),
        }
      })
    }
    let baseline: Awaited<ReturnType<typeof snapshot>> | undefined,
      linearPath: string | undefined,
      linearHash: string | undefined
    try {
      for (const [revision, recipe] of recipes.entries()) {
        if (revision)
          await page.evaluate(
            ({ id, patch, expectedRevision }) =>
              window.irodori.updateEdits(id, patch, expectedRevision),
            { id, patch: recipe.patch, expectedRevision: revision - 1 },
          )
        const settings = { ...initialHistory.settings, ...recipe.patch }
        expected.push(settings)
        await expect.poll(state).toMatchObject({ revision, settings })
        await expect(canvas).toHaveAttribute('data-backend', 'webgl2')
        await expect(canvas).toHaveAttribute('data-editing', 'ready')
        await expect(canvas).toHaveCSS('visibility', 'visible')
        await expect(canvas).toHaveAttribute(
          'data-color-mixer',
          JSON.stringify(settings.colorMixer),
        )
        await expect(canvas).toHaveAttribute(
          'data-color-grading',
          JSON.stringify(settings.colorGrading),
        )
        await expect(canvas).toHaveAttribute('data-saturation', String(settings.saturation))
        await expect(canvas).toHaveAttribute('data-vibrance', String(settings.vibrance))
        if (revision) await expect(canvas).toHaveAttribute('data-color-program', 'ready')
        await expect
          .poll(
            async () => {
              const requestId = await canvas.getAttribute('data-preview-request-id'),
                sourceUrl = await canvas.getAttribute('data-src'),
                reply = requestId
                  ? await observed.evaluate((control, id) => control.frame(id), requestId)
                  : undefined
              return reply?.preview.settingsRevision === revision && reply.preview.url === sourceUrl
            },
            {
              timeout: 120000,
              message: 'The graded full-frame reply must match the displayed request.',
            },
          )
          .toBe(true)
        // These presenter attributes follow the draw; an idle hidden rAF is not a fence.
        manifest.stage = `${recipe.id}:drawn-parameters-ready`
        await writeFile(
          info.outputPath('manifest.json'),
          JSON.stringify({ ...manifest, proofs }, null, 2) + '\n',
        )
        const before = await snapshot()
        expect(before.renderer, 'The actual WebGL renderer must be identified.').toBeTruthy()
        expect(before.renderer).not.toMatch(/swiftshader|llvmpipe|software/i)
        baseline ??= before
        expect(before.view).toEqual(baseline.view)
        expect(before.parameters).toEqual(recipe.patch)
        expect(before.view).toMatchObject({
          mode: 'manual',
          scale: 1,
          width: input.width,
          height: input.height,
          dpr: 1,
        })
        expect(before.target.mode).toBe('sdr')
        const url = new URL(before.sourceUrl!),
          [photoId, kind, version, variant, extra] = url.pathname.split('/').filter(Boolean),
          directory = join(
            userDataDir,
            'library',
            'cache',
            'previews',
            version,
            `${id}-${variant}`,
          ),
          sourceMetadata = JSON.parse(await readFile(join(directory, 'entry.json'), 'utf8')) as {
            width: number
            height: number
            linear: { sha256: string; byteLength: number; transform: unknown }
            settingsRevision?: number
          }
        expect([url.protocol, url.hostname, photoId, kind, version, extra]).toEqual([
          'irodori-photo:',
          'library',
          id,
          'full',
          PREVIEW_ASSET_VERSION,
          undefined,
        ])
        expect(sourceMetadata).toMatchObject({ width: input.width, height: input.height })
        const displayed = await observed.evaluate(
            (control, requestId) => control.frame(requestId),
            before.requestId!,
          ),
          working = await observed.evaluate((control, id) => control.working(id), id),
          displayedFrame = displayed?.preview,
          workingFrame = working?.preview
        expect(displayedFrame).toMatchObject({
          photoId: id,
          requestId: before.requestId,
          settingsRevision: revision,
          url: before.sourceUrl,
          width: input.width,
          height: input.height,
          adjustments: recipe.patch,
        })
        expect(before.geometryRevision).toBe(displayedFrame!.settingsRevision)
        expect(workingFrame).toMatchObject({
          photoId: id,
          width: input.width,
          height: input.height,
        })
        expect(workingFrame!.linear?.url).toBeTruthy()
        expect(workingFrame!.settingsRevision!).toBeLessThanOrEqual(revision)
        const linearUrl = new URL(workingFrame!.linear!.url!),
          [linearPhotoId, linearKind, linearVersion, linearVariant, linearExtra] =
            linearUrl.pathname.split('/').filter(Boolean),
          actualLinearPath = join(
            userDataDir,
            'library',
            'cache',
            'previews',
            linearVersion,
            `${id}-${linearVariant}`,
            'linear.f32',
          )
        expect([
          linearUrl.protocol,
          linearUrl.hostname,
          linearPhotoId,
          linearKind,
          linearVersion,
          linearExtra,
        ]).toEqual(['irodori-photo:', 'library', id, 'linear', PREVIEW_ASSET_VERSION, undefined])
        linearPath ??= actualLinearPath
        expect(actualLinearPath).toBe(linearPath)
        linearHash ??= await nativeOriginalHash(linearPath)
        expect(workingFrame!.linear!.sha256).toBe(linearHash)
        const rect = {
            x: Math.ceil(before.view.rect.x + (before.view.rect.width - 512) / 2),
            y: Math.ceil(before.view.rect.y + (before.view.rect.height - 512) / 2),
            width: 512,
            height: 512,
          },
          imageLeft =
            before.view.rect.x +
            (before.view.rect.width - before.view.width) / 2 +
            before.view.panX,
          imageTop =
            before.view.rect.y +
            (before.view.rect.height - before.view.height) / 2 +
            before.view.panY,
          sourceRoi = { x: rect.x - imageLeft, y: rect.y - imageTop, width: 512, height: 512 }
        expect(rect.x).toBeGreaterThanOrEqual(before.view.rect.x)
        expect(rect.y).toBeGreaterThanOrEqual(before.view.rect.y)
        expect(rect.x + 512).toBeLessThanOrEqual(before.view.rect.x + before.view.rect.width)
        expect(rect.y + 512).toBeLessThanOrEqual(before.view.rect.y + before.view.rect.height)
        expect(Math.abs(sourceRoi.x + 256 - input.width / 2)).toBeLessThanOrEqual(0.5)
        expect(Math.abs(sourceRoi.y + 256 - input.height / 2)).toBeLessThanOrEqual(0.5)
        manifest.stage = `${recipe.id}:capture`
        manifest.pendingCapture = {
          before,
          displayed,
          working,
          rectangle: rect,
          decodedSourceRoi: sourceRoi,
        }
        await writeFile(
          info.outputPath('manifest.json'),
          JSON.stringify(
            {
              ...manifest,
              proofs,
              pendingCapture: {
                before,
                displayed,
                working,
                rectangle: rect,
                decodedSourceRoi: sourceRoi,
              },
            },
            null,
            2,
          ) + '\n',
        )
        const encoded = await test.step(
            `Capture ${recipe.id} from the composited WebGL surface`,
            () =>
              browserWindow.evaluate(async (window, rect) => {
                const image = await window.capturePage(rect, { stayHidden: true, stayAwake: true })
                if (image.isEmpty()) throw new Error('Native photo crop capture is empty.')
                return { png: image.toPNG().toString('base64'), size: image.getSize() }
              }, rect),
            { timeout: 10000 },
          ),
          name = `${recipe.id}-native.png`,
          path = info.outputPath(name)
        expect(encoded.size).toEqual({ width: 512, height: 512 })
        await writeFile(path, Buffer.from(encoded.png, 'base64'))
        const after = await snapshot(),
          confirmed = await state()
        proofs.push({
          name,
          label: recipe.label,
          sha256: await nativeOriginalHash(path),
          revision,
          settings,
          before,
          after,
          sourceMetadata,
          displayed,
          working,
          rectangle: rect,
          decodedSourceRoi: sourceRoi,
          program: revision
            ? 'active creative-color WebGL2 program'
            : 'existing neutral WebGL2 program',
          changes: attribution.changes,
        })
        delete manifest.pendingCapture
        expect({ ...after, target: undefined }).toEqual({ ...before, target: undefined })
        expect(after.target).toMatchObject({
          generation: before.target.generation,
          requested: before.target.requested,
          mode: before.target.mode,
          colorSpace: before.target.colorSpace,
        })
        expect(confirmed).toMatchObject({ revision, settings })
        await info.attach(recipe.id, { path, contentType: 'image/png' })
      }
      const finalHistory = await history(),
        preserved = {
          externalOriginal: await nativeOriginalHash(input.path),
          managedOriginal: await nativeOriginalHash(managedOriginal),
          workingSource: await nativeOriginalHash(linearPath!),
        },
        finalSourceHashes = await Promise.all(
          sourceFiles.map(async (path) => ({ path, sha256: await nativeOriginalHash(path) })),
        )
      manifest.finalHistory = finalHistory
      manifest.preserved = preserved
      manifest.sourceHashesAfter = finalSourceHashes
      expect(finalHistory.snapshots.map((snapshot) => snapshot.settings)).toEqual(expected)
      expect(finalHistory.snapshots[0]).toEqual(initialHistory.snapshots[0])
      expect(preserved).toEqual({
        externalOriginal: input.sha256,
        managedOriginal: input.sha256,
        workingSource: linearHash,
      })
      expect(finalSourceHashes).toEqual(sourceHashes)
      await run('git', ['diff', '--quiet', 'HEAD', '--', ...tracked])
    } catch (error) {
      failure = String(error)
      throw error
    } finally {
      manifest.failure = failure
      manifest.proofs = proofs
      manifest.initialHistory = initialHistory
      manifest.previewObservation = await observed
        .evaluate((control) => control.close())
        .catch((error: unknown) => ({ unavailable: String(error) }))
      await observed.dispose().catch(() => undefined)
      manifest.endingHistory = await history().catch((error: unknown) => ({
        unavailable: String(error),
      }))
      const path = info.outputPath('manifest.json')
      await writeFile(path, JSON.stringify(manifest, null, 2) + '\n')
      await writeFile(
        info.outputPath('gallery.html'),
        `<!doctype html><html lang="en"><meta charset="utf-8"><title>Irodori native color review</title><style>body{background:#171717;color:#ddd;font:15px system-ui;margin:24px}a{color:#9cceff}.proofs{display:flex;gap:20px;overflow-x:auto}figure{margin:0;flex:0 0 512px}img{width:512px;height:512px;max-width:none}pre{white-space:pre-wrap}</style><h1>Native color review</h1><p>${escapeHtml(attribution.credit)} <a href="${attribution.source}">Source</a> · <a href="${attribution.license}">CC BY-SA 3.0</a></p><p>${escapeHtml(attribution.changes)}</p><p>Actual WebGL2 preview captures, 100% at DPR 1. These proofs require human review and do not establish calibrated skin accuracy or full photographic acceptance.</p><div class="proofs">${proofs.map((proof) => `<figure><img src="${proof.name}" alt="${escapeHtml(String(proof.label))}"><figcaption><h2>${escapeHtml(String(proof.label))}</h2><pre>${escapeHtml(JSON.stringify(recipes.find((recipe) => `${recipe.id}-native.png` === proof.name)?.patch, null, 2))}</pre></figcaption></figure>`).join('')}</div></html>`,
      )
      await info.attach('native-photo-proof-manifest', { path, contentType: 'application/json' })
    }
  },
)
