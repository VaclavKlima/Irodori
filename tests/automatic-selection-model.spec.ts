import { expect, test } from '@playwright/test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { validateObjectSelectionRequest } from '../src/shared/object-selection'
import {
  automaticSelectionGraphs,
  loadAutomaticSelectionGraph,
} from '../src/main/object-selection/automatic-model'
import { sha256 } from '../src/main/object-selection/model'

test('automatic modes omit guides, preserve the frozen destination, and refuse ambiguous requests', () => {
  const request = { photoId: 'a'.repeat(64), expectedRevision: 4, gridIdentity: 'b'.repeat(64) }
  for (const selection of ['sky', 'background'] as const) {
    expect(validateObjectSelectionRequest({ ...request, selection })).toEqual({
      ...request,
      selection,
      prompts: { positivePoints: [], negativePoints: [] },
    })
    expect(() =>
      validateObjectSelectionRequest({
        ...request,
        selection,
        prompts: { positivePoints: [[0.5, 0.5]], negativePoints: [] },
      }),
    ).toThrow(/does not take object guides/)
  }
  expect(() => validateObjectSelectionRequest(request)).toThrow(/box or positive point/)
  expect(() => validateObjectSelectionRequest({ ...request, selection: 'anything' })).toThrow(
    /sky or background/,
  )
})

test('both pinned offline graphs reconstruct without network or research paths', async () => {
  for (const name of ['sky', 'background'] as const) {
    const graph = await loadAutomaticSelectionGraph(resolve('assets/app/object-selection'), name)
    expect(graph.byteLength).toBe(automaticSelectionGraphs[name].bytes)
    expect(sha256(graph)).toBe(automaticSelectionGraphs[name].sha256)
  }
})

test('damaged automatic model chunks are refused before inference', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-automatic-integrity-'))
  try {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(root, 'automatic'))
    const manifest = JSON.parse(
      await readFile('assets/app/object-selection/automatic/manifest.json', 'utf8'),
    )
    const component = manifest.components.find((entry: { name: string }) => entry.name === 'sky')
    await writeFile(join(root, 'automatic/manifest.json'), JSON.stringify(manifest))
    await writeFile(join(root, 'automatic', component.parts[0].file), 'damaged')
    await expect(loadAutomaticSelectionGraph(root, 'sky')).rejects.toThrow(/chunk is damaged/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
