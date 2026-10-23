import { build } from 'esbuild'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdir, open, readFile, rm, writeFile, type FileHandle } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import type { JSHandle, Page } from '@playwright/test'
import { expect, test } from './electron.fixture'
import fixtureJson from './fixtures/native-hdr-mask-parity.json' with { type: 'json' }
import { NativeCpuController, type CpuWorkingLease } from '../src/main/native-cpu-controller'
import { nativeCpuExecutable, nativeCpuMaskCapability } from '../src/main/native-cpu-executable'
import { resolveResourcePolicy } from '../src/shared/resource-policy'
import {
  hdrSourceVersion,
  HDR_SOURCE_VERSION,
  HDR_JPEG_SOURCE_VERSION,
  SDR_TARGET,
  validateHdrSource,
  validateTarget,
  type DisplayTarget,
  type HdrWorkingAsset,
} from '../src/shared/hdr'
import { neutralAdjustments, type AdjustmentParameters } from '../src/shared/adjustments'
import { validatePatch } from '../src/shared/edits'
import {
  NATIVE_HDR_MASK_VERSION,
  type NativeHdrMaskRequest,
  type NativeHdrMaskResult,
} from '../src/shared/native-hdr-mask'
import type { CpuPreviewSourceRef } from '../src/shared/native-cpu-preview'
import type {
  MaskParityResult,
  MaskParityRuntimeStart,
  MaskParityStart,
} from './native-hdr-mask-parity.worker'

interface Photograph {
  name: string
  defaultWorkingPath: string
  workingPathEnvironment: string
  originalPath: string
  originalSha256: string
  asset: HdrWorkingAsset
  parameters: AdjustmentParameters
  target: DisplayTarget
  retainedManifestPath: string
  retainedManifestSha256: string
}
interface Threshold {
  name: string
  parameters: AdjustmentParameters
  target: DisplayTarget
  actualInputF32: number[]
  actualInputSha256: string
  expectedBaseBytes: number[]
  evidence: unknown
}
const fixtures = fixtureJson as unknown as {
  photographs: Photograph[]
  publicThresholdControls: Threshold[]
}
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const errno = (error: unknown) => (error as NodeJS.ErrnoException).code
interface Pinned {
  path: string
  file: FileHandle
  fingerprint: string
  byteLength: number
  sha256: string
}
async function fingerprint(file: FileHandle) {
  const value = await file.stat({ bigint: true })
  if (!value.isFile()) throw new Error('Parity fixtures must be actual regular files.')
  return JSON.stringify(
    [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].map(String),
  )
}
async function readExact(file: FileHandle, bytes: Buffer, offset: number) {
  for (let filled = 0; filled < bytes.length;) {
    const { bytesRead } = await file.read(bytes, filled, bytes.length - filled, offset + filled)
    if (!bytesRead) throw new Error('Truncated read-only parity fixture.')
    filled += bytesRead
  }
}
async function hashPinned(pin: Pick<Pinned, 'file' | 'byteLength'>) {
  const hash = createHash('sha256'),
    storage = Buffer.alloc(1024 * 1024)
  for (let position = 0; position < pin.byteLength; position += storage.length) {
    const bytes = storage.subarray(0, Math.min(storage.length, pin.byteLength - position))
    await readExact(pin.file, bytes, position)
    hash.update(bytes)
  }
  return hash.digest('hex')
}
async function pin(path: string, expectedSha256: string, expectedLength?: number): Promise<Pinned> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const initial = await fingerprint(file),
      byteLength = Number((await file.stat()).size)
    if (expectedLength !== undefined) expect(byteLength).toBe(expectedLength)
    const value = { path, file, fingerprint: initial, byteLength, sha256: expectedSha256 }
    expect(await hashPinned(value)).toBe(expectedSha256)
    expect(await fingerprint(file)).toBe(initial)
    return value
  } catch (error) {
    await file.close()
    throw error
  }
}
async function recheck(pin: Pinned) {
  expect(await hashPinned(pin)).toBe(pin.sha256)
  expect(await fingerprint(pin.file)).toBe(pin.fingerprint)
}
const sourceFiles = [
  'tests/native-hdr-mask-parity.spec.ts',
  'tests/native-hdr-mask-parity.worker.ts',
  'tests/fixtures/native-hdr-mask-parity.json',
  'src/shared/hdr-statistics.ts',
  'src/shared/hdr.ts',
  'src/shared/adjustments.ts',
  'src/shared/display-rendering.ts',
  'src/shared/aces-core.ts',
  'src/shared/white-balance.ts',
  'src/renderer/src/preview/hdr-stream.ts',
  'src/renderer/src/preview/native-mask-math.ts',
  'src/main/native-cpu-controller.ts',
  'src/main/native-cpu-input.ts',
  'src/main/native-cpu-mask-sink.ts',
  'src/main/native-cpu-executable.ts',
  'out/main/native-cpu-render/linux-x64/SHA256SUMS',
  'out/main/native-cpu-render/linux-x64/capabilities.json',
]
const sourcePins = async () =>
  Object.fromEntries(
    await Promise.all(sourceFiles.map(async (path) => [path, sha(await readFile(path))])),
  )
interface WorkerApi {
  start(value: MaskParityStart): Promise<MaskParityRuntimeStart>
  source(index: number, bytes: string): Promise<unknown>
  native(index: number, bytes: string): Promise<unknown>
  finish(): Promise<MaskParityResult>
  close(): void
}
async function createOracle(page: Page, filename: string) {
  const handle: JSHandle<WorkerApi> = await page.evaluateHandle((name): WorkerApi => {
    const worker = new Worker(new URL(`assets/${name}`, location.href), { type: 'module' })
    let serial = 0
    const pending = new Map<
      number,
      { resolve: (value: unknown) => void; reject: (error: Error) => void }
    >()
    const invoke = (command: unknown, transfer: Transferable[] = []) =>
      new Promise<unknown>((resolve, reject) => {
        const id = ++serial
        pending.set(id, { resolve, reject })
        worker.postMessage({ id, command }, transfer)
      })
    const send = (kind: 'source' | 'native', index: number, base64: string) => {
      const decoded = atob(base64),
        bytes = new Uint8Array(decoded.length)
      for (let at = 0; at < decoded.length; at++) bytes[at] = decoded.charCodeAt(at)
      return invoke({ kind, index, bytes: bytes.buffer }, [bytes.buffer])
    }
    worker.onmessage = ({ data }) => {
      const entry = pending.get(data.id)
      if (!entry) return
      pending.delete(data.id)
      if (data.error) entry.reject(new Error(data.error))
      else entry.resolve(data.result)
    }
    worker.onerror = (event) => {
      event.preventDefault()
      for (const entry of pending.values()) entry.reject(new Error(event.message))
      pending.clear()
    }
    return {
      start: (start) => invoke({ kind: 'start', start }) as Promise<MaskParityRuntimeStart>,
      source: (index, bytes) => send('source', index, bytes),
      native: (index, bytes) => send('native', index, bytes),
      finish: () => invoke({ kind: 'finish' }) as Promise<MaskParityResult>,
      close: () => {
        for (const entry of pending.values()) entry.reject(new Error('Parity worker closed.'))
        pending.clear()
        worker.terminate()
      },
    }
  }, filename)
  return {
    handle,
    close: async () => {
      try {
        await handle.evaluate((control) => control.close())
      } finally {
        await handle.dispose()
      }
    },
  }
}
interface Source {
  pin: Pinned
  asset: HdrWorkingAsset
  ref: CpuPreviewSourceRef
  parameters: AdjustmentParameters
  handles: Set<FileHandle>
  acquisitions: number
  releases: number
}

// Deliberately long, explicit private-working-plane quality gate. It is omitted
// from routine scopes and never measures foreground cadence or application RSS.
test('actual Electron unchanged full-mask oracle matches native at every photographic mip and public threshold', async ({
  luma,
}, info) => {
  test.skip(
    process.platform !== 'linux' || process.arch !== 'x64',
    'Bazzite/Linux x64 native mask acceptance; macOS is incomplete.',
  )
  test.setTimeout(600000)
  expect(fixtures.photographs).toHaveLength(2)
  expect(new Set(fixtures.photographs.map((item) => item.originalSha256)).size).toBe(2)
  expect(fixtures.publicThresholdControls).toHaveLength(12)
  const paths = fixtures.photographs.map((item) => ({
    fixture: item,
    working: resolve(process.env[item.workingPathEnvironment] ?? item.defaultWorkingPath),
    original: resolve(item.originalPath),
  }))
  const absent: string[] = []
  for (const entry of paths)
    for (const path of [entry.working, entry.original]) {
      try {
        await access(path, constants.R_OK)
      } catch (error) {
        if (errno(error) === 'ENOENT') absent.push(path)
        else throw error
      }
    }
  test.skip(
    absent.length > 0,
    `Incomplete: both unchanged full-size working planes and originals are required; missing ${absent.join(', ')}. No repeated/smaller substitute.`,
  )
  expect(await luma.page.evaluate(() => window.luma.listPhotos())).toMatchObject({ photos: [] })
  const runtime = await luma.app.evaluate(() => ({
    platform: process.platform,
    arch: process.arch,
    versions: process.versions,
    executable: process.execPath,
  }))
  const executable = await nativeCpuExecutable(resolve('out/main'))
  const capability = await nativeCpuMaskCapability(resolve('out/main'))
  const pinsBefore = await sourcePins(),
    bundlePath = resolve('out/renderer/assets', `native-mask-parity-${randomUUID()}.js`)
  const directory = info.outputPath('mask-parity')
  await mkdir(directory, { recursive: true })
  const report: Record<string, unknown> = {
    status: 'running',
    applicationAcceptance: false,
    scope:
      'Actual hidden Electron worker runs unchanged full analyzeHdr + OR reducer against a real combined native helper through production controller/feed/sink. Bounded test strip transfer is not production browser fetch or presenter-memory/performance acceptance.',
    runtime,
    executable,
    executableSha256: sha(await readFile(executable)),
    capability,
    sourcePins: pinsBefore,
    thresholdControls: [],
    photographs: [],
    numericFailures: [],
  }
  const save = () =>
    writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  await save()
  const opened: Pinned[] = [],
    sources: Source[] = []
  let oracle: Awaited<ReturnType<typeof createOracle>> | undefined
  let controller: NativeCpuController | undefined
  let activeTarget: DisplayTarget | undefined
  let failure: unknown
  let bundleOwned = false
  const errors: unknown[] = []
  try {
    const compiled = await build({
      entryPoints: ['tests/native-hdr-mask-parity.worker.ts'],
      bundle: true,
      format: 'iife',
      platform: 'browser',
      write: false,
      sourcemap: false,
    })
    expect(compiled.outputFiles).toHaveLength(1)
    await writeFile(bundlePath, compiled.outputFiles[0].contents, { flag: 'wx', mode: 0o600 })
    bundleOwned = true
    report.oracleBundleSha256 = sha(compiled.outputFiles[0].contents)
    oracle = await createOracle(luma.page, basename(bundlePath))
    const policy = resolveResourcePolicy(
      { version: 1, ramMiB: 2048, vramMiB: 2048 },
      {
        ram: { totalBytes: 8 * 1024 ** 3, availableBytes: 6 * 1024 ** 3 },
        gpu: { status: 'unknown', reason: 'adapter-unverified' },
      },
      1,
    )
    const acquire = async (
      request: Pick<NativeHdrMaskRequest, 'source' | 'expectedSettingsRevision'>,
      signal: AbortSignal,
    ): Promise<CpuWorkingLease> => {
      signal.throwIfAborted()
      const source = sources.find((item) => item.ref.cacheId === request.source.cacheId)
      if (!source || JSON.stringify(source.ref) !== JSON.stringify(request.source))
        throw new Error('The numerical parity fixture source changed.')
      const file = await open(source.pin.path, constants.O_RDONLY | constants.O_NOFOLLOW)
      source.handles.add(file)
      source.acquisitions++
      let released = false
      return {
        source: source.ref,
        asset: source.asset,
        file,
        check: async (revision, activeSignal) => {
          activeSignal.throwIfAborted()
          expect(revision).toBe(1)
          expect(await fingerprint(file)).toBe(source.pin.fingerprint)
        },
        release: async () => {
          if (released) return
          released = true
          try {
            await file.close()
          } finally {
            source.handles.delete(file)
            source.releases++
          }
        },
      }
    }
    controller = new NativeCpuController({
      root: join(directory, 'native-output'),
      executable: () => nativeCpuExecutable(resolve('out/main')),
      policy: async () => policy,
      acquireSource: acquire,
      foreground: async (work, signal) => {
        signal.throwIfAborted()
        return work()
      },
      existingOwners: () => ({ ramBytes: 0, gpuBytes: 0 }),
      mask: {
        arithmeticSha256: capability.arithmeticSha256,
        checkTarget: (request) => {
          for (const key of [
            'generation',
            'requested',
            'mode',
            'colorSpace',
            'peak',
            'headroom',
            'outputVersion',
          ] as const)
            if (request.target[key] !== activeTarget?.[key])
              throw new Error('The parity target changed.')
        },
        acquireSource: async (request, signal) => {
          const lease = await acquire(request, signal)
          const source = sources.find((item) => item.ref.cacheId === request.source.cacheId)!
          return { ...lease, parameters: source.parameters, policy }
        },
      },
    })
    await controller.open()
    const makeSource = (
      sourcePin: Pinned,
      asset: HdrWorkingAsset,
      parameters: AdjustmentParameters,
      originalSha256: string,
    ): Source => {
      validateHdrSource(asset.source)
      validatePatch(parameters)
      const result: Source = {
        pin: sourcePin,
        asset,
        parameters,
        ref: {
          photoId: originalSha256,
          cacheId: randomUUID(),
          workingSha256: asset.sha256,
          renderingIdentity: `${hdrSourceVersion(asset.source)}-${asset.sha256}`,
        },
        handles: new Set(),
        acquisitions: 0,
        releases: 0,
      }
      sources.push(result)
      return result
    }
    const compare = async (source: Source, target: DisplayTarget) => {
      validateTarget(target)
      activeTarget = target
      const request: NativeHdrMaskRequest = {
        version: NATIVE_HDR_MASK_VERSION,
        requestId: randomUUID(),
        sessionId: randomUUID(),
        source: source.ref,
        generation: 1,
        expectedSettingsRevision: 1,
        comparison: 'after',
        domain: 'content-hdr',
        parameters: source.parameters,
        target,
        existingOwners: { ramBytes: 0, vramBytes: 0 },
      }
      const started = performance.now()
      const outcome = await controller!.renderMask(request)
      if (outcome.kind !== 'mask')
        throw new Error(`Native parity work was declined: ${outcome.reason}.`)
      const result: NativeHdrMaskResult = outcome
      expect(result.arithmeticSha256).toBe(capability.arithmeticSha256)
      expect(result.source).toEqual(source.ref)
      expect(result.width).toBe(source.asset.width)
      expect(result.height).toBe(source.asset.height)
      expect(source.handles.size).toBe(0)
      expect(source.acquisitions).toBe(source.releases)
      const nativeThroughActualCloseAndLeaseReleaseMs = performance.now() - started
      const stream = controller!.acquireMask(new URL(result.url))
      if (!stream) throw new Error('The real native mask capability is unavailable.')
      let output: FileHandle | undefined
      try {
        output = await open(stream.path, constants.O_RDONLY | constants.O_NOFOLLOW)
        expect((await output.stat()).size).toBe(result.byteLength)
        const runtimeStart = await oracle!.handle.evaluate(
          (control, start) => control.start(start),
          {
            asset: { ...source.asset, url: result.url },
            parameters: source.parameters,
            target,
            nativeSha256: result.sha256,
          },
        )
        // Each actual F32 strip is transferred once into this genuine Electron
        // worker. Original working planes are neither copied to a library nor decoded again.
        for (const [index, strip] of source.asset.strips.entries()) {
          const bytes = Buffer.alloc(strip.byteLength)
          await readExact(source.pin.file, bytes, index * source.asset.width * 64 * 16)
          expect(sha(bytes)).toBe(strip.sha256)
          await oracle!.handle.evaluate(
            (control, value) => control.source(value.index, value.bytes),
            { index, bytes: bytes.toString('base64') },
          )
        }
        const outputHash = createHash('sha256')
        for (let index = 0; index < source.asset.strips.length; index++) {
          const length = source.asset.width * Math.min(64, source.asset.height - index * 64)
          const bytes = Buffer.alloc(length)
          await readExact(output, bytes, index * source.asset.width * 64)
          outputHash.update(bytes)
          await oracle!.handle.evaluate(
            (control, value) => control.native(value.index, value.bytes),
            { index, bytes: bytes.toString('base64') },
          )
        }
        expect(outputHash.digest('hex')).toBe(result.sha256)
        const parity = await oracle!.handle.evaluate((control) => control.finish())
        return { result, parity, runtimeStart, nativeThroughActualCloseAndLeaseReleaseMs }
      } finally {
        try {
          await output?.close()
        } finally {
          stream.release()
          await controller!.releaseMask(request.sessionId, result.maskId)
        }
      }
    }
    const literal = [0.25, 0.25, 0.25, 1, 3, 0, 0, 1, 4, 4, 4, 0.5, 100, 100, 100, 0, -1, -1, -1, 1]
    const controls: (Threshold & { authored?: boolean })[] = [
      ...fixtures.publicThresholdControls,
      {
        name: 'independent-authored-five-pixel-four-bit-golden',
        authored: true,
        parameters: neutralAdjustments,
        target: { ...SDR_TARGET, mode: 'hdr', peak: 2, headroom: 2 },
        actualInputF32: literal,
        actualInputSha256: sha(Buffer.from(new Float32Array(literal).buffer)),
        expectedBaseBytes: [0, 9, 7, 0, 0],
        evidence:
          'Independent authored-display literals exercise gamut bits, above white/headroom, alpha0/.5/1 and odd-width OR mips.',
      },
    ]
    const checkNumerics = (
      name: string,
      actual: {
        parity: MaskParityResult
        runtimeStart: MaskParityRuntimeStart
      },
      expectedBaseBytes?: number[],
    ) => {
      const failures = report.numericFailures as unknown[]
      if (
        actual.runtimeStart.primitiveVerificationError ||
        actual.runtimeStart.primitiveMismatches.length
      )
        failures.push({
          name,
          kind: 'actual-electron-primitive-mismatch',
          error: actual.runtimeStart.primitiveVerificationError,
          mismatches: actual.runtimeStart.primitiveMismatches,
        })
      if (actual.parity.differentBytes)
        failures.push({
          name,
          kind: 'full-mask-byte-mismatch',
          differentBytes: actual.parity.differentBytes,
          levels: actual.parity.levels.filter((level) => level.differentBytes),
        })
      if (
        expectedBaseBytes &&
        JSON.stringify(actual.parity.expectedBaseBytes) !== JSON.stringify(expectedBaseBytes)
      )
        failures.push({
          name,
          kind: 'actual-electron-independent-golden-mismatch',
          expected: expectedBaseBytes,
          actual: actual.parity.expectedBaseBytes,
        })
    }
    for (const [index, control] of controls.entries()) {
      const bytes = Buffer.from(new Float32Array(control.actualInputF32).buffer)
      expect(sha(bytes)).toBe(control.actualInputSha256)
      const path = join(directory, `threshold-${index}.f32`)
      await writeFile(path, bytes, { flag: 'wx', mode: 0o400 })
      const sourcePin = await pin(path, control.actualInputSha256, bytes.length)
      opened.push(sourcePin)
      const source = makeSource(
        sourcePin,
        {
          kind: 'hdr-working-v1',
          width: bytes.length / 16,
          height: 1,
          byteLength: bytes.length,
          sha256: control.actualInputSha256,
          strips: [{ byteLength: bytes.length, sha256: control.actualInputSha256 }],
          whiteBalance: control.authored ? undefined : fixtures.photographs[0].asset.whiteBalance,
          source: control.authored
            ? {
                version: HDR_JPEG_SOURCE_VERSION,
                processing: 'hdr-v1',
                colorSpace: 'rec2020',
                whitePoint: 'D65',
                transfer: 'linear',
                alpha: 'straight',
                decoder: 'synthetic-authored-four-bit-golden',
                orientation: 'applied-once',
                normalization: { referenceWhite: 1, sourceSaturation: null },
                display: { encoding: 'iso-21496-1-jpeg', headroom: 10, referenceWhiteNits: 203 },
              }
            : {
                version: HDR_SOURCE_VERSION,
                processing: 'hdr-v1',
                colorSpace: 'rec2020',
                whitePoint: 'D65',
                transfer: 'linear',
                alpha: 'straight',
                decoder: 'synthetic-public-mask-threshold',
                cameraProfile: 'synthetic-threshold-with-pinned-real-wb-profile',
                orientation: 'applied-once',
                normalization: {
                  black: [0, 0, 0, 0],
                  maximum: 1,
                  gains: [1, 1, 1, 1],
                  restoreGain: 1,
                  referenceWhite: 1,
                  sourceSaturation: null,
                },
              },
        },
        control.parameters,
        sha(`synthetic-public-threshold-${index}`),
      )
      report.phase = { kind: 'public-threshold-or-authored-golden', index, name: control.name }
      await save()
      const actual = await compare(source, control.target)
      ;(report.thresholdControls as unknown[]).push({
        name: control.name,
        preservedEvidence: control.evidence,
        ...actual,
      })
      checkNumerics(control.name, actual, control.expectedBaseBytes)
      await save()
      await recheck(sourcePin)
    }
    for (const entry of paths) {
      const { fixture } = entry
      const original = await pin(entry.original, fixture.originalSha256)
      opened.push(original)
      const sourcePin = await pin(entry.working, fixture.asset.sha256, fixture.asset.byteLength)
      opened.push(sourcePin)
      const source = makeSource(
        sourcePin,
        fixture.asset,
        fixture.parameters,
        fixture.originalSha256,
      )
      report.phase = {
        kind: 'full-photograph',
        name: fixture.name,
        width: fixture.asset.width,
        height: fixture.asset.height,
      }
      await save()
      const actual = await compare(source, fixture.target)
      ;(report.photographs as unknown[]).push({
        name: fixture.name,
        original: {
          path: entry.original,
          sha256: original.sha256,
          fingerprint: original.fingerprint,
        },
        working: {
          path: entry.working,
          sha256: sourcePin.sha256,
          fingerprint: sourcePin.fingerprint,
        },
        preparation: fixture.retainedManifestPath,
        retainedManifestSha256: fixture.retainedManifestSha256,
        ...actual,
      })
      checkNumerics(fixture.name, actual)
      await save()
      expect(actual.parity.sourcePixels).toBe(fixture.asset.width * fixture.asset.height)
      expect(actual.parity.sourceStrips).toBe(fixture.asset.strips.length)
      expect(actual.parity.nativeStrips).toBe(fixture.asset.strips.length)
      expect(actual.parity.comparedBytes).toBeGreaterThan(
        fixture.asset.width * fixture.asset.height,
      )
      await recheck(original)
      await recheck(sourcePin)
    }
    expect(await sourcePins()).toEqual(pinsBefore)
    expect(sha(await readFile(executable))).toBe(report.executableSha256)
    expect(await luma.page.evaluate(() => window.luma.listPhotos())).toMatchObject({ photos: [] })
    report.allComparisonsCompleted = true
    report.originalsAndWorkingSourcesUnchanged = true
    report.sourcePinsUnchanged = true
    await save()
    // Any real primitive rejection, preserved literal difference or full-image
    // mismatch fails acceptance, after retaining both complete actual references.
    expect(
      report.numericFailures,
      'Actual Electron primitive and full-mask numeric gates must all pass.',
    ).toEqual([])
    report.status = 'passed-actual-electron-full-mask-parity'
    report.limits =
      'One exact numeric observation per image/target on this actual runtime; not a cadence benchmark, universal libm proof, production UI/source-cache/receiver-route acceptance, or OS memory measurement. macOS deferred.'
  } catch (error) {
    failure = error
    report.status = 'failed'
    report.error = String(error)
  } finally {
    for (const action of [
      () => oracle?.close(),
      () => controller?.close(),
      ...opened.map((value) => () => value.file.close()),
      () => (bundleOwned ? rm(bundlePath, { force: true }) : undefined),
    ]) {
      try {
        await action()
      } catch (error) {
        errors.push(error)
      }
    }
    const sourceHandlesRemaining = sources.reduce((n, source) => n + source.handles.size, 0)
    if (sourceHandlesRemaining)
      errors.push(new Error('Native source descriptors remain after controller close.'))
    report.cleanup = { errors: errors.map(String), sourceHandlesRemaining }
    await save()
    await info.attach('actual-electron-mask-parity', {
      path: join(directory, 'report.json'),
      contentType: 'application/json',
    })
  }
  if (failure && errors.length)
    throw new AggregateError([failure, ...errors], 'Mask parity and cleanup failed.')
  if (failure) throw failure
  if (errors.length) throw new AggregateError(errors, 'Mask parity cleanup failed.')
})
