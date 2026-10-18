import { expect, test } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildNative } from '../scripts/research/build-native.mjs'
import { NativeService, REQUEST_MAGIC } from '../scripts/research/pipeline/native-service'
import { GraphExecutor } from '../scripts/research/pipeline/graph'
import { operations } from '../scripts/research/pipeline/operations'
import { imageSpec, workloads } from '../scripts/research/pipeline/workloads'
import { whole } from '../scripts/research/pipeline/contract'
import { attachResearchEvidence } from './research.helpers'

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test.afterEach(async ({}, info) => {
  if (info.status === 'passed')
    await attachResearchEvidence(info, {
      kind: 'native protocol correctness only; no throughput claim',
      checks: info.title,
      result: 'passed',
    })
})

let binary = ''
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test.beforeAll(async ({}, info) => {
  const build = buildNative('pointwise', info.outputPath('native'))
  binary = build.binary
})
for (const threads of [1, 2, 4])
  test(`persistent C++ service at ${threads} threads matches graph order, alpha, identity and reused ownership`, async () => {
    const w = workloads(undefined, imageSpec(256, 192)),
      recipe = structuredClone(w.recipes.grading)
    recipe.nodes[1].parameters.ev = 0.5
    const expected = new GraphExecutor(operations, w.assets).render(recipe, {
      purpose: 'export',
      region: whole(w.spec),
      revision: 3,
      scale: 1,
      approximation: 'exact',
    }).data
    const service = new NativeService(binary, threads)
    try {
      for (const id of [1, 2]) {
        const result = await service.process(w.data, w.spec.width, w.spec.height, id)
        expect(Buffer.from(result.data.buffer).equals(Buffer.from(expected.buffer))).toBe(true)
        expect(result.ownedBytes).toBe(w.data.byteLength)
        expect(result.computeMs).toBeGreaterThan(0)
      }
    } finally {
      await service.close()
    }
    expect(service.child.exitCode !== null || service.child.signalCode !== null).toBe(true)
  })
test('C++ rejects truncated, oversized and invalid contracts without accepting arbitrary commands', () => {
  const header = Buffer.alloc(32)
  header.writeUInt32LE(REQUEST_MAGIC)
  header.writeUInt32LE(32768, 4)
  header.writeUInt32LE(32768, 8)
  expect(spawnSync(binary, ['1'], { input: header }).status).toBe(1)
  expect(spawnSync(binary, ['1'], { input: Buffer.alloc(1) }).status).toBe(1)
  expect(spawnSync(binary, ['99']).status).toBe(1)
})
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('service cancellation settles outstanding work and preserves its immutable input', async ({}, info) => {
  const w = workloads(undefined, imageSpec(512, 512)),
    path = join(info.outputPath('source.f32'))
  await writeFile(path, new Uint8Array(w.data.buffer))
  const before = await readFile(path)
  const service = new NativeService(binary, 1)
  const pending = service.process(w.data, 512, 512, 1).catch((error) => error)
  await service.close()
  await pending
  expect((await readFile(path)).equals(before)).toBe(true)
  expect(service.child.exitCode !== null || service.child.signalCode !== null).toBe(true)
})
