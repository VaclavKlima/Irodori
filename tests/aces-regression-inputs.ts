/** The original-pixel Bazzite miss at (2, 655) in the 1024 × 684 lattice. */
export const bazziteAcesInput = [
  Math.fround(0.02 + (2 / 1024) * 2),
  Math.fround(0.3 + 655 / 684),
  Math.fround(0.1),
]

/** Nearby binary32 inputs preserve the cancellation instead of hiding it in a decimal ramp. */
export const acesRegressionInputs: number[][] = []
const bits = new Uint32Array(new Float32Array(bazziteAcesInput).buffer)
for (let r = -2; r <= 2; r++)
  for (let g = -2; g <= 2; g++)
    for (let b = -2; b <= 2; b++)
      acesRegressionInputs.push(
        Array.from(
          new Float32Array(new Uint32Array([bits[0] + r, bits[1] + g, bits[2] + b]).buffer),
        ),
      )
