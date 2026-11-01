import { execFile, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, test, type TestInfo } from '@playwright/test'

// Source-only draft until root reviews this helper and the exact driver source.
// The Python child uses only stdlib and an isolated fake lock runtime.
const repository = resolve('.')
const driver = resolve('scripts/research/strong-noise/pilot-screen.py')
const helper = resolve('tests/strong-noise-pilot-screen.helpers.py')
const python = process.env.IRODORI_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
const children = new Set<ChildProcess>()
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const cases = [
  ['normal', 'normal isolated token lifecycle retires only its own lock'],
  ['owner-write-failure', 'owner publication failure retires the captured empty directory'],
  ['post-publication-failure', 'post-publication failure retires its observed valid owner'],
  ['foreign-lock', 'an existing isolated foreign lock remains byte and inode identical'],
  ['cancel-owner-update', 'cancelled atomic owner update removes its temporary before guard exit'],
  [
    'freeze-destination-safety',
    'actual freeze assembly writes only fresh output and preserves retained source canaries',
  ],
] as const

interface Receipt {
  version: string
  case: string
  status: string
  checks: number
  privateDirectory: string
  driver: { path: string; beforeSha256: string; afterSha256: string }
  helper: { path: string; beforeSha256: string; afterSha256: string }
  imports: {
    blockedImports: unknown[]
    blockedProjectFiles: unknown[]
    projectModulesExecuted: string[]
    childProcessAttempts: unknown[]
  }
  filterExecutions: number
  gpuExecutions: number
  temporaryFilesRemaining: string[]
  error?: string
  observations: {
    normalTokenLifecycle?: boolean
    emptyCapturedInodeRetired?: boolean
    publishedOwnTokenRetired?: boolean
    foreignFixturePreserved?: boolean
    cancelledAtomicUpdateRetired?: boolean
    freezeDestinationSafety?: boolean
    freshOutput?: string
    declarationPath?: string
    declarationSha256?: string
    retainedSnapshotsBefore?: Record<string, unknown>
    retainedSnapshotsAfter?: Record<string, unknown>
    sourceFiles?: number
    observedActualWrites?: { operation: string; source?: string; target: string }[]
    retainedDestinationRefusals?: string[]
    retainedFactoryRefusals?: string[]
    capturedDestinationRefusals?: string[]
    outputSelfInclusionRefused?: boolean
    ownerBeforeSha256?: string
    ownerAfterSha256?: string
    directoryBefore?: number[]
    directoryAfter?: number[]
    audit: {
      status: string
      acquired: boolean
      ownerPublished: boolean
      ownedLockReleased: boolean
    }
  }
}

async function run(name: string, info: TestInfo) {
  await mkdir(info.outputDir, { recursive: true })
  const receiptPath = info.outputPath('guard-receipt.json')
  const directory = info.outputPath('isolated-guard')
  const driverSha = sha(await readFile(driver))
  const helperSha = sha(await readFile(helper))
  await new Promise<void>((accept, reject) => {
    const child = execFile(
      python,
      [
        '-I',
        '-S',
        '-B',
        helper,
        '--driver',
        driver,
        '--repository-root',
        repository,
        '--directory',
        directory,
        '--output',
        receiptPath,
        '--case',
        name,
      ],
      { timeout: 15_000, maxBuffer: 64 * 1024, cwd: repository },
      (error, stdout, stderr) => {
        children.delete(child)
        void Promise.all([
          writeFile(info.outputPath('stdout.txt'), stdout),
          writeFile(info.outputPath('stderr.txt'), stderr),
        ]).then(() => {
          if (error) reject(new Error('Isolated guard helper failed: ' + stderr, { cause: error }))
          else accept()
        }, reject)
      },
    )
    children.add(child)
  })
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as Receipt
  expect(receipt.version).toBe('irodori-c15-isolated-guard-proof-v1')
  expect(receipt.case).toBe(name)
  expect(receipt.status, receipt.error).toBe('passed')
  expect(receipt.checks).toBeGreaterThan(0)
  expect(receipt.privateDirectory).toBe(directory)
  expect(receipt.driver).toEqual({
    path: driver,
    beforeSha256: driverSha,
    afterSha256: driverSha,
  })
  expect(receipt.helper).toEqual({
    path: helper,
    beforeSha256: helperSha,
    afterSha256: helperSha,
  })
  expect(receipt.imports.blockedImports).toEqual([])
  expect(receipt.imports.blockedProjectFiles).toEqual([])
  expect(receipt.imports.projectModulesExecuted).toEqual([driver])
  expect(receipt.imports.childProcessAttempts).toEqual([])
  expect(receipt.filterExecutions).toBe(0)
  expect(receipt.gpuExecutions).toBe(0)
  expect(receipt.temporaryFilesRemaining).toEqual([])
  if (name === 'freeze-destination-safety') {
    const evidence = receipt.observations
    expect(evidence.freezeDestinationSafety).toBe(true)
    expect(evidence.sourceFiles).toBe(4)
    expect(evidence.observedActualWrites).toHaveLength(5)
    expect(evidence.retainedDestinationRefusals).toHaveLength(2)
    expect(evidence.retainedFactoryRefusals).toHaveLength(2)
    expect(evidence.capturedDestinationRefusals).toHaveLength(2)
    expect(evidence.outputSelfInclusionRefused).toBe(true)
    expect(evidence.retainedSnapshotsAfter).toEqual(evidence.retainedSnapshotsBefore)
    expect(evidence.declarationSha256).toBe(sha(await readFile(evidence.declarationPath!)))
    return
  }
  const audit = receipt.observations.audit
  if (name === 'normal') expect(receipt.observations.normalTokenLifecycle).toBe(true)
  if (name === 'owner-write-failure')
    expect(receipt.observations.emptyCapturedInodeRetired).toBe(true)
  if (name === 'post-publication-failure')
    expect(receipt.observations.publishedOwnTokenRetired).toBe(true)
  if (name === 'cancel-owner-update')
    expect(receipt.observations.cancelledAtomicUpdateRetired).toBe(true)
  if (name === 'foreign-lock') {
    expect(receipt.observations.foreignFixturePreserved).toBe(true)
    expect(receipt.observations.ownerAfterSha256).toBe(receipt.observations.ownerBeforeSha256)
    expect(receipt.observations.directoryAfter).toEqual(receipt.observations.directoryBefore)
    expect(audit.acquired).toBe(false)
    expect(audit.ownedLockReleased).toBe(false)
  } else {
    expect(audit.acquired).toBe(true)
    expect(audit.ownedLockReleased).toBe(true)
    expect(audit.ownerPublished).toBe(name !== 'owner-write-failure')
  }
}

test.afterEach(async () => {
  await Promise.all(
    [...children].map(
      (child) =>
        new Promise<void>((accept) => {
          if (child.exitCode !== null || child.signalCode !== null) return accept()
          child.once('close', () => accept())
          child.kill('SIGTERM')
        }),
    ),
  )
  children.clear()
})

for (const [name, title] of cases) {
  // eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures.
  test(title, async ({}, info) => {
    test.setTimeout(30_000)
    await run(name, info)
  })
}
