import { test, expect } from '@playwright/test'
import { cp, mkdir, mkdtemp, rm, writeFile, readdir, stat } from 'node:fs/promises'
import { join, resolve, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { PreviewEngine } from '../src/main/preview-engine'
import { MergeProcess } from '../src/main/merge/process'
import { mergeFailure, validateMergeSources, type MergeSource } from '../src/shared/merge'
import { librawDecoder } from '../src/main/processing/decoders/libraw'

// eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures.
test('read-only supplied Sony brackets pass common preparation and measured exposure validation', async ({}, info) => {
  test.skip(
    !process.env.IRODORI_MERGE_BRACKETS,
    'Set IRODORI_MERGE_BRACKETS to a JSON array of read-only Sony paths.',
  )
  test.setTimeout(20 * 60 * 1000)
  const paths = JSON.parse(process.env.IRODORI_MERGE_BRACKETS!) as string[],
    directory = await mkdtemp(join(tmpdir(), 'irodori-sony-merge-')),
    engine = new PreviewEngine()
  const evidence = resolve(
    process.env.IRODORI_VERIFICATION_DIR ?? 'artifacts/verification/merge-sony',
  )
  await mkdir(evidence, { recursive: true })
  try {
    const sources: MergeSource[] = []
    for (let i = 0; i < paths.length; i++) {
      const metadata = await engine.inspect(paths[i])
      expect(metadata.capture).toBeDefined()
      const decoder = await librawDecoder.open(paths[i])
      const dimensions = decoder.dimensions
      decoder.close()
      sources.push({
        photo: {
          id: String(i + 1).padStart(64, '0'),
          filename: basename(paths[i]),
          width: dimensions.flip & 4 ? dimensions.height : dimensions.width,
          height: dimensions.flip & 4 ? dimensions.width : dimensions.height,
          format: 'ARW',
          bytes: (await stat(paths[i])).size,
          importedAt: '',
          thumbnailUrl: '',
          previewUrl: '',
          previewSource: 'decoded',
        },
        metadata,
        capture: metadata.capture!,
        captureMetadata: await engine.inspectCapture(paths[i]),
        relativeEv: 0,
      })
    }
    validateMergeSources(sources, 'hdr')
    const result = await new MergeProcess(resolve('out/main/merge-worker.js')).run(
      {
        directory,
        output: join(directory, 'output'),
        paths,
        sources,
        settings: {
          mode: 'hdr',
          referenceId: sources[0].photo.id,
          autoAlign: true,
          deghost: true,
          strength: 50,
          autoCrop: true,
        },
        comparisons: true,
      },
      new AbortController().signal,
      () => {},
    )
    expect(result.asset.width).toBeGreaterThan(3000)
    await cp(join(directory, 'output'), info.outputPath('native-output'), { recursive: true })
    const scratch = async (path: string): Promise<number> => {
      let size = 0
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const p = join(path, entry.name)
        size += entry.isDirectory() ? await scratch(p) : (await stat(p)).size
      }
      return size
    }
    await writeFile(
      join(evidence, 'sony-merge.json'),
      JSON.stringify({ ...result, scratchBytes: await scratch(directory) }, null, 2),
    )
  } catch (error) {
    await writeFile(join(evidence, 'failure.json'), JSON.stringify(mergeFailure(error), null, 2))
    if (process.env.IRODORI_TEST_TRACE === '1')
      await cp(directory, join(evidence, 'scratch'), { recursive: true })
    throw error
  } finally {
    await engine.close()
    await rm(directory, { recursive: true, force: true })
  }
})
