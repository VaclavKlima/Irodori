import { defineConfig } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { resolve, join } from 'node:path'
import { suites, workersFor, type Group } from './scripts/verification-plan'

const runDirectory = (process.env.IRODORI_VERIFICATION_DIR ??= resolve(
  'artifacts/verification',
  `playwright-${Date.now()}-${randomUUID()}`,
))
const output = join(runDirectory, process.env.IRODORI_TEST_GROUP ?? 'playwright')
const groups: Group[] = ['node', 'service', 'electron', 'raw-gpu']
if (process.env.IRODORI_PREVIEW_BENCHMARK === '1') groups.splice(0, groups.length, 'benchmark')

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 2,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 7_500 },
  outputDir: join(output, 'results'),
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: join(output, 'report') }],
    ['./scripts/verification-reporter.ts', { outputDir: output }],
  ],
  projects: groups.map((name) => ({
    name,
    workers: workersFor(name),
    testMatch: suites
      .filter((suite) => suite.group === name)
      .map((suite) => `**/${suite.file.slice(6)}`),
  })),
})
