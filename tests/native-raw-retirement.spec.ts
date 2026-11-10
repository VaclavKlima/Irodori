import { expect, test } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

// eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures with testInfo.
test('joined RAW workers retain the exact thread gate while Linux accounting settles', async ({}, info) => {
  const binary = info.outputPath('native-raw-retirement-tests')
  for (const [stage, command, args] of [
    [
      'compile',
      'rustc',
      ['--edition=2021', '--test', resolve('native/raw-source/src/retirement.rs'), '-o', binary],
    ],
    ['unit', binary, ['--test-threads=1']],
  ] as const) {
    const result = spawnSync(command, [...args], {
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 64 * 1024,
    })
    await info.attach(`native-raw-retirement-${stage}`, {
      body: `${result.stdout ?? ''}${result.stderr ?? ''}`,
      contentType: 'text/plain',
    })
    expect(result.error, `Native RAW retirement ${stage} must run.`).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.status, `See the attached ${stage} diagnostics.`).toBe(0)
    if (stage === 'unit') expect(result.stdout).toContain('test result: ok.')
  }
})
