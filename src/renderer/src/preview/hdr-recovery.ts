/// <reference types="@webgpu/types" />
import type { HdrManagedBytes, HdrRecoveryReservation } from './hdr-memory'

/** Derived recovery pixels have their own policy; normal rendering is unchanged. */
export const HDR_RECOVERY_VERSION = 'float16-cpu-snapshot-v1'

export interface HdrRecoverySnapshot {
  serial: number
  presentationSerial: number
  sourceIdentity: string
  epoch: number
  settingsRevision: number | null
  target: {
    mode: 'sdr' | 'hdr'
    colorSpace: PredefinedColorSpace
    peak: number
    headroom: number | null
    generation: number
  }
  quality: 'normal' | 'interactive'
  arithmeticPolicy: string
  width: number
  height: number
}

export interface HdrRecoveryCapture {
  readonly finished: Promise<void>
  complete: (fence: Promise<void>) => Promise<{ mapMs: number; copyMs: number }>
  commit: (snapshot: HdrRecoverySnapshot) => void
  release: () => void
}

interface HalfFrame {
  pixels: Uint16Array<ArrayBuffer>
  snapshot: HdrRecoverySnapshot
}

let supported: boolean | undefined
function float16Constructor() {
  return (
    globalThis as unknown as {
      Float16Array?: new (buffer: ArrayBuffer) => ArrayBufferView<ArrayBuffer>
    }
  ).Float16Array
}

/** Check the format once, without reading or converting any photograph. */
export function supportsHdrRecovery() {
  if (supported !== undefined) return supported
  supported = false
  const Float16 = float16Constructor()
  if (!Float16) return false
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  try {
    const options = { colorSpace: 'display-p3', colorType: 'float16', willReadFrequently: true },
      context = canvas.getContext('2d', options) as CanvasRenderingContext2D | null,
      attributes = context?.getContextAttributes() as
        (CanvasRenderingContext2DSettings & { colorType?: string }) | undefined,
      buffer = new ArrayBuffer(8),
      pixels = Reflect.construct(ImageData, [
        new Float16(buffer),
        1,
        1,
        { colorSpace: 'display-p3', pixelFormat: 'rgba-float16' },
      ]) as ImageData & { pixelFormat?: string }
    supported =
      attributes?.colorSpace === 'display-p3' &&
      attributes.colorType === 'float16' &&
      attributes.willReadFrequently === true &&
      pixels.pixelFormat === 'rgba-float16' &&
      pixels.data.buffer === buffer
  } catch {
    supported = false
  } finally {
    canvas.width = canvas.height = 0
  }
  return supported
}

/** One mapped GPU buffer and two alternating CPU planes; the committed plane never aliases a map. */
export class HdrRecovery {
  private device?: GPUDevice
  private buffer?: GPUBuffer
  private extent = ''
  private spare?: Uint16Array<ArrayBuffer>
  private staging?: Uint16Array<ArrayBuffer>
  private committed?: HalfFrame
  private active?: HdrRecoveryCapture
  private closed = false

  get snapshot() {
    return this.committed?.snapshot
  }

  /** Existing owners remain charged until a differently sized replacement commits. */
  reservation(width: number, height: number): HdrRecoveryReservation {
    const cpuBytes =
        (this.committed?.pixels.byteLength ?? 0) +
        (this.spare?.byteLength ?? 0) +
        (this.staging?.byteLength ?? 0),
      conversionBytes = Math.max(
        this.committed?.pixels.byteLength ?? 0,
        this.staging?.byteLength ?? 0,
      ),
      gpuBytes = this.buffer?.size ?? 0,
      owners: HdrManagedBytes = {
        // Mapped readback may own host staging beside its GPU resource.
        ramBytes: cpuBytes + conversionBytes + gpuBytes,
        vramBytes: gpuBytes,
      }
    return {
      rawReplacementOverlap:
        (this.extent && this.extent !== `${width}:${height}`) ||
        (this.committed &&
          (this.committed.snapshot.width !== width || this.committed.snapshot.height !== height))
          ? owners
          : { ramBytes: 0, vramBytes: 0 },
      cpuStagingCarry: owners,
    }
  }

  encode(
    device: GPUDevice,
    encoder: GPUCommandEncoder,
    texture: GPUTexture,
    width: number,
    height: number,
  ): HdrRecoveryCapture {
    if (this.closed || this.active) throw new Error('HDR recovery owner is unavailable.')
    if (![width, height].every((value) => Number.isSafeInteger(value) && value > 0))
      throw new Error('Invalid HDR recovery extent.')
    const bytesPerRow = Math.ceil((width * 8) / 256) * 256,
      size = bytesPerRow * height,
      length = width * height * 4,
      extent = `${width}:${height}`
    if (!Number.isSafeInteger(size) || !Number.isSafeInteger(length))
      throw new Error('HDR recovery extent is not exact.')
    if (this.device !== device || this.extent !== extent) {
      this.buffer?.destroy()
      this.buffer = undefined
      this.spare = undefined
      this.device = device
      this.extent = extent
    }
    const buffer = (this.buffer ??= device.createBuffer({
      label: 'luma-hdr-recovery-readback',
      size,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    }))
    const pixels = this.spare?.length === length ? this.spare : new Uint16Array(length)
    this.spare = undefined
    this.staging = pixels
    let finish!: () => void,
      complete = false,
      released = false,
      committed = false,
      completing: Promise<{ mapMs: number; copyMs: number }> | undefined
    const capture: HdrRecoveryCapture = {
      finished: new Promise<void>((resolve) => {
        finish = resolve
      }),
      complete: (fence) => {
        if (released || completing) throw new Error('HDR recovery capture already completed.')
        completing = (async () => {
          const mapping = performance.now()
          // Observe fence and mapping independently, including a synchronous map failure.
          const settled = await Promise.allSettled([
            fence,
            Promise.resolve().then(() => buffer.mapAsync(GPUMapMode.READ)),
          ])
          const mapMs = performance.now() - mapping,
            failure = settled.find((item) => item.status === 'rejected')
          try {
            if (failure?.status === 'rejected') throw failure.reason
            if (this.closed) return { mapMs, copyMs: 0 }
            const copying = performance.now(),
              mapped = buffer.getMappedRange()
            for (let row = 0; row < height; row++)
              pixels.set(new Uint16Array(mapped, row * bytesPerRow, width * 4), row * width * 4)
            complete = true
            return { mapMs, copyMs: performance.now() - copying }
          } finally {
            if (buffer.mapState === 'mapped') buffer.unmap()
          }
        })()
        return completing
      },
      commit: (snapshot) => {
        if (this.closed || released || !complete || committed || this.active !== capture)
          throw new Error('HDR recovery capture is not ready to commit.')
        if (snapshot.width !== width || snapshot.height !== height)
          throw new Error('HDR recovery snapshot extent changed before publication.')
        const previous = this.committed
        this.committed = { pixels, snapshot: structuredClone(snapshot) }
        this.staging = undefined
        if (previous?.pixels.length === length) this.spare = previous.pixels
        committed = true
      },
      release: () => {
        if (released) return
        released = true
        const release = () => {
          if (!committed && !this.closed) this.spare = pixels
          if (this.staging === pixels) this.staging = undefined
          if (this.active === capture) this.active = undefined
          finish()
        }
        // Cancellation cannot release a mapped/source owner before both promises settle.
        if (completing) void completing.then(release, release)
        else release()
      },
    }
    try {
      encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: height }, [
        width,
        height,
      ])
      this.active = capture
      return capture
    } catch (error) {
      capture.release()
      throw error
    }
  }

  /** No GPU access: the last published half-float plane survives device destruction. */
  recover(surface: HTMLCanvasElement) {
    const frame = this.committed,
      Float16 = float16Constructor()
    if (!frame || !Float16) return false
    const { snapshot, pixels } = frame,
      { width, height, target } = snapshot,
      reconstructed = document.createElement('canvas')
    reconstructed.width = width
    reconstructed.height = height
    try {
      const data = Reflect.construct(ImageData, [
        new Float16(pixels.buffer),
        width,
        height,
        { colorSpace: target.colorSpace, pixelFormat: 'rgba-float16' },
      ]) as ImageData & { pixelFormat?: string }
      if (
        data.pixelFormat !== 'rgba-float16' ||
        data.colorSpace !== target.colorSpace ||
        data.data.buffer !== pixels.buffer
      )
        throw new Error('HDR recovery ImageData did not retain the owned half-float plane.')
      const requested = {
          colorSpace: target.colorSpace,
          colorType: 'float16',
          willReadFrequently: true,
        },
        context = reconstructed.getContext('2d', requested) as CanvasRenderingContext2D | null,
        attributes = context?.getContextAttributes() as
          (CanvasRenderingContext2DSettings & { colorType?: string }) | undefined
      if (
        !context ||
        attributes?.colorSpace !== target.colorSpace ||
        attributes.colorType !== 'float16' ||
        attributes.willReadFrequently !== true
      )
        throw new Error('HDR recovery source-gamut CPU float16 canvas is unavailable.')
      context.putImageData(data, 0, 0)
      const scale = Math.min(1, 1024 / Math.max(width, height))
      surface.width = Math.max(1, Math.round(width * scale))
      surface.height = Math.max(1, Math.round(height * scale))
      const output = surface.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true })
      if (!output || output.isContextLost()) throw new Error('HDR recovery CPU canvas is lost.')
      output.drawImage(reconstructed, 0, 0, surface.width, surface.height)
      output.getImageData(0, 0, 1, 1)
      if (output.isContextLost()) throw new Error('HDR recovery conversion was lost.')
      Object.assign(surface.dataset, {
        presentationSerial: String(snapshot.presentationSerial),
        recoveryPolicy: HDR_RECOVERY_VERSION,
        recoverySnapshot: JSON.stringify(snapshot),
        recoveryMaterialized: 'true',
      })
      return true
    } finally {
      reconstructed.width = reconstructed.height = 0
    }
  }

  clear() {
    this.committed = undefined
  }

  async releaseTransient() {
    if (this.active) await this.active.finished
    this.buffer?.destroy()
    this.buffer = undefined
    this.spare = undefined
    this.extent = ''
  }

  async dispose() {
    this.closed = true
    // Cancel only a genuinely pending map. The capture still drains its real
    // fence and rejected map before releasing owners; mapped receivers stay valid.
    if (this.buffer?.mapState === 'pending') this.buffer.unmap()
    await this.releaseTransient()
    // The presenter materializes its bounded recovery canvas before closing.
    // Do not keep a full old CPU plane alive behind a retired presenter callback.
    this.committed = undefined
  }
}
