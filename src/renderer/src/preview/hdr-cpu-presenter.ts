import { publishHdrSample } from './hdr-sample'
import type { WorkingFrame, AdjustmentParameters } from '../../../shared/adjustments'
import type { DisplayTarget } from '../../../shared/hdr'
import type { Size, View } from './geometry'
import { reservePresentationBitmaps } from './frame-cache'

export class HdrCpuPresenter {
  private worker = new Worker(new URL('./hdr-presentation-worker.ts', import.meta.url), {
    type: 'module',
  })
  private context: CanvasRenderingContext2D
  private frame?: WorkingFrame
  private bitmap?: ImageBitmap
  private completedParameters?: AdjustmentParameters
  private completedRanges = false
  private neutral?: ImageBitmap
  private generation = 0
  private key = ''
  private mode = 'after'
  private split = 0.5
  private hdrRanges = false
  private target?: DisplayTarget
  private release = reservePresentationBitmaps(256 * 1024 ** 2)
  private view?: { image: Size; viewport: Size; view: View; parameters: AdjustmentParameters }
  constructor(
    private canvas: HTMLCanvasElement,
    private loaded: () => void,
    private failed: () => void,
  ) {
    const context = canvas.getContext('2d', { colorSpace: 'srgb' })
    if (!context) throw new Error('CPU presentation unavailable.')
    this.context = context
    canvas.dataset.backend = 'canvas2d-hdr-sdr'
    this.worker.onmessage = ({ data }) => {
      if (data.generation !== this.generation) {
        data.bitmap?.close()
        data.neutral?.close()
        return
      }
      if (data.error) {
        this.failed()
        return
      }
      this.bitmap?.close()
      this.neutral?.close()
      this.bitmap = data.bitmap
      this.neutral = data.neutral
      this.completedParameters = data.parameters
      this.completedRanges = data.hdrRanges
      this.canvas.dataset.quality = data.draft ? 'draft' : 'normal'
      if (data.sample && data.draftSample && this.frame?.hdr)
        publishHdrSample(this.frame.hdr.sha256, data.sample, data.draftSample)
      this.loaded()
      if (this.view)
        this.draw(this.view.image, this.view.viewport, this.view.view, this.view.parameters)
    }
  }
  setTarget(target: DisplayTarget) {
    this.target = target
  }
  setWorking(frame: WorkingFrame) {
    if (this.frame?.identity === frame.identity) return
    this.frame = frame
    this.key = ''
  }
  setBitmap(bitmap: ImageBitmap) {
    void bitmap /* HDR data is rendered by the worker. */
  }
  setComparison(mode: string, split: number) {
    this.mode = mode
    this.split = split
  }
  setHdrRanges(enabled: boolean) {
    this.hdrRanges = enabled
  }
  draw(image: Size, viewport: Size, view: View, parameters: AdjustmentParameters) {
    this.view = { image, viewport, view, parameters }
    if (!this.frame?.hdr || !viewport.width || !viewport.height) return
    const key = JSON.stringify([parameters, this.hdrRanges, this.target?.headroom])
    if (key !== this.key) {
      this.key = key
      this.worker.postMessage({
        asset: this.frame.hdr,
        parameters,
        hdrRanges: this.hdrRanges,
        generation: ++this.generation,
        target: this.target,
      })
    }
    if (!this.bitmap || !this.neutral) return
    const dpr = devicePixelRatio || 1
    const width = Math.max(1, Math.round(viewport.width * dpr)),
      height = Math.max(1, Math.round(viewport.height * dpr))
    if (width * height * 16 > 64 * 1024 ** 2) {
      this.failed()
      return
    }
    this.canvas.width = width
    this.canvas.height = height
    const context = this.context
    context.scale(dpr, dpr)
    context.clearRect(0, 0, viewport.width, viewport.height)
    context.imageSmoothingEnabled = view.scale < 1
    const x = (viewport.width - image.width * view.scale) / 2 + view.x,
      y = (viewport.height - image.height * view.scale) / 2 + view.y
    context.drawImage(
      this.mode === 'before' ? this.neutral : this.bitmap,
      x,
      y,
      image.width * view.scale,
      image.height * view.scale,
    )
    if (this.mode === 'split') {
      context.save()
      context.beginPath()
      context.rect(0, 0, viewport.width * this.split, viewport.height)
      context.clip()
      context.clearRect(0, 0, viewport.width, viewport.height)
      context.drawImage(this.neutral, x, y, image.width * view.scale, image.height * view.scale)
      context.restore()
    }
    if (view.scale >= 8) {
      context.strokeStyle = 'rgba(128,128,128,0.15)'
      context.lineWidth = 1 / dpr
      context.beginPath()
      for (
        let px = Math.max(0, Math.ceil(-x / view.scale));
        px <= Math.min(image.width, Math.floor((viewport.width - x) / view.scale));
        px++
      ) {
        context.moveTo(x + px * view.scale, Math.max(0, y))
        context.lineTo(
          x + px * view.scale,
          Math.min(viewport.height, y + image.height * view.scale),
        )
      }
      for (
        let py = Math.max(0, Math.ceil(-y / view.scale));
        py <= Math.min(image.height, Math.floor((viewport.height - y) / view.scale));
        py++
      ) {
        context.moveTo(Math.max(0, x), y + py * view.scale)
        context.lineTo(Math.min(viewport.width, x + image.width * view.scale), y + py * view.scale)
      }
      context.stroke()
    }
    this.canvas.style.visibility = 'visible'
    const completed = this.completedParameters!
    Object.assign(this.canvas.dataset, {
      editing: 'ready',
      exposure: String(completed.exposureEv),
      contrast: String(completed.contrast),
      highlights: String(completed.highlights),
      shadows: String(completed.shadows),
      whites: String(completed.whites),
      blacks: String(completed.blacks),
      whiteBalance: JSON.stringify(completed.whiteBalance),
      comparison: this.mode,
      hdrRanges: String(this.completedRanges),
    })
  }
  dispose() {
    this.worker.terminate()
    this.bitmap?.close()
    this.neutral?.close()
    this.release()
  }
}
