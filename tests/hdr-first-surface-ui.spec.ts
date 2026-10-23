import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import type { HdrPreview } from '../src/shared/contracts'
import type { FullPreviewResult } from '../src/main/preview-types'
import { PREVIEW_ASSET_VERSION } from '../src/shared/preview-frame'
import type { HdrFirstSurfaceOffer, HdrFirstSurfaceRequest } from '../src/shared/hdr-first-surface'
import type { AdjustmentParameters } from '../src/shared/adjustments'
import type { DisplayTarget } from '../src/shared/hdr'
import type { HdrRecoverySnapshot } from '../src/renderer/src/preview/hdr-recovery'
import { expect, test } from './electron.fixture'
import { activateButton } from './button.helpers'
import { importPhotos } from './import.helpers'
import { foregroundTest } from './foreground'
import { maximizeEditorOnMonitor } from './editor-native-window.helpers'

const raw = 'tests/fixtures/sony-zv1.ARW'
const photoId = '14c9d2912584a3ccc5cf10f554fbe495fc960c36758a14d7d858b36ac5ca88e2'
type HdrReply = { preview?: HdrPreview | null; error?: string }
interface RawFixture {
  path: string
  filename: string
  photoId: string
  workingSha256?: string
  image?: { width: number; height: number }
  catalogImage?: { width: number; height: number }
}
const landscape: RawFixture = { path: raw, filename: 'sony-zv1.ARW', photoId }

test.use({ hdrDisplay: true })
test.skip(
  process.platform !== 'linux' || process.arch !== 'x64',
  'First-surface native application support is currently Linux x64.',
)
test.setTimeout(180000)

/** Hold delivery only after the existing handler has finished the real native job. */
async function holdFullReply(app: ElectronApplication, id = photoId) {
  return app.evaluateHandle(({ ipcMain }, photoId) => {
    type Handler = (...args: unknown[]) => unknown
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })
      ._invokeHandlers
    const channel = 'preview:hdr',
      releaseChannel = 'preview:first-surface-release'
    const original = handlers.get(channel)!,
      originalRelease = handlers.get(releaseChannel)!
    if (!original || !originalRelease)
      throw new Error('The real first-surface handlers are missing.')
    const requests: { requestId: string; firstSurface?: HdrFirstSurfaceRequest }[] = []
    const completed: { requestId: string; reply: HdrReply }[] = []
    const delivered: string[] = []
    const releases: { requestId: string; surfaceId: string; completed: boolean }[] = []
    const held = new Map<string, () => void>(),
      pending = new Set<Promise<unknown>>()
    let blocking = true
    const release = () => {
      blocking = false
      for (const resolve of held.values()) resolve()
      held.clear()
    }
    const wrapped: Handler = (...args) => {
      if (args[1] !== photoId) return original(...args)
      if (requests.length >= 16) throw new Error('First-surface observation exceeded 16 requests.')
      const requestId = args[2] as string
      requests.push({
        requestId,
        firstSurface: structuredClone(args[5] as HdrFirstSurfaceRequest | undefined),
      })
      const work = (async () => {
        const reply = (await original(...args)) as HdrReply
        completed.push({ requestId, reply: structuredClone(reply) })
        if (blocking) await new Promise<void>((resolve) => held.set(requestId, resolve))
        delivered.push(requestId)
        return reply
      })()
      pending.add(work)
      void work.finally(() => pending.delete(work)).catch(() => undefined)
      return work
    }
    const released: Handler = (...args) => {
      if (releases.length >= 64) throw new Error('First-surface observation exceeded 64 releases.')
      const record = {
        requestId: args[1] as string,
        surfaceId: args[2] as string,
        completed: false,
      }
      releases.push(record)
      const work = Promise.resolve(originalRelease(...args)).then((result) => {
        record.completed = true
        return result
      })
      pending.add(work)
      void work.finally(() => pending.delete(work)).catch(() => undefined)
      return work
    }
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, wrapped)
    ipcMain.removeHandler(releaseChannel)
    ipcMain.handle(releaseChannel, released)
    const state = () => ({ requests, completed, delivered, releases, held: [...held.keys()] })
    return {
      state,
      release,
      releaseRequest: (requestId: string) => {
        const resolve = held.get(requestId)
        if (!resolve) throw new Error('The actual completed reply is not held.')
        held.delete(requestId)
        resolve()
      },
      close: async () => {
        // Always release before waiting; the diagnostic must not wait on its own gate.
        release()
        try {
          await Promise.allSettled([...pending])
        } finally {
          if (handlers.get(channel) === wrapped) {
            ipcMain.removeHandler(channel)
            ipcMain.handle(channel, original)
          }
          if (handlers.get(releaseChannel) === released) {
            ipcMain.removeHandler(releaseChannel)
            ipcMain.handle(releaseChannel, originalRelease)
          }
        }
        return state()
      },
    }
  }, id)
}

/** Observe real queue fences and events without synthesizing frames or paint callbacks. */
async function observeFirstSurface(page: Page) {
  return page.evaluateHandle(() => {
    const offers: HdrFirstSurfaceOffer[] = []
    const fences: { queue: number; resolved: boolean }[] = []
    const phases: {
      surfaceId: string
      phase: string
      actualFenceResolved: boolean
      editing: string
      quality: string
      cachedReady: string
      recovery: boolean
      visible: boolean
      geometryMatches: boolean
      geometry: { imageWidth: number; imageHeight: number; scale: number }
    }[] = []
    const queues = new WeakMap<GPUQueue, number>()
    const originalFence = GPUQueue.prototype.onSubmittedWorkDone
    let nextQueue = 0,
      omitted = 0,
      previous = ''
    const wrapped: typeof originalFence = function (this: GPUQueue) {
      let queue = queues.get(this)
      if (!queue) {
        queue = ++nextQueue
        queues.set(this, queue)
      }
      const record = { queue, resolved: false }
      if (fences.length < 256) fences.push(record)
      else omitted++
      return originalFence.call(this).then((result) => {
        record.resolved = true
        return result
      })
    }
    GPUQueue.prototype.onSubmittedWorkDone = wrapped
    const unsubscribe = window.luma.onHdrFirstSurface((offer) => {
      if (offers.length < 16) offers.push(structuredClone(offer))
      else omitted++
    })
    const read = () => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')
      if (!canvas?.dataset.firstSurfaceId) return
      const viewport = document.querySelector<HTMLElement>('[data-testid="preview-viewport"]')!,
        bounds = viewport.getBoundingClientRect(),
        geometry = {
          imageWidth: Number(viewport.dataset.imageWidth),
          imageHeight: Number(viewport.dataset.imageHeight),
          scale: Number(viewport.dataset.scale),
        },
        offer = offers.find(
          (offer) =>
            offer.surfaceId === canvas.dataset.firstSurfaceId &&
            offer.requestId === canvas.dataset.previewRequestId,
        ),
        visible =
          canvas.getClientRects().length > 0 && getComputedStyle(canvas).visibility === 'visible'
      const geometryMatches =
        !!offer &&
        geometry.imageWidth === offer.identity.image.width &&
        geometry.imageHeight === offer.identity.image.height &&
        geometry.scale === offer.identity.view.scale &&
        viewport.dataset.mode === (offer.identity.view.fit ? 'fit' : 'manual') &&
        Number(viewport.dataset.panX) === offer.identity.view.x &&
        Number(viewport.dataset.panY) === offer.identity.view.y &&
        bounds.width === offer.identity.viewport.width &&
        bounds.height === offer.identity.viewport.height &&
        (window.devicePixelRatio || 1) === offer.identity.dpr &&
        canvas.width === offer.width &&
        canvas.height === offer.height
      const key = JSON.stringify([
        canvas.dataset.firstSurfaceId,
        canvas.dataset.firstSurface,
        canvas.dataset.editing,
        canvas.dataset.quality,
        visible,
        geometry,
        geometryMatches,
      ])
      if (key === previous) return
      previous = key
      const queue = canvas.getContext('webgpu')?.getConfiguration()?.device.queue
      const queueId = queue ? queues.get(queue) : undefined
      if (phases.length < 64)
        phases.push({
          surfaceId: canvas.dataset.firstSurfaceId,
          phase: canvas.dataset.firstSurface ?? '',
          actualFenceResolved:
            queueId !== undefined &&
            fences.some((fence) => fence.queue === queueId && fence.resolved),
          editing: canvas.dataset.editing ?? '',
          quality: canvas.dataset.quality ?? '',
          cachedReady: canvas.dataset.cachedDisplayReady ?? '',
          recovery: !!canvas.dataset.recoverySnapshot,
          visible,
          geometryMatches,
          geometry,
        })
      else omitted++
    }
    const observer = new MutationObserver(read)
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        'data-first-surface',
        'data-first-surface-id',
        'data-editing',
        'data-quality',
        'data-image-width',
        'data-image-height',
        'data-scale',
        'data-mode',
        'data-pan-x',
        'data-pan-y',
        'style',
      ],
    })
    return {
      state: () => {
        read()
        return { offers, phases, fences, omitted }
      },
      close: () => {
        read()
        observer.disconnect()
        unsubscribe()
        if (GPUQueue.prototype.onSubmittedWorkDone === wrapped)
          GPUQueue.prototype.onSubmittedWorkDone = originalFence
        return { offers, phases, fences, omitted }
      },
    }
  })
}

/** Copy only the real recovery map submitted with this canvas's matching normal blit. */
async function observeNormalHalfPlane(
  page: Page,
  offer: HdrFirstSurfaceOffer,
  preview: HdrPreview,
) {
  return page.evaluateHandle(
    ({ offer, preview }) => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')!
      const context = canvas.getContext('webgpu')!,
        configuration = context.getConfiguration()!
      if (!configuration || configuration.format !== 'rgba16float')
        throw new Error('The actual first-surface context is not configured for half output.')
      const queue = configuration.device.queue,
        byteLength = offer.width * offer.height * 8
      if (!Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > 64 * 1024 ** 2)
        throw new Error('The bounded normal half-plane diagnostic cannot admit this extent.')
      const original = {
        current: GPUCanvasContext.prototype.getCurrentTexture,
        view: GPUTexture.prototype.createView,
        group: GPUDevice.prototype.createBindGroup,
        pass: GPUCommandEncoder.prototype.beginRenderPass,
        bind: GPURenderPassEncoder.prototype.setBindGroup,
        draw: GPURenderPassEncoder.prototype.draw,
        copy: GPUCommandEncoder.prototype.copyTextureToBuffer,
        finish: GPUCommandEncoder.prototype.finish,
        submit: GPUQueue.prototype.submit,
        map: GPUBuffer.prototype.getMappedRange,
      }
      interface Blit {
        id: number
        serial: number
        presentationBefore: number
        sourceIdentity: string
        epoch: number
        parameters: AdjustmentParameters
        view: HdrFirstSurfaceOffer['identity']['view']
        source?: GPUTexture
        submitted: boolean
        draws: number
      }
      interface Copy {
        blit: Blit
        rowBytes: number
        mappedBytes: number
      }
      const views = new WeakMap<GPUTextureView, GPUTexture>(),
        groups = new WeakMap<GPUBindGroup, GPUTexture>(),
        currentTextures = new WeakSet<GPUTexture>(),
        passes = new WeakMap<
          GPURenderPassEncoder,
          { encoder: GPUCommandEncoder; source?: GPUTexture }
        >(),
        blits = new WeakMap<GPUCommandEncoder, Blit>(),
        commands = new WeakMap<GPUCommandBuffer, Blit>(),
        copies = new WeakMap<GPUBuffer, Copy>(),
        errors: string[] = []
      let sequence = 0,
        maps = 0,
        boundCount = 0,
        closed = false
      let mapped: { copy: Copy; pixels: ArrayBuffer } | undefined
      let bound: { copy: Copy; pixels: ArrayBuffer; snapshot: HdrRecoverySnapshot } | undefined
      let hashing: Promise<{ sha256: string; byteLength: number }> | undefined
      const note = (error: unknown) => {
        if (errors.length < 16) errors.push(String(error))
      }
      const adjustments = (p: AdjustmentParameters) =>
        JSON.stringify([
          p.exposureEv,
          p.contrast,
          p.highlights,
          p.shadows,
          p.whites,
          p.blacks,
          p.whiteBalance?.mode === 'custom'
            ? ['custom', p.whiteBalance.kelvin, p.whiteBalance.tint]
            : ['as-shot'],
        ])
      const pose = (view: HdrFirstSurfaceOffer['identity']['view']) =>
        JSON.stringify([view.fit, view.scale, view.x, view.y])
      const expectedSource = `${preview.linear.url}:${preview.linear.hdr.sha256}`
      const inspectPublication = () => {
        if (
          closed ||
          bound ||
          !mapped ||
          !canvas.dataset.recoverySnapshot ||
          canvas.dataset.editing !== 'ready'
        )
          return
        try {
          const snapshot = JSON.parse(canvas.dataset.recoverySnapshot) as HdrRecoverySnapshot,
            blit = mapped.copy.blit,
            target = offer.identity.target
          if (snapshot.serial !== blit.serial) return
          if (
            document.querySelector('[data-testid="main-preview"]') !== canvas ||
            !canvas.isConnected ||
            context.getConfiguration()?.device.queue !== queue ||
            !blit.submitted ||
            blit.draws !== 1 ||
            snapshot.presentationSerial !== blit.presentationBefore + 1 ||
            String(snapshot.serial) !== canvas.dataset.completedEditSerial ||
            String(snapshot.presentationSerial) !== canvas.dataset.presentationSerial ||
            snapshot.sourceIdentity !== expectedSource ||
            blit.sourceIdentity !== expectedSource ||
            canvas.dataset.presentedSourceIdentity !== expectedSource ||
            snapshot.settingsRevision !== offer.identity.settingsRevision ||
            canvas.dataset.presentedSettingsRevision !== String(offer.identity.settingsRevision) ||
            snapshot.epoch !== blit.epoch ||
            snapshot.quality !== 'normal' ||
            canvas.dataset.quality !== 'normal' ||
            snapshot.arithmeticPolicy !== 'reference' ||
            canvas.dataset.presentedArithmeticPolicy !== 'reference' ||
            canvas.dataset.retentionMethod !== 'raw-half-cpu' ||
            snapshot.width !== offer.width ||
            snapshot.height !== offer.height ||
            canvas.width !== offer.width ||
            canvas.height !== offer.height ||
            snapshot.target.generation !== target.generation ||
            snapshot.target.mode !== target.mode ||
            snapshot.target.colorSpace !== target.colorSpace ||
            snapshot.target.peak !== target.peak ||
            snapshot.target.headroom !== target.headroom ||
            adjustments(blit.parameters) !== adjustments(offer.identity.parameters) ||
            pose(blit.view) !== pose(offer.identity.view) ||
            pose(JSON.parse(canvas.dataset.presentedView!)) !== pose(offer.identity.view) ||
            canvas.dataset.comparison !== offer.identity.comparison ||
            canvas.dataset.hdrRanges !== String(offer.identity.hdrRanges)
          )
            throw new Error(
              'The real recovery map is not bound to the expected normal publication.',
            )
          bound = { ...mapped, snapshot }
          mapped = undefined
          boundCount++
        } catch (error) {
          note(error)
        }
      }
      const wrapped = {
        current: function (this: GPUCanvasContext) {
          const texture = original.current.call(this)
          if (this === context) currentTextures.add(texture)
          return texture
        },
        view: function (this: GPUTexture, ...args: Parameters<typeof original.view>) {
          const view = original.view.apply(this, args)
          views.set(view, this)
          return view
        },
        group: function (this: GPUDevice, descriptor: GPUBindGroupDescriptor) {
          const group = original.group.call(this, descriptor)
          if (Array.isArray(descriptor.entries)) {
            const entry = descriptor.entries.find((entry) => entry.binding === 0)
            const texture = entry ? views.get(entry.resource as GPUTextureView) : undefined
            if (texture) groups.set(group, texture)
          }
          return group
        },
        pass: function (this: GPUCommandEncoder, descriptor: GPURenderPassDescriptor) {
          const pass = original.pass.call(this, descriptor)
          if (Array.isArray(descriptor.colorAttachments)) {
            const attachment = descriptor.colorAttachments[0]
            const texture = attachment ? views.get(attachment.view as GPUTextureView) : undefined
            if (texture && currentTextures.has(texture)) passes.set(pass, { encoder: this })
          }
          return pass
        },
        bind: function (this: GPURenderPassEncoder, ...args: unknown[]) {
          const result = Reflect.apply(original.bind, this, args)
          const pass = passes.get(this),
            group = args[1] as GPUBindGroup | null | undefined
          if (pass && args[0] === 0) pass.source = group ? groups.get(group) : undefined
          return result
        } as typeof original.bind,
        draw: function (this: GPURenderPassEncoder, ...args: Parameters<typeof original.draw>) {
          const result = original.draw.apply(this, args),
            pass = passes.get(this)
          if (pass?.source) {
            try {
              const existing = blits.get(pass.encoder)
              if (existing) existing.draws++
              else
                blits.set(pass.encoder, {
                  id: ++sequence,
                  serial: Number(canvas.dataset.requestedSerial),
                  presentationBefore: Number(canvas.dataset.presentationSerial ?? 0),
                  sourceIdentity: canvas.dataset.requestedSourceIdentity ?? '',
                  epoch: Number(canvas.dataset.requestedEpoch),
                  parameters: JSON.parse(canvas.dataset.requestedParameters!),
                  view: JSON.parse(canvas.dataset.requestedView!),
                  source: pass.source,
                  submitted: false,
                  draws: 1,
                })
            } catch (error) {
              note(error)
            }
          }
          return result
        },
        copy: function (this: GPUCommandEncoder, ...args: Parameters<typeof original.copy>) {
          const result = original.copy.apply(this, args),
            [source, destination, extent] = args,
            blit = blits.get(this)
          if (
            blit &&
            source.texture === blit.source &&
            destination.buffer.label === 'luma-hdr-recovery-readback'
          ) {
            try {
              const size = Array.isArray(extent)
                ? extent
                : [
                    (extent as GPUExtent3DDict).width,
                    (extent as GPUExtent3DDict).height ?? 1,
                    (extent as GPUExtent3DDict).depthOrArrayLayers ?? 1,
                  ]
              const rowBytes = Math.ceil((offer.width * 8) / 256) * 256
              if (
                size[0] !== offer.width ||
                size[1] !== offer.height ||
                (size[2] ?? 1) !== 1 ||
                source.texture.format !== 'rgba16float' ||
                (source.mipLevel ?? 0) !== 0 ||
                source.origin !== undefined ||
                (destination.offset ?? 0) !== 0 ||
                destination.bytesPerRow !== rowBytes ||
                destination.rowsPerImage !== offer.height ||
                destination.buffer.size !== rowBytes * offer.height
              )
                throw new Error('The actual normal blit readback geometry is not exact.')
              copies.set(destination.buffer, {
                blit,
                rowBytes,
                mappedBytes: destination.buffer.size,
              })
            } catch (error) {
              note(error)
            }
          }
          return result
        },
        finish: function (this: GPUCommandEncoder, ...args: Parameters<typeof original.finish>) {
          const command = original.finish.apply(this, args),
            blit = blits.get(this)
          if (blit) commands.set(command, blit)
          return command
        },
        submit: function (this: GPUQueue, buffers: Iterable<GPUCommandBuffer>) {
          const result = original.submit.call(this, buffers)
          if (this === queue && Array.isArray(buffers))
            for (const buffer of buffers) {
              const blit = commands.get(buffer)
              if (blit) blit.submitted = true
            }
          return result
        },
        map: function (this: GPUBuffer, ...args: Parameters<typeof original.map>) {
          const range = original.map.apply(this, args),
            copy = copies.get(this)
          if (!closed && !bound && copy?.blit.submitted) {
            try {
              if (++maps > 8 || (args[0] ?? 0) !== 0 || range.byteLength !== copy.mappedBytes)
                throw new Error('The bounded actual normal readback map is ambiguous.')
              mapped = undefined
              const pixels = new ArrayBuffer(byteLength),
                output = new Uint8Array(pixels)
              for (let row = 0; row < offer.height; row++)
                output.set(
                  new Uint8Array(range, row * copy.rowBytes, offer.width * 8),
                  row * offer.width * 8,
                )
              mapped = { copy, pixels }
            } catch (error) {
              note(error)
            }
          }
          return range
        },
      }
      GPUCanvasContext.prototype.getCurrentTexture = wrapped.current
      GPUTexture.prototype.createView = wrapped.view
      GPUDevice.prototype.createBindGroup = wrapped.group
      GPUCommandEncoder.prototype.beginRenderPass = wrapped.pass
      GPURenderPassEncoder.prototype.setBindGroup = wrapped.bind
      GPURenderPassEncoder.prototype.draw = wrapped.draw
      GPUCommandEncoder.prototype.copyTextureToBuffer = wrapped.copy
      GPUCommandEncoder.prototype.finish = wrapped.finish
      GPUQueue.prototype.submit = wrapped.submit
      GPUBuffer.prototype.getMappedRange = wrapped.map
      const observer = new MutationObserver(inspectPublication)
      observer.observe(canvas, {
        attributes: true,
        attributeFilter: [
          'data-recovery-snapshot',
          'data-completed-edit-serial',
          'data-editing',
          'data-quality',
        ],
      })
      const state = () => ({
        maps,
        boundCount,
        errors,
        binding: bound
          ? {
              encoder: bound.copy.blit.id,
              serial: bound.copy.blit.serial,
              presentationBefore: bound.copy.blit.presentationBefore,
              sourceIdentity: bound.copy.blit.sourceIdentity,
              submitted: bound.copy.blit.submitted,
              draws: bound.copy.blit.draws,
              rowBytes: bound.copy.rowBytes,
              mappedBytes: bound.copy.mappedBytes,
              byteLength: bound.pixels.byteLength,
              snapshot: bound.snapshot,
              parameters: bound.copy.blit.parameters,
              view: bound.copy.blit.view,
            }
          : null,
      })
      return {
        state,
        compare: async () => {
          inspectPublication()
          if (!bound || errors.length || boundCount !== 1)
            throw new Error(
              `No unambiguous submitted normal half-plane publication: ${JSON.stringify(state())}`,
            )
          const published = bound
          hashing ??= crypto.subtle.digest('SHA-256', published.pixels).then((digest) => ({
            sha256: Array.from(new Uint8Array(digest), (value) =>
              value.toString(16).padStart(2, '0'),
            ).join(''),
            byteLength: published.pixels.byteLength,
          }))
          return { ...state(), ...(await hashing) }
        },
        close: async () => {
          closed = true
          observer.disconnect()
          GPUCanvasContext.prototype.getCurrentTexture = original.current
          GPUTexture.prototype.createView = original.view
          GPUDevice.prototype.createBindGroup = original.group
          GPUCommandEncoder.prototype.beginRenderPass = original.pass
          GPURenderPassEncoder.prototype.setBindGroup = original.bind
          GPURenderPassEncoder.prototype.draw = original.draw
          GPUCommandEncoder.prototype.copyTextureToBuffer = original.copy
          GPUCommandEncoder.prototype.finish = original.finish
          GPUQueue.prototype.submit = original.submit
          GPUBuffer.prototype.getMappedRange = original.map
          await hashing?.catch(() => undefined)
          const result = state()
          mapped = bound = undefined
          return result
        },
      }
    },
    { offer, preview },
  )
}

async function prepare(app: ElectronApplication, page: Page, fixture: RawFixture = landscape) {
  const { path: raw, filename, photoId } = fixture
  expect(
    createHash('sha256')
      .update(await readFile(raw))
      .digest('hex'),
  ).toBe(photoId)
  const native = await app.browserWindow(page)
  await native.evaluate((window) => {
    window.unmaximize()
    window.setContentSize(1100, 700)
  })
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([1100, 700])
  await activateButton(
    page
      .getByRole('navigation', { name: 'Workspaces' })
      .getByRole('button', { name: 'Library', exact: true }),
  )
  await page.evaluate(() => window.luma.setPreviewPreference('sdr'))
  await importPhotos(app, page, [raw], false, 'keyboard')
  const photo = (await page.evaluate(() => window.luma.listPhotos())).photos.find(
    (photo) => photo.id === photoId,
  )
  expect(photo?.filename).toBe(filename)
  if (fixture.catalogImage)
    expect({ width: photo?.width, height: photo?.height }).toEqual(fixture.catalogImage)
  const edits = await page.evaluate(async (id) => {
    const before = await window.luma.getEdits(id)
    return window.luma.updateEdits(id, { exposureEv: 1.25 }, before.revision)
  }, photoId)
  expect(edits.revision).toBeGreaterThan(0)
  return edits
}

async function openEditor(page: Page, filename = landscape.filename) {
  await activateButton(
    page
      .getByRole('navigation', { name: 'Workspaces' })
      .getByRole('button', { name: 'Editor', exact: true }),
  )
  await activateButton(page.getByRole('button', { name: `Select ${filename}`, exact: true }))
}

/** Read only the genuinely completed isolated cache entry, after the held handler returns. */
async function completedFirstSurface(userDataDir: string, photoId: string, sha256: string) {
  const directory = join(userDataDir, 'library/cache/previews', PREVIEW_ASSET_VERSION),
    matches: (NonNullable<FullPreviewResult['firstSurface']> &
      Pick<FullPreviewResult, 'diagnostics'>)[] = []
  for (const folder of await readdir(directory, { withFileTypes: true })) {
    if (!folder.isDirectory() || !folder.name.startsWith(photoId)) continue
    const entry = JSON.parse(
      await readFile(join(directory, folder.name, 'entry.json'), 'utf8'),
    ) as FullPreviewResult
    if (entry.firstSurface?.sha256 === sha256)
      matches.push({ ...entry.firstSurface, diagnostics: entry.diagnostics })
  }
  expect(matches).toHaveLength(1)
  return matches[0]
}

const firstSurfaceFixtures: (RawFixture & {
  title: string
  actualHdr?: true
  wide?: { vramMiB: number | null; capacity: number; batches: number; peakGpuBytes: number }
})[] = [
  {
    ...landscape,
    title:
      'a real first surface fences before the held full reply and survives full-source attachment',
  },
  {
    path: 'tests/fixtures/research-sony/originals/DSC03243.ARW',
    filename: 'DSC03243.ARW',
    photoId: '93880fc72a77553efd7a4f9b1f6d2462d0175cee94ae37f330903f70f78581ee',
    workingSha256: 'e0f54018ffd6506b1b19eefac33aa8139a2bb5d442bc3669a96dc257a6276856',
    image: { width: 3672, height: 5496 },
    catalogImage: { width: 3672, height: 5504 },
    title:
      'a real portrait first surface matches every normal browser half-plane byte after orientation',
  },
  {
    ...landscape,
    title:
      'a wide real landscape first surface uses one bounded native batch and matches every normal browser half-plane byte',
    wide: { vramMiB: null, capacity: 330, batches: 1, peakGpuBytes: 1596863648 },
  },
  {
    ...landscape,
    title:
      'a lower frozen GPU budget preserves a wide real first surface through bounded native batches with exact browser half bytes',
    wide: { vramMiB: 1510, capacity: 280, batches: 2, peakGpuBytes: 1583342848 },
  },
  {
    ...landscape,
    workingSha256: '632578e368f3ed0b538291b9a4082c5b3f4a7362bf6304083b7f723ed7d381a1',
    image: { width: 5422, height: 3622 },
    title:
      'an actual HDR ultrawide first surface matches every normal browser half-plane byte on the current display target',
    actualHdr: true,
    wide: { vramMiB: null, capacity: 330, batches: 1, peakGpuBytes: 1596863648 },
  },
]
for (const fixture of firstSurfaceFixtures) {
  test(
    fixture.title,
    fixture.wide
      ? foregroundTest(
          fixture.actualHdr
            ? 'Actual HDR requires the native Microstep display, reported HDR headroom and compositor-managed ultrawide backing.'
            : 'Wayland requires a visible compositor-managed window to verify the native ultrawide backing size.',
        )
      : {},
    async ({ luma }, info) => {
      const { app, page, userDataDir } = luma,
        edits = await prepare(app, page, fixture)
      let actualHdrTarget: DisplayTarget | undefined
      if (fixture.wide) {
        const saved = await page.evaluate(
          (vramMiB) => window.luma.setResourceSettings({ version: 1, ramMiB: null, vramMiB }),
          fixture.wide.vramMiB,
        )
        expect(saved.settings.vramMiB).toBe(fixture.wide.vramMiB)
        const maximized = await maximizeEditorOnMonitor(app, page, {
          monitorLabel: fixture.actualHdr
            ? 'Microstep 34"'
            : process.env.LUMA_RESPONSIVENESS_MONITOR,
        })
        await expect
          .poll(() => page.evaluate(() => [innerWidth, innerHeight]))
          .toEqual([3440, 1371])
        if (fixture.actualHdr) {
          // Select Auto only after actual monitor placement. Repeated public
          // observations must agree before the first real source request is admitted.
          const requested = await page.evaluate(() => window.luma.setPreviewPreference('auto'))
          let previous = ''
          try {
            await expect
              .poll(
                async () => {
                  const target = await page.evaluate(() => window.luma.getDisplayState())
                  actualHdrTarget = target
                  const current = JSON.stringify([
                    target.generation,
                    target.mode,
                    target.colorSpace,
                    target.peak,
                    target.headroom,
                    target.capabilities,
                  ])
                  const stable = previous === current
                  previous = current
                  return (
                    stable &&
                    target.requested === 'auto' &&
                    target.generation >= requested.generation &&
                    target.mode === 'hdr' &&
                    target.peak > 1 &&
                    (target.headroom ?? 0) > 1 &&
                    target.capabilities?.hardware === true &&
                    target.capabilities.extended === true &&
                    target.capabilities.monitor?.label === 'Microstep 34"'
                  )
                },
                { timeout: 15000, message: 'The actual ultrawide HDR target must be stable.' },
              )
              .toBe(true)
          } catch (error) {
            await writeFile(
              info.outputPath('hdr-first-surface-actual-hdr-target.json'),
              JSON.stringify(
                { maximized, requested, target: actualHdrTarget, error: String(error) },
                null,
                2,
              ),
            )
            test.skip(
              actualHdrTarget?.mode !== 'hdr' ||
                actualHdrTarget.capabilities?.hardware !== true ||
                actualHdrTarget.capabilities.extended !== true ||
                (actualHdrTarget.headroom ?? 0) <= 1,
              `Actual HDR hardware verification is unavailable: ${actualHdrTarget?.reason ?? 'no display target'}. Selected coverage is incomplete.`,
            )
            throw error
          }
          await writeFile(
            info.outputPath('hdr-first-surface-actual-hdr-target.json'),
            JSON.stringify({ maximized, requested, target: actualHdrTarget }, null, 2),
          )
        }
      }
      const replies = await holdFullReply(app, fixture.photoId),
        observation = await observeFirstSurface(page)
      try {
        await openEditor(page, fixture.filename)
        const canvas = page.getByTestId('main-preview')
        await expect(canvas).toHaveAttribute('data-first-surface-ready', 'true', {
          timeout: 120000,
        })
        await expect(canvas).toBeVisible()
        await expect(canvas).toHaveAttribute('data-editing', 'loading')
        await expect(canvas).not.toHaveAttribute('data-quality', 'normal')
        await expect(canvas).toHaveAttribute('data-cached-display-ready', 'false')
        await expect(canvas).toHaveAttribute('data-source-uploads', '0')
        await expect(page.getByTestId('preview-resolution')).toHaveText('Loading full detail…')
        await expect(page.getByRole('spinbutton', { name: 'Exposure value' })).toBeDisabled()
        await expect(page.getByLabel('Preview zoom', { exact: true })).toBeDisabled()
        await expect
          .poll(async () => (await replies.evaluate((c) => c.state())).held.length)
          .toBe(1)
        const held = await replies.evaluate((c) => c.state())
        expect(held.delivered).toEqual([])
        expect(held.completed).toHaveLength(1)
        const preview = held.completed[0].reply.preview
        expect(held.completed[0].reply.error).toBeUndefined()
        expect(preview?.format).toBe('hdr-working')
        if (!preview) throw new Error('The real full HDR reply is missing.')
        expect(preview.photoId).toBe(fixture.photoId)
        if (fixture.workingSha256) expect(preview.linear.hdr.sha256).toBe(fixture.workingSha256)
        if (fixture.image)
          expect({ width: preview.width, height: preview.height }).toEqual(fixture.image)
        const before = await observation.evaluate((c) => c.state())
        expect(before.offers).toHaveLength(1)
        const offer = before.offers[0]
        expect(offer.photoId).toBe(fixture.photoId)
        expect(offer.identity.originalSha256).toBe(fixture.photoId)
        expect(offer.requestId).toBe(held.completed[0].requestId)
        expect(offer.identity.settingsRevision).toBe(edits.revision)
        if (fixture.actualHdr) {
          expect(actualHdrTarget).toBeDefined()
          expect({
            outputVersion: offer.identity.target.outputVersion,
            generation: offer.identity.target.generation,
            mode: offer.identity.target.mode,
            colorSpace: offer.identity.target.colorSpace,
            peak: offer.identity.target.peak,
            headroom: offer.identity.target.headroom,
          }).toEqual({
            outputVersion: actualHdrTarget!.outputVersion,
            generation: actualHdrTarget!.generation,
            mode: actualHdrTarget!.mode,
            colorSpace: actualHdrTarget!.colorSpace,
            peak: actualHdrTarget!.peak,
            headroom: actualHdrTarget!.headroom,
          })
          expect(offer.identity.target.mode).toBe('hdr')
          expect(offer.identity.target.peak).toBeGreaterThan(1)
        }
        expect(preview.firstSurfaceLineage).toEqual({
          parentWorkingKey: offer.identity.parentWorkingKey,
          workingSha256: preview.linear.hdr.sha256,
        })
        expect(preview.firstSurfacePolicy).toEqual(offer.policy)
        expect(offer.identity.image).toEqual({ width: preview.width, height: preview.height })
        const producer = await completedFirstSurface(userDataDir, fixture.photoId, offer.sha256)
        await writeFile(
          info.outputPath('hdr-first-surface-producer.json'),
          JSON.stringify(producer, null, 2),
        )
        expect(producer.diagnostics?.sourceBackend).toBe('native-rust-rows')
        expect(producer.diagnostics?.backend).toBe('gpu')
        expect(producer.diagnostics?.timings.workerNativeRawSourceMs).toBeGreaterThan(0)
        expect(producer.identity).toEqual(offer.identity)
        expect(producer.timings.deviceTextureArrayLayers).toBe(
          Math.min(2048, producer.timings.adapterTextureArrayLayers),
        )
        expect(producer.timings.allocatedTileLayers).toBe(producer.timings.tileCapacity)
        expect(producer.timings.allocatedTileBytes).toBe(
          producer.timings.tileCapacity * 130 * 130 * 16,
        )
        expect(producer.timings.peakRamBytes).toBeLessThanOrEqual(offer.policy.ram.effectiveBytes)
        expect(producer.timings.peakGpuBytes).toBeLessThanOrEqual(offer.policy.vram.effectiveBytes)
        if (fixture.wide) {
          expect(offer.identity.viewport).toEqual({ width: 2866, height: 1189 })
          expect(offer.identity.dpr).toBe(1)
          expect(producer.timings.adapterTextureArrayLayers).toBeGreaterThanOrEqual(330)
          expect(producer.timings.deviceTextureArrayLayers).toBeGreaterThanOrEqual(330)
          expect(producer.timings.sourceTileCount).toBe(330)
          expect(producer.timings.tileCapacity).toBe(fixture.wide.capacity)
          expect(producer.timings.batches).toBe(fixture.wide.batches)
          expect(producer.timings.peakGpuBytes).toBe(fixture.wide.peakGpuBytes)
          if (fixture.wide.vramMiB !== null) {
            expect(offer.policy.vram.effectiveBytes).toBe(1510 * 1024 ** 2)
            expect(producer.timings.tileCapacity).toBeLessThan(producer.timings.sourceTileCount)
            // The next real slot would exceed this unchanged complete-overlap budget.
            expect(producer.timings.peakGpuBytes + 270416).toBeGreaterThan(
              offer.policy.vram.effectiveBytes,
            )
          }
        }
        expect(
          before.phases.some(
            (phase) =>
              phase.surfaceId === offer.surfaceId &&
              ['fenced', 'painted'].includes(phase.phase) &&
              phase.actualFenceResolved &&
              phase.editing === 'loading' &&
              phase.quality === '' &&
              !phase.recovery,
          ),
        ).toBe(true)
        expect(before.phases.every((phase) => phase.editing !== 'ready')).toBe(true)
        const visibleFirstPlanes = before.phases.filter(
          (phase) =>
            phase.surfaceId === offer.surfaceId &&
            phase.visible &&
            ['fenced', 'painted'].includes(phase.phase),
        )
        expect(visibleFirstPlanes.length).toBeGreaterThan(0)
        expect(visibleFirstPlanes.every((phase) => phase.geometryMatches)).toBe(true)
        expect(visibleFirstPlanes[0].geometry).toEqual({
          imageWidth: offer.identity.image.width,
          imageHeight: offer.identity.image.height,
          scale: offer.identity.view.scale,
        })
        await expect
          .poll(async () =>
            (await replies.evaluate((c) => c.state())).releases.some(
              (release) =>
                release.requestId === offer.requestId &&
                release.surfaceId === offer.surfaceId &&
                release.completed,
            ),
          )
          .toBe(true)
        const revoked = await app.evaluate(async ({ net }, url) => {
          const response = await net.fetch(url)
          await response.arrayBuffer()
          return response.status
        }, offer.url)
        expect(revoked).toBe(404)
        const owner = await canvas.evaluateHandle((element) => {
          const canvas = element as HTMLCanvasElement,
            context = canvas.getContext('webgpu')
          return {
            matches: () =>
              document.querySelector('[data-testid="main-preview"]') === canvas &&
              canvas.getContext('webgpu') === context &&
              canvas.isConnected,
          }
        })
        let half: Awaited<ReturnType<typeof observeNormalHalfPlane>> | undefined
        try {
          // The genuine early blit is already drained and the full reply is still
          // held, so every observed recovery command belongs to normal preparation.
          half = await observeNormalHalfPlane(page, offer, preview)
          await replies.evaluate((c) => c.release())
          await expect(canvas).toHaveAttribute('data-quality', 'normal', { timeout: 120000 })
          await expect(canvas).toHaveAttribute('data-editing', 'ready')
          await expect(canvas).toHaveAttribute(
            'data-presented-settings-revision',
            String(edits.revision),
          )
          await expect(canvas).toHaveAttribute('data-exposure', '1.25')
          await expect(canvas).toHaveAttribute('data-first-surface-id', offer.surfaceId)
          await expect(canvas).toHaveAttribute('data-source-uploads', '1')
          await expect.poll(() => owner.evaluate((state) => state.matches())).toBe(true)
          const source = await canvas.getAttribute('data-presented-source-identity')
          expect(source).toContain(preview.linear.url)
          expect(source).toContain(preview.linear.hdr.sha256)
          await expect(page.getByRole('spinbutton', { name: 'Exposure value' })).toBeEnabled()
          await expect(page.getByLabel('Preview zoom', { exact: true })).toBeEnabled()
          await expect(canvas).toHaveAttribute('data-retention-method', 'raw-half-cpu')
          const comparison = await half.evaluate((control) => control.compare())
          await writeFile(
            info.outputPath('hdr-first-surface-half-comparison.json'),
            JSON.stringify(
              {
                native: {
                  surfaceId: offer.surfaceId,
                  sha256: offer.sha256,
                  byteLength: offer.byteLength,
                  parentWorkingKey: offer.identity.parentWorkingKey,
                  requestId: offer.requestId,
                },
                browser: comparison,
                producer: { timings: producer.timings, policy: offer.policy },
              },
              null,
              2,
            ),
          )
          expect(comparison.errors).toEqual([])
          expect(comparison.maps).toBeGreaterThan(0)
          expect(comparison.maps).toBeLessThanOrEqual(8)
          expect(comparison.boundCount).toBe(1)
          expect(comparison.binding).toMatchObject({
            submitted: true,
            draws: 1,
            sourceIdentity: source,
            byteLength: offer.byteLength,
            parameters: offer.identity.parameters,
            view: offer.identity.view,
            snapshot: {
              sourceIdentity: source,
              settingsRevision: edits.revision,
              quality: 'normal',
              arithmeticPolicy: 'reference',
              width: offer.width,
              height: offer.height,
            },
          })
          expect(comparison.binding?.serial).toBe(
            Number(await canvas.getAttribute('data-completed-edit-serial')),
          )
          expect(comparison.binding?.snapshot.presentationSerial).toBe(
            Number(await canvas.getAttribute('data-presentation-serial')),
          )
          expect(comparison.byteLength).toBe(offer.byteLength)
          expect(comparison.sha256).toBe(offer.sha256)
        } finally {
          try {
            if (half) {
              const drained = await half.evaluate((control) => control.close())
              await writeFile(
                info.outputPath('hdr-first-surface-half-drain.json'),
                JSON.stringify(drained, null, 2),
              )
            }
          } finally {
            await Promise.allSettled([half?.dispose(), owner.dispose()])
          }
        }
      } finally {
        let completed
        try {
          completed = await replies.evaluate((c) => c.close())
        } finally {
          try {
            const observed = await observation.evaluate((c) => c.close())
            await writeFile(
              info.outputPath('hdr-first-surface-handoff.json'),
              JSON.stringify({ completed, observed }, null, 2),
            )
            expect(observed.omitted).toBe(0)
          } finally {
            await Promise.allSettled([replies.dispose(), observation.dispose()])
          }
        }
      }
    },
  )
}

test('a real display-target generation change invalidates a fenced first surface before full delivery', async ({
  luma,
}, info) => {
  const { app, page } = luma
  await prepare(app, page)
  const replies = await holdFullReply(app),
    observation = await observeFirstSurface(page)
  try {
    await openEditor(page)
    const canvas = page.getByTestId('main-preview')
    await expect(canvas).toHaveAttribute('data-first-surface-ready', 'true', { timeout: 120000 })
    const offered = (await observation.evaluate((c) => c.state())).offers[0]
    expect(offered).toBeDefined()
    // Re-selecting SDR changes the actual target generation without inventing a display event.
    const changed = await page.evaluate(() => window.luma.setPreviewPreference('sdr'))
    expect(changed.generation).toBeGreaterThan(offered.identity.target.generation)
    await expect
      .poll(() =>
        page
          .getByTestId('main-preview')
          .evaluate(
            (element) =>
              element.dataset.firstSurfaceReady === 'false' &&
              getComputedStyle(element).visibility === 'hidden',
          ),
      )
      .toBe(true)
    await expect(page.getByRole('spinbutton', { name: 'Exposure value' })).toBeDisabled()
    expect((await replies.evaluate((c) => c.state())).delivered).toEqual([])
    await replies.evaluate((c) => c.release())
    await expect(page.getByTestId('main-preview')).toHaveAttribute('data-quality', 'normal', {
      timeout: 120000,
    })
    await expect(page.getByTestId('main-preview')).toHaveAttribute(
      'data-target-generation',
      String(changed.generation),
    )
    await expect(page.getByRole('spinbutton', { name: 'Exposure value' })).toBeEnabled()
  } finally {
    let completed
    try {
      completed = await replies.evaluate((c) => c.close())
    } finally {
      try {
        const observed = await observation.evaluate((c) => c.close())
        await writeFile(
          info.outputPath('hdr-first-surface-target-change.json'),
          JSON.stringify({ completed, observed }, null, 2),
        )
        expect(observed.omitted).toBe(0)
      } finally {
        await Promise.allSettled([replies.dispose(), observation.dispose()])
      }
    }
  }
})

async function observeHdrRequests(app: ElectronApplication) {
  return app.evaluateHandle(({ ipcMain }) => {
    type Handler = (...args: unknown[]) => unknown
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })
      ._invokeHandlers
    const hdrChannel = 'preview:hdr',
      releaseChannel = 'preview:first-surface-release',
      sourceReleaseChannel = 'preview:release',
      originalHdr = handlers.get(hdrChannel)!,
      originalRelease = handlers.get(releaseChannel)!,
      originalSourceRelease = handlers.get(sourceReleaseChannel)!
    if (!originalHdr || !originalRelease || !originalSourceRelease)
      throw new Error('The actual HDR handlers are missing.')
    const events: {
      sequence: number
      phase: string
      photoId?: string
      requestId: string
      surfaceId?: string
      firstSurface?: HdrFirstSurfaceRequest
      reply?: HdrReply
    }[] = []
    const pending = new Set<Promise<unknown>>()
    let sequence = 0,
      omitted = 0
    const note = (event: Omit<(typeof events)[number], 'sequence'>) => {
      if (events.length < 128) events.push({ ...event, sequence: ++sequence })
      else omitted++
    }
    const hdr: Handler = (...args) => {
      const id = args[1] as string,
        requestId = args[2] as string
      note({
        phase: 'request',
        photoId: id,
        requestId,
        firstSurface: structuredClone(args[5] as HdrFirstSurfaceRequest | undefined),
      })
      const work = Promise.resolve(originalHdr(...args)).then((reply) => {
        note({ phase: 'reply', photoId: id, requestId, reply: structuredClone(reply as HdrReply) })
        return reply
      })
      pending.add(work)
      void work.finally(() => pending.delete(work)).catch(() => undefined)
      return work
    }
    const release: Handler = (...args) => {
      const requestId = args[1] as string,
        surfaceId = args[2] as string
      note({ phase: 'release-start', requestId, surfaceId })
      const work = Promise.resolve(originalRelease(...args)).then((result) => {
        note({ phase: 'release-done', requestId, surfaceId })
        return result
      })
      pending.add(work)
      void work.finally(() => pending.delete(work)).catch(() => undefined)
      return work
    }
    const sourceRelease: Handler = (...args) => {
      const requestId = args[1] as string
      note({ phase: 'source-release-start', requestId })
      const work = Promise.resolve(originalSourceRelease(...args)).then((result) => {
        note({ phase: 'source-release-done', requestId })
        return result
      })
      pending.add(work)
      void work.finally(() => pending.delete(work)).catch(() => undefined)
      return work
    }
    ipcMain.removeHandler(hdrChannel)
    ipcMain.handle(hdrChannel, hdr)
    ipcMain.removeHandler(releaseChannel)
    ipcMain.handle(releaseChannel, release)
    ipcMain.removeHandler(sourceReleaseChannel)
    ipcMain.handle(sourceReleaseChannel, sourceRelease)
    const state = () => ({ events, sequence, omitted })
    return {
      state,
      close: async () => {
        try {
          await Promise.allSettled([...pending])
        } finally {
          if (handlers.get(hdrChannel) === hdr) {
            ipcMain.removeHandler(hdrChannel)
            ipcMain.handle(hdrChannel, originalHdr)
          }
          if (handlers.get(releaseChannel) === release) {
            ipcMain.removeHandler(releaseChannel)
            ipcMain.handle(releaseChannel, originalRelease)
          }
          if (handlers.get(sourceReleaseChannel) === sourceRelease) {
            ipcMain.removeHandler(sourceReleaseChannel)
            ipcMain.handle(sourceReleaseChannel, originalSourceRelease)
          }
        }
        return state()
      },
    }
  })
}

async function holdFirstSurfaceDigest(page: Page) {
  return page.evaluateHandle((photoId) => {
    const originalDigest = SubtleCrypto.prototype.digest,
      originalBuffer = GPUDevice.prototype.createBuffer,
      originalTexture = GPUDevice.prototype.createTexture
    const offers: HdrFirstSurfaceOffer[] = [],
      pending = new Set<Promise<unknown>>()
    const events: {
      sequence: number
      phase: string
      delivered: boolean
      format?: string
      bytes?: number
      width?: number
      height?: number
    }[] = []
    let armed = true,
      monitoring = false,
      held = false,
      delivered = false,
      sequence = 0,
      omitted = 0,
      stalePublication = false
    let heldOffer: HdrFirstSurfaceOffer | undefined,
      actualSha256: string | undefined,
      oldCanvas: HTMLCanvasElement | undefined,
      releaseHeld: (() => void) | undefined,
      oldObserver: MutationObserver | undefined
    const note = (phase: string, detail: Partial<(typeof events)[number]> = {}) => {
      if (events.length < 256) events.push({ sequence: ++sequence, phase, delivered, ...detail })
      else omitted++
    }
    const inspectOld = () => {
      if (!oldCanvas || !heldOffer) return
      stalePublication ||=
        oldCanvas.dataset.firstSurfaceId === heldOffer.surfaceId ||
        oldCanvas.dataset.firstSurfaceReady === 'true' ||
        !!oldCanvas.dataset.firstSurfaceFencedAt ||
        !!oldCanvas.dataset.firstSurfacePostPaintAt ||
        oldCanvas.dataset.editing === 'ready'
    }
    const release = () => {
      const resolve = releaseHeld
      releaseHeld = undefined
      resolve?.()
    }
    const unsubscribe = window.luma.onHdrFirstSurface((offer) => {
      if (offer.photoId !== photoId) return
      if (offers.length < 16) offers.push(structuredClone(offer))
      else omitted++
    })
    const digest: typeof originalDigest = function (this: SubtleCrypto, ...args) {
      const work = (async () => {
        const result = await originalDigest.apply(this, args)
        if (armed) {
          const sha256 = Array.from(new Uint8Array(result), (value) =>
            value.toString(16).padStart(2, '0'),
          ).join('')
          const offer = offers.find(
            (offer) => offer.sha256 === sha256 && offer.byteLength === args[1].byteLength,
          )
          if (offer) {
            armed = false
            held = true
            heldOffer = offer
            actualSha256 = sha256
            oldCanvas = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')!
            if (oldCanvas.dataset.previewRequestId !== offer.requestId)
              throw new Error('The genuine digest does not belong to the current preview request.')
            oldObserver = new MutationObserver(inspectOld)
            oldObserver.observe(oldCanvas, { attributes: true })
            note('actual-digest-completed', { bytes: args[1].byteLength })
            await new Promise<void>((resolve) => {
              releaseHeld = resolve
            })
            held = false
            delivered = true
            note('actual-digest-delivered')
          }
        }
        return result
      })()
      pending.add(work)
      void work.finally(() => pending.delete(work)).catch(() => undefined)
      return work
    }
    const buffer: typeof originalBuffer = function (this: GPUDevice, descriptor) {
      const result = originalBuffer.call(this, descriptor)
      if (monitoring) note('gpu-buffer', { bytes: descriptor.size })
      return result
    }
    const texture: typeof originalTexture = function (this: GPUDevice, descriptor) {
      const result = originalTexture.call(this, descriptor)
      if (monitoring) {
        const size = Array.isArray(descriptor.size)
          ? descriptor.size
          : [
              (descriptor.size as GPUExtent3DDict).width,
              (descriptor.size as GPUExtent3DDict).height ?? 1,
            ]
        note('gpu-texture', { format: descriptor.format, width: size[0], height: size[1] })
      }
      return result
    }
    SubtleCrypto.prototype.digest = digest
    GPUDevice.prototype.createBuffer = buffer
    GPUDevice.prototype.createTexture = texture
    const state = () => {
      inspectOld()
      return {
        held,
        delivered,
        heldOffer,
        actualSha256,
        offers,
        events,
        omitted,
        stalePublication,
      }
    }
    return {
      state,
      release,
      beginSwitch: () => {
        if (!held || !heldOffer || delivered)
          throw new Error('The genuine completed first digest must still be held.')
        monitoring = true
        note('photo-switch-started')
      },
      close: async () => {
        armed = false
        release()
        try {
          await Promise.allSettled([...pending])
        } finally {
          inspectOld()
          oldObserver?.disconnect()
          unsubscribe()
          if (SubtleCrypto.prototype.digest === digest)
            SubtleCrypto.prototype.digest = originalDigest
          if (GPUDevice.prototype.createBuffer === buffer)
            GPUDevice.prototype.createBuffer = originalBuffer
          if (GPUDevice.prototype.createTexture === texture)
            GPUDevice.prototype.createTexture = originalTexture
        }
        return state()
      },
    }
  }, photoId)
}

test('a held genuine first-surface digest drains before a photo switch can start new HDR owners', async ({
  luma,
}, info) => {
  const { app, page } = luma,
    edits = await prepare(app, page)
  await importPhotos(app, page, ['tests/fixtures/photos/alpine-lake.jpg'], false, 'keyboard')
  await expect
    .poll(async () =>
      (await page.evaluate(() => window.luma.listPhotos())).photos.some(
        (photo) => photo.filename === 'alpine-lake.jpg',
      ),
    )
    .toBe(true)
  const main = await observeHdrRequests(app)
  const receiver = await holdFirstSurfaceDigest(page)
  try {
    await openEditor(page)
    await expect
      .poll(async () => (await receiver.evaluate((control) => control.state())).held, {
        timeout: 120000,
      })
      .toBe(true)
    const initial = await receiver.evaluate((control) => control.state()),
      offer = initial.heldOffer!
    expect(offer).toBeDefined()
    expect(initial.actualSha256).toBe(offer.sha256)
    expect(offer.identity.settingsRevision).toBe(edits.revision)
    expect(initial.stalePublication).toBe(false)
    const canvas = page.getByTestId('main-preview')
    await expect(canvas).toHaveAttribute('data-editing', 'loading')
    await expect(canvas).toHaveAttribute('data-first-surface-ready', 'false')
    await receiver.evaluate((control) => control.beginSwitch())
    await activateButton(page.getByRole('button', { name: 'Select alpine-lake.jpg', exact: true }))
    await expect(canvas).toHaveAttribute('aria-label', 'alpine-lake.jpg')
    await activateButton(page.getByRole('button', { name: 'Select sony-zv1.ARW', exact: true }))
    await expect(canvas).toHaveAttribute('aria-label', 'sony-zv1.ARW')
    // A bounded scheduling interval tests ownership ordering, not presentation cadence.
    await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 250)))
    const blocked = await receiver.evaluate((control) => control.state()),
      beforeRelease = await main.evaluate((control) => control.state())
    expect(blocked).toMatchObject({
      held: true,
      delivered: false,
      stalePublication: false,
      omitted: 0,
    })
    expect(blocked.events.filter((event) => event.phase.startsWith('gpu-'))).toEqual([])
    expect(
      beforeRelease.events
        .filter((event) => event.phase === 'request' && event.photoId === photoId)
        .map((event) => event.requestId),
    ).toEqual([offer.requestId])
    await expect(canvas).not.toHaveAttribute('data-editing', 'ready')
    await expect(canvas).toHaveAttribute('data-first-surface-ready', 'false')
    await receiver.evaluate((control) => control.release())
    await expect(canvas).toHaveAttribute('data-quality', 'normal', { timeout: 120000 })
    await expect(canvas).toHaveAttribute('data-editing', 'ready')
    await expect(canvas).toHaveAttribute('data-exposure', '1.25')
    await expect(canvas).toHaveAttribute('data-presented-settings-revision', String(edits.revision))
    const finalRequestId = await canvas.getAttribute('data-preview-request-id')
    expect(finalRequestId).toBeTruthy()
    expect(finalRequestId).not.toBe(offer.requestId)
    const settled = await main.evaluate((control) => control.state())
    const finalRequest = settled.events.find(
      (event) => event.phase === 'request' && event.requestId === finalRequestId,
    )
    const finalReply = settled.events.find(
      (event) => event.phase === 'reply' && event.requestId === finalRequestId,
    )?.reply
    expect(finalRequest?.photoId).toBe(photoId)
    expect(finalReply?.error).toBeUndefined()
    expect(finalReply?.preview?.format).toBe('hdr-working')
    expect(
      settled.events.some(
        (event) =>
          event.phase === 'release-done' &&
          event.requestId === offer.requestId &&
          event.surfaceId === offer.surfaceId &&
          event.sequence > beforeRelease.sequence &&
          event.sequence < finalRequest!.sequence,
      ),
    ).toBe(true)
    const source = await canvas.getAttribute('data-presented-source-identity')
    expect(source).toContain(finalReply!.preview!.linear.url)
    expect(source).toContain(finalReply!.preview!.linear.hdr.sha256)
    const drained = await receiver.evaluate((control) => control.state())
    expect(drained).toMatchObject({
      held: false,
      delivered: true,
      stalePublication: false,
      omitted: 0,
    })
    const allocations = drained.events.filter((event) => event.phase.startsWith('gpu-'))
    expect(allocations.length).toBeGreaterThan(0)
    expect(allocations.every((allocation) => allocation.delivered)).toBe(true)
    expect(
      allocations.some(
        (allocation) =>
          allocation.phase === 'gpu-texture' &&
          allocation.format === 'rgba32float' &&
          allocation.width === finalReply!.preview!.width &&
          allocation.height === finalReply!.preview!.height,
      ),
    ).toBe(true)
  } finally {
    // Release the actual digest before waiting on either renderer or main diagnostics.
    let renderer, privileged
    try {
      await receiver.evaluate((control) => control.release())
      renderer = await receiver.evaluate((control) => control.close())
    } finally {
      try {
        privileged = await main.evaluate((control) => control.close())
      } finally {
        await Promise.allSettled([receiver.dispose(), main.dispose()])
      }
    }
    await writeFile(
      info.outputPath('hdr-first-surface-digest-interruption.json'),
      JSON.stringify({ renderer, privileged }, null, 2),
    )
    expect(renderer.omitted).toBe(0)
    expect(privileged.omitted).toBe(0)
  }
})

async function prepareResidentRaw(app: ElectronApplication, page: Page) {
  const edits = await prepare(app, page)
  await importPhotos(app, page, ['tests/fixtures/photos/alpine-lake.jpg'], false, 'keyboard')
  await expect
    .poll(async () =>
      (await page.evaluate(() => window.luma.listPhotos())).photos.some(
        (photo) => photo.filename === 'alpine-lake.jpg',
      ),
    )
    .toBe(true)
  await openEditor(page)
  const canvas = page.getByTestId('main-preview')
  await expect(canvas).toHaveAttribute('data-quality', 'normal', { timeout: 120000 })
  await expect(canvas).toHaveAttribute('data-editing', 'ready')
  await expect(canvas).toHaveAttribute('data-source-cache', 'miss-retained')
  await expect(canvas).toHaveAttribute('data-source-uploads', '1')
  await expect(canvas).toHaveAttribute('data-presented-settings-revision', String(edits.revision))
  const seededSource = await canvas.getAttribute('data-presented-source-identity'),
    seededRequestId = await canvas.getAttribute('data-preview-request-id')
  expect(seededSource).toBeTruthy()
  expect(seededRequestId).toBeTruthy()
  await activateButton(page.getByRole('button', { name: 'Select alpine-lake.jpg', exact: true }))
  await expect(canvas).toHaveAttribute('aria-label', 'alpine-lake.jpg')
  await expect(canvas).toHaveAttribute('data-editing', 'ready')
  const history = await page.evaluate((id) => window.luma.getEditHistory(id), photoId)

  return { edits, seededSource, seededRequestId, history }
}

/** Observe optional receiver work without changing admission or any real operation. */
async function observeWarmSource(page: Page) {
  return page.evaluateHandle(() => {
    const originalFetch = window.fetch,
      originalDigest = SubtleCrypto.prototype.digest,
      offers: HdrFirstSurfaceOffer[] = [],
      firstFetches: string[] = [],
      digests: { byteLength: number; filename: string; requestId: string }[] = []
    let omitted = 0,
      stalePublication = false,
      forbiddenRequestId = '',
      forbiddenCanvas: HTMLCanvasElement | undefined,
      oldObserver: MutationObserver | undefined
    const inspect = () => {
      const current = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')
      for (const canvas of [current, forbiddenCanvas])
        if (forbiddenRequestId && canvas?.dataset.previewRequestId === forbiddenRequestId)
          stalePublication ||=
            canvas.dataset.editing === 'ready' ||
            canvas.dataset.quality === 'normal' ||
            canvas.dataset.firstSurfaceReady === 'true' ||
            canvas.dataset.cachedDisplayReady === 'true'
    }
    const observer = new MutationObserver(inspect)
    observer.observe(document.body, { subtree: true, childList: true, attributes: true })
    const unsubscribe = window.luma.onHdrFirstSurface((offer) => {
      if (offers.length < 16) offers.push(structuredClone(offer))
      else omitted++
    })
    const fetch: typeof originalFetch = function (...args) {
      const input = args[0],
        url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('/first/')) {
        if (firstFetches.length < 32) firstFetches.push(url)
        else omitted++
      }
      return originalFetch.apply(window, args)
    }
    const digest: typeof originalDigest = function (this: SubtleCrypto, ...args) {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')
      if (digests.length < 64)
        digests.push({
          byteLength: args[1].byteLength,
          filename: canvas?.getAttribute('aria-label') ?? '',
          requestId: canvas?.dataset.previewRequestId ?? '',
        })
      else omitted++
      return originalDigest.apply(this, args)
    }
    window.fetch = fetch
    SubtleCrypto.prototype.digest = digest
    const state = () => {
      inspect()
      return { offers, firstFetches, digests, stalePublication, omitted }
    }
    return {
      state,
      forbidPublication: (requestId: string) => {
        forbiddenRequestId = requestId
        forbiddenCanvas = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')!
        if (forbiddenCanvas.dataset.previewRequestId !== requestId)
          throw new Error('The cancelled warm owner must be the actual current canvas.')
        oldObserver = new MutationObserver(inspect)
        oldObserver.observe(forbiddenCanvas, { attributes: true })
        inspect()
      },
      close: () => {
        inspect()
        observer.disconnect()
        oldObserver?.disconnect()
        unsubscribe()
        if (window.fetch === fetch) window.fetch = originalFetch
        if (SubtleCrypto.prototype.digest === digest) SubtleCrypto.prototype.digest = originalDigest
        return state()
      },
    }
  })
}

test('a verified resident RAW source omits optional first-surface work and reuses exact source history', async ({
  luma,
}, info) => {
  const { app, page } = luma,
    { edits, seededSource, seededRequestId, history } = await prepareResidentRaw(app, page),
    main = await observeHdrRequests(app),
    receiver = await observeWarmSource(page)
  try {
    await activateButton(page.getByRole('button', { name: 'Select sony-zv1.ARW', exact: true }))
    const canvas = page.getByTestId('main-preview')
    await expect(canvas).toHaveAttribute('aria-label', landscape.filename)
    await expect(canvas).toHaveAttribute('data-quality', 'normal', { timeout: 120000 })
    await expect(canvas).toHaveAttribute('data-editing', 'ready')
    await expect(canvas).toHaveAttribute('data-source-cache', 'hit')
    await expect(canvas).toHaveAttribute('data-source-uploads', '0')
    await expect(canvas).toHaveAttribute('data-exposure', '1.25')
    await expect(canvas).toHaveAttribute('data-presented-settings-revision', String(edits.revision))
    await expect(canvas).toHaveAttribute('data-presented-source-identity', seededSource!)
    await expect(canvas).toHaveAttribute('data-first-surface-ready', 'false')
    const requestId = await canvas.getAttribute('data-preview-request-id')
    expect(requestId).toBeTruthy()
    expect(requestId).not.toBe(seededRequestId)
    const privileged = await main.evaluate((control) => control.state()),
      requests = privileged.events.filter(
        (event) => event.phase === 'request' && event.photoId === photoId,
      ),
      reply = privileged.events.find(
        (event) => event.phase === 'reply' && event.requestId === requestId,
      )?.reply
    expect(requests).toHaveLength(1)
    expect(requests[0].requestId).toBe(requestId)
    expect(requests[0].firstSurface).toBeUndefined()
    expect(reply?.error).toBeUndefined()
    expect(reply?.preview?.format).toBe('hdr-working')
    expect(reply?.preview?.photoId).toBe(photoId)
    expect(reply?.preview?.requestId).toBe(requestId)
    expect(seededSource).toContain(reply!.preview!.linear.url)
    expect(seededSource).toContain(reply!.preview!.linear.hdr.sha256)
    const renderer = await receiver.evaluate((control) => control.state())
    expect(renderer.offers).toEqual([])
    expect(renderer.firstFetches).toEqual([])
    expect(renderer.digests).toEqual([])
    expect(renderer.stalePublication).toBe(false)
    expect(await page.evaluate((id) => window.luma.getEditHistory(id), photoId)).toEqual(history)
  } finally {
    let renderer, privileged
    try {
      renderer = await receiver.evaluate((control) => control.close())
    } finally {
      try {
        privileged = await main.evaluate((control) => control.close())
      } finally {
        await Promise.allSettled([receiver.dispose(), main.dispose()])
      }
    }
    await writeFile(
      info.outputPath('hdr-first-surface-warm-omitted.json'),
      JSON.stringify({ renderer, privileged }, null, 2),
    )
    expect(renderer.omitted).toBe(0)
    expect(privileged.omitted).toBe(0)
  }
})

test('a cancelled completed warm RAW reply cannot replace the next photo or its later current owner', async ({
  luma,
}, info) => {
  const { app, page } = luma,
    { edits, seededSource, seededRequestId, history } = await prepareResidentRaw(app, page),
    main = await observeHdrRequests(app),
    replies = await holdFullReply(app),
    receiver = await observeWarmSource(page)
  try {
    await activateButton(page.getByRole('button', { name: 'Select sony-zv1.ARW', exact: true }))
    const canvas = page.getByTestId('main-preview')
    await expect
      .poll(async () => (await replies.evaluate((control) => control.state())).held.length)
      .toBe(1)
    const held = await replies.evaluate((control) => control.state()),
      oldRequestId = held.held[0]
    expect(held.requests).toHaveLength(1)
    expect(held.requests[0]).toEqual({ requestId: oldRequestId, firstSurface: undefined })
    expect(held.completed[0].reply.error).toBeUndefined()
    expect(held.completed[0].reply.preview?.format).toBe('hdr-working')
    expect(held.completed[0].reply.preview?.requestId).toBe(oldRequestId)
    expect(held.delivered).toEqual([])
    await expect(canvas).toHaveAttribute('data-preview-request-id', oldRequestId)
    await expect(canvas).not.toHaveAttribute('data-editing', 'ready')
    await receiver.evaluate((control, id) => control.forbidPublication(id), oldRequestId)
    await activateButton(page.getByRole('button', { name: 'Select alpine-lake.jpg', exact: true }))
    await expect(canvas).toHaveAttribute('aria-label', 'alpine-lake.jpg')
    await expect(canvas).toHaveAttribute('data-editing', 'ready')
    const rasterRequestId = await canvas.getAttribute('data-preview-request-id')
    await expect
      .poll(async () =>
        (await main.evaluate((control) => control.state())).events.some(
          (event) => event.phase === 'source-release-done' && event.requestId === oldRequestId,
        ),
      )
      .toBe(true)
    await replies.evaluate((control, id) => control.releaseRequest(id), oldRequestId)
    await expect
      .poll(async () => (await replies.evaluate((control) => control.state())).delivered)
      .toContain(oldRequestId)
    // A genuine renderer/main round trip follows the old IPC reply's delivery.
    await page.evaluate(() => window.luma.getDisplayState())
    await expect(canvas).toHaveAttribute('aria-label', 'alpine-lake.jpg')
    await expect(canvas).toHaveAttribute('data-preview-request-id', rasterRequestId!)
    await expect(canvas).toHaveAttribute('data-editing', 'ready')
    expect((await receiver.evaluate((control) => control.state())).stalePublication).toBe(false)
    await activateButton(page.getByRole('button', { name: 'Select sony-zv1.ARW', exact: true }))
    await expect
      .poll(async () => (await replies.evaluate((control) => control.state())).held.length)
      .toBe(1)
    const nextHeld = await replies.evaluate((control) => control.state()),
      finalRequestId = nextHeld.held[0]
    expect(finalRequestId).not.toBe(oldRequestId)
    expect(finalRequestId).not.toBe(seededRequestId)
    expect(nextHeld.requests).toHaveLength(2)
    expect(nextHeld.requests.every((request) => request.firstSurface === undefined)).toBe(true)
    await expect(canvas).toHaveAttribute('data-preview-request-id', finalRequestId)
    await expect(canvas).not.toHaveAttribute('data-editing', 'ready')
    await replies.evaluate((control) => control.release())
    await expect(canvas).toHaveAttribute('data-quality', 'normal', { timeout: 120000 })
    await expect(canvas).toHaveAttribute('data-editing', 'ready')
    await expect(canvas).toHaveAttribute('data-preview-request-id', finalRequestId)
    await expect(canvas).toHaveAttribute('data-source-cache', 'hit')
    await expect(canvas).toHaveAttribute('data-source-uploads', '0')
    await expect(canvas).toHaveAttribute('data-presented-source-identity', seededSource!)
    await expect(canvas).toHaveAttribute('data-presented-settings-revision', String(edits.revision))
    await expect(canvas).toHaveAttribute('data-exposure', '1.25')
    const privileged = await main.evaluate((control) => control.state()),
      release = privileged.events.find(
        (event) => event.phase === 'source-release-done' && event.requestId === oldRequestId,
      ),
      finalRequest = privileged.events.find(
        (event) => event.phase === 'request' && event.requestId === finalRequestId,
      ),
      finalReply = privileged.events.find(
        (event) => event.phase === 'reply' && event.requestId === finalRequestId,
      )?.reply
    expect(release).toBeDefined()
    expect(finalRequest?.photoId).toBe(photoId)
    expect(release!.sequence).toBeLessThan(finalRequest!.sequence)
    expect(finalReply?.error).toBeUndefined()
    expect(finalReply?.preview?.photoId).toBe(photoId)
    expect(finalReply?.preview?.requestId).toBe(finalRequestId)
    expect(seededSource).toContain(finalReply!.preview!.linear.url)
    expect(seededSource).toContain(finalReply!.preview!.linear.hdr.sha256)
    const renderer = await receiver.evaluate((control) => control.state())
    expect(renderer.offers).toEqual([])
    expect(renderer.firstFetches).toEqual([])
    expect(renderer.digests.filter((digest) => digest.filename === landscape.filename)).toEqual([])
    expect(renderer.stalePublication).toBe(false)
    expect(await page.evaluate((id) => window.luma.getEditHistory(id), photoId)).toEqual(history)
  } finally {
    // Release held genuine IPC replies before awaiting either observer's real work.
    let completed, renderer, privileged
    try {
      await replies.evaluate((control) => control.release())
      renderer = await receiver.evaluate((control) => control.close())
    } finally {
      try {
        completed = await replies.evaluate((control) => control.close())
      } finally {
        try {
          privileged = await main.evaluate((control) => control.close())
        } finally {
          await Promise.allSettled([receiver.dispose(), replies.dispose(), main.dispose()])
        }
      }
    }
    await writeFile(
      info.outputPath('hdr-first-surface-warm-late-reply.json'),
      JSON.stringify({ completed, renderer, privileged }, null, 2),
    )
    expect(renderer.omitted).toBe(0)
    expect(privileged.omitted).toBe(0)
  }
})
