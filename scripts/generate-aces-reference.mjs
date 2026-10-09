// Regenerate independent reference vectors from the vendored CTL, using Float64 C++.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { buildAcesReference, referenceAces } from '../tests/aces-reference.ts'
const directory = join('artifacts', `aces-reference-${Date.now()}`)
await mkdir(directory, { recursive: true })
const binary = buildAcesReference(directory)
const input = [
  [0, 0, 0],
  [-1, -1, -1],
  [65536, 65536, 65536],
  [16, -0.1, 4],
  [-2, 4, 1],
]
for (let stop = -20; stop <= 16; stop++) {
  const v = 2 ** stop
  input.push(
    [v, v, v],
    [v, 0, 0],
    [0, v, 0],
    [0, 0, v],
    [-v * 0.1, v, v * 0.8],
    [v * 16, -v * 8, v * 4],
  )
}
for (let i = 0; i < 256; i++) input.push([i / 16, (255 - i) / 128, Math.sin(i) * 0.1])
for (let stop = -20; stop <= 16; stop += 0.125) {
  const v = 2 ** stop
  input.push([v, v, v], [v, v * 0.01, -v * 0.05], [v * 0.1, v, v * 0.4])
}
const inputs = input.map((v) => v.map(Math.fround))
const targets = []
for (const colorSpace of ['srgb', 'display-p3'])
  for (const peak of [1, 2, 4, 8])
    targets.push({ peak, colorSpace, rgb: referenceAces(binary, inputs, peak, colorSpace) })
targets.push({ peak: 10, colorSpace: 'rec2020', rgb: referenceAces(binary, inputs, 10, 'rec2020') })
const files = [
  'Lib.Academy.Utilities.ctl',
  'Lib.Academy.Tonescale.ctl',
  'Lib.Academy.OutputTransform.ctl',
  'Lib.Academy.ColorSpaces.ctl',
]
const hashes = {}
for (const file of files)
  hashes[file] = createHash('sha256')
    .update(await readFile(join('third_party/aces-core/lib', file)))
    .digest('hex')
await writeFile(
  'tests/fixtures/aces-reference.json',
  JSON.stringify(
    {
      revision: '069b0bc3e1f6c62820f19fdae2fecec3f4fc0f80',
      precision: 'Float64 CTL via C++17',
      hashes,
      inputs,
      targets,
    },
    null,
    2,
  ) + '\n',
)
