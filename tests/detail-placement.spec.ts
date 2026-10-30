import { expect, test } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import {
  detailPlacementStudy,
  placementScenes,
  placementSeeds,
} from '../scripts/research/detail-placement'

test('the declared native-detail placement study retains every seed and candidate under unchanged quality gates', async () => {
  const testInfo = test.info()
  const reference = JSON.parse(await readFile('tests/fixtures/detail-quality.json', 'utf8')) as {
    coefficients: Record<'srgb' | 'rec2020', number[]>
    cases: { name: string; clean: number[][]; entering: number[][] }[]
  }
  // Cross-check the independent Python chart recipe before generating extra seeds/primaries.
  for (const scene of placementScenes(0x4c554d41, reference.coefficients.srgb).filter(
    (scene) => scene.name !== 'soft-edge',
  )) {
    const independent = reference.cases.find((value) => value.name === scene.name)!
    expect(
      Buffer.from(scene.clean.data.buffer).equals(
        Buffer.from(new Float32Array(independent.clean.flat()).buffer),
      ),
    ).toBe(true)
    expect(
      Buffer.from(scene.entering.data.buffer).equals(
        Buffer.from(new Float32Array(independent.entering.flat()).buffer),
      ),
    ).toBe(true)
  }
  const report = detailPlacementStudy(reference.coefficients),
    sources: Record<string, string> = {}
  for (const path of [
    'scripts/research/detail-placement.ts',
    'tests/fixtures/detail-quality.json',
    'src/shared/spatial-detail.ts',
    'src/shared/crop.ts',
    'src/shared/crop-filter.ts',
    'src/shared/reconstruction.ts',
    'src/shared/white-balance.ts',
  ])
    sources[path] = createHash('sha256')
      .update(await readFile(path))
      .digest('hex')
  await writeFile(
    testInfo.outputPath('placement-report.json'),
    JSON.stringify({ ...report, sources }, null, 2) + '\n',
  )
  expect(report.perSeed).toHaveLength(672)
  for (const aggregate of report.aggregates) expect(aggregate.seeds).toEqual([...placementSeeds])
  const failedBefore = report.aggregates.filter(
    (row) => row.order === 'before' && Object.values(row.gates).some((passed) => !passed),
  )
  expect(
    failedBefore.map((row) => ({
      key: row.key,
      gates: row.gates,
      irodori: row.luminanceRmsRatio,
      chroma: row.chromaRmsRatio,
      texture: row.textureRetention,
    })),
  ).toEqual([])
  const quarter = report.geometryDiagnostics.filter((row) => row.kind === 'quarter-turn')
  expect(Math.max(...quarter.map((row) => row.maximumRatio))).toBeLessThanOrEqual(1)
  const integer = report.geometryDiagnostics.filter((row) => row.kind === 'integer-crop')
  expect(Math.max(...integer.map((row) => row.interiorMaximumRatio))).toBeLessThanOrEqual(1)
  expect(Math.max(...integer.map((row) => row.maximumRatio))).toBeGreaterThan(1)
})
