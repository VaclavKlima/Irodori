import { expect, test } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PreviewProcess } from '../src/main/preview-process'
import type { FullPreviewResult } from '../src/main/preview-types'

// Real bundled-Node IPC children exercise process ownership only: no decoder, image or GPU work.
const workerSource = `
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
let requests = 0
process.on('message', async (message) => {
  if (message.type === 'close') { process.exit(0); return }
  requests++
  await writeFile(join(message.output, 'producer-pid.txt'), String(process.pid))
  const result = {
    width: 1, height: 1, format: 'rgba8-srgb', byteLength: 4,
    sha256: 'a'.repeat(64), renderId: 'ipc-fixture-' + process.pid, placeholderBytes: 0,
    diagnostics: { backend: 'cpu', timings: { pid: process.pid, requests } },
  }
  if (message.path === 'terminal-error') {
    process.send({ type:'error', error:'Deliberate full terminal failure.' })
    return
  }
  if (message.path !== 'plain')
    process.send({ type: 'first-surface', progress: { status: 'declined', reason: 'ipc-fixture' } })
  if (message.path === 'exit-progress') {
    setImmediate(() => process.exit(19))
    return
  }
  if (message.path === 'hold-progress') return
  process.send({ type: 'result', result }, async () => {
    await writeFile(join(message.output, 'terminal-sent.txt'), 'sent')
  })
})
`

const warmingWorkerSource = `
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const root = dirname(fileURLToPath(import.meta.url))
let warmed = false
process.on('message', async (message) => {
  if (message.type === 'close') {
    await writeFile(join(root, 'closing.txt'), String(process.pid))
    while (!(await readFile(join(root, 'close-release.txt'), 'utf8').catch(() => '')))
      await new Promise((resolve) => setTimeout(resolve, 5))
    process.exit(0)
    return
  }
  if (message.type === 'warmup') {
    await writeFile(join(root, 'warming.txt'), String(process.pid))
    while (!(await readFile(join(root, 'warm-release.txt'), 'utf8').catch(() => '')))
      await new Promise((resolve) => setTimeout(resolve, 5))
    warmed = true
    process.send({ type:'result', result:{status:'ready',kernel:message.kernel,elapsedMs:1,
      timings:{wasmMs:0.2,tableMs:0.1,gpuMs:0.6,totalMs:1}} })
    return
  }
  await writeFile(join(message.output, 'producer-pid.txt'), String(process.pid))
  process.send({ type:'result', result:{
    width:1,height:1,format:'rgba8-srgb',byteLength:4,sha256:'a'.repeat(64),
    renderId:'warming-fixture-'+process.pid,placeholderBytes:0,
    diagnostics:{backend:'cpu',timings:{pid:process.pid,warmed:Number(warmed)}},
  } })
})
`

function failedWarmingWorkerSource(failure: 'unavailable' | 'error') {
  return `
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const root = dirname(fileURLToPath(import.meta.url))
await appendFile(join(root, 'launches.txt'), String(process.pid) + '\\n')
let poisoned = false
process.on('message', async (message) => {
  if (message.type === 'close') {
    await writeFile(join(root, 'closing.txt'), String(process.pid))
    while (!(await readFile(join(root, 'close-release.txt'), 'utf8').catch(() => '')))
      await new Promise((resolve) => setTimeout(resolve, 5))
    process.exit(0)
    return
  }
  if (message.type === 'warmup') {
    poisoned = true
    await writeFile(join(root, 'warming.txt'), String(process.pid))
    while (!(await readFile(join(root, 'warm-release.txt'), 'utf8').catch(() => '')))
      await new Promise((resolve) => setTimeout(resolve, 5))
    if (${JSON.stringify(failure)} === 'error')
      process.send({type:'error',error:'Deliberate warm-up initialization failure.'})
    else
      process.send({type:'result',result:{status:'unavailable',kernel:message.kernel,elapsedMs:1,
        timings:{wasmMs:0.9,totalMs:1},reason:'Deliberate sticky WASM initialization failure.'}})
    return
  }
  await writeFile(join(message.output, 'producer-pid.txt'), String(process.pid))
  if (poisoned) {
    process.send({type:'error',error:'A poisoned warm-up worker was reused.'})
    return
  }
  process.send({type:'result',result:{
    width:1,height:1,format:'rgba8-srgb',byteLength:4,sha256:'a'.repeat(64),
    renderId:'fresh-fixture-'+process.pid,placeholderBytes:0,
    diagnostics:{backend:'cpu',timings:{pid:process.pid,poisoned:Number(poisoned)}},
  }})
})
`
}

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
function isAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}
async function fixture(source = workerSource, idleMs?: number) {
  const root = test.info().outputPath('ipc-lifecycle')
  await mkdir(root, { recursive: true })
  const worker = join(root, 'worker.mjs')
  await writeFile(worker, source)
  return {
    process: new PreviewProcess(worker, 90_000, idleMs),
    root,
    output: async (name: string) => {
      const path = join(root, name)
      await mkdir(path)
      return path
    },
  }
}

test('a real full request joins one warm-up and reuses its actual child', async () => {
  const instance = await fixture(warmingWorkerSource),
    preview = instance.process,
    output = await instance.output('full'),
    cancelledOutput = await instance.output('cancelled-demand'),
    warming = preview.prewarmHdr('linear64')
  expect(preview.prewarmHdr('linear64')).toBe(warming)
  let settled = false
  const full = preview.renderFull('plain', output, new AbortController().signal).finally(() => {
    settled = true
  })
  // Observe rejections immediately even if an assertion fails while the real warm-up is held.
  const outcome = full.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  )
  try {
    await expect
      .poll(async () => readFile(join(instance.root, 'warming.txt'), 'utf8').catch(() => ''))
      .not.toBe('')
    const pid = Number(await readFile(join(instance.root, 'warming.txt'), 'utf8'))
    expect(isAlive(pid)).toBe(true)
    expect(settled).toBe(false)
    const cancelled = new AbortController(),
      discarded = observe(preview.renderFull('plain', cancelledOutput, cancelled.signal))
    cancelled.abort()
    expect(await discarded.outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining('cancelled'),
    })
    expect(isAlive(pid)).toBe(true)
    expect(settled).toBe(false)
    expect(await readFile(join(cancelledOutput, 'producer-pid.txt'), 'utf8').catch(() => '')).toBe(
      '',
    )
    expect(await readFile(join(output, 'producer-pid.txt'), 'utf8').catch(() => '')).toBe('')
    await writeFile(join(instance.root, 'warm-release.txt'), 'release')
    expect(await warming).toMatchObject({
      status: 'ready',
      kernel: 'linear64',
      elapsedMs: 1,
      timings: { wasmMs: 0.2, tableMs: 0.1, gpuMs: 0.6, totalMs: 1 },
    })
    const result = await outcome
    expect(result).toHaveProperty('value')
    if ('value' in result) {
      expect(resultPid(result.value)).toBe(pid)
      expect(result.value.diagnostics?.timings.warmed).toBe(1)
    }
  } finally {
    await writeFile(join(instance.root, 'warm-release.txt'), 'release')
    await writeFile(join(instance.root, 'close-release.txt'), 'release')
    await preview.close(true)
    await Promise.allSettled([warming, outcome])
  }
})

test('idle retirement drains its actual child before the next request launches a replacement', async () => {
  const instance = await fixture(warmingWorkerSource, 5),
    preview = instance.process,
    output = await instance.output('replacement')
  await writeFile(join(instance.root, 'warm-release.txt'), 'release')
  const warming = preview.prewarmHdr('linear64')
  let pending: ReturnType<typeof observe> | undefined
  try {
    await warming
    await expect
      .poll(async () => readFile(join(instance.root, 'closing.txt'), 'utf8').catch(() => ''))
      .not.toBe('')
    const pid = Number(await readFile(join(instance.root, 'closing.txt'), 'utf8'))
    expect(isAlive(pid)).toBe(true)
    pending = observe(preview.renderFull('plain', output, new AbortController().signal))
    expect(pending.settled()).toBe(false)
    expect(await readFile(join(output, 'producer-pid.txt'), 'utf8').catch(() => '')).toBe('')
    await writeFile(join(instance.root, 'close-release.txt'), 'release')
    const result = await pending.outcome
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(resultPid(result.value)).not.toBe(pid)
      expect(isAlive(pid)).toBe(false)
      expect(result.value.diagnostics?.timings.warmed).toBe(0)
    }
  } finally {
    await writeFile(join(instance.root, 'close-release.txt'), 'release')
    await preview.close(true)
    await Promise.allSettled([warming, pending?.outcome])
  }
})

test('closing a held warm-up cancels its waiting demand without launching a replacement', async () => {
  const instance = await fixture(warmingWorkerSource),
    preview = instance.process,
    output = await instance.output('cancelled'),
    warming = preview.prewarmHdr('linear64'),
    warmOutcome = warming.then(
      () => 'ready',
      () => 'cancelled',
    ),
    pending = observe(preview.renderFull('plain', output, new AbortController().signal))
  try {
    await expect
      .poll(async () => readFile(join(instance.root, 'warming.txt'), 'utf8').catch(() => ''))
      .not.toBe('')
    const pid = Number(await readFile(join(instance.root, 'warming.txt'), 'utf8'))
    for (const retiredOrInvalid of ['grid8', 'invalid'])
      await expect(preview.prewarmHdr(retiredOrInvalid as 'linear64')).rejects.toThrow(
        'Invalid HDR warm-up kernel',
      )
    await preview.close(true)
    expect(isAlive(pid)).toBe(false)
    expect(await warmOutcome).toBe('cancelled')
    expect(await pending.outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining('cancelled'),
    })
    expect(await readFile(join(output, 'producer-pid.txt'), 'utf8').catch(() => '')).toBe('')
  } finally {
    await writeFile(join(instance.root, 'warm-release.txt'), 'release')
    await writeFile(join(instance.root, 'close-release.txt'), 'release')
    await preview.close(true)
    await Promise.allSettled([warmOutcome, pending.outcome])
  }
})

for (const failure of ['unavailable', 'error'] as const) {
  test(`${failure} warm-up drains its failed child before waiting demand uses a fresh worker`, async () => {
    const instance = await fixture(failedWarmingWorkerSource(failure)),
      preview = instance.process,
      output = await instance.output('fresh-demand'),
      warming = preview.prewarmHdr('linear64')
    let warmSettled = false
    const warmOutcome = warming.then(
      (value) => {
        warmSettled = true
        return { ok: true as const, value }
      },
      (error: unknown) => {
        warmSettled = true
        return { ok: false as const, error: String(error) }
      },
    )
    const pending = observe(preview.renderFull('plain', output, new AbortController().signal))
    try {
      await expect
        .poll(async () => readFile(join(instance.root, 'warming.txt'), 'utf8').catch(() => ''))
        .not.toBe('')
      const pid = Number(await readFile(join(instance.root, 'warming.txt'), 'utf8'))
      await writeFile(join(instance.root, 'warm-release.txt'), 'release')
      await expect
        .poll(async () => readFile(join(instance.root, 'closing.txt'), 'utf8').catch(() => ''))
        .toBe(String(pid))
      expect(isAlive(pid)).toBe(true)
      expect(preview.prewarmHdr('linear64')).toBe(warming)
      expect(warmSettled).toBe(false)
      expect(pending.settled()).toBe(false)
      expect(await readFile(join(output, 'producer-pid.txt'), 'utf8').catch(() => '')).toBe('')
      expect(
        (await readFile(join(instance.root, 'launches.txt'), 'utf8')).trim().split('\n'),
      ).toEqual([String(pid)])
      await writeFile(join(instance.root, 'close-release.txt'), 'release')
      const warm = await warmOutcome
      if (failure === 'unavailable') {
        expect(warm).toMatchObject({
          ok: true,
          value: {
            status: 'unavailable',
            kernel: 'linear64',
            elapsedMs: 1,
            timings: { wasmMs: 0.9, totalMs: 1 },
          },
        })
      } else {
        expect(warm).toMatchObject({
          ok: false,
          error: expect.stringContaining('Deliberate warm-up initialization failure'),
        })
      }
      expect(isAlive(pid)).toBe(false)
      const result = await pending.outcome
      expect(result.ok).toBe(true)
      if (result.ok) {
        const replacement = resultPid(result.value)
        expect(replacement).not.toBe(pid)
        expect(result.value.diagnostics?.timings.poisoned).toBe(0)
        expect(
          (await readFile(join(instance.root, 'launches.txt'), 'utf8')).trim().split('\n'),
        ).toEqual([String(pid), String(replacement)])
      }
    } finally {
      await writeFile(join(instance.root, 'warm-release.txt'), 'release')
      await writeFile(join(instance.root, 'close-release.txt'), 'release')
      await preview.close(true)
      await Promise.allSettled([warmOutcome, pending.outcome])
    }
  })
}

test('aborting demand during failed warm-up retirement does not launch another child', async () => {
  const instance = await fixture(failedWarmingWorkerSource('unavailable')),
    preview = instance.process,
    output = await instance.output('aborted-demand'),
    warming = preview.prewarmHdr('linear64'),
    warmOutcome = warming.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    ),
    controller = new AbortController(),
    pending = observe(preview.renderFull('plain', output, controller.signal))
  try {
    await writeFile(join(instance.root, 'warm-release.txt'), 'release')
    await expect
      .poll(async () => readFile(join(instance.root, 'closing.txt'), 'utf8').catch(() => ''))
      .not.toBe('')
    const pid = Number(await readFile(join(instance.root, 'closing.txt'), 'utf8'))
    controller.abort()
    expect(await pending.outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining('cancelled'),
    })
    expect(isAlive(pid)).toBe(true)
    await writeFile(join(instance.root, 'close-release.txt'), 'release')
    expect(await warmOutcome).toMatchObject({ value: { status: 'unavailable' } })
    expect(isAlive(pid)).toBe(false)
    expect(await readFile(join(output, 'producer-pid.txt'), 'utf8').catch(() => '')).toBe('')
    expect(
      (await readFile(join(instance.root, 'launches.txt'), 'utf8')).trim().split('\n'),
    ).toEqual([String(pid)])
  } finally {
    await writeFile(join(instance.root, 'warm-release.txt'), 'release')
    await writeFile(join(instance.root, 'close-release.txt'), 'release')
    await preview.close(true)
    await Promise.allSettled([warmOutcome, pending.outcome])
  }
})

test('explicit close during failed warm-up retirement cancels waiting demand without respawn', async () => {
  const instance = await fixture(failedWarmingWorkerSource('unavailable')),
    preview = instance.process,
    output = await instance.output('closed-demand'),
    warming = preview.prewarmHdr('linear64'),
    warmOutcome = warming.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    ),
    pending = observe(preview.renderFull('plain', output, new AbortController().signal))
  try {
    await writeFile(join(instance.root, 'warm-release.txt'), 'release')
    await expect
      .poll(async () => readFile(join(instance.root, 'closing.txt'), 'utf8').catch(() => ''))
      .not.toBe('')
    const pid = Number(await readFile(join(instance.root, 'closing.txt'), 'utf8'))
    await preview.close(true)
    expect(isAlive(pid)).toBe(false)
    expect(await warmOutcome).toMatchObject({ value: { status: 'unavailable' } })
    expect(await pending.outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining('cancelled'),
    })
    expect(await readFile(join(output, 'producer-pid.txt'), 'utf8').catch(() => '')).toBe('')
    expect(
      (await readFile(join(instance.root, 'launches.txt'), 'utf8')).trim().split('\n'),
    ).toEqual([String(pid)])
  } finally {
    await writeFile(join(instance.root, 'warm-release.txt'), 'release')
    await writeFile(join(instance.root, 'close-release.txt'), 'release')
    await preview.close(true)
    await Promise.allSettled([warmOutcome, pending.outcome])
  }
})

function observe(work: Promise<FullPreviewResult>) {
  let settled = false
  const outcome = work.then(
    (value) => {
      settled = true
      return { ok: true as const, value }
    },
    (error: unknown) => {
      settled = true
      return { ok: false as const, error: String(error) }
    },
  )
  return { outcome, settled: () => settled }
}
async function pidAt(output: string) {
  return Number(await readFile(join(output, 'producer-pid.txt'), 'utf8'))
}
function resultPid(result: FullPreviewResult) {
  const pid = result.diagnostics?.timings.pid
  expect(Number.isSafeInteger(pid)).toBe(true)
  return pid!
}

test('a rejected publication retires the actual child before any subsequent request can reuse it', async () => {
  const instance = await fixture(),
    preview = instance.process,
    output = await instance.output('first'),
    retryOutputs = await Promise.all(
      Array.from({ length: 32 }, (_, index) => instance.output(`retry-${index}`)),
    ),
    finalOutput = await instance.output('final'),
    entered = deferred(),
    publication = deferred()
  const first = observe(
    preview.renderFull(
      'hold-progress',
      output,
      new AbortController().signal,
      undefined,
      async () => {
        entered.resolve()
        await publication.promise
      },
    ),
  )
  try {
    await entered.promise
    const firstPid = await pidAt(output)
    expect(isAlive(firstPid)).toBe(true)
    publication.reject(new Error('Deliberate publication rejection.'))
    // Exercise the interval between publication rejection and actual child exit. A busy
    // rejection is valid; admission is valid only after the old real PID has retired.
    let busyRejections = 0
    for (const retryOutput of retryOutputs) {
      if (first.settled()) break
      const previousAlive = isAlive(firstPid)
      try {
        const retried = await preview.renderFull('plain', retryOutput, new AbortController().signal)
        expect(
          previousAlive,
          'A new request was admitted while the failed producer still lived.',
        ).toBe(false)
        expect(resultPid(retried)).not.toBe(firstPid)
        break
      } catch (error) {
        expect(String(error)).toContain('busy')
        busyRejections++
      }
    }
    expect(busyRejections).toBeGreaterThan(0)
    expect(await first.outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining('Deliberate publication rejection.'),
    })
    expect(isAlive(firstPid)).toBe(false)
    const next = await preview.renderFull('plain', finalOutput, new AbortController().signal)
    expect(resultPid(next)).toBe(await pidAt(finalOutput))
    expect(resultPid(next)).not.toBe(firstPid)
  } finally {
    publication.resolve()
    await preview.close(true)
    await first.outcome
  }
})

test('a normal terminal result waits publication and then reuses the same warm child', async () => {
  const instance = await fixture(),
    preview = instance.process,
    output = await instance.output('first'),
    nextOutput = await instance.output('next'),
    entered = deferred(),
    publication = deferred()
  const first = observe(
    preview.renderFull(
      'progress-result',
      output,
      new AbortController().signal,
      undefined,
      async () => {
        entered.resolve()
        await publication.promise
      },
    ),
  )
  try {
    await entered.promise
    const pid = await pidAt(output)
    await expect
      .poll(async () => readFile(join(output, 'terminal-sent.txt'), 'utf8').catch(() => ''))
      .toBe('sent')
    expect(first.settled()).toBe(false)
    expect(isAlive(pid)).toBe(true)
    await expect(
      preview.renderFull('plain', nextOutput, new AbortController().signal),
    ).rejects.toThrow('busy')
    publication.resolve()
    expect(await first.outcome).toMatchObject({ ok: true })
    const next = await preview.renderFull('plain', nextOutput, new AbortController().signal)
    expect(resultPid(next)).toBe(pid)
    expect(next.diagnostics?.timings.requests).toBe(2)
  } finally {
    publication.resolve()
    await preview.close(true)
    await first.outcome
  }
})

test('a full terminal error retires its actual child before admitting another request', async () => {
  const instance = await fixture(),
    preview = instance.process,
    output = await instance.output('failure'),
    nextOutput = await instance.output('next')
  try {
    await expect(
      preview.renderFull('terminal-error', output, new AbortController().signal),
    ).rejects.toThrow('Deliberate full terminal failure.')
    const pid = await pidAt(output)
    expect(isAlive(pid)).toBe(false)
    const next = await preview.renderFull('plain', nextOutput, new AbortController().signal)
    expect(resultPid(next)).not.toBe(pid)
    expect(isAlive(pid)).toBe(false)
  } finally {
    await preview.close(true)
  }
})

test('concurrent close and abort retain busy ownership until the publication callback drains', async () => {
  const instance = await fixture(),
    preview = instance.process,
    output = await instance.output('first'),
    nextOutput = await instance.output('next'),
    entered = deferred(),
    publication = deferred(),
    abort = new AbortController()
  const first = observe(
    preview.renderFull('hold-progress', output, abort.signal, undefined, async () => {
      entered.resolve()
      await publication.promise
    }),
  )
  try {
    await entered.promise
    const pid = await pidAt(output)
    const closing = preview.close(true)
    abort.abort()
    await closing
    expect(isAlive(pid)).toBe(false)
    expect(first.settled()).toBe(false)
    await expect(
      preview.renderFull('plain', nextOutput, new AbortController().signal),
    ).rejects.toThrow('busy')
    publication.resolve()
    expect(await first.outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining('cancelled'),
    })
    const next = await preview.renderFull('plain', nextOutput, new AbortController().signal)
    expect(resultPid(next)).not.toBe(pid)
  } finally {
    publication.resolve()
    await preview.close(true)
    await first.outcome
  }
})

test('unexpected child exit still waits an in-progress publication before rejecting and replacing it', async () => {
  const instance = await fixture(),
    preview = instance.process,
    output = await instance.output('first'),
    nextOutput = await instance.output('next'),
    entered = deferred(),
    publication = deferred()
  const first = observe(
    preview.renderFull(
      'exit-progress',
      output,
      new AbortController().signal,
      undefined,
      async () => {
        entered.resolve()
        await publication.promise
      },
    ),
  )
  try {
    await entered.promise
    const pid = await pidAt(output)
    await expect.poll(() => isAlive(pid)).toBe(false)
    expect(first.settled()).toBe(false)
    await expect(
      preview.renderFull('plain', nextOutput, new AbortController().signal),
    ).rejects.toThrow('busy')
    publication.resolve()
    expect(await first.outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining('stopped'),
    })
    const next = await preview.renderFull('plain', nextOutput, new AbortController().signal)
    expect(resultPid(next)).not.toBe(pid)
  } finally {
    publication.resolve()
    await preview.close(true)
    await first.outcome
  }
})
