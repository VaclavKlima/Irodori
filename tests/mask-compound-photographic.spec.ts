/* eslint-disable no-empty-pattern -- Playwright requires destructured fixture arguments. */
import { expect, test, type TestInfo } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import sharp from 'sharp'
import { ObjectSelectionProcess } from '../src/main/object-selection/process'
import { prepareMaskMutation } from '../src/main/mask-store'
import { neutralAdjustments } from '../src/shared/adjustments'
import { maskBaseReference, resolveMasks, type MaskBaseContent } from '../src/shared/masks'
import { sourceFor, compare } from './helpers/mask-rendering'

const photograph =
  'assets/tests/images/raster/wikimedia/flamingo-reflection/originals/Flamant_rose_Salines_de_Thyna.jpg'
const sourceHash = '3b87780172e91a6986610d6632babda98bf6ab24ab6e03cdff50bd70e33db5c6'
type Frame = Awaited<ReturnType<typeof compare>>
function patch(a: Frame, b: Frame, x: number, y: number, radius = 2) {
  let maximum = 0
  const centerX = Math.floor(x * a.info.width),
    centerY = Math.floor(y * a.info.height)
  for (let dy = -radius; dy <= radius; dy++)
    for (let dx = -radius; dx <= radius; dx++) {
      const at = ((centerY + dy) * a.info.width + centerX + dx) * 4
      for (let c = 0; c < 3; c++)
        maximum = Math.max(maximum, Math.abs(a.data[at + c] - b.data[at + c]))
    }
  return maximum
}
async function evidence(info: TestInfo, name: string, frame: Frame) {
  await sharp(frame.data, { raw: frame.info })
    .resize({ width: 750, height: 700, fit: 'inside', withoutEnlargement: true })
    .png()
    .toFile(info.outputPath(`${name}-fit.png`))
  for (const [label, x, y] of [
    ['feathers-water', 0.16, 0.51],
    ['legs-water', 0.4, 0.72],
    ['beak-water', 0.81, 0.24],
  ] as const) {
    const width = Math.min(512, frame.info.width),
      height = Math.min(512, frame.info.height)
    const left = Math.max(
        0,
        Math.min(frame.info.width - width, Math.round(x * frame.info.width - width / 2)),
      ),
      top = Math.max(
        0,
        Math.min(frame.info.height - height, Math.round(y * frame.info.height - height / 2)),
      )
    await sharp(frame.data, { raw: frame.info })
      .extract({ left, top, width, height })
      .png()
      .toFile(info.outputPath(`${name}-${label}-100-percent.png`))
  }
}

test('real refined flamingo copied into a radial subtraction protects feathers and legs in GPU proof and frozen SDR export', async ({}, info) => {
  test.setTimeout(180000)
  expect(
    createHash('sha256')
      .update(await readFile(photograph))
      .digest('hex'),
  ).toBe(sourceHash)
  const source = await sourceFor(resolve(photograph)),
    directory = info.outputPath('object-selection')
  await mkdir(directory, { recursive: true })
  const rawPath = resolve(directory, 'source.rgba'),
    image = await sharp(photograph)
      .toColourspace('srgb')
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
  await writeFile(rawPath, image.data)
  const runtime = new ObjectSelectionProcess({
    workerPath: resolve('out/main/object-selection-worker.js'),
    modelDirectory: resolve('out/main/object-selection-model'),
  })
  const signal = new AbortController().signal,
    key = `compound-flamingo-${sourceHash}`
  let base: MaskBaseContent
  try {
    await runtime.prepare(
      { key, path: rawPath, width: image.info.width, height: image.info.height, format: 'rgba8' },
      signal,
    )
    await rm(rawPath)
    const proposal = await runtime.refine(
      {
        key,
        positivePoints: [
          [0.43, 0.46],
          [0.72, 0.1],
          [0.435, 0.7],
        ],
        negativePoints: [
          [0.18, 0.22],
          [0.2, 0.8],
        ],
      },
      resolve(directory, 'refined-bird.png'),
      signal,
    )
    const png = await readFile(proposal.path)
    expect(createHash('sha256').update(png).digest('hex')).toBe(proposal.sha256)
    base = {
      version: 1,
      hash: proposal.sha256,
      width: proposal.width,
      height: proposal.height,
      pngBase64: png.toString('base64'),
    }
  } finally {
    await runtime.close()
  }
  const subjectId = randomUUID(),
    waterId = randomUUID(),
    copyId = randomUUID()
  const original = prepareMaskMutation([], {
    operations: [{ kind: 'create', id: subjectId, name: 'Refined bird' }],
  })
  original.stack[0].base = maskBaseReference(base!)
  const manual = prepareMaskMutation(original.stack, {
    operations: [
      {
        kind: 'stroke',
        id: subjectId,
        strokeTarget: 'primary',
        stroke: {
          mode: 'add',
          radius: 0.005,
          feather: 0.3,
          points: [
            { x: 0.374, y: 0.635 },
            { x: 0.356, y: 0.805 },
          ],
        },
      },
      {
        kind: 'stroke',
        id: subjectId,
        strokeTarget: 'primary',
        stroke: {
          mode: 'add',
          radius: 0.005,
          feather: 0.3,
          points: [
            { x: 0.438, y: 0.635 },
            { x: 0.427, y: 0.805 },
          ],
        },
      },
      {
        kind: 'create',
        id: waterId,
        name: 'Protected radial water',
        gradient: {
          kind: 'radial',
          center: { x: 0.43, y: 0.5 },
          radiusX: 0.7,
          radiusY: 0.7,
          rotation: 0,
          feather: 75,
        },
      },
      {
        kind: 'component-copy',
        id: waterId,
        componentId: copyId,
        name: 'Bird protection copy',
        operator: 'subtract',
        sourceMaskId: subjectId,
      },
      { kind: 'update', id: waterId, light: { exposureEv: -1.2 } },
    ],
  })
  const resolved = resolveMasks(manual.stack, manual.chunks, [base!])
  const baseline = await compare(source, info.outputPath('baseline-export'))
  source.processing.adjustments = { ...neutralAdjustments, localMasks: resolved }
  const protectedWater = await compare(source, info.outputPath('compound-export'))
  await evidence(info, 'baseline', baseline)
  await evidence(info, 'protected-radial', protectedWater)
  expect(patch(baseline, protectedWater, 0.18, 0.22)).toBeGreaterThan(8)
  for (const [x, y] of [
    [0.43, 0.46],
    [0.72, 0.1],
    [0.365, 0.72],
    [0.433, 0.72],
  ])
    expect(
      patch(baseline, protectedWater, x, y),
      `Protected bird at ${x},${y}`,
    ).toBeLessThanOrEqual(2)
  // The copied coverage retains geometry/strokes but has no live source-mask dependency.
  const changed = prepareMaskMutation(manual.stack, {
    operations: [{ kind: 'update', id: subjectId, inverted: true }],
  })
  const independent = resolveMasks(changed.stack, manual.chunks, [base!])
  expect(independent.find((m) => m.id === waterId)?.operands).toEqual(
    resolved.find((m) => m.id === waterId)?.operands,
  )
  expect(resolved.find((m) => m.id === waterId)?.edge).toEqual({ featherPx: 0, shiftPx: 0 })
  await writeFile(
    info.outputPath('credit.txt'),
    'Elgollimoh, Flamant rose Salines de Thyna.jpg, Wikimedia Commons, CC BY-SA 3.0. https://commons.wikimedia.org/wiki/File:Flamant_rose_Salines_de_Thyna.jpg https://creativecommons.org/licenses/by-sa/3.0/\nChanges: SAM2 object proposal, manual leg protection, copied coverage subtracted from radial exposure. Native proof/export; Fit resized and 100% crops without resampling. No automatic matting quality claim.\n',
  )
  await info.attach('compound-photographic-scope', {
    contentType: 'application/json',
    body: JSON.stringify({
      input: photograph,
      sha256: sourceHash,
      native: { width: image.info.width, height: image.info.height },
      baseHash: base!.hash,
      rootEdges: 'neutral',
      scope:
        'Actual GPU object inference plus editable manual leg protection; independently copied into radial subtraction; proof/frozen SDR pixel matching. Boundary spreading verified separately in compound GPU target.',
    }),
  })
})
