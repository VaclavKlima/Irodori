/* eslint-disable no-empty-pattern -- Playwright requires destructured fixture arguments. */
import { expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { lstat, readFile, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

test('both automatic models match every official-weight Float32 value without sky or foreground label flips', async ({}, info) => {
  test.setTimeout(240000)
  const references = resolve(
    process.env.IRODORI_AUTOMATIC_REFERENCE_DIR ?? 'artifacts/sky-selection/model-reference',
  )
  const manifestPath = join(references, 'manifest.json')
  const available = await stat(manifestPath).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return false
    },
  )
  test.skip(
    !available,
    'Official model tensors are unavailable. Prepare GPU inputs and run the isolated pinned official-weight generator; this selected qualification is incomplete.',
  )
  expect((await stat(manifestPath)).size).toBeLessThanOrEqual(1024 * 1024)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  test.skip(
    !manifest.officialReference,
    'GPU inputs exist, but official-weight reference generation is incomplete. No model numerical acceptance is claimed.',
  )
  expect(Array.isArray(manifest.cases)).toBe(true)
  for (const fixture of manifest.cases) {
    if (!fixture.reference) {
      test.skip(true, `Official Float32 reference is unavailable for ${fixture.id}.`)
      return
    }
    for (const descriptor of [fixture.input, fixture.reference]) {
      expect(typeof descriptor?.file).toBe('string')
      expect(descriptor.file).toMatch(/^[a-z0-9-]+\.(input|reference)\.f32$/)
      const metadata = await lstat(join(references, descriptor.file)).then(
        (value) => value,
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
          return undefined
        },
      )
      test.skip(!metadata, `Official model tensor ${descriptor.file} is unavailable.`)
      expect(metadata?.isSymbolicLink()).toBe(false)
      expect(metadata?.isFile()).toBe(true)
    }
  }
  const output = info.outputPath('native-official-reference')
  const env = { ...process.env }
  delete env.NODE_OPTIONS
  delete env.ELECTRON_RUN_AS_NODE
  let failure: unknown
  try {
    await promisify(execFile)(
      process.execPath,
      [
        resolve('scripts/research/sky-selection/model-reference-child.mjs'),
        'compare',
        references,
        output,
      ],
      { env, timeout: 210000, maxBuffer: 1024 * 1024 },
    )
  } catch (error) {
    failure = error
  }
  const resultPath = join(output, 'result.json')
  const files = await readdir(output).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return []
  })
  for (const file of files.filter((file) => /^(launcher-.*\.json|process-.*\.log)$/.test(file)))
    await info.attach(file, {
      path: join(output, file),
      contentType: file.endsWith('.json') ? 'application/json' : 'text/plain',
    })
  expect(files, String(failure)).toContain('result.json')
  await info.attach('native-official-reference', {
    path: resultPath,
    contentType: 'application/json',
  })
  const result = JSON.parse(await readFile(resultPath, 'utf8'))
  expect(failure, result.error).toBeUndefined()
  expect(result.status).toBe('passed')
  expect(result.cpuFallbackDisabled).toBe(true)
  expect(result.tolerance).toEqual({ absolute: 1e-3, relative: 1e-3, allowedFlips: 0 })
  expect(result.cases).toHaveLength(7)
  expect(
    result.cases.reduce((total: number, entry: { values: number }) => total + entry.values, 0),
  ).toBe(15_794_176)
  for (const fixture of result.cases) {
    expect(fixture.violations).toBe(0)
    expect(fixture.flips).toBe(0)
  }
  expect(result.profiles).toHaveLength(2)
  for (const profile of result.profiles) {
    expect(profile.nodes).toBeGreaterThan(0)
    expect(profile.providers).toEqual(['WebGpuExecutionProvider'])
  }
})
