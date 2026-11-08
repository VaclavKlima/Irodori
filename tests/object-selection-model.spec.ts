import { expect, test } from '@playwright/test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { loadObjectSelectionGraph, sha256 } from '../src/main/object-selection/model'

test('portable model chunks reconstruct the pinned qualified graphs without Python or a download', async () => {
  for (const [name, bytes, hash] of [
    ['encoder', 109384732, 'ea9b33edd91a35d295eb9490de774a85dc85057de55fa6d94cd67510939631b9'],
    ['decoder', 16444091, '106c9f532dbe04d0c8226295a62625ba594f6a5ffef7d78b95b9b2fcf5f8cf95'],
  ] as const) {
    const graph = await loadObjectSelectionGraph(resolve('assets/app/object-selection'), name)
    expect(graph.byteLength).toBe(bytes)
    expect(sha256(graph)).toBe(hash)
  }
})

test('damaged bundled content is refused before a model session can be created', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'irodori-selection-model-integrity-'))
  try {
    const manifest = JSON.parse(await readFile('assets/app/object-selection/manifest.json', 'utf8'))
    const decoder = manifest.components.find((entry: { name: string }) => entry.name === 'decoder')
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest))
    await writeFile(join(directory, decoder.parts[0].file), Buffer.from('damaged'))
    await expect(loadObjectSelectionGraph(directory, 'decoder')).rejects.toThrow(/chunk is damaged/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
