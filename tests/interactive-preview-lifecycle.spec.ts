import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ConsoleMessage, ElectronApplication, Page, TestInfo } from '@playwright/test'
import { expect, test } from './electron.fixture'
import { foregroundTest } from './foreground'
import { editorTestPreviewPolicy, requireEditorPreviewFeature } from './hdr-test-policy.helpers'
import { importPhotos } from './import.helpers'
import {
  ACES_INTERACTIVE_PREVIEW_VERSION,
  selectInteractivePreviewPolicy,
} from '../src/shared/aces-preview-wgsl'
import { encodeHdr } from '../src/shared/hdr'
import {
  assertHdrMemory,
  readHdrMemory,
  type HdrMemoryObservation,
} from './hdr-memory-policy.helpers'
import type { AdjustmentParameters } from '../src/shared/adjustments'
import type { EditState } from '../src/shared/edits'
import {
  observeNativeCpuReplies,
  requireTrustedNativeBridge,
  expectCpuPair,
} from './native-cpu-preview-ui.helpers'

const fixture = 'tests/fixtures/sony-zv1.ARW'
const originalSha256 = '14c9d2912584a3ccc5cf10f554fbe495fc960c36758a14d7d858b36ac5ca88e2'
const raster = 'tests/fixtures/photos/alpine-lake.jpg'
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const requestedTileBatch = String(editorTestPreviewPolicy.tileBatch)
const requestedInteractiveFence = editorTestPreviewPolicy.interactiveFence
const usesNativeCpuRenderer = process.platform === 'linux' && process.arch === 'x64'
type NativeCpuReplies = Awaited<ReturnType<typeof observeNativeCpuReplies>>
const parameters: AdjustmentParameters = {
  saturation: 0,
  vibrance: 0,
  exposureEv: 1.25,
  contrast: 45,
  highlights: -55,
  shadows: 40,
  whites: 20,
  blacks: -25,
  whiteBalance: { mode: 'custom', kelvin: 4500, tint: 12 },
}
interface FaultObservation {
  recoveryCapabilityControl: {
    profile: 'float16-unavailable-v1'
    originalOwnDescriptor: boolean
    originalType: string
    forcedType: 'undefined'
  }
  rejectedPipelines: number
  rejection?: { name: string; reason?: string; message: string }
  interactiveDispatches: number
  canonicalDispatches: number
  held: number
  waiting: number
  liveBytes: number
  peakBytes: number
  peakGpuBudgetBytes: number
  peakGpuBudgetWitness?: Record<string, unknown>
  resourcePlanCount: number
  invalidResourcePlans: number
  peakPlannedRam?: HdrMemoryObservation & { witness: Record<string, unknown> }
  peakPlannedGpu?: HdrMemoryObservation & { witness: Record<string, unknown> }
  allocations: number
  destructions: number
  uploadedSources: string[]
  cpuRequests: Array<{ sha256: string; parameters: AdjustmentParameters }>
  presentations: Array<{ phase: string; filename: string | null }>
  retentionStages: number
  retentionReads: number
  retentionStageLive: number
  retentionStageCleared: number
  retentionCompletionRejections: number
  retentionStageInvalidAttributes: number
  phase: string
}
interface FaultController {
  observation: FaultObservation
  arm: () => void
  armRetention: () => void
  armRetentionRejection: () => void
  release: () => void
  close: () => void | Promise<void>
}
type FaultWindow = Window & { interactiveLifecycle: FaultController }

test.use({ hdrDisplay: true })
test.beforeEach(async ({ irodori }) => {
  await requireEditorPreviewFeature(irodori.page, 'interactive')
})
const foreground = foregroundTest(
  'Native pointer capture, interrupted HDR GPU presentation and compositor captures require foreground interaction.',
)

async function installFaults(page: Page, rejectInteractive = false) {
  await page.addInitScript(
    ({ rejectInteractive }) => {
      // Exercise the production unsupported-Float16 CPU staging path. The
      // separate raw-half suite retains normal capability/default coverage.
      const float16Descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Float16Array'),
        originalFloat16Type = typeof Reflect.get(globalThis, 'Float16Array')
      if (float16Descriptor?.configurable === false)
        throw new Error('Cannot isolate the Float16-unavailable recovery capability.')
      Object.defineProperty(globalThis, 'Float16Array', {
        value: undefined,
        configurable: true,
        writable: true,
        enumerable: float16Descriptor?.enumerable ?? false,
      })
      if (typeof Reflect.get(globalThis, 'Float16Array') !== 'undefined')
        throw new Error('The Float16-unavailable capability control did not apply.')
      const observation: FaultObservation = {
        recoveryCapabilityControl: {
          profile: 'float16-unavailable-v1',
          originalOwnDescriptor: !!float16Descriptor,
          originalType: originalFloat16Type,
          forcedType: 'undefined',
        },
        rejectedPipelines: 0,
        interactiveDispatches: 0,
        canonicalDispatches: 0,
        held: 0,
        waiting: 0,
        liveBytes: 0,
        peakBytes: 0,
        peakGpuBudgetBytes: Number.NaN,
        resourcePlanCount: 0,
        invalidResourcePlans: 0,
        allocations: 0,
        destructions: 0,
        uploadedSources: [],
        cpuRequests: [],
        presentations: [],
        retentionStages: 0,
        retentionReads: 0,
        retentionStageLive: 0,
        retentionStageCleared: 0,
        retentionCompletionRejections: 0,
        retentionStageInvalidAttributes: 0,
        phase: 'setup',
      }
      const modules = new WeakMap<GPUShaderModule, string>(),
        interactive = new WeakSet<GPUComputePipeline>(),
        canonical = new WeakSet<GPUComputePipeline>(),
        passes = new WeakSet<GPUComputePassEncoder>(),
        canonicalPasses = new WeakSet<GPUComputePassEncoder>(),
        retentionCanvases = new Set<HTMLCanvasElement>(),
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
        retentionDraw: CanvasRenderingContext2D.prototype.drawImage,
        retentionRead: CanvasRenderingContext2D.prototype.getImageData,
        canvasWidth: Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width')!,
      }
      const resourceMemory = () => {
        const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')
        if (!canvas || canvas.dataset.backend !== 'webgpu-hdr') return
        const number = (key: string) => {
          const raw = canvas.dataset[key]
          return raw === undefined || raw.trim() === '' ? Number.NaN : Number(raw)
        }
        return {
          allocatedRamBytes: number('allocatedRamBytes'),
          allocatedGpuBytes: number('allocatedGpuBytes'),
          ramBudgetBytes: number('ramBudgetBytes'),
          vramBudgetBytes: number('vramBudgetBytes'),
          resourcePolicyRevision: number('resourcePolicyRevision'),
          witness: {
            at: performance.now(),
            filename: canvas.getAttribute('aria-label'),
            requestedSourceIdentity: canvas.dataset.requestedSourceIdentity,
            presentedSourceIdentity: canvas.dataset.presentedSourceIdentity,
            width: canvas.width,
            height: canvas.height,
          },
        }
      }
      let previousResourcePlan = ''
      const observeResourcePlan = () => {
        const memory = resourceMemory()
        if (!memory) return
        const key = JSON.stringify(memory, (key, value) => (key === 'at' ? undefined : value))
        if (key === previousResourcePlan) return
        previousResourcePlan = key
        observation.resourcePlanCount++
        if (
          ![
            memory.allocatedRamBytes,
            memory.allocatedGpuBytes,
            memory.ramBudgetBytes,
            memory.vramBudgetBytes,
            memory.resourcePolicyRevision,
          ].every(Number.isSafeInteger) ||
          memory.allocatedRamBytes <= 0 ||
          memory.allocatedGpuBytes <= 0 ||
          memory.ramBudgetBytes <= 0 ||
          memory.vramBudgetBytes <= 0 ||
          memory.resourcePolicyRevision < 0 ||
          memory.allocatedRamBytes > memory.ramBudgetBytes ||
          memory.allocatedGpuBytes > memory.vramBudgetBytes
        )
          observation.invalidResourcePlans++
        if (
          !observation.peakPlannedRam ||
          memory.allocatedRamBytes > observation.peakPlannedRam.allocatedRamBytes
        )
          observation.peakPlannedRam = memory
        if (
          !observation.peakPlannedGpu ||
          memory.allocatedGpuBytes > observation.peakPlannedGpu.allocatedGpuBytes
        )
          observation.peakPlannedGpu = memory
      }
      const resourceObserver = new MutationObserver(observeResourcePlan)
      resourceObserver.observe(document, {
        subtree: true,
        attributes: true,
        attributeFilter: [
          'data-allocated-ram-bytes',
          'data-allocated-gpu-bytes',
          'data-ram-budget-bytes',
          'data-vram-budget-bytes',
          'data-resource-policy-revision',
          'data-completed-edit-serial',
        ],
      })
      const own = <T extends object>(resource: T, bytes: number) => {
        resources.set(resource, bytes)
        observation.allocations++
        observation.liveBytes += bytes
        if (observation.liveBytes > observation.peakBytes) {
          observation.peakBytes = observation.liveBytes
          const memory = resourceMemory()
          observation.peakGpuBudgetBytes = memory?.vramBudgetBytes ?? Number.NaN
          observation.peakGpuBudgetWitness = memory ? { ...memory.witness, ...memory } : undefined
        }
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
            observation.rejection = {
              name: value.name,
              reason: value.reason,
              message: value.message,
            }
            throw error
          } finally {
            await this.popErrorScope()
          }
        }
        const result = await original.pipeline.call(this, descriptor)
        if (isInteractive) interactive.add(result)
        else if (descriptor.compute.entryPoint === 'renderTile' && code?.includes('fn dsPow('))
          canonical.add(result)
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
        if (canonical.has(pipeline)) canonicalPasses.add(this)
        else canonicalPasses.delete(this)
        original.setPipeline.call(this, pipeline)
      }
      GPUComputePassEncoder.prototype.dispatchWorkgroups = function (...counts) {
        if (passes.has(this)) observation.interactiveDispatches++
        if (canonicalPasses.has(this)) observation.canonicalDispatches++
        original.dispatch.apply(this, counts)
      }
      Object.defineProperty(HTMLCanvasElement.prototype, 'width', {
        ...original.canvasWidth,
        set(this: HTMLCanvasElement, value: number) {
          if (value === 0 && this.width > 0 && retentionCanvases.delete(this)) {
            observation.retentionStageCleared++
            observation.retentionStageLive = retentionCanvases.size
          }
          original.canvasWidth.set!.call(this, value)
        },
      })
      CanvasRenderingContext2D.prototype.drawImage = function (
        this: CanvasRenderingContext2D,
        ...args: unknown[]
      ) {
        const source = args[0]
        if (
          source instanceof HTMLCanvasElement &&
          source.dataset.testid === 'main-preview' &&
          this.canvas instanceof HTMLCanvasElement &&
          this.canvas.dataset.testid !== 'retained-preview'
        ) {
          const surface = this.canvas,
            attributes = this.getContextAttributes(),
            scale = Math.min(1, 1024 / Math.max(source.width, source.height))
          retentionCanvases.add(surface)
          observation.retentionStages++
          observation.retentionStageLive = retentionCanvases.size
          observation.retentionStageInvalidAttributes += Number(
            attributes.colorSpace !== 'srgb' ||
              typeof attributes.willReadFrequently !== 'boolean' ||
              surface.width !== Math.max(1, Math.round(source.width * scale)) ||
              surface.height !== Math.max(1, Math.round(source.height * scale)) ||
              args.length !== 5 ||
              args[1] !== 0 ||
              args[2] !== 0 ||
              args[3] !== surface.width ||
              args[4] !== surface.height,
          )
        }
        Reflect.apply(original.retentionDraw, this, args)
      } as CanvasRenderingContext2D['drawImage']
      CanvasRenderingContext2D.prototype.getImageData = function (
        this: CanvasRenderingContext2D,
        ...args: Parameters<CanvasRenderingContext2D['getImageData']>
      ) {
        if (this.canvas instanceof HTMLCanvasElement && retentionCanvases.has(this.canvas)) {
          observation.retentionReads++
        }
        return Reflect.apply(original.retentionRead, this, args)
      }
      let armedAt: number | undefined, retentionArmedAt: number | undefined
      let rejectRetention = false
      const pending: Array<() => void> = []
      GPUQueue.prototype.onSubmittedWorkDone = function () {
        const completed = original.fence.call(this)
        const holdInteractive =
            armedAt !== undefined && observation.interactiveDispatches > armedAt,
          holdRetention =
            retentionArmedAt !== undefined && observation.retentionStages > retentionArmedAt
        if (!holdInteractive && !holdRetention) return completed
        const rejectHeld = holdRetention && rejectRetention
        armedAt = undefined
        retentionArmedAt = undefined
        rejectRetention = false
        // Delay only delivery of a real completed submission, never manufacture unfinished GPU work.
        return completed.then(
          () =>
            new Promise<undefined>((resolve, reject) => {
              observation.held++
              observation.waiting++
              pending.push(() => {
                observation.waiting--
                if (rejectHeld) {
                  observation.retentionCompletionRejections++
                  reject(
                    new DOMException(
                      'Injected late staging completion failure.',
                      'InvalidStateError',
                    ),
                  )
                } else resolve(undefined)
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
            this.canvas instanceof HTMLCanvasElement
              ? this.canvas.getAttribute('aria-label')
              : null,
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
        retentionArmedAt = undefined
        rejectRetention = false
        for (const resolve of pending.splice(0)) resolve()
      }
      Object.assign(window, {
        interactiveLifecycle: {
          observation,
          arm: () => {
            armedAt = observation.interactiveDispatches
          },
          armRetention: () => {
            retentionArmedAt = observation.retentionStages
          },
          armRetentionRejection: () => {
            retentionArmedAt = observation.retentionStages
            rejectRetention = true
          },
          release,
          close: () => {
            observeResourcePlan()
            resourceObserver.disconnect()
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
            CanvasRenderingContext2D.prototype.drawImage = original.retentionDraw
            CanvasRenderingContext2D.prototype.getImageData = original.retentionRead
            Object.defineProperty(HTMLCanvasElement.prototype, 'width', original.canvasWidth)
            if (float16Descriptor)
              Object.defineProperty(globalThis, 'Float16Array', float16Descriptor)
            else if (!Reflect.deleteProperty(globalThis, 'Float16Array'))
              throw new Error('The Float16 capability descriptor could not be restored.')
          },
        } satisfies FaultController,
      })
    },
    { rejectInteractive },
  )
  await page.reload()
  expect(await page.evaluate(() => typeof Reflect.get(globalThis, 'Float16Array'))).toBe(
    'undefined',
  )
  expect(
    await page.evaluate(
      () =>
        (window as unknown as FaultWindow).interactiveLifecycle.observation
          .recoveryCapabilityControl,
    ),
  ).toMatchObject({ profile: 'float16-unavailable-v1', forcedType: 'undefined' })
}

const observation = (page: Page) =>
  page.evaluate(() => (window as unknown as FaultWindow).interactiveLifecycle.observation)
const gate = (page: Page, action: 'arm' | 'armRetention' | 'armRetentionRejection' | 'release') =>
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
    await expect(canvas).toHaveAttribute('data-planned-retention-method', 'cpu-staging')
    await expect(canvas).toHaveAttribute('data-retention-method', 'cpu-staging')
    await expect(canvas).toHaveAttribute('data-retention-will-read-frequently', 'true')
    await expect(canvas).toHaveAttribute('data-recovery-policy', 'canvas2d-cpu-staging-v1')
    await expect(canvas).toHaveAttribute('data-presented-policy', 'reference')
    await expect
      .poll(() =>
        canvas.evaluate(
          (element) => element.dataset.completedEditSerial === element.dataset.requestedSerial,
        ),
      )
      .toBe(true)
    assertHdrMemory(await canvas.evaluate(readHdrMemory))
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
  await page.evaluate(() => window.irodori.setPreviewPreference('sdr'))
  await importPhotos(app, page, withRaster ? [raster, fixture] : [fixture], false)
  const raw = (await page.evaluate(() => window.irodori.listPhotos())).photos.find(
    (photo) => photo.filename === 'sony-zv1.ARW',
  )!
  const before = await page.evaluate((id) => window.irodori.getEdits(id), raw.id)
  await page.evaluate(
    ({ id, revision, parameters }) => window.irodori.updateEdits(id, parameters, revision),
    { id: raw.id, revision: before.revision, parameters },
  )
  await workspaces.getByRole('button', { name: 'Editor', exact: true }).click()
  await page.getByRole('button', { name: 'Select sony-zv1.ARW', exact: true }).click()
  await exact(page)
  const requestId = randomUUID()
  try {
    const source = await page.evaluate(
      ({ id, requestId }) => window.irodori.requestHdrPreview(id, requestId, false, 'hdr'),
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
      history: await page.evaluate((id) => window.irodori.getEditHistory(id), raw.id),
    }
  } finally {
    await page.evaluate((requestId) => window.irodori.releaseFullPreview(requestId), requestId)
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
  await expect(canvas).toHaveAttribute('data-tile-batch', requestedTileBatch)
  await expect(canvas).toHaveAttribute('data-interactive-fence', requestedInteractiveFence)
  const target = await page.evaluate(() => window.irodori.getDisplayState())
  await expect(canvas).toHaveAttribute(
    'data-presented-arithmetic-policy',
    selectInteractivePreviewPolicy('f32', target.mode),
  )
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

async function holdLocalCommitReply(app: ElectronApplication, photoId: string) {
  return app.evaluateHandle(({ ipcMain }, photoId) => {
    const handlers = (
        ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
      )._invokeHandlers,
      original = handlers.get('edits:update')!,
      originalGet = handlers.get('edits:get')!
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const state = {
      calls: 0,
      persisted: null as EditState | null,
      refreshCalls: 0,
      refreshed: null as EditState | null,
      released: false,
    }
    ipcMain.removeHandler('edits:get')
    ipcMain.handle('edits:get', async (...args) => {
      const next = await originalGet(...args)
      if (args[1] === photoId && !state.released) {
        state.refreshCalls++
        state.refreshed = next as EditState
      }
      return next
    })
    ipcMain.removeHandler('edits:update')
    ipcMain.handle('edits:update', async (...args) => {
      // Persist and broadcast normally; hold only this caller's real reply.
      const next = await original(...args)
      if (args[1] === photoId) {
        state.calls++
        state.persisted = next as EditState
        await pending
      }
      return next
    })
    return {
      state,
      release: () => {
        state.released = true
        release()
      },
      close: () => {
        state.released = true
        release()
        ipcMain.removeHandler('edits:update')
        ipcMain.handle('edits:update', original)
        ipcMain.removeHandler('edits:get')
        ipcMain.handle('edits:get', originalGet)
      },
    }
  }, photoId)
}

async function traceLocalCommit(page: Page) {
  return page.evaluateHandle(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')!,
      attributes = [
        'data-quality',
        'data-presented-policy',
        'data-presented-arithmetic-policy',
        'data-range-arithmetic-policy',
        'data-gesturing',
        'data-editing-epoch',
        'data-gesture-handoff',
        'data-requested-epoch',
        'data-presented-epoch',
        'data-requested-serial',
        'data-completed-edit-serial',
        'data-presentation-serial',
        'data-presented-settings-revision',
        'data-requested-source-identity',
        'data-presented-source-identity',
        'data-target-generation',
        'data-exposure',
      ]
    const state = {
      snapshots: [] as Array<{
        at: number
        phase: string
        values: Record<string, string | null>
        changes: Array<{ attribute: string; previous: string | null }>
      }>,
      droppedSnapshots: 0,
      droppedChanges: 0,
    }
    const snapshot = (phase: string, records: MutationRecord[] = []) => {
      if (state.snapshots.length >= 256) {
        state.droppedSnapshots++
        return
      }
      state.droppedChanges += Math.max(0, records.length - 128)
      state.snapshots.push({
        at: Date.now(),
        phase,
        values: Object.fromEntries(attributes.map((name) => [name, canvas.getAttribute(name)])),
        changes: records.slice(0, 128).map((record) => ({
          attribute: record.attributeName!,
          previous: record.oldValue,
        })),
      })
    }
    const observer = new MutationObserver((records) => snapshot('mutation', records))
    observer.observe(canvas, {
      attributes: true,
      attributeOldValue: true,
      attributeFilter: attributes,
    })
    snapshot('installed')
    return {
      mark: (phase: string) => snapshot(phase, observer.takeRecords()),
      close: () => {
        snapshot('cleanup', observer.takeRecords())
        observer.disconnect()
        return state
      },
    }
  })
}

async function capture(
  app: ElectronApplication,
  page: Page,
  path: string,
  testId: 'main-preview' | 'retained-preview' = 'main-preview',
) {
  const bounds = await page.getByTestId(testId).boundingBox()
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

async function retainedSnapshot(page: Page) {
  return page.getByTestId('retained-preview').evaluate(async (element) => {
    const canvas = element as HTMLCanvasElement,
      pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data,
      identity = {
        width: canvas.width,
        height: canvas.height,
        serial: canvas.dataset.presentationSerial,
        nonblack: pixels.some((value, index) => index % 4 !== 3 && value > 0),
      },
      digest = new Uint8Array(await crypto.subtle.digest('SHA-256', pixels))
    return {
      ...identity,
      sha256: Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join(''),
    }
  })
}

async function cpuProof(page: Page, id: string, sourceIdentity: string, exposure: number) {
  await expect(page.getByTestId('main-preview')).toHaveAttribute('data-backend', 'canvas2d-hdr-sdr')
  await page.getByLabel('Preview zoom', { exact: true }).selectOption('1')
  await exact(page, exposure)
  const state = await page.evaluate((id) => window.irodori.getEdits(id), id)
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
        window.irodori.getPhotoPixel(id, revision, x, y, { domain: 'output', target: 'sdr' }),
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

/** Bind the actual displayed full-detail pair to the unchanged main CPU handler. */
async function assertNativeCpuPublication(
  page: Page,
  replies: NativeCpuReplies,
  prepared: Awaited<ReturnType<typeof setup>>,
  expectedParameters: AdjustmentParameters,
) {
  const canvas = page.getByTestId('main-preview')
  await expect(canvas).toHaveAttribute('data-cpu-renderer', 'native')
  const pairId = await canvas.getAttribute('data-native-cpu-pair')
  expect(pairId).toBeTruthy()
  const observed = await replies.evaluate((control) => control.state())
  expect(observed.omitted).toBe(0)
  const pairs = observed.pairs.filter((pair) => pair.pairId === pairId)
  expect(pairs).toHaveLength(1)
  const pair = pairs[0]
  if (!pair) throw new Error('The displayed normal CPU pair was not observed from main.')
  const requests = observed.requests.filter((request) => request.requestId === pair.requestId)
  expect(requests).toHaveLength(1)
  const request = requests[0]
  if (!request) throw new Error('The displayed CPU pair has no observed real request.')
  const current = await page.evaluate((id) => window.irodori.getEdits(id), prepared.raw.id)
  const hdr = prepared.source.linear?.hdr
  if (!hdr || !prepared.source.cpuSource)
    throw new Error('The corrected source has no trusted native CPU identity.')
  expect(pair.quality).toBe('normal')
  expect(pair.source).toEqual(prepared.source.cpuSource)
  expect(pair.source).toMatchObject({
    photoId: prepared.raw.id,
    renderingIdentity: prepared.source.renderId,
    workingSha256: hdr.sha256,
  })
  expect(pair.parameters).toEqual(expectedParameters)
  expect(pair.settingsRevision).toBe(current.revision)
  expect(request).toMatchObject({
    requestId: pair.requestId,
    sessionId: pair.sessionId,
    generation: pair.generation,
    source: pair.source,
    parameters: expectedParameters,
    expectedSettingsRevision: current.revision,
    quality: 'normal',
    hdrRanges: pair.hdrRanges,
    headroom: pair.headroom,
  })
  expect(pair.sourceDimensions).toEqual({ width: hdr.width, height: hdr.height })
  for (const plane of [pair.after, pair.before]) {
    expect(plane).toMatchObject({
      format: 'rgba8-srgb',
      width: hdr.width,
      height: hdr.height,
      byteLength: hdr.width * hdr.height * 4,
    })
    expect(plane.sha256).toMatch(/^[a-f0-9]{64}$/)
  }
  expect(observed.events).toContainEqual({
    phase: 'delivered',
    channel: 'preview:cpu-render',
    requestId: pair.requestId,
    pairId: pair.pairId,
  })
  await expectCpuPair(page, pair)
  return { publishedPairId: pairId, request, pair }
}

async function closeNativeCpuObservation(replies: NativeCpuReplies | undefined, info: TestInfo) {
  if (!replies) return
  try {
    const observed = await replies.evaluate((control) => control.close())
    await writeFile(
      info.outputPath('interactive-native-cpu.json'),
      JSON.stringify(observed, null, 2),
    )
    expect(observed.omitted).toBe(0)
    expect(observed.held).toBeNull()
  } finally {
    await replies.dispose()
  }
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
    displayState = await page
      .evaluate(() => window.irodori.getDisplayState())
      .catch(() => undefined),
    canvasState = await page
      .getByTestId('main-preview')
      .evaluate((element) => {
        const canvas = element as HTMLCanvasElement,
          bounds = canvas.getBoundingClientRect(),
          configuration =
            canvas.dataset.backend === 'webgpu-hdr'
              ? canvas.getContext('webgpu')?.getConfiguration()
              : null
        return {
          dpr: window.devicePixelRatio,
          width: canvas.width,
          height: canvas.height,
          bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
          backend: canvas.dataset.backend,
          tileBatch: canvas.dataset.tileBatch,
          interactiveFence: canvas.dataset.interactiveFence,
          presentedArithmeticPolicy: canvas.dataset.presentedArithmeticPolicy,
          rangeArithmeticPolicy: canvas.dataset.rangeArithmeticPolicy,
          retentionMethod: canvas.dataset.retentionMethod,
          plannedRetentionMethod: canvas.dataset.plannedRetentionMethod,
          retentionWillReadFrequently: canvas.dataset.retentionWillReadFrequently,
          targetGeneration: canvas.dataset.targetGeneration,
          configuration: configuration
            ? {
                format: configuration.format,
                colorSpace: configuration.colorSpace,
                alphaMode: configuration.alphaMode,
                toneMapping: configuration.toneMapping,
                usage: configuration.usage,
              }
            : null,
        }
      })
      .catch(() => undefined),
    originalHashAfter = sha(await readFile(fixture)),
    managedHash = id
      ? sha(await readFile(join(userDataDir, 'library', 'originals', id, 'original.arw')))
      : undefined
  await writeFile(
    info.outputPath('interactive-lifecycle.json'),
    JSON.stringify(
      {
        policy: ACES_INTERACTIVE_PREVIEW_VERSION,
        requestedTileBatch,
        requestedInteractiveFence,
        originalSha256,
        originalHashAfter,
        managedHash,
        observed,
        displayState,
        canvasState,
        detail,
        memory:
          'peakBytes counts explicit GPU textures/buffers and is compared to the contemporaneous GPU budget; separate planned RAM/GPU peaks retain their own admitted limits and observed source/geometry witnesses. Browser/driver physical residency is not measured.',
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
    expect(observed.resourcePlanCount).toBeGreaterThan(0)
    expect(observed.invalidResourcePlans).toBe(0)
    assertHdrMemory(observed.peakPlannedRam, 'Lifecycle peak planned RAM')
    assertHdrMemory(observed.peakPlannedGpu, 'Lifecycle peak planned GPU')
    expect(Number.isSafeInteger(observed.peakGpuBudgetBytes)).toBe(true)
    expect(observed.peakGpuBudgetBytes).toBeGreaterThan(0)
    expect(observed.peakBytes).toBeLessThanOrEqual(observed.peakGpuBudgetBytes)
    expect(observed.waiting).toBe(0)
  }
}

test(
  'a native interactive-pipeline rejection recovers complete corrected CPU pixels without changing history',
  foreground,
  async ({ irodori }, info) => {
    test.setTimeout(180000)
    const { app, page, userDataDir } = irodori
    let id: string | undefined, native: NativeCpuReplies | undefined
    const detail: unknown[] = []
    try {
      await installFaults(page, true)
      if (usesNativeCpuRenderer) {
        await requireTrustedNativeBridge(page)
        native = await observeNativeCpuReplies(app)
      }
      const prepared = await setup(app, page)
      id = prepared.raw.id
      const observed = await observation(page)
      expect(observed.rejectedPipelines).toBe(1)
      expect(observed.rejection).toMatchObject({ name: 'GPUPipelineError', reason: 'validation' })
      expect(observed.interactiveDispatches).toBe(0)
      detail.push(await cpuProof(page, id, prepared.source.renderId, parameters.exposureEv))
      expect(await page.evaluate((id) => window.irodori.getEditHistory(id), id)).toEqual(
        prepared.history,
      )
      if (usesNativeCpuRenderer)
        detail.push(await assertNativeCpuPublication(page, native!, prepared, parameters))
      else
        expect((await observation(page)).cpuRequests.at(-1)).toEqual({
          sha256: prepared.source.linear!.hdr!.sha256,
          parameters,
        })
      await expect.poll(async () => (await observation(page)).liveBytes).toBe(0)
    } finally {
      try {
        await evidence(page, info, userDataDir, id, detail)
      } finally {
        await closeNativeCpuObservation(native, info)
      }
    }
  },
)

test(
  'the last local input receives Float32 feedback before its own reply and canonical refinement after confirmation',
  foreground,
  async ({ irodori }, info) => {
    test.setTimeout(180000)
    const { app, page, userDataDir } = irodori
    let id: string | undefined,
      reply: Awaited<ReturnType<typeof holdLocalCommitReply>> | undefined,
      trace: Awaited<ReturnType<typeof traceLocalCommit>> | undefined
    const detail: unknown[] = []
    const rendererMessages: Array<{ at: number; type: string; text: string }> = []
    const onConsole = (message: ConsoleMessage) => {
      if (rendererMessages.length < 32 && ['warning', 'error'].includes(message.type()))
        rendererMessages.push({
          at: Date.now(),
          type: message.type(),
          text: message.text().slice(0, 2000),
        })
    }
    page.on('console', onConsole)
    try {
      await installFaults(page)
      const prepared = await setup(app, page)
      id = prepared.raw.id
      trace = await traceLocalCommit(page)
      const slider = await beginGesture(page),
        canvas = page.getByTestId('main-preview')
      await expect
        .poll(() =>
          canvas.evaluate(
            (element) => element.dataset.completedEditSerial === element.dataset.requestedSerial,
          ),
        )
        .toBe(true)
      const before = await observation(page)
      detail.push({ before })
      reply = await holdLocalCommitReply(app, id)
      await trace.evaluate((value) => value.mark('before-final-input'))
      // The last input has no intervening animation frame in which to render.
      await slider.evaluate((element) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          element,
          '1.75',
        )
        element.dispatchEvent(new Event('input', { bubbles: true }))
        element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
      })
      await expect.poll(() => reply!.evaluate((value) => value.state.persisted !== null)).toBe(true)
      const committed = await reply.evaluate((value) => value.state.persisted!)
      expect(committed.photoId).toBe(id)
      expect(committed.revision).toBeGreaterThan(prepared.history.revision)
      expect(committed.settings.exposureEv).toBe(1.75)
      // Observe the application's real broadcast-triggered refresh, without issuing a test read.
      await expect.poll(() => reply!.evaluate((value) => value.state.refreshed)).toEqual(committed)
      await trace.evaluate((value) => value.mark('broadcast-refresh-returned'))
      await expect(canvas).toHaveAttribute('data-exposure', '1.75')
      await expect(canvas).toHaveAttribute('data-quality', 'interactive')
      await expect(canvas).toHaveAttribute(
        'data-presented-policy',
        ACES_INTERACTIVE_PREVIEW_VERSION,
      )
      await expect(canvas).toHaveAttribute('data-gesturing', 'false')
      await expect(canvas).not.toHaveAttribute('data-presented-settings-revision')
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      )
      const pending = await observation(page),
        feedback = await canvas.evaluate((element) => ({
          source: element.dataset.presentedSourceIdentity,
          epoch: element.dataset.presentedEpoch,
          serial: element.dataset.completedEditSerial,
          quality: element.dataset.quality,
          policy: element.dataset.presentedPolicy,
          arithmeticPolicy: element.dataset.presentedArithmeticPolicy,
          exposure: element.dataset.exposure,
          settingsRevision: element.getAttribute('data-presented-settings-revision'),
        })),
        fastPixels = await capture(app, page, info.outputPath('final-input-feedback.png'))
      expect(feedback.source).toContain(`irodori-photo://library/${id}/`)
      expect(feedback.epoch).toBeDefined()
      expect(feedback.serial).toBeDefined()
      expect(feedback.settingsRevision).toBeNull()
      expect(feedback).toMatchObject({
        quality: 'interactive',
        policy: ACES_INTERACTIVE_PREVIEW_VERSION,
        arithmeticPolicy: selectInteractivePreviewPolicy(
          'f32',
          (await page.evaluate(() => window.irodori.getDisplayState())).mode,
        ),
        exposure: '1.75',
      })
      expect(pending.interactiveDispatches).toBeGreaterThan(before.interactiveDispatches)
      expect(pending.canonicalDispatches).toBe(before.canonicalDispatches)
      const replyBeforeRelease = await reply.evaluate((value) => value.state)
      expect(replyBeforeRelease.refreshCalls).toBeGreaterThan(0)
      expect(replyBeforeRelease).toMatchObject({
        calls: 1,
        refreshed: committed,
        released: false,
      })
      detail.push({ committed, replyBeforeRelease, feedback })
      await reply.evaluate((value) => value.release())
      await trace.evaluate((value) => value.mark('own-reply-released'))
      await page.mouse.up()
      await exact(page, 1.75)
      await expect(canvas).toHaveAttribute(
        'data-presented-settings-revision',
        String(committed.revision),
      )
      const final = await observation(page),
        history = await page.evaluate((id) => window.irodori.getEditHistory(id), id)
      expect(final.canonicalDispatches).toBeGreaterThan(pending.canonicalDispatches)
      expect(history.snapshots).toHaveLength(prepared.history.snapshots.length + 1)
      expect(history.snapshots.slice(0, -1)).toEqual(prepared.history.snapshots)
      expect(history.settings).toEqual({ ...prepared.history.settings, exposureEv: 1.75 })
      expect(await reply.evaluate((value) => value.state.calls)).toBe(1)
      expect(
        difference(
          fastPixels,
          await capture(app, page, info.outputPath('final-input-canonical.png')),
        ),
      ).toBeLessThanOrEqual(1)
      expect(final.invalidResourcePlans).toBe(0)
      assertHdrMemory(final.peakPlannedRam, 'Final input peak planned RAM')
      assertHdrMemory(final.peakPlannedGpu, 'Final input peak planned GPU')
      expect(Number.isSafeInteger(final.peakGpuBudgetBytes)).toBe(true)
      expect(final.peakBytes).toBeLessThanOrEqual(final.peakGpuBudgetBytes)
      detail.push({ before, pending, final, feedback, committed, history })
    } finally {
      page.off('console', onConsole)
      detail.push({ rendererMessages })
      if (trace) {
        detail.push({
          canvasTransitions: await trace.evaluate((value) => value.close()).catch(() => undefined),
        })
        await trace.dispose()
      }
      if (reply) {
        detail.push({
          replyAtCleanup: await reply.evaluate((value) => value.state).catch(() => undefined),
        })
        await reply.evaluate((value) => value.close()).catch(() => undefined)
        await reply.dispose()
      }
      await page.mouse.up().catch(() => undefined)
      await evidence(page, info, userDataDir, id, detail)
    }
  },
)

test(
  'device loss before staged CPU capture preserves the last published recovery image and committed edit',
  foreground,
  async ({ irodori }, info) => {
    test.setTimeout(180000)
    const { app, page, userDataDir } = irodori
    let id: string | undefined
    const detail: unknown[] = []
    try {
      await installFaults(page)
      const prepared = await setup(app, page)
      id = prepared.raw.id
      const slider = await beginGesture(page)
      await expect
        .poll(() =>
          page
            .getByTestId('main-preview')
            .evaluate(
              (canvas) => canvas.dataset.completedEditSerial === canvas.dataset.requestedSerial,
            ),
        )
        .toBe(true)
      const before = await retainedSnapshot(page),
        previous = await observation(page)
      expect(before.nonblack).toBe(true)
      expect(before.serial).toBe(
        await page.getByTestId('main-preview').getAttribute('data-presentation-serial'),
      )
      await gate(page, 'armRetention')
      await inputExposure(slider, 1.75)
      await expect.poll(async () => (await observation(page)).waiting).toBe(1)
      const held = await observation(page)
      expect(held.retentionStages).toBe(previous.retentionStages + 1)
      expect(held.retentionReads).toBe(previous.retentionReads)
      expect(await retainedSnapshot(page)).toEqual(before)
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
      await expect(page.getByTestId('main-preview')).toHaveAttribute(
        'data-backend',
        'canvas2d-hdr-sdr',
      )
      await expect(page.getByTestId('retained-preview')).toBeVisible()
      expect(await retainedSnapshot(page)).toEqual(before)
      expect((await observation(page)).retentionReads).toBe(previous.retentionReads)
      await expect.poll(async () => (await observation(page)).retentionStageLive).toBe(0)
      await page.mouse.up()
      detail.push(before, held, await cpuProof(page, id, prepared.source.renderId, 1.75))
      const history = await page.evaluate((id) => window.irodori.getEditHistory(id), id)
      expect(history.settings).toEqual({ ...prepared.history.settings, exposureEv: 1.75 })
      expect(history.snapshots).toHaveLength(prepared.history.snapshots.length + 1)
      expect(history.snapshots.slice(0, -1)).toEqual(prepared.history.snapshots)
      await expect.poll(async () => (await observation(page)).liveBytes).toBe(0)
    } finally {
      await page.mouse.up().catch(() => undefined)
      await evidence(page, info, userDataDir, id, detail)
    }
  },
)

test(
  'device loss during an actual Float32 gesture drains completion and recovers its single committed edit on CPU',
  foreground,
  async ({ irodori }, info) => {
    test.setTimeout(180000)
    const { app, page, userDataDir } = irodori
    let id: string | undefined, native: NativeCpuReplies | undefined
    const detail: unknown[] = []
    try {
      await installFaults(page)
      if (usesNativeCpuRenderer) {
        await requireTrustedNativeBridge(page)
        native = await observeNativeCpuReplies(app)
      }
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
            (await page.evaluate((id) => window.irodori.getEditHistory(id), id!)).snapshots.length,
        )
        .toBe(prepared.history.snapshots.length + 1)
      detail.push(await cpuProof(page, id, prepared.source.renderId, 1.75))
      const history = await page.evaluate((id) => window.irodori.getEditHistory(id), id)
      expect(history.settings).toEqual({ ...prepared.history.settings, exposureEv: 1.75 })
      expect(history.snapshots.slice(0, -1)).toEqual(prepared.history.snapshots)
      const observed = await observation(page)
      expect(observed.interactiveDispatches).toBeGreaterThan(0)
      expect(observed.held).toBe(1)
      if (usesNativeCpuRenderer)
        detail.push(
          await assertNativeCpuPublication(page, native!, prepared, {
            ...parameters,
            exposureEv: 1.75,
          }),
        )
      else
        expect(observed.cpuRequests.at(-1)).toEqual({
          sha256: prepared.source.linear!.hdr!.sha256,
          parameters: { ...parameters, exposureEv: 1.75 },
        })
      await expect.poll(async () => (await observation(page)).liveBytes).toBe(0)
      detail.push(history)
    } finally {
      await page.mouse.up().catch(() => undefined)
      try {
        await evidence(page, info, userDataDir, id, detail)
      } finally {
        await closeNativeCpuObservation(native, info)
      }
    }
  },
)

test(
  'cancelling and switching photographs while completed Float32 work is held cannot publish stale pixels or poison exact refinement',
  foreground,
  async ({ irodori }, info) => {
    test.setTimeout(180000)
    const { app, page, userDataDir } = irodori
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
      expect(await page.evaluate((id) => window.irodori.getEditHistory(id), id)).toEqual(
        prepared.history,
      )
      expect(
        difference(initial, await capture(app, page, info.outputPath('raw-cancelled.png'))),
      ).toBeLessThanOrEqual(1)
      await page.getByRole('button', { name: 'Select alpine-lake.jpg', exact: true }).click()
      await expect(page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready')
      const rasterReference = await capture(app, page, info.outputPath('raster-canonical.png')),
        rasterPhoto = (await page.evaluate(() => window.irodori.listPhotos())).photos.find(
          (photo) => photo.filename === 'alpine-lake.jpg',
        )!,
        rasterHistory = await page.evaluate(
          (id) => window.irodori.getEditHistory(id),
          rasterPhoto.id,
        )
      await page.getByRole('button', { name: 'Select sony-zv1.ARW', exact: true }).click()
      await exact(page)
      const nextSlider = await beginGesture(page)
      await gate(page, 'armRetention')
      await inputExposure(nextSlider, 1.75)
      await expect.poll(async () => (await observation(page)).waiting).toBe(1)
      expect((await observation(page)).retentionStageLive).toBe(1)
      const readsWhenHeld = (await observation(page)).retentionReads
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
      const retainedBeforeRelease = await retainedSnapshot(page)
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
      expect(await retainedSnapshot(page)).toEqual(retainedBeforeRelease)
      const afterRelease = await observation(page)
      expect(afterRelease.retentionReads).toBe(readsWhenHeld)
      expect(
        afterRelease.presentations.filter(
          (entry) => entry.phase === 'after-switch' && entry.filename === 'sony-zv1.ARW',
        ),
      ).toEqual([])
      expect(afterRelease.waiting).toBe(0)
      expect(afterRelease.retentionStageLive).toBe(0)
      expect(afterRelease.retentionStageCleared).toBeGreaterThan(0)
      expect(afterRelease.retentionStageInvalidAttributes).toBe(0)
      expect(
        await page.evaluate((id) => window.irodori.getEditHistory(id), rasterPhoto.id),
      ).toEqual(rasterHistory)
      await expect
        .poll(
          async () =>
            (await page.evaluate((id) => window.irodori.getEditHistory(id), id!)).snapshots.length,
        )
        .toBe(prepared.history.snapshots.length + 1)
      await page.getByRole('button', { name: 'Select sony-zv1.ARW', exact: true }).click()
      await exact(page, 1.75)
      const history = await page.evaluate((id) => window.irodori.getEditHistory(id), id)
      expect(history.settings).toEqual({ ...prepared.history.settings, exposureEv: 1.75 })
      expect(history.snapshots.slice(0, -1)).toEqual(prepared.history.snapshots)
      detail.push(history, await page.evaluate(() => window.irodori.getPreviewDiagnostics()))
    } finally {
      await page.mouse.up().catch(() => undefined)
      await evidence(page, info, userDataDir, id, detail)
    }
  },
)

test(
  'a late staging completion rejection after a photo switch releases its private canvas without replacing the new photo or recovery image',
  foreground,
  async ({ irodori }, info) => {
    test.setTimeout(180000)
    const { app, page, userDataDir } = irodori
    let id: string | undefined
    const detail: unknown[] = []
    try {
      await installFaults(page)
      const prepared = await setup(app, page, true)
      id = prepared.raw.id
      const slider = await beginGesture(page)
      await gate(page, 'armRetentionRejection')
      await inputExposure(slider, 1.75)
      await expect.poll(async () => (await observation(page)).waiting).toBe(1)
      const held = await observation(page)
      expect(held.retentionStageLive).toBe(1)
      await page.mouse.up()
      await page.getByRole('button', { name: 'Select alpine-lake.jpg', exact: true }).click()
      const canvas = page.getByTestId('main-preview')
      await expect(canvas).toHaveAttribute('aria-label', 'alpine-lake.jpg')
      await expect(canvas).toHaveAttribute('data-editing', 'ready')
      const pixels = await capture(app, page, info.outputPath('raster-before-rejection.png')),
        retained = await retainedSnapshot(page),
        photo = (await page.evaluate(() => window.irodori.listPhotos())).photos.find(
          (value) => value.filename === 'alpine-lake.jpg',
        )!,
        history = await page.evaluate((id) => window.irodori.getEditHistory(id), photo.id)
      await gate(page, 'release')
      await expect.poll(async () => (await observation(page)).retentionStageLive).toBe(0)
      const completed = await observation(page)
      expect(completed.waiting).toBe(0)
      expect(completed.retentionCompletionRejections).toBe(1)
      expect(completed.retentionStageCleared).toBe(held.retentionStageCleared + 1)
      expect(completed.retentionReads).toBe(held.retentionReads)
      expect(completed.retentionStageInvalidAttributes).toBe(0)
      await expect(canvas).toHaveAttribute('aria-label', 'alpine-lake.jpg')
      await expect(canvas).toHaveAttribute('data-editing', 'ready')
      expect(await retainedSnapshot(page)).toEqual(retained)
      expect(
        difference(pixels, await capture(app, page, info.outputPath('raster-after-rejection.png'))),
      ).toBeLessThanOrEqual(1)
      expect(await page.evaluate((id) => window.irodori.getEditHistory(id), photo.id)).toEqual(
        history,
      )
      detail.push({ held, completed, history })
    } finally {
      await page.mouse.up().catch(() => undefined)
      await evidence(page, info, userDataDir, id, detail)
    }
  },
)
