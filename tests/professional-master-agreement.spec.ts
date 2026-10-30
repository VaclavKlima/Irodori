import { expect, test } from '@playwright/test'
import { chmod, copyFile, mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { verifyMaster } from '../src/main/merge/store'
import { MERGE_VERSION, type MergeManifest } from '../src/shared/merge'
import {
  sourceAgreementCodeHashes,
  sourceAgreementHash,
  sourceAgreementIdentity,
  sourceAgreementJson,
  verifyFullSourceDetail,
} from './professional-source-agreement.helpers'

async function bundleHashes(directory: string) {
  const entries = await readdir(directory, { withFileTypes: true })
  if (entries.some((entry) => !entry.isFile()))
    throw new Error('Expected a retained flat master bundle.')
  return Promise.all(
    entries
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(async (entry) => ({
        name: entry.name,
        bytes: (await stat(join(directory, entry.name))).size,
        sha256: await sourceAgreementHash(join(directory, entry.name)),
      })),
  )
}

// This deliberate target is outside broad scopes: missing its genuine-master prerequisite is incomplete.
// eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures.
test('full native genuine Sony v4 master agrees between canonical CPU and production GPU detail streams', async ({}, info) => {
  test.skip(
    !process.env.IRODORI_PROFESSIONAL_MASTER,
    'Supply IRODORI_PROFESSIONAL_MASTER as a retained genuine current-format HDR master bundle.',
  )
  test.setTimeout(60 * 60 * 1000)
  const original = resolve(process.env.IRODORI_PROFESSIONAL_MASTER!),
    root = info.outputPath('full-master'),
    copy = join(root, 'master'),
    manifest = JSON.parse(await readFile(join(original, 'manifest.json'), 'utf8')) as MergeManifest,
    before = await bundleHashes(original),
    codeBefore = await sourceAgreementCodeHashes(resolve('.')),
    fixtureRoot = resolve('tests/fixtures/research-sony'),
    fixtureManifest = JSON.parse(await readFile(join(fixtureRoot, 'manifest.json'), 'utf8')) as {
      sequences: {
        id: string
        mode: string
        complete: boolean
        files: string[]
      }[]
      files: { name: string; path: string; sha256: string }[]
    },
    sequence = fixtureManifest.sequences.find((candidate) => candidate.id === 'hdr-brk'),
    cancellation = new AbortController(),
    timer = setTimeout(
      () => cancellation.abort(new Error('Full-master acceptance timed out.')),
      58 * 60 * 1000,
    )
  timer.unref()
  await mkdir(copy, { recursive: true })
  try {
    expect(sequence).toMatchObject({ mode: 'hdr', complete: true })
    expect(sequence!.files).toHaveLength(3)
    const sources = sequence!.files.map((name) => {
      const source = fixtureManifest.files.find((entry) => entry.name === name)
      if (!source) throw new Error('Incomplete committed HDR fixture manifest.')
      const path = resolve(fixtureRoot, source.path)
      if (!path.startsWith(fixtureRoot + sep)) throw new Error('Fixture path escaped its root.')
      return { ...source, path }
    })
    expect(new Set(sources.map((source) => source.sha256)).size).toBe(3)
    expect(await Promise.all(sources.map((source) => sourceAgreementHash(source.path)))).toEqual(
      sources.map((source) => source.sha256),
    )
    expect(manifest.version).toBe(MERGE_VERSION)
    expect(manifest.recipe.version).toBe(MERGE_VERSION)
    expect(manifest.recipe.resolution).toBe('native')
    expect(manifest.recipe.settings.mode).toBe('hdr')
    expect(manifest.recipe.sources.map((source) => source.id).sort()).toEqual(
      sources.map((source) => source.sha256).sort(),
    )
    expect(manifest.recipe.sources.map((source) => source.filename).sort()).toEqual(
      sequence!.files.slice().sort(),
    )
    expect(manifest.asset.width).toBeGreaterThan(3000)
    expect(manifest.asset.height).toBeGreaterThan(3000)
    expect(manifest.asset.width * manifest.asset.height).toBeGreaterThan(18_000_000)
    await verifyMaster(original, manifest)
    for (const entry of before) {
      const path = join(copy, entry.name)
      await copyFile(join(original, entry.name), path)
      await chmod(path, 0o444)
    }
    expect(await bundleHashes(copy)).toEqual(before)
    await verifyMaster(copy, manifest)
    await sourceAgreementJson(join(root, 'source.json'), {
      original,
      bundle: before,
      manifest,
      committedInputs: sources,
      implementation: codeBefore,
      harnessSha256: await sourceAgreementHash(
        resolve('tests/professional-master-agreement.spec.ts'),
      ),
    })
    await verifyFullSourceDetail(
      join(root, 'detail'),
      join(copy, 'linear.f32'),
      manifest.asset,
      sourceAgreementIdentity({ bundle: before, manifest }),
      cancellation.signal,
    )
    expect(await bundleHashes(copy)).toEqual(before)
    expect(await Promise.all(sources.map((source) => sourceAgreementHash(source.path)))).toEqual(
      sources.map((source) => source.sha256),
    )
  } finally {
    clearTimeout(timer)
    const codeAfter = await sourceAgreementCodeHashes(resolve('.'))
    await sourceAgreementJson(join(root, 'implementation-after.json'), codeAfter)
    expect(codeAfter).toEqual(codeBefore)
    expect(await bundleHashes(original)).toEqual(before)
  }
})
