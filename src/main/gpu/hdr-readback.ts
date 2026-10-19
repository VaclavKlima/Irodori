/** Copy a mapped RGBA Float32 strip into its full native, oriented destination.
 * The mapped view starts at strip row zero; rowBytes includes GPU row padding.
 * Both views and their geometry are owned and validated by the readback caller. */
export function copyHdrReadbackStrip(
  values: Float32Array,
  pixels: Float32Array,
  width: number,
  height: number,
  rowBytes: number,
  top: number,
  count: number,
  flip: number,
): void {
  if (flip === 0) {
    const rowFloats = width * 4,
      stride = rowBytes / 4
    if (stride === rowFloats) {
      pixels.set(values.subarray(0, count * rowFloats), top * rowFloats)
    } else {
      for (let row = 0; row < count; row++)
        pixels.set(values.subarray(row * stride, row * stride + rowFloats), (top + row) * rowFloats)
    }
    return
  }
  const orientedWidth = flip & 4 ? height : width
  for (let row = 0; row < count; row++)
    for (let x = 0; x < width; x++) {
      const y = top + row
      let dx = flip & 1 ? width - 1 - x : x,
        dy = flip & 2 ? height - 1 - y : y
      if (flip & 4) [dx, dy] = [dy, dx]
      const from = (row * rowBytes) / 4 + x * 4,
        to = (dy * orientedWidth + dx) * 4
      for (let c = 0; c < 4; c++) pixels[to + c] = values[from + c]
    }
}
