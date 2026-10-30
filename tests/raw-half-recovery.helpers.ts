import type { Page } from '@playwright/test'

export interface RawHalfRecoverySnapshot {
  serial: number
  sourceIdentity: string
  presentationSerial: number
  epoch: number
  settingsRevision: number | null
  target: {
    mode: 'sdr' | 'hdr'
    colorSpace: PredefinedColorSpace
    generation: number
    peak: number
    headroom: number | null
  }
  quality: string
  arithmeticPolicy: string
  width: number
  height: number
}

export interface PendingRecoveryDeparture {
  source: string | null
  serial: number | null
  requestId: string | null
  submittedAt: number
  fenceLinked: boolean
  pendingAt?: number
  mapStateAtEntry?: GPUBufferMapState
  switchRequestedAt?: number
  fenceResolvedAt?: number
  fenceRejectedAt?: number
  mapFulfilledAt?: number
  mapRejectedAt?: number
  mapErrorName?: string
  unmaps: Array<{ at: number; before: GPUBufferMapState; after: GPUBufferMapState }>
  destroyedAt?: number
  nextHdrSubmittedAt?: number
  stalePublication: boolean
}

interface Probe {
  armOracle(): void
  armReadback(): void
  armPendingDeparture(filename: string): void
  release(): void
  state(): {
    oracleCaptures: number
    recoveryMaterializations: number
    holdArmed: boolean
    held: boolean
    mapped: boolean
    heldSource: string | null
    heldSerial: number | null
    released: number
    settled: number
    errors: string[]
    trace: Array<Record<string, unknown>>
    pendingDeparture: PendingRecoveryDeparture | null
    departedCanvasConnected: boolean | null
  }
  compare(): Promise<{
    reference: Record<string, unknown>
    retained: Record<string, unknown>
    width: number
    height: number
    maximumRgbDifference: number
    maximumAlphaDifference: number
    changedRGBA: number[]
    changedPixels: number
    strictZero: boolean
    proposedOneCode: boolean
    referenceSha256: string
    retainedSha256: string
    referencePng: string
    retainedPng: string
  }>
  close(): void
}
type ProbeWindow = Window & { rawHalfRecoveryProbe: Probe }

export async function installRawHalfRecoveryProbe(page: Page) {
  await page.addInitScript(() => {
    const original = {
        current: GPUCanvasContext.prototype.getCurrentTexture,
        submit: GPUQueue.prototype.submit,
        map: GPUBuffer.prototype.mapAsync,
        unmap: GPUBuffer.prototype.unmap,
        destroy: GPUBuffer.prototype.destroy,
        copyTextureToBuffer: GPUCommandEncoder.prototype.copyTextureToBuffer,
        finish: GPUCommandEncoder.prototype.finish,
        fence: GPUQueue.prototype.onSubmittedWorkDone,
        putImageData: CanvasRenderingContext2D.prototype.putImageData,
      },
      pending = new WeakMap<GPUQueue, HTMLCanvasElement>(),
      recoveryEncoders = new WeakMap<GPUCommandEncoder, GPUBuffer>(),
      recoveryCommands = new WeakMap<GPUCommandBuffer, GPUBuffer>(),
      recoverySubmissions = new WeakMap<GPUBuffer, PendingRecoveryDeparture>(),
      recoveryFences = new WeakMap<GPUQueue, PendingRecoveryDeparture>(),
      trace: Array<Record<string, unknown>> = [],
      errors: string[] = []
    let oracleArmed = false,
      holdArmed = false,
      oracleCaptures = 0,
      recoveryMaterializations = 0,
      released = 0,
      settled = 0,
      departureFilename: string | undefined,
      departure: PendingRecoveryDeparture | undefined,
      departedCanvas: HTMLCanvasElement | undefined,
      departedRecovery: HTMLCanvasElement | undefined,
      departureObserver: MutationObserver | undefined,
      reference:
        | {
            canvas: HTMLCanvasElement
            pixels: Uint8ClampedArray
            metadata: Record<string, unknown>
          }
        | undefined,
      held:
        | { mapped: boolean; source: string | null; serial: number | null; release: () => void }
        | undefined
    const main = () => document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]'),
      retained = () =>
        document.querySelector<HTMLCanvasElement>('[data-testid="retained-preview"]'),
      metadata = (canvas: HTMLCanvasElement) => ({
        source: canvas.dataset.requestedSourceIdentity ?? null,
        requestedSerial: canvas.dataset.requestedSerial ?? null,
        completedSerial: canvas.dataset.completedEditSerial ?? null,
        presentationSerial: canvas.dataset.presentationSerial ?? null,
        epoch: canvas.dataset.requestedEpoch ?? null,
        settingsRevision: canvas.dataset.presentedSettingsRevision ?? null,
        recoveryPolicy: canvas.dataset.recoveryPolicy ?? null,
        recoverySnapshot: canvas.dataset.recoverySnapshot
          ? JSON.parse(canvas.dataset.recoverySnapshot)
          : null,
        label: canvas.getAttribute('aria-label'),
        width: canvas.width,
        height: canvas.height,
        bounds: canvas.getBoundingClientRect().toJSON(),
        visibility: getComputedStyle(canvas).visibility,
      }),
      note = (phase: string) => {
        if (trace.length < 256)
          trace.push({
            at: Date.now(),
            phase,
            main: main() ? metadata(main()!) : null,
            retained: retained() ? metadata(retained()!) : null,
          })
      },
      release = () => {
        if (held) {
          released++
          held.release()
        }
      },
      observer = new MutationObserver((records) => {
        if (
          records.some(
            (record) =>
              record.target instanceof HTMLCanvasElement &&
              ['main-preview', 'retained-preview'].includes(record.target.dataset.testid ?? ''),
          )
        )
          note('publication')
      })
    observer.observe(document, {
      subtree: true,
      attributes: true,
      attributeFilter: [
        'data-completed-edit-serial',
        'data-recovery-snapshot',
        'data-recovery-materialized',
        'data-recovery-policy',
        'style',
        'aria-label',
      ],
    })
    CanvasRenderingContext2D.prototype.putImageData = function (data, ...coordinates: number[]) {
      if ((data as ImageData & { pixelFormat?: string }).pixelFormat === 'rgba-float16')
        recoveryMaterializations++
      return Reflect.apply(original.putImageData, this, [data, ...coordinates])
    }
    GPUCanvasContext.prototype.getCurrentTexture = function () {
      const texture = original.current.call(this),
        canvas = this.canvas
      if (canvas instanceof HTMLCanvasElement && canvas.dataset.testid === 'main-preview') {
        const queue = this.getConfiguration()?.device.queue
        if (queue) pending.set(queue, canvas)
      }
      return texture
    }
    GPUCommandEncoder.prototype.copyTextureToBuffer = function (...args) {
      const result = Reflect.apply(original.copyTextureToBuffer, this, args)
      if (departureFilename && args[1].buffer.label === 'irodori-hdr-recovery-readback')
        recoveryEncoders.set(this, args[1].buffer)
      return result
    }
    GPUCommandEncoder.prototype.finish = function (...args) {
      const command = Reflect.apply(original.finish, this, args) as GPUCommandBuffer,
        buffer = recoveryEncoders.get(this)
      if (buffer) recoveryCommands.set(command, buffer)
      return command
    }
    GPUQueue.prototype.onSubmittedWorkDone = function () {
      const work = original.fence.call(this),
        record = recoveryFences.get(this)
      recoveryFences.delete(this)
      if (record) {
        record.fenceLinked = true
        void work.then(
          () => {
            record.fenceResolvedAt = performance.now()
          },
          () => {
            record.fenceRejectedAt = performance.now()
          },
        )
      }
      return work
    }
    GPUBuffer.prototype.unmap = function () {
      const record = recoverySubmissions.get(this),
        before = this.mapState,
        at = performance.now()
      original.unmap.call(this)
      if (record) record.unmaps.push({ at, before, after: this.mapState })
    }
    GPUBuffer.prototype.destroy = function () {
      original.destroy.call(this)
      const record = recoverySubmissions.get(this)
      if (record) record.destroyedAt = performance.now()
    }
    GPUQueue.prototype.submit = function (...args) {
      const commands = departureFilename ? Array.from(args[0]) : undefined,
        result = Reflect.apply(original.submit, this, commands ? [commands] : args),
        canvas = pending.get(this)
      pending.delete(this)
      if (departure && canvas && canvas !== departedCanvas && !departure.nextHdrSubmittedAt)
        departure.nextHdrSubmittedAt = performance.now()
      if (departureFilename && commands && canvas) {
        const buffers = commands.flatMap((command) => {
          const buffer = recoveryCommands.get(command)
          return buffer ? [buffer] : []
        })
        if (buffers.length > 1) errors.push('Ambiguous submitted recovery copy.')
        if (buffers.length === 1) {
          departure = {
            source: canvas.dataset.requestedSourceIdentity ?? null,
            serial: canvas.dataset.requestedSerial ? Number(canvas.dataset.requestedSerial) : null,
            requestId: canvas.dataset.previewRequestId ?? null,
            submittedAt: performance.now(),
            fenceLinked: false,
            unmaps: [],
            stalePublication: false,
          }
          departedCanvas = canvas
          departedRecovery = retained() ?? undefined
          recoverySubmissions.set(buffers[0], departure)
          recoveryFences.set(this, departure)
          const record = departure,
            stale = () => {
              if (!record.switchRequestedAt || record.serial === null) return
              for (const element of [departedCanvas, departedRecovery]) {
                if (!element) continue
                const snapshot = element.dataset.recoverySnapshot
                  ? JSON.parse(element.dataset.recoverySnapshot)
                  : null
                if (
                  Number(element.dataset.completedEditSerial ?? -1) >= record.serial ||
                  Number(snapshot?.serial ?? -1) >= record.serial
                )
                  record.stalePublication = true
              }
            }
          departureObserver = new MutationObserver(stale)
          for (const element of [departedCanvas, departedRecovery])
            if (element)
              departureObserver.observe(element, {
                attributes: true,
                attributeFilter: ['data-completed-edit-serial', 'data-recovery-snapshot'],
              })
        }
      }
      if (oracleArmed && canvas) {
        oracleArmed = false
        try {
          const scale = Math.min(1, 1024 / Math.max(canvas.width, canvas.height)),
            copy = document.createElement('canvas')
          copy.width = Math.max(1, Math.round(canvas.width * scale))
          copy.height = Math.max(1, Math.round(canvas.height * scale))
          const context = copy.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true })!
          // The real final blit has been submitted. Capture in this same task,
          // before the WebGPU drawing buffer expires; never substitute earlier tiles.
          context.drawImage(canvas, 0, 0, copy.width, copy.height)
          const image = context.getImageData(0, 0, copy.width, copy.height),
            config = canvas.getContext('webgpu')!.getConfiguration()
          if (reference) reference.canvas.width = reference.canvas.height = 0
          reference = {
            canvas: copy,
            pixels: image.data,
            metadata: {
              ...metadata(canvas),
              submitted: true,
              context: context.getContextAttributes(),
              readColorSpace: image.colorSpace,
              configuration: config
                ? {
                    format: config.format,
                    colorSpace: config.colorSpace,
                    alphaMode: config.alphaMode,
                    toneMapping: config.toneMapping,
                  }
                : null,
            },
          }
          oracleCaptures++
          note('same-task-oracle')
        } catch (error) {
          errors.push(String(error))
        }
      }
      return result
    }
    GPUBuffer.prototype.mapAsync = function (...args) {
      const work = Reflect.apply(original.map, this, args) as Promise<undefined>,
        record = recoverySubmissions.get(this)
      if (departureFilename && record) {
        const filename = departureFilename
        departureFilename = undefined
        record.mapStateAtEntry = this.mapState
        if (!record.fenceLinked || this.mapState !== 'pending') {
          errors.push('Recovery map was not pending after its actual submitted fence was linked.')
          return work
        }
        record.pendingAt = performance.now()
        void work.then(
          () => {
            record.mapFulfilledAt = performance.now()
          },
          (error: unknown) => {
            record.mapRejectedAt = performance.now()
            record.mapErrorName = error instanceof DOMException ? error.name : String(error)
          },
        )
        const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
          (button) => button.getAttribute('aria-label') === `Select ${filename}`,
        )
        if (!button || button.disabled)
          errors.push('The real departure photo button is unavailable.')
        else {
          // Switch within this genuine pending-map task; no GPU promise or RAF is held.
          record.switchRequestedAt = performance.now()
          button.click()
        }
        return work
      }
      if (!holdArmed || this.label !== 'irodori-hdr-recovery-readback') return work
      holdArmed = false
      let resolve!: () => void
      const gate = new Promise<void>((done) => {
          resolve = done
        }),
        canvas = main(),
        owner = {
          mapped: false,
          source: canvas?.dataset.requestedSourceIdentity ?? null,
          serial: canvas?.dataset.requestedSerial ? Number(canvas.dataset.requestedSerial) : null,
          release: resolve,
        }
      held = owner
      note('readback-held')
      return work
        .then(async (): Promise<undefined> => {
          owner.mapped = true
          note('real-readback-mapped')
          await gate
          return undefined
        })
        .finally(() => {
          settled++
          if (held === owner) held = undefined
          note('held-readback-settled')
        })
    }
    ;(window as unknown as ProbeWindow).rawHalfRecoveryProbe = {
      armOracle: () => {
        trace.length = 0
        oracleArmed = true
        note('oracle-armed')
      },
      armReadback: () => {
        if (held || holdArmed) throw new Error('A recovery readback is already armed or held.')
        trace.length = 0
        holdArmed = true
        note('readback-armed')
      },
      armPendingDeparture: (filename) => {
        if (held || holdArmed || departureFilename || departure)
          throw new Error('A recovery departure or held readback is already active.')
        departureFilename = filename
        note('pending-departure-armed')
      },
      release,
      state: () => ({
        oracleCaptures,
        recoveryMaterializations,
        holdArmed,
        held: !!held,
        mapped: held?.mapped ?? false,
        heldSource: held?.source ?? null,
        heldSerial: held?.serial ?? null,
        released,
        settled,
        errors: [...errors],
        trace,
        pendingDeparture: departure ?? null,
        departedCanvasConnected: departedCanvas?.isConnected ?? null,
      }),
      compare: async () => {
        if (!reference) throw new Error('No final-blit CPU oracle was captured.')
        const canvas = retained()
        if (
          !canvas ||
          canvas.width !== reference.canvas.width ||
          canvas.height !== reference.canvas.height
        )
          throw new Error('Recovery dimensions do not match the unchanged CPU oracle.')
        const actual = canvas
            .getContext('2d', { colorSpace: 'srgb', willReadFrequently: true })!
            .getImageData(0, 0, canvas.width, canvas.height).data,
          expected = reference.pixels,
          changedRGBA = [0, 0, 0, 0]
        if (actual.length !== expected.length)
          throw new Error('Recovery RGBA plane length changed.')
        let maximumRgbDifference = 0,
          maximumAlphaDifference = 0,
          changedPixels = 0,
          nonblack = false
        for (let i = 0; i < actual.length; i += 4) {
          let changed = false
          for (let c = 0; c < 4; c++) {
            const difference = Math.abs(actual[i + c] - expected[i + c])
            if (c < 3) {
              maximumRgbDifference = Math.max(maximumRgbDifference, difference)
              nonblack ||= expected[i + c] > 0
            } else {
              maximumAlphaDifference = Math.max(maximumAlphaDifference, difference)
              if (expected[i + c] !== 255) throw new Error('CPU oracle is not opaque.')
            }
            if (difference) {
              changedRGBA[c]++
              changed = true
            }
          }
          changedPixels += Number(changed)
        }
        if (!nonblack) throw new Error('The actual photographic oracle was blank.')
        const hash = async (pixels: Uint8ClampedArray) =>
          Array.from(
            new Uint8Array(await crypto.subtle.digest('SHA-256', pixels.buffer as ArrayBuffer)),
            (n) => n.toString(16).padStart(2, '0'),
          ).join('')
        return {
          reference: reference.metadata,
          retained: metadata(canvas),
          width: canvas.width,
          height: canvas.height,
          maximumRgbDifference,
          maximumAlphaDifference,
          changedRGBA,
          changedPixels,
          strictZero: maximumRgbDifference === 0 && maximumAlphaDifference === 0,
          proposedOneCode: maximumRgbDifference <= 1 && maximumAlphaDifference === 0,
          referenceSha256: await hash(expected),
          retainedSha256: await hash(actual),
          referencePng: reference.canvas.toDataURL('image/png'),
          retainedPng: canvas.toDataURL('image/png'),
        }
      },
      close: () => {
        release()
        oracleArmed = holdArmed = false
        observer.disconnect()
        departureObserver?.disconnect()
        departureFilename = undefined
        departedCanvas = departedRecovery = undefined
        GPUCanvasContext.prototype.getCurrentTexture = original.current
        GPUQueue.prototype.submit = original.submit
        GPUBuffer.prototype.mapAsync = original.map
        GPUBuffer.prototype.unmap = original.unmap
        GPUBuffer.prototype.destroy = original.destroy
        GPUCommandEncoder.prototype.copyTextureToBuffer = original.copyTextureToBuffer
        GPUCommandEncoder.prototype.finish = original.finish
        GPUQueue.prototype.onSubmittedWorkDone = original.fence
        CanvasRenderingContext2D.prototype.putImageData = original.putImageData
        if (reference) reference.canvas.width = reference.canvas.height = 0
      },
    }
  })
  await page.reload()
}

export const recoveryProbeState = (page: Page) =>
  page.evaluate(() => (window as unknown as ProbeWindow).rawHalfRecoveryProbe.state())
export const recoveryProbeAction = (
  page: Page,
  action: 'armOracle' | 'armReadback' | 'release' | 'close',
) =>
  page.evaluate(
    (action) => (window as unknown as ProbeWindow).rawHalfRecoveryProbe[action](),
    action,
  )
export const compareRawHalfRecovery = (page: Page) =>
  page.evaluate(() => (window as unknown as ProbeWindow).rawHalfRecoveryProbe.compare())

export const armPendingRecoveryDeparture = (page: Page, filename: string) =>
  page.evaluate(
    (filename) =>
      (window as unknown as ProbeWindow).rawHalfRecoveryProbe.armPendingDeparture(filename),
    filename,
  )
