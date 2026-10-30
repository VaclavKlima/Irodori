/** Actual Electron44.3.0/V815.2.124.19-electron.0 primitive receipt.
 * The LLVM mask seam passed these exact observed outputs independently.
 * This still does not replace full actual Electron mask/mip parity.
 * Source receipt is pinned in native/irodori-cpu-render/upstream/electron-llvm/provenance/electron-primitives.json.
 * The older Node/D expectation remains in the retained research archive.
 */
const controls: readonly (readonly [number, number, string])[] = [
  [-11.507243131689393, -6.353538344650907, 'c0009a2a798c6723'],
  [0, 0, '0000000000000000'],
  [-0, 0, '8000000000000000'],
  [0, -0, '400921fb54442d18'],
  [-0, -0, 'c00921fb54442d18'],
  [1, 1, '3fe921fb54442d18'],
  [-1, 1, 'bfe921fb54442d18'],
  [1, -1, '4002d97c7f3321d2'],
  [-1, -1, 'c002d97c7f3321d2'],
  [1, 0, '3ff921fb54442d18'],
  [-1, 0, 'bff921fb54442d18'],
  [0, 1, '0000000000000000'],
  [-0, 1, '8000000000000000'],
  [5e-324, 1, '0000000000000001'],
  [1, 5e-324, '3ff921fb54442d18'],
  [1e-300, -1, '400921fb54442d18'],
  [-1, 1e-300, 'bff921fb54442d18'],
]
export function verifyNativeMaskMath(): void {
  const storage = new ArrayBuffer(8),
    view = new DataView(storage)
  for (const [y, x, expected] of controls) {
    view.setFloat64(0, Math.atan2(y, x), false)
    if (view.getBigUint64(0, false).toString(16).padStart(16, '0') !== expected)
      throw new Error(
        'This renderer Math.atan2 does not match the Electron LLVM native mask arithmetic.',
      )
  }
}
