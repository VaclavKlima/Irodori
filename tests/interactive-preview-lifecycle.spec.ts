import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Page, TestInfo } from '@playwright/test'
import { expect, test } from './electron.fixture'
import { foregroundTest } from './foreground'
import { importPhotos } from './import.helpers'
import { ACES_INTERACTIVE_PREVIEW_VERSION } from '../src/shared/aces-preview-wgsl'
import { encodeHdr } from '../src/shared/hdr'
import { HDR_PRESENTATION_BUDGET } from '../src/renderer/src/preview/hdr-memory'
import type { AdjustmentParameters } from '../src/shared/adjustments'

const fixture = 'tests/fixtures/sony-zv1.ARW'
const originalSha256 = '14c9d2912584a3ccc5cf10f554fbe495fc960c36758a14d7d858b36ac5ca88e2'
const raster = 'tests/fixtures/photos/alpine-lake.jpg'
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const parameters: AdjustmentParameters = {
  exposureEv: 1.25,
  contrast: 45,
  highlights: -55,
  shadows: 40,
  whites: 20,
  blacks: -25,
  whiteBalance: { mode: 'custom', kelvin: 4500, tint: 12 },
}
interface FaultObservation {
  rejectedPipelines: number
  rejection?: { name: string; reason?: string; message: string }
  interactiveDispatches: number
  held: number
  waiting: number
  liveBytes: number
  peakBytes: number
  allocations: number
  destructions: number
  uploadedSources: string[]
  cpuRequests: Array<{ sha256: string; parameters: AdjustmentParameters }>
  presentations: Array<{ phase: string; filename: string | null }>
  phase: string
}
interface FaultController {
  observation: FaultObservation
  arm: () => void
  release: () => void
  close: () => void
}
type FaultWindow = Window & { interactiveLifecycle: FaultController }

test.use({ hdrDisplay: true })
const foreground = foregroundTest(
  'Native pointer capture, interrupted HDR GPU presentation and compositor captures require foreground interaction.',
)

async function installFaults(page: Page, rejectInteractive = false) {
  await page.addInitScript((rejectInteractive) => {
    const observation: FaultObservation = {
      rejectedPipelines: 0,
      interactiveDispatches: 0,
      held: 0,
      waiting: 0,
      liveBytes: 0,
      peakBytes: 0,
      allocations: 0,
      destructions: 0,
      uploadedSources: [],
      cpuRequests: [],
      presentations: [],
      phase: 'setup',
    }
    const modules = new WeakMap<GPUShaderModule, string>(),
      interactive = new WeakSet<GPUComputePipeline>(),
      passes = new WeakSet<GPUComputePassEncoder>(),
      resources = new WeakMap<object, number>()
    const original = {
      shader: GPUDevice.prototype.createShaderModule,
      pipeline: GPUDevice.prototype.createComputePipelineAsync,
      buffer: GPUDevice.prototype.createBuffer,
      texture: GPUDevice.prototype.createTexture,
      destroyBuffer: GPUBuffer.prototype.destroy,
      destroyTexture: GPUTexture.prototype.destroy,
      setPipeline: GPUComputePassEncoder.prototype.setPipeline,
      dispatch: GPUComputePassEncoder.prototype.dispatchWorkgroups,
      fence: GPUQueue.prototype.onSubmittedWorkDone,
      present: GPUCanvasContext.prototype.getCurrentTexture,
      post: Worker.prototype.postMessage,
    }
    const own = <T extends object>(resource: T, bytes: number) => {
      resources.set(resource, bytes)
      observation.allocations++
      observation.liveBytes += bytes
      observation.peakBytes = Math.max(observation.peakBytes, observation.liveBytes)
      return resource
    }
    const releaseResource = (resource: object) => {
      const bytes = resources.get(resource)
      if (bytes === undefined) return
      resources.delete(resource)
      observation.liveBytes -= bytes
      observation.destructions++
    }
    GPUDevice.prototype.createShaderModule = function (descriptor) {
      const result = original.shader.call(this, descriptor)
      modules.set(result, descriptor.code)
      return result
    }
    GPUDevice.prototype.createComputePipelineAsync = async function (descriptor) {
      const code = modules.get(descriptor.compute.module),
        isInteractive =
          descriptor.compute.entryPoint === 'renderTile' && !!code && !code.includes('fn dsPow(')
      if (isInteractive && rejectInteractive) {
        rejectInteractive = false
        observation.rejectedPipelines++
        this.pushErrorScope('validation')
        try {
          // The native API rejects this otherwise real F32 module; reference compilation is untouched.
          return await original.pipeline.call(this, {
            ...descriptor,
            compute: { ...descriptor.compute, entryPoint: 'missing_interactive_entry_point' },
          })
        } catch (error) {
          const value = error as Error & { reason?: string }
          observation.rejection = { name: value.name, reason: value.reason, message: value.message }
          throw error
        } finally {
          await this.popErrorScope()
        }
      }
      const result = await original.pipeline.call(this, descriptor)
      if (isInteractive) interactive.add(result)
      return result
    }
    GPUDevice.prototype.createBuffer = function (descriptor) {
      return own(original.buffer.call(this, descriptor), descriptor.size)
    }
    GPUDevice.prototype.createTexture = function (descriptor) {
      const dimensions =
          Symbol.iterator in Object(descriptor.size)
            ? Array.from(descriptor.size as Iterable<number>)
            : [
                (descriptor.size as GPUExtent3DDict).width,
                (descriptor.size as GPUExtent3DDict).height ?? 1,
                (descriptor.size as GPUExtent3DDict).depthOrArrayLayers ?? 1,
              ],
        bytesPerPixel =
          descriptor.format === 'rgba32float' ? 16 : descriptor.format === 'rgba16float' ? 8 : 4
      let bytes = 0
      for (let level = 0; level < (descriptor.mipLevelCount ?? 1); level++)
        bytes +=
          Math.max(1, dimensions[0] >> level) *
          Math.max(1, (dimensions[1] ?? 1) >> level) *
          (dimensions[2] ?? 1) *
          bytesPerPixel
      return own(original.texture.call(this, descriptor), bytes)
    }
    GPUBuffer.prototype.destroy = function () {
      releaseResource(this)
      original.destroyBuffer.call(this)
    }
    GPUTexture.prototype.destroy = function () {
      releaseResource(this)
      original.destroyTexture.call(this)
    }
    GPUComputePassEncoder.prototype.setPipeline = function (pipeline) {
      if (interactive.has(pipeline)) passes.add(this)
      else passes.delete(this)
      original.setPipeline.call(this, pipeline)
    }
    GPUComputePassEncoder.prototype.dispatchWorkgroups = function (...counts) {
      if (passes.has(this)) observation.interactiveDispatches++
      original.dispatch.apply(this, counts)
    }
    let armedAt: number | undefined
    const pending: Array<() => void> = []
    GPUQueue.prototype.onSubmittedWorkDone = function () {
      const completed = original.fence.call(this)
      if (armedAt === undefined || observation.interactiveDispatches <= armedAt) return completed
      armedAt = undefined
      // Delay only delivery of a real completed submission, never manufacture unfinished GPU work.
      return completed.then(
        () =>
          new Promise<undefined>((resolve) => {
            observation.held++
            observation.waiting++
            pending.push(() => {
              observation.waiting--
              resolve(undefined)
            })
          }),
      )
    }
    GPUCanvasContext.prototype.getCurrentTexture = function () {
      if (observation.presentations.length >= 4096)
        throw new Error('Lifecycle observation exceeded its bound.')
      observation.presentations.push({
        phase: observation.phase,
        filename:
          this.canvas instanceof HTMLCanvasElement ? this.canvas.getAttribute('aria-label') : null,
      })
      return original.present.call(this)
    }
    Worker.prototype.postMessage = function (
      this: Worker,
      message: unknown,
      options?: StructuredSerializeOptions | Transferable[],
    ) {
      const value = message as {
        asset?: { kind?: string; sha256: string }
        parameters?: AdjustmentParameters
      }
      if (value?.asset?.kind === 'hdr-working-v1') {
        if (value.parameters)
          observation.cpuRequests.push({
            sha256: value.asset.sha256,
            parameters: structuredClone(value.parameters),
          })
        else observation.uploadedSources.push(value.asset.sha256)
        if (observation.cpuRequests.length + observation.uploadedSources.length > 128)
          throw new Error('Lifecycle source observation exceeded its bound.')
      }
      Reflect.apply(original.post, this, options === undefined ? [message] : [message, options])
    } as Worker['postMessage']
    const release = () => {
      armedAt = undefined
      for (const resolve of pending.splice(0)) resolve()
    }
    Object.assign(window, {
      interactiveLifecycle: {
        observation,
        arm: () => {
          armedAt = observation.interactiveDispatches
        },
        release,
        close: () => {
          release()
          GPUDevice.prototype.createShaderModule = original.shader
          GPUDevice.prototype.createComputePipelineAsync = original.pipeline
          GPUDevice.prototype.createBuffer = original.buffer
          GPUDevice.prototype.createTexture = original.texture
          GPUBuffer.prototype.destroy = original.destroyBuffer
          GPUTexture.prototype.destroy = original.destroyTexture
          GPUComputePassEncoder.prototype.setPipeline = original.setPipeline
          GPUComputePassEncoder.prototype.dispatchWorkgroups = original.dispatch
          GPUQueue.prototype.onSubmittedWorkDone = original.fence
          GPUCanvasContext.prototype.getCurrentTexture = original.present
          Worker.prototype.postMessage = original.post
        },
      } satisfies FaultController,
    })
  }, rejectInteractive)
  await page.reload()
}

const observation = (page: Page) =>
  page.evaluate(() => (window as unknown as FaultWindow).interactiveLifecycle.observation)
const gate = (page: Page, action: 'arm' | 'release') =>
  page.evaluate(
    (action) => (window as unknown as FaultWindow).interactiveLifecycle[action](),
    action,
  )

async function exact(page: Page, exposure = parameters.exposureEv) {
  const canvas = page.getByTestId('main-preview')
  await expect(canvas).toHaveAttribute('data-editing', 'ready', { timeout: 90000 })
  await expect(canvas).toHaveAttribute('data-quality', 'normal', { timeout: 90000 })
  await expect(canvas).toHaveAttribute('data-exposure', String(exposure))
  if ((await canvas.getAttribute('data-backend')) === 'webgpu-hdr') {
    await expect(canvas).toHaveAttribute('data-presented-policy', 'reference')
    await expect
      .poll(() =>
        canvas.evaluate(
          (element) => element.dataset.completedEditSerial === element.dataset.requestedSerial,
        ),
      )
      .toBe(true)
    expect(Number(await canvas.getAttribute('data-allocated-bytes'))).toBeLessThanOrEqual(
      HDR_PRESENTATION_BUDGET,
    )
  }
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
}

async function setup(app: ElectronApplication, page: Page, withRaster = false) {
  await (await app.browserWindow(page)).evaluate((window) => window.setContentSize(1100, 700))
  const workspaces = page.getByRole('navigation', { name: 'Workspaces' })
  await workspaces.getByRole('button', { name: 'Library', exact: true }).click()
  await page.evaluate(() => window.luma.setPreviewPreference('sdr'))
  await importPhotos(app, page, withRaster ? [raster, fixture] : [fixture], false)
  const raw = (await page.evaluate(() => window.luma.listPhotos())).photos.find(
    (photo) => photo.filename === 'sony-zv1.ARW',
  )!
  const before = await page.evaluate((id) => window.luma.getEdits(id), raw.id)
  await page.evaluate(
    ({ id, revision, parameters }) => window.luma.updateEdits(id, parameters, revision),
    { id: raw.id, revision: before.revision, parameters },
  )
  await workspaces.getByRole('button', { name: 'Editor', exact: true }).click()
  await page.getByRole('button', { name: 'Select sony-zv1.ARW', exact: true }).click()
  await exact(page)
  const requestId = randomUUID()
  try {
    const source = await page.evaluate(
      ({ id, requestId }) => window.luma.requestHdrPreview(id, requestId, false, 'hdr'),
      { id: raw.id, requestId },
    )
    if (!source?.linear?.hdr) throw new Error('The existing HDR preview omitted its native source.')
    expect(source.appliedCorrections).toEqual({
      distortion: true,
      vignetting: true,
      chromaticAberration: true,
    })
    return {
      raw,
      source,
      history: await page.evaluate((id) => window.luma.getEditHistory(id), raw.id),
    }
  } finally {
    await page.evaluate((requestId) => window.luma.releaseFullPreview(requestId), requestId)
  }
}

async function beginGesture(page: Page) {
  const label = page.locator('label').filter({ hasText: /^Exposure$/ }),
    id = await label.getAttribute('for')
  if (!id) throw new Error('Exposure has no associated native slider.')
  const slider = page
      .locator('input[type="range"]')
      .and(page.locator(`[id=${JSON.stringify(id)}]`)),
    box = await slider.boundingBox()
  if (!box) throw new Error('Exposure slider is not visible.')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  const canvas = page.getByTestId('main-preview')
  await expect(canvas).toHaveAttribute('data-gesturing', 'true')
  await expect(canvas).toHaveAttribute('data-quality', 'interactive')
  await expect(canvas).toHaveAttribute('data-presented-policy', ACES_INTERACTIVE_PREVIEW_VERSION)
  return slider
}

async function inputExposure(slider: ReturnType<Page['locator']>, value: number) {
  await slider.evaluate((element, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      element,
      String(value),
    )
    element.dispatchEvent(new Event('input', { bubbles: true }))
  }, value)
}

async function capture(app: ElectronApplication, page: Page, path: string) {
  const bounds = await page.getByTestId('main-preview').boundingBox()
  if (!bounds) throw new Error('No native canvas bounds.')
  const image = await (
    await app.browserWindow(page)
  ).evaluate(async (window, bounds) => {
    const image = await window.capturePage({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    })
    return {
      png: image.toPNG().toString('base64'),
      pixels: Array.from(image.resize({ width: 96, height: 64 }).toBitmap()) as number[],
    }
  }, bounds)
  await writeFile(path, Buffer.from(image.png, 'base64'))
  return image.pixels
}

function difference(reference: number[], actual: number[]) {
  expect(actual).toHaveLength(reference.length)
  return Math.max(
    ...actual.map((value, index) => (index % 4 === 3 ? 0 : Math.abs(value - reference[index]))),
  )
}

async function cpuProof(page: Page, id: string, sourceIdentity: string, exposure: number) {
  await expect(page.getByTestId('main-preview')).toHaveAttribute('data-backend', 'canvas2d-hdr-sdr')
  await page.getByLabel('Preview zoom', { exact: true }).selectOption('1')
  await exact(page, exposure)
  const state = await page.evaluate((id) => window.luma.getEdits(id), id)
  const samples = await page.getByTestId('main-preview').evaluate((element) => {
    const canvas = element as HTMLCanvasElement,
      context = canvas.getContext('2d')!,
      viewport = canvas.parentElement!,
      width = Number(viewport.dataset.imageWidth),
      height = Number(viewport.dataset.imageHeight),
      dpr = devicePixelRatio,
      bounds = viewport.getBoundingClientRect(),
      left = (bounds.width - width) / 2 + Number(viewport.dataset.panX),
      top = (bounds.height - height) / 2 + Number(viewport.dataset.panY)
    return [-48, 0, 48].flatMap((dy) =>
      [-64, 0, 64].map((dx) => {
        const px = Math.floor(canvas.width / 2 + dx * dpr),
          py = Math.floor(canvas.height / 2 + dy * dpr)
        return {
          x: Math.floor((px + 0.5) / dpr - left),
          y: Math.floor((py + 0.5) / dpr - top),
          rgba: Array.from(context.getImageData(px, py, 1, 1).data),
        }
      }),
    )
  })
  const expected = []
  for (const sample of samples) {
    const pixel = await page.evaluate(
      ({ id, revision, x, y }) =>
        window.luma.getPhotoPixel(id, revision, x, y, { domain: 'output', target: 'sdr' }),
      { id, revision: state.revision, x: sample.x, y: sample.y },
    )
    expect(pixel.renderingIdentity).toBe(sourceIdentity)
    expect(pixel.alpha).toBe(1)
    const rgb = pixel.rgb.map((value) => Math.round(encodeHdr(value) * 255))
    expect(
      Math.max(...rgb.map((value, c) => Math.abs(value - sample.rgba[c]))),
    ).toBeLessThanOrEqual(1)
    expect(sample.rgba[3]).toBe(255)
    expected.push({ ...sample, expected: rgb })
  }
  return expected
}

async function evidence(
  page: Page,
  info: TestInfo,
  userDataDir: string,
  id?: string,
  detail: unknown = {},
) {
  await gate(page, 'release').catch(() => undefined)
  const observed = await observation(page).catch(() => undefined),
    originalHashAfter = sha(await readFile(fixture)),
    managedHash = id
      ? sha(await readFile(join(userDataDir, 'library', 'originals', id, 'original.arw')))
      : undefined
  await writeFile(
    info.outputPath('interactive-lifecycle.json'),
    JSON.stringify(
      {
        policy: ACES_INTERACTIVE_PREVIEW_VERSION,
        originalSha256,
        originalHashAfter,
        managedHash,
        observed,
        detail,
        memory:
          'Explicit GPU textures/buffers only; browser/native backing allowance uses the production logical planner, physical VRAM is not measured.',
        oracle:
          'CPU recovery samples use the canonical application pixel API; independent CTL numerical conformance is verified by the separate GPU quality targets.',
      },
      null,
      2,
    ),
  )
  await page
    .evaluate(() => (window as unknown as FaultWindow).interactiveLifecycle.close())
    .catch(() => undefined)
  expect(originalHashAfter).toBe(originalSha256)
  if (id) expect(managedHash).toBe(originalSha256)
  if (observed) {
    expect(observed.peakBytes).toBeLessThanOrEqual(HDR_PRESENTATION_BUDGET)
    expect(observed.waiting).toBe(0)
  }
}

test(
  'a native interactive-pipeline rejection recovers complete corrected CPU pixels without changing history',
  foreground,
  async ({ luma }, info) => {
    test.setTimeout(180000)
    const { app, page, userDataDir } = luma
    let id: string | undefined
    const detail: unknown[] = []
    try {
      await installFaults(page, true)
      const prepared = await setup(app, page)
      id = prepared.raw.id
      const observed = await observation(page)
      expect(observed.rejectedPipelines).toBe(1)
      expect(observed.rejection).toMatchObject({ name: 'GPUPipelineError', reason: 'validation' })
      expect(observed.interactiveDispatches).toBe(0)
      detail.push(await cpuProof(page, id, prepared.source.renderId, parameters.exposureEv))
      expect(await page.evaluate((id) => window.luma.getEditHistory(id), id)).toEqual(
        prepared.history,
      )
      expect((await observation(page)).cpuRequests.at(-1)).toEqual({
        sha256: prepared.source.linear!.hdr!.sha256,
        parameters,
      })
      await expect.poll(async () => (await observation(page)).liveBytes).toBe(0)
    } finally {
      await evidence(page, info, userDataDir, id, detail)
    }
  },
)

test(
  'device loss during an actual Float32 gesture drains completion and recovers its single committed edit on CPU',
  foreground,
  async ({ luma }, info) => {
    test.setTimeout(180000)
    const { app, page, userDataDir } = luma
    let id: string | undefined
    const detail: unknown[] = []
    try {
      await installFaults(page)
      const prepared = await setup(app, page)
      id = prepared.raw.id
      const slider = await beginGesture(page)
      await gate(page, 'arm')
      await inputExposure(slider, 1.75)
      await expect.poll(async () => (await observation(page)).waiting).toBe(1)
      await page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')!,
          device = canvas.getContext('webgpu')!.getConfiguration()!.device
        Object.defineProperty(navigator, 'gpu', {
          configurable: true,
          value: { requestAdapter: async () => null },
        })
        device.destroy()
      })
      await gate(page, 'release')
      await page.mouse.up()
      await page.getByTestId('main-preview').focus()
      await expect
        .poll(
          async () =>
            (await page.evaluate((id) => window.luma.getEditHistory(id), id!)).snapshots.length,
        )
        .toBe(prepared.history.snapshots.length + 1)
      detail.push(await cpuProof(page, id, prepared.source.renderId, 1.75))
      const history = await page.evaluate((id) => window.luma.getEditHistory(id), id)
      expect(history.settings).toEqual({ ...prepared.history.settings, exposureEv: 1.75 })
      expect(history.snapshots.slice(0, -1)).toEqual(prepared.history.snapshots)
      const observed = await observation(page)
      expect(observed.interactiveDispatches).toBeGreaterThan(0)
      expect(observed.held).toBe(1)
      expect(observed.cpuRequests.at(-1)).toEqual({
        sha256: prepared.source.linear!.hdr!.sha256,
        parameters: { ...parameters, exposureEv: 1.75 },
      })
      await expect.poll(async () => (await observation(page)).liveBytes).toBe(0)
      detail.push(history)
    } finally {
      await page.mouse.up().catch(() => undefined)
      await evidence(page, info, userDataDir, id, detail)
    }
  },
)

test(
  'cancelling and switching photographs while completed Float32 work is held cannot publish stale pixels or poison exact refinement',
  foreground,
  async ({ luma }, info) => {
    test.setTimeout(180000)
    const { app, page, userDataDir } = luma
    let id: string | undefined
    const detail: unknown[] = []
    try {
      await installFaults(page)
      const prepared = await setup(app, page, true)
      id = prepared.raw.id
      const initial = await capture(app, page, info.outputPath('raw-initial.png'))
      const slider = await beginGesture(page)
      await gate(page, 'arm')
      await inputExposure(slider, 1.75)
      await expect.poll(async () => (await observation(page)).waiting).toBe(1)
      await slider.focus()
      await page.keyboard.press('Escape')
      await gate(page, 'release')
      await page.mouse.up()
      await exact(page)
      expect(await page.evaluate((id) => window.luma.getEditHistory(id), id)).toEqual(
        prepared.history,
      )
      expect(
        difference(initial, await capture(app, page, info.outputPath('raw-cancelled.png'))),
      ).toBeLessThanOrEqual(1)
      await page.getByRole('button', { name: 'Select alpine-lake.jpg', exact: true }).click()
      await expect(page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready')
      const rasterReference = await capture(app, page, info.outputPath('raster-canonical.png')),
        rasterPhoto = (await page.evaluate(() => window.luma.listPhotos())).photos.find(
          (photo) => photo.filename === 'alpine-lake.jpg',
        )!,
        rasterHistory = await page.evaluate((id) => window.luma.getEditHistory(id), rasterPhoto.id)
      await page.getByRole('button', { name: 'Select sony-zv1.ARW', exact: true }).click()
      await exact(page)
      const nextSlider = await beginGesture(page)
      await gate(page, 'arm')
      await inputExposure(nextSlider, 1.75)
      await expect.poll(async () => (await observation(page)).waiting).toBe(1)
      await page.mouse.up()
      await page.getByRole('button', { name: 'Select alpine-lake.jpg', exact: true }).click()
      await expect(page.getByTestId('main-preview')).toHaveAttribute(
        'aria-label',
        'alpine-lake.jpg',
      )
      await expect(page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready')
      await page.evaluate(() => {
        ;(window as unknown as FaultWindow).interactiveLifecycle.observation.phase = 'after-switch'
      })
      await gate(page, 'release')
      for (let frame = 0; frame < 3; frame++) {
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            ),
        )
        await expect(page.getByTestId('main-preview')).toHaveAttribute(
          'aria-label',
          'alpine-lake.jpg',
        )
        const pixels = await capture(
          app,
          page,
          info.outputPath(`raster-after-release-${frame}.png`),
        )
        expect(difference(rasterReference, pixels)).toBeLessThanOrEqual(1)
      }
      const afterRelease = await observation(page)
      expect(
        afterRelease.presentations.filter(
          (entry) => entry.phase === 'after-switch' && entry.filename === 'sony-zv1.ARW',
        ),
      ).toEqual([])
      expect(afterRelease.waiting).toBe(0)
      expect(await page.evaluate((id) => window.luma.getEditHistory(id), rasterPhoto.id)).toEqual(
        rasterHistory,
      )
      await expect
        .poll(
          async () =>
            (await page.evaluate((id) => window.luma.getEditHistory(id), id!)).snapshots.length,
        )
        .toBe(prepared.history.snapshots.length + 1)
      await page.getByRole('button', { name: 'Select sony-zv1.ARW', exact: true }).click()
      await exact(page, 1.75)
      const history = await page.evaluate((id) => window.luma.getEditHistory(id), id)
      expect(history.settings).toEqual({ ...prepared.history.settings, exposureEv: 1.75 })
      expect(history.snapshots.slice(0, -1)).toEqual(prepared.history.snapshots)
      detail.push(history, await page.evaluate(() => window.luma.getPreviewDiagnostics()))
    } finally {
      await page.mouse.up().catch(() => undefined)
      await evidence(page, info, userDataDir, id, detail)
    }
  },
)
