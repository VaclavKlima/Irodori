/** Independent forward image operations, rather than the producer's inverse fetch mapping. */
export function orientedPixelOrder(width: number, height: number, flip: number) {
  let rows = Array.from({ length: height }, (_, y) =>
    Array.from({ length: width }, (_, x) => y * width + x),
  )
  if (flip & 1) rows = rows.map((row) => row.slice().reverse())
  if (flip & 2) rows = rows.slice().reverse()
  if (flip & 4) rows = rows[0].map((_, x) => rows.map((row) => row[x]))
  return { width: rows[0].length, height: rows.length, pixels: rows.flat() }
}

export const manuallyOrientedThreeByTwo = [
  [0, 1, 2, 3, 4, 5],
  [2, 1, 0, 5, 4, 3],
  [3, 4, 5, 0, 1, 2],
  [5, 4, 3, 2, 1, 0],
  [0, 3, 1, 4, 2, 5],
  [2, 5, 1, 4, 0, 3],
  [3, 0, 4, 1, 5, 2],
  [5, 2, 4, 1, 3, 0],
]

/** Large and tiny terms make reassociation visible; alpha exercises premultiplication. */
export function orientationInput(width: number, height: number): Float32Array<ArrayBuffer> {
  const terms = [2 ** 24, 1, -(2 ** 24), 0.5, -0.25, 2 ** -24, 0.75, -1]
  const alpha = [0, 0.125, 0.5, 1, Math.fround(0.7)]
  return Float32Array.from({ length: width * height * 4 }, (_, index) => {
    const pixel = Math.floor(index / 4),
      channel = index % 4
    const x = pixel % width,
      y = Math.floor(pixel / width)
    if (width >= 4 && height >= 2 && x >= 2 && x < 4 && y < 2) {
      const corner = y * 2 + x - 2
      if (channel === 3) return [1, 0.5, 1, 1][corner]
      if (channel === 0) return [2 ** 24, 1, -(2 ** 24), 0.5][corner]
    }
    if (channel === 3)
      return pixel % width < 2 && Math.floor(pixel / width) < 2 ? 0 : alpha[pixel % alpha.length]
    return terms[(pixel * 3 + channel) % terms.length]
  })
}

export function independentlyOrientedInput(
  input: Float32Array<ArrayBuffer>,
  width: number,
  height: number,
  flip: number,
) {
  const order = orientedPixelOrder(width, height, flip)
  const source = new Uint32Array(input.buffer, input.byteOffset, input.length)
  const words = Uint32Array.from(
    order.pixels.flatMap((pixel) => Array.from(source.subarray(pixel * 4, pixel * 4 + 4))),
  )
  return { ...order, data: new Float32Array(words.buffer) }
}
