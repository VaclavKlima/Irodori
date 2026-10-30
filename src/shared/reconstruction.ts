/** Existing native/lens Catmull-Rom kernel, with border extension owned by the sampler. */
export function catmullRom(x: number): number {
  x = Math.abs(x)
  return x < 1 ? (1.5 * x - 2.5) * x * x + 1 : x < 2 ? ((-0.5 * x + 2.5) * x - 4) * x + 2 : 0
}
