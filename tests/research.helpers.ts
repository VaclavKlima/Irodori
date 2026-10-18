import type { TestInfo } from '@playwright/test'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { recordBenchmark } from './benchmark.helpers'

// Keep the runner summary compact; full observations remain attached and hashed.
function compact(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) {
    if (value.length > 20 || value.every((item) => typeof item === 'number'))
      return { count: value.length }
    return value.map((item) => compact(item, depth + 1))
  }
  if (value && typeof value === 'object') {
    if (depth > 4) return 'See attached evidence.'
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key, child]) =>
            !['inputs', 'presentations', 'completed', 'frames', 'sizes', 'provenance'].includes(
              key,
            ) && !(key === 'observations' && Array.isArray(child)),
        )
        .map(([key, child]) => [key, compact(child, depth + 1)]),
    )
  }
  return value
}

export async function attachResearchEvidence(
  info: TestInfo,
  correctnessOnly?: Record<string, unknown>,
) {
  const names = (await readdir(info.outputDir).catch(() => []))
    .filter((name) => name.endsWith('.json'))
    .sort()
  if (!names.length && !correctnessOnly) {
    if (info.status === 'passed') throw new Error('Research case omitted its measurement evidence.')
    return
  }
  const evidence = names.map((name) => join(info.outputDir, name))
  const datasets = await Promise.all(
    evidence.map(async (path, index) => {
      const bytes = await readFile(path)
      return {
        file: names[index],
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.length,
        summary: compact(JSON.parse(bytes.toString())),
      }
    }),
  )
  await recordBenchmark(info, {
    family: 'research',
    measurements: {
      case: info.title,
      classification: 'isolated research; no production performance acceptance',
      ...correctnessOnly,
      datasets,
    },
    gates: [],
    evidence,
  })
}
