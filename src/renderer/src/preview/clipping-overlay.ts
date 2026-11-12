interface Size {
  readonly width: number
  readonly height: number
}
interface Level extends Size {
  readonly data: Uint8Array
}
interface ClippingOverlayOptions {
  readonly levels: readonly Level[]
  readonly image: Size
  readonly viewport: Size
  readonly view: { readonly scale: number; readonly x: number; readonly y: number }
  readonly hdr: boolean
  readonly hdrOverlay: number
  readonly highlights: boolean
  readonly shadows: boolean
  readonly split?: number
}

/** Viewport decoration only. Classifications stay in their source-grid pyramid.
 * Sample at CSS pixel centres, then use putImageData without a fractional canvas
 * rescale: Canvas2D backends can disagree at nearest-neighbour boundaries. */
export function clippingOverlayPixels(options: ClippingOverlayOptions) {
  const { levels, image, viewport, view } = options
  if (!levels.length || view.scale <= 0) return undefined
  let index = 0
  while (
    index + 1 < levels.length &&
    (image.width * view.scale < levels[index].width ||
      image.height * view.scale < levels[index].height)
  )
    index++
  const level = levels[index]
  const left = (viewport.width - image.width * view.scale) / 2 + view.x
  const top = (viewport.height - image.height * view.scale) / 2 + view.y
  const pixelWidth = (image.width * view.scale) / level.width
  const pixelHeight = (image.height * view.scale) / level.height
  const canvasWidth = Math.max(1, Math.round(viewport.width))
  const canvasHeight = Math.max(1, Math.round(viewport.height))
  const x0 = Math.max(0, Math.ceil(left - 0.5))
  const y0 = Math.max(0, Math.ceil(top - 0.5))
  const x1 = Math.min(canvasWidth, Math.ceil(left + image.width * view.scale - 0.5))
  const y1 = Math.min(canvasHeight, Math.ceil(top + image.height * view.scale - 0.5))
  const width = x1 - x0
  const height = y1 - y0
  if (width <= 0 || height <= 0) return undefined
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    const my = Math.min(
      level.height - 1,
      Math.max(0, Math.floor((y0 + y + 0.5 - top) / pixelHeight)),
    )
    for (let x = 0; x < width; x++) {
      if (options.split !== undefined && x0 + x + 0.5 < canvasWidth * options.split) continue
      const mx = Math.min(
        level.width - 1,
        Math.max(0, Math.floor((x0 + x + 0.5 - left) / pixelWidth)),
      )
      const bits = level.data[my * level.width + mx]
      const at = (y * width + x) * 4
      if (options.hdr && bits & options.hdrOverlay) {
        data[at] = 255
        data[at + 1] = 160
        data[at + 3] = (mx + my) % 4 < 2 ? 220 : 140
      } else if (!options.hdr && options.highlights && bits & 2) {
        data[at] = 255
        data[at + 3] = 180
      } else if (!options.hdr && options.shadows && bits & 1) {
        data[at + 2] = 255
        data[at + 3] = 180
      }
    }
  }
  return { data, width, height, left: x0, top: y0 }
}
