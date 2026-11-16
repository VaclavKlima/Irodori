/** Reduce automatic model predictions without changing the common inference policy. */
export function accumulateAutomaticCoverage(
  selection: 'sky' | 'background',
  values: Float32Array,
  mask: Float32Array,
) {
  let selected = 0
  if (selection === 'sky') {
    for (let pixel = 0; pixel < mask.length; pixel++) {
      const sky = values[2 * mask.length + pixel]
      let isSky = true
      for (let label = 0; label < 150; label++) {
        if (
          label !== 2 &&
          (values[label * mask.length + pixel] > sky ||
            (label < 2 && values[label * mask.length + pixel] === sky))
        ) {
          isSky = false
          break
        }
      }
      if (isSky && !mask[pixel]) {
        mask[pixel] = 1
        selected++
      }
    }
  } else {
    for (let pixel = 0; pixel < mask.length; pixel++) {
      mask[pixel] = 1 / (1 + Math.exp(values[pixel]))
      if (values[pixel] > 0) selected++
    }
    if (!selected || selected === mask.length)
      throw new Error(
        'A foreground subject and background could not be separated. Existing masks are unchanged. Use Select object or Paint/Erase.',
      )
  }
  return selected
}
