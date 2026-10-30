import { expect, test } from '@playwright/test'
import { fitCropDraft, moveCrop, resizeCrop } from '../src/shared/crop-authoring'
import { cropGeometry, fitCrop, identityCrop, type CropSettings } from '../src/shared/crop'

test('corner dragging keeps the opposite native corner fixed through every quarter turn', () => {
  const source = { width: 400, height: 300 }
  const cases = [
    {
      quarterTurns: 0,
      point: { x: 300, y: 200 },
      size: [300, 200],
      corners: [
        [0, 0],
        [300, 0],
        [300, 200],
        [0, 200],
      ],
    },
    {
      quarterTurns: 1,
      point: { x: 300, y: 100 },
      size: [200, 300],
      corners: [
        [0, 300],
        [0, 100],
        [300, 100],
        [300, 300],
      ],
    },
    {
      quarterTurns: 2,
      point: { x: 100, y: 100 },
      size: [300, 200],
      corners: [
        [400, 300],
        [100, 300],
        [100, 100],
        [400, 100],
      ],
    },
    {
      quarterTurns: 3,
      point: { x: 100, y: 200 },
      size: [200, 300],
      corners: [
        [400, 0],
        [400, 200],
        [100, 200],
        [100, 0],
      ],
    },
  ]
  for (const item of cases) {
    const result = resizeCrop(
        source,
        { ...identityCrop, quarterTurns: item.quarterTurns as CropSettings['quarterTurns'] },
        2,
        item.point,
      ),
      geometry = cropGeometry(source, result)
    expect([geometry.width, geometry.height]).toEqual(item.size)
    expect(geometry.corners.map(({ x, y }) => [x, y])).toEqual(item.corners)
    expect(geometry.pixelAligned).toBe(true)
  }
})

test('outside drags stop at the first edge, while translation retains native dimensions', () => {
  const source = { width: 400, height: 300 },
    crop = { ...identityCrop, width: 0.5, height: 0.5 }
  const resized = cropGeometry(source, resizeCrop(source, crop, 2, { x: 1000, y: 1000 }))
  expect([resized.width, resized.height]).toEqual([300, 225])
  expect(resized.corners).toEqual([
    { x: 100, y: 75 },
    { x: 400, y: 75 },
    { x: 400, y: 300 },
    { x: 100, y: 300 },
  ])
  const moved = moveCrop(source, crop, { x: 1000, y: -1000 })
  expect(moved).toMatchObject({ centerX: 0.75, centerY: 0.25, width: 0.5, height: 0.5 })
  expect(cropGeometry(source, moved).corners).toEqual([
    { x: 200, y: 0 },
    { x: 400, y: 0 },
    { x: 400, y: 150 },
    { x: 200, y: 150 },
  ])
  expect(crop).toEqual({ ...identityCrop, width: 0.5, height: 0.5 })
})

test('aspect-constrained numeric sizing retains exact ratio and explicitly fits the shown draft', () => {
  const source = { width: 400, height: 300 },
    crop = fitCropDraft(source, identityCrop, { aspectRatio: 16 / 9 })
  expect(crop).toMatchObject({ width: 1, height: 0.75, aspectRatio: 16 / 9 })
  const resized = resizeCrop(source, crop, 2, { x: 200, y: 200 })
  expect(resized.width * source.width).toBeCloseTo(200, 10)
  expect(resized.height * source.height).toBeCloseTo(112.5, 10)
  expect(resized.centerX * source.width).toBeCloseTo(100, 10)
  expect(resized.centerY * source.height).toBeCloseTo(93.75, 10)
  const numeric = fitCropDraft(source, crop, { width: 0.5 })
  expect((numeric.width * source.width) / (numeric.height * source.height)).toBeCloseTo(16 / 9, 13)
  const leveled = fitCropDraft(source, numeric, { angle: 45 })
  expect(leveled.angle).toBe(45)
  expect(leveled.width).toBeLessThanOrEqual(numeric.width)
  expect(leveled.height).toBeLessThanOrEqual(numeric.height)
  expect(cropGeometry(source, leveled).width).toBeGreaterThanOrEqual(1)
})

test('rotated, straightened and locked drafts remain finite and contained for corner and move commands', () => {
  for (const source of [
    { width: 400, height: 300 },
    { width: 32768, height: 16384 },
  ])
    for (const quarterTurns of [0, 1, 2, 3] as const)
      for (const angle of [-45, -13.37, 0, 17.23, 45])
        for (const aspectRatio of [null, 1, 16 / 9]) {
          const crop = fitCrop(source, {
              ...identityCrop,
              quarterTurns,
              angle,
              aspectRatio,
              width: 0.8,
              height: 0.7,
            }),
            before = cropGeometry(source, crop)
          for (const x of [-source.width, source.width * 0.4, source.width * 2])
            for (const y of [-source.height, source.height * 0.6, source.height * 2]) {
              const moved = cropGeometry(source, moveCrop(source, crop, { x, y }))
              expect([moved.width, moved.height]).toEqual([before.width, before.height])
              for (const corner of [0, 1, 2, 3] as const) {
                const result = resizeCrop(source, crop, corner, { x, y }),
                  geometry = cropGeometry(source, result)
                expect(geometry.width).toBeGreaterThanOrEqual(1)
                expect(geometry.height).toBeGreaterThanOrEqual(1)
                if (aspectRatio !== null) {
                  const ratio =
                    (result.width * (quarterTurns % 2 ? source.height : source.width)) /
                    (result.height * (quarterTurns % 2 ? source.width : source.height))
                  expect(Math.abs(ratio - aspectRatio)).toBeLessThan(1e-12)
                }
              }
            }
        }
})
