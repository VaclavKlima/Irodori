import type { ElectronApplication, Page, TestInfo } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import type { EditHistory, EditState } from '../src/shared/edits'
import { expect, test } from './electron.fixture'
import { foregroundTest } from './foreground'
import { importPhotos } from './import.helpers'
import { assertHdrMemory, readHdrMemory } from './hdr-memory-policy.helpers'
import { HDR_HISTOGRAM_WORDS } from '../src/renderer/src/preview/hdr-histogram'

test.use({ hdrDisplay: true })
const foreground = foregroundTest(
  'GPU source-cache output agreement requires real native compositor captures after completed normal frames.',
)
const files = ['tests/fixtures/sony-zv1.ARW', 'tests/fixtures/research-sony/originals/DSC03243.ARW']
const filenames = ['sony-zv1.ARW', 'DSC03243.ARW']
const GiB = 1024 ** 3
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
interface Target {
  id: string
  filename: string
  edits: EditState
  history: EditHistory
}

async function minimumWindow(app: ElectronApplication, page: Page) {
  const native = await app.browserWindow(page)
  await native.evaluate((window) => {
    window.unmaximize()
    window.setContentSize(1100, 700)
  })
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([1100, 700])
}

async function setup(app: ElectronApplication, page: Page) {
  await minimumWindow(app, page)
  await page
    .getByRole('navigation', { name: 'Workspaces' })
    .getByRole('button', { name: 'Library', exact: true })
    .click()
  await page.evaluate(() =>
    window.irodori.setResourceSettings({ version: 1, ramMiB: 2048, vramMiB: 2048 }),
  )
  const manifest = JSON.parse(
    await readFile('tests/fixtures/research-sony/manifest.json', 'utf8'),
  ) as {
    files: { name: string; sha256: string }[]
  }
  const fixtures = await Promise.all(
    files.map(async (path) => ({ path, sha256: sha256(await readFile(path)) })),
  )
  expect(fixtures[0].sha256).toBe(
    '14c9d2912584a3ccc5cf10f554fbe495fc960c36758a14d7d858b36ac5ca88e2',
  )
  expect(fixtures[1].sha256).toBe(manifest.files.find((file) => file.name === filenames[1])!.sha256)
  expect(fixtures[0].sha256).not.toBe(fixtures[1].sha256)
  await importPhotos(app, page, files, false)
  await page.evaluate(() => window.irodori.setPreviewPreference('sdr'))
  const photos = (await page.evaluate(() => window.irodori.listPhotos())).photos
  const targets: Target[] = []
  for (const [index, filename] of filenames.entries()) {
    const photo = photos.find((photo) => photo.filename === filename)!
    expect(photo).toBeDefined()
    const edits = await page.evaluate(
      async ({ id, exposureEv }) => {
        const before = await window.irodori.getEdits(id)
        return window.irodori.updateEdits(id, { exposureEv }, before.revision)
      },
      { id: photo.id, exposureEv: index === 0 ? 1 : -1 },
    )
    targets.push({
      id: photo.id,
      filename,
      edits,
      history: await page.evaluate((id) => window.irodori.getEditHistory(id), photo.id),
    })
  }
  await page
    .getByRole('navigation', { name: 'Workspaces' })
    .getByRole('button', { name: 'Editor', exact: true })
    .click()
  await page.getByRole('button', { name: `Select ${targets[0].filename}`, exact: true }).click()
  return { fixtures, targets }
}

async function observe(page: Page) {
  const canvas = page.getByTestId('main-preview')
  const memory = await canvas.evaluate(readHdrMemory)
  const frame = await canvas.evaluate((element) => {
    const value = (name: string) => {
      const raw = element.dataset[name]
      return raw === undefined || raw.trim() === '' ? Number.NaN : Number(raw)
    }
    const timings = JSON.parse(element.dataset.frameTimings ?? 'null') as {
      cacheSlots: number
      tileSize: number
    } | null
    const load = JSON.parse(element.dataset.loadTimings ?? 'null') as {
      sourceCacheHit: number
    } | null
    const recovery = JSON.parse(element.dataset.recoverySnapshot ?? 'null') as {
      serial: number
      sourceIdentity: string
      settingsRevision: number
      target: {
        mode: string
        colorSpace: string
        peak: number
        headroom: number | null
        generation: number
      }
    } | null
    const plot = document.querySelector('[aria-label="Histogram tonal value"]')
    const viewport = document
      .querySelector('[data-testid="preview-viewport"]')!
      .getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    return {
      geometryMatches:
        viewport.width > 0 &&
        viewport.height > 0 &&
        (element as HTMLCanvasElement).width === Math.round(viewport.width * dpr) &&
        (element as HTMLCanvasElement).height === Math.round(viewport.height * dpr),
      filename: element.getAttribute('aria-label'),
      source: element.dataset.presentedSourceIdentity,
      requestedSource: element.dataset.requestedSourceIdentity,
      revision: value('presentedSettingsRevision'),
      completed: value('completedEditSerial'),
      requested: value('requestedSerial'),
      analysisSerial: value('analysisSerial'),
      analysisKey: element.dataset.analysisKey,
      displayedAnalysisKey: element.dataset.displayedAnalysisKey,
      analysisPending: element.dataset.analysisPending,
      targetGeneration: value('targetGeneration'),
      sourceCache: element.dataset.sourceCache,
      sourceUploads: value('sourceUploads'),
      sourceCacheEntries: value('sourceCacheEntries'),
      sourceCacheRamBytes: value('sourceCacheRamBytes'),
      sourceCacheGpuBytes: value('sourceCacheGpuBytes'),
      sourceReservationRamBytes: value('sourceReservationRamBytes'),
      sourceReservationGpuBytes: value('sourceReservationGpuBytes'),
      loadCacheHit: load?.sourceCacheHit,
      cacheSlots: timings?.cacheSlots,
      tileSize: timings?.tileSize,
      retentionMethod: element.dataset.retentionMethod,
      recoveryPolicy: element.dataset.recoveryPolicy,
      recovery,
      presentedPolicy: element.dataset.presentedPolicy,
      arithmeticPolicy: element.dataset.presentedArithmeticPolicy,
      exposure: element.dataset.exposure,
      whiteBalance: element.dataset.whiteBalance,
      histogram: {
        serial: document.getElementById('histogram')?.dataset.editSerial,
        curveSerial: (plot as HTMLElement | null)?.dataset.curveEditSerial,
        animating: plot?.getAttribute('data-animating'),
        samples: document.getElementById('histogram')?.dataset.samples,
        paths: Array.from(plot?.querySelectorAll('path') ?? [], (path) => path.getAttribute('d')),
      },
      canvas: {
        width: (element as HTMLCanvasElement).width,
        height: (element as HTMLCanvasElement).height,
      },
    }
  })
  return { ...frame, memory }
}

async function ready(page: Page, target: Target) {
  let lastState: Awaited<ReturnType<typeof observe>> | undefined
  const canvas = page.getByTestId('main-preview')
  await expect(canvas).toHaveAttribute('aria-label', target.filename)
  await expect(canvas).toHaveAttribute('data-backend', 'webgpu-hdr', { timeout: 60000 })
  await expect(canvas).toHaveAttribute('data-editing', 'ready', { timeout: 60000 })
  await expect(canvas).toHaveAttribute('data-quality', 'normal')
  await expect(canvas).toHaveAttribute('data-exposure', String(target.edits.settings.exposureEv))
  await expect(canvas).toHaveAttribute(
    'data-presented-settings-revision',
    String(target.edits.revision),
  )
  await expect
    .poll(async () => {
      const state = await observe(page)
      lastState = state
      return (
        state.geometryMatches &&
        !!state.source &&
        state.source === state.requestedSource &&
        state.completed === state.requested &&
        state.analysisSerial === state.completed &&
        !!state.analysisKey &&
        state.analysisKey === state.displayedAnalysisKey &&
        state.analysisPending === 'false' &&
        state.histogram.animating === 'false' &&
        state.histogram.serial === String(state.completed) &&
        state.histogram.curveSerial === String(state.completed)
      )
    })
    .toBe(true)
    .catch(async (error: unknown) => {
      await writeFile(
        test.info().outputPath(`readiness-failure-${target.id}.json`),
        JSON.stringify({ target, lastState, currentState: await observe(page) }, null, 2),
      )
      throw error
    })
  await expect(canvas).toBeVisible()
  const state = await observe(page)
  assertHdrMemory(state.memory, target.filename)
  expect(state.memory.ramBudgetBytes).toBe(2 * GiB)
  expect(state.presentedPolicy).toBe('reference')
  expect(state.arithmeticPolicy).toBe('reference')
  expect(state.retentionMethod).toBe('raw-half-cpu')
  expect(state.recoveryPolicy).toBe('float16-cpu-snapshot-v1')
  expect(state.whiteBalance).toBe(JSON.stringify(target.edits.settings.whiteBalance))
  expect(state.cacheSlots).toBeGreaterThan(0)
  expect(state.tileSize).toBe(128)
  expect(state.sourceCacheEntries).toBeGreaterThan(0)
  expect(state.sourceCacheEntries).toBeLessThanOrEqual(2)
  expect(state.sourceCacheRamBytes).toBeGreaterThan(0)
  expect(state.sourceCacheGpuBytes).toBeGreaterThan(0)
  expect(state.recovery).toMatchObject({
    serial: state.completed,
    sourceIdentity: state.source,
    settingsRevision: target.edits.revision,
  })
  const display = await page.evaluate(() => window.irodori.getDisplayState())
  expect(display.mode).toBe('sdr')
  expect(state.targetGeneration).toBe(display.generation)
  expect(state.recovery!.target).toEqual({
    mode: display.mode,
    colorSpace: display.colorSpace,
    peak: display.peak,
    headroom: display.headroom,
    generation: display.generation,
  })
  expect(await page.evaluate((id) => window.irodori.getEdits(id), target.id)).toEqual(target.edits)
  expect(await page.evaluate((id) => window.irodori.getEditHistory(id), target.id)).toEqual(
    target.history,
  )
  expect(
    (await page.evaluate(() => window.irodori.getPreviewDiagnostics())).presentation,
  ).toMatchObject({ photoId: target.id, revision: target.edits.revision, stage: 'presented' })
  return state
}

async function select(page: Page, target: Target) {
  await page.getByRole('button', { name: `Select ${target.filename}`, exact: true }).click()
  return ready(page, target)
}

function cacheState(state: Awaited<ReturnType<typeof observe>>, hit: boolean) {
  expect(state.sourceCache).toBe(hit ? 'hit' : 'miss-retained')
  expect(state.sourceUploads).toBe(hit ? 0 : 1)
  expect(state.loadCacheHit).toBe(Number(hit))
}

/** Hold only the source-mip completion receipt; submitted hardware work still completes. */
async function holdSourceMip(page: Page) {
  return page.evaluateHandle(() => {
    const begin = GPUCommandEncoder.prototype.beginComputePass,
      setPipeline = GPUComputePassEncoder.prototype.setPipeline,
      finish = GPUCommandEncoder.prototype.finish,
      submit = GPUQueue.prototype.submit,
      completed = GPUQueue.prototype.onSubmittedWorkDone,
      owners = new WeakMap<GPUComputePassEncoder, GPUCommandEncoder>(),
      encoders = new WeakSet<GPUCommandEncoder>(),
      buffers = new WeakSet<GPUCommandBuffer>(),
      queues = new WeakSet<GPUQueue>()
    let release!: () => void,
      held = false,
      hardwareCompleted = false,
      hardwareError: string | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    GPUCommandEncoder.prototype.beginComputePass = function (descriptor) {
      const pass = begin.call(this, descriptor)
      owners.set(pass, this)
      return pass
    }
    GPUComputePassEncoder.prototype.setPipeline = function (pipeline) {
      setPipeline.call(this, pipeline)
      if (pipeline.label === 'Irodori HDR source mip') {
        const owner = owners.get(this)
        if (owner) encoders.add(owner)
      }
    }
    GPUCommandEncoder.prototype.finish = function (descriptor) {
      const buffer = finish.call(this, descriptor)
      if (encoders.has(this)) buffers.add(buffer)
      return buffer
    }
    GPUQueue.prototype.submit = function (commands) {
      const values = Array.from(commands)
      submit.call(this, values)
      if (!held && values.some((value) => buffers.has(value))) queues.add(this)
    }
    GPUQueue.prototype.onSubmittedWorkDone = function () {
      const actual = completed.call(this)
      if (held || !queues.has(this)) return actual
      held = true
      void actual.then(
        () => {
          hardwareCompleted = true
        },
        (error) => {
          hardwareError = String(error)
        },
      )
      return gate.then(() => actual)
    }
    return {
      get state() {
        return { held, hardwareCompleted, hardwareError }
      },
      release,
      close() {
        release()
        GPUCommandEncoder.prototype.beginComputePass = begin
        GPUComputePassEncoder.prototype.setPipeline = setPipeline
        GPUCommandEncoder.prototype.finish = finish
        GPUQueue.prototype.submit = submit
        GPUQueue.prototype.onSubmittedWorkDone = completed
      },
    }
  })
}

/** Full native canvas bytes; no reduced thumbnail, pixel tolerance or cached browser image oracle. */
async function capture(app: ElectronApplication, page: Page, info: TestInfo, name: string) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
  const bounds = await page.getByTestId('main-preview').boundingBox()
  if (!bounds) throw new Error('The normal source-cache frame has no native compositor bounds.')
  const native = await app.browserWindow(page)
  const result = await native.evaluate(async (window, bounds) => {
    const image = await window.capturePage(
      {
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
      },
      { stayHidden: true },
    )
    return {
      size: image.getSize(),
      png: image.toPNG().toString('base64'),
      pixels: image.toBitmap().toString('base64'),
    }
  }, bounds)
  await writeFile(info.outputPath(`${name}.png`), Buffer.from(result.png, 'base64'))
  const bytes = Buffer.from(result.pixels, 'base64')
  expect(bytes.byteLength).toBe(result.size.width * result.size.height * 4)
  return { size: result.size, sha256: sha256(bytes), bytes: bytes.byteLength }
}

test(
  'two real completed Sony GPU sources support A/B/A/B with current edits, histograms and exact normal output',
  foreground,
  async ({ irodori }, info) => {
    test.setTimeout(180000)
    const { app, page } = irodori
    const {
      fixtures,
      targets: [a, b],
    } = await setup(app, page)
    const visits = []
    try {
      for (const [index, target] of [a, b, a, b].entries()) {
        const state = index === 0 ? await ready(page, target) : await select(page, target)
        const pixels = await capture(app, page, info, `visit-${index}`)
        visits.push({ target: target.filename, state, pixels })
        cacheState(state, index >= 2)
        expect(state.memory.vramBudgetBytes).toBe(2 * GiB)
        expect(state.sourceCacheEntries).toBe(index === 0 ? 1 : 2)
        if (index >= 2) {
          const control = visits[index - 2]
          expect(state.source).toBe(control.state.source)
          expect(state.revision).toBe(control.state.revision)
          expect(state.recovery!.target).toEqual(control.state.recovery!.target)
          expect(state.histogram.paths).toEqual(control.state.histogram.paths)
          expect(state.histogram.samples).toBe(control.state.histogram.samples)
          expect(pixels).toEqual(control.pixels)
        }
      }
      expect(visits[0].state.source).not.toBe(visits[1].state.source)
      expect(visits[0].pixels.sha256).not.toBe(visits[1].pixels.sha256)
    } finally {
      await writeFile(
        info.outputPath('hdr-source-cache-ui.json'),
        JSON.stringify({ fixtures, visits }, null, 2),
      )
    }
  },
)

test(
  'a lower new-photo GPU budget prunes inactive sources before ordinary tile capacity or raw-half recovery',
  foreground,
  async ({ irodori }, info) => {
    test.setTimeout(180000)
    let { app, page } = irodori
    const {
      fixtures,
      targets: [a, b],
    } = await setup(app, page)
    const visits = []
    try {
      const first = await ready(page, a)
      cacheState(first, false)
      const firstPixels = await capture(app, page, info, 'a-original-miss')
      visits.push({ phase: 'a-miss', state: first, pixels: firstPixels })
      const second = await select(page, b)
      cacheState(second, false)
      expect(second.sourceCacheEntries).toBe(2)
      visits.push({ phase: 'b-miss', state: second })
      a.edits = await page.evaluate(
        ({ id, revision }) => window.irodori.updateEdits(id, { exposureEv: 1.5 }, revision),
        { id: a.id, revision: a.edits.revision },
      )
      a.history = await page.evaluate((id) => window.irodori.getEditHistory(id), a.id)
      const saved = await page.evaluate(() =>
        window.irodori.setResourceSettings({ version: 1, ramMiB: 2048, vramMiB: 1024 }),
      )
      expect(saved.settings.vramMiB).toBe(1024)
      const stillActive = await ready(page, b)
      expect(stillActive.memory).toEqual(second.memory)
      expect(stillActive.source).toBe(second.source)
      const lower = await select(page, a)
      cacheState(lower, true)
      expect(lower.memory.vramBudgetBytes).toBe(GiB)
      expect(lower.memory.resourcePolicyRevision).toBeGreaterThan(
        second.memory.resourcePolicyRevision,
      )
      expect(lower.source).toBe(first.source)
      expect(lower.sourceCacheEntries).toBe(1)
      expect(lower.sourceReservationRamBytes).toBe(0)
      expect(lower.sourceReservationGpuBytes).toBe(0)
      const lowerPixels = await capture(app, page, info, 'a-lower-budget-hit')
      expect(lowerPixels.sha256).not.toBe(firstPixels.sha256)
      visits.push({
        phase: 'a-lower-budget-hit-current-revision',
        state: lower,
        pixels: lowerPixels,
      })
      ;({ app, page } = await irodori.restart())
      await minimumWindow(app, page)
      await page.getByRole('button', { name: `Select ${a.filename}`, exact: true }).click()
      const ordinary = await ready(page, a)
      cacheState(ordinary, false)
      expect(ordinary.memory.vramBudgetBytes).toBe(GiB)
      expect(ordinary.sourceCacheEntries).toBe(1)
      expect(ordinary.sourceReservationRamBytes).toBe(0)
      expect(ordinary.sourceReservationGpuBytes).toBe(0)
      expect(lower.canvas).toEqual(ordinary.canvas)
      expect(lower.cacheSlots).toBe(ordinary.cacheSlots)
      expect(lower.tileSize).toBe(ordinary.tileSize)
      expect(lower.retentionMethod).toBe(ordinary.retentionMethod)
      expect(lower.recovery!.target).toMatchObject({
        mode: ordinary.recovery!.target.mode,
        colorSpace: ordinary.recovery!.target.colorSpace,
        peak: ordinary.recovery!.target.peak,
        headroom: ordinary.recovery!.target.headroom,
      })
      expect(lower.histogram.paths).toEqual(ordinary.histogram.paths)
      const ordinaryPixels = await capture(app, page, info, 'a-lower-budget-fresh-miss')
      visits.push({
        phase: 'a-fresh-session-ordinary-control',
        state: ordinary,
        pixels: ordinaryPixels,
      })
      expect(lowerPixels).toEqual(ordinaryPixels)
    } finally {
      await writeFile(
        info.outputPath('hdr-source-cache-budget-ui.json'),
        JSON.stringify({ fixtures, visits }, null, 2),
      )
    }
  },
)

test(
  'a cancelled real mip completion cannot promote its source or replace the next photo',
  foreground,
  async ({ irodori }, info) => {
    test.setTimeout(180000)
    const { app, page } = irodori
    const {
      targets: [a, b],
      fixtures,
    } = await setup(app, page)
    const first = await ready(page, a)
    cacheState(first, false)
    const pixels = await capture(app, page, info, 'before-mip-cancellation')
    const gate = await holdSourceMip(page)
    try {
      await page.getByRole('button', { name: `Select ${b.filename}`, exact: true }).click()
      await expect
        .poll(() => gate.evaluate((value) => value.state))
        .toEqual({
          held: true,
          hardwareCompleted: true,
          hardwareError: undefined,
        })
      const blocked = page.getByTestId('main-preview')
      await expect(blocked).toHaveAttribute('aria-label', b.filename)
      await expect(blocked).toHaveAttribute('data-source-cache', 'miss')
      await expect(blocked).toHaveAttribute('data-source-uploads', '0')
      await expect(blocked).not.toHaveAttribute('data-editing', 'ready')
      await page.getByRole('button', { name: `Select ${a.filename}`, exact: true }).click()
      await expect(page.getByTestId('main-preview')).toHaveAttribute('aria-label', a.filename)
      await gate.evaluate((value) => value.release())
      const recovered = await ready(page, a)
      cacheState(recovered, true)
      expect(recovered.sourceCacheEntries).toBe(1)
      expect(await capture(app, page, info, 'after-mip-cancellation')).toEqual(pixels)
      const subsequent = await select(page, b)
      cacheState(subsequent, false)
      expect(subsequent.sourceCacheEntries).toBe(2)
      await writeFile(
        info.outputPath('mip-cancellation.json'),
        JSON.stringify(
          {
            fixtures,
            first,
            recovered,
            subsequent,
            gate: await gate.evaluate((value) => value.state),
          },
          null,
          2,
        ),
      )
    } finally {
      await gate.evaluate((value) => value.close())
      await gate.dispose()
    }
  },
)

/** Hold delivery of a real submitted histogram readback only after its map completes. */
async function holdCompletedHistogramMap(page: Page) {
  return page.evaluateHandle((byteLength) => {
    interface Copy {
      buffer: GPUBuffer
      sourceIdentity: string
      serial: number
      key: string
    }
    const original = {
      copy: GPUCommandEncoder.prototype.copyBufferToBuffer,
      finish: GPUCommandEncoder.prototype.finish,
      submit: GPUQueue.prototype.submit,
      map: GPUBuffer.prototype.mapAsync,
    }
    const encoders = new WeakMap<GPUCommandEncoder, Copy>(),
      commands = new WeakMap<GPUCommandBuffer, Copy>(),
      submitted = new WeakMap<GPUBuffer, Copy>(),
      pending = new Set<Promise<void>>()
    const submissions: Omit<Copy, 'buffer'>[] = []
    let held = false,
      delivered = false,
      armed = true,
      maps = 0,
      omitted = 0,
      releaseHeld: (() => void) | undefined
    let heldCopy: Omit<Copy, 'buffer'> | undefined
    const release = () => {
      const resolve = releaseHeld
      releaseHeld = undefined
      resolve?.()
    }
    const copy: typeof original.copy = function (
      this: GPUCommandEncoder,
      ...args: [GPUBuffer, GPUBuffer, number?] | [GPUBuffer, number, GPUBuffer, number, number?]
    ): undefined {
      Reflect.apply(original.copy, this, args)
      const source = args[0],
        sourceOffset = typeof args[1] === 'number' ? args[1] : 0,
        destination = typeof args[1] === 'number' ? (args[2] as GPUBuffer) : args[1],
        destinationOffset = typeof args[1] === 'number' ? args[3]! : 0,
        size = (typeof args[1] === 'number' ? args[4] : args[2]) ?? source.size - sourceOffset
      if (
        size !== byteLength ||
        sourceOffset !== 0 ||
        destinationOffset !== 0 ||
        source.size !== byteLength ||
        destination.size !== byteLength ||
        !(source.usage & GPUBufferUsage.STORAGE) ||
        !(destination.usage & GPUBufferUsage.MAP_READ)
      )
        return
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')!
      if (canvas.dataset.quality !== 'normal' || !canvas.dataset.presentedSourceIdentity)
        throw new Error('The real histogram copy has no current normal source publication.')
      encoders.set(this, {
        buffer: destination,
        sourceIdentity: canvas.dataset.presentedSourceIdentity,
        serial: Number(canvas.dataset.completedEditSerial),
        key: canvas.dataset.displayedAnalysisKey!,
      })
    }
    const finish: typeof original.finish = function (this: GPUCommandEncoder, ...args) {
      const command = original.finish.apply(this, args),
        record = encoders.get(this)
      if (record) commands.set(command, record)
      return command
    }
    const submit: typeof original.submit = function (this: GPUQueue, commandsToSubmit) {
      const values = Array.from(commandsToSubmit)
      original.submit.call(this, values)
      for (const command of values) {
        const record = commands.get(command)
        if (!record) continue
        submitted.set(record.buffer, record)
        if (submissions.length < 16) {
          const { sourceIdentity, serial, key } = record
          submissions.push({ sourceIdentity, serial, key })
        } else omitted++
      }
    }
    const map: typeof original.map = function (this: GPUBuffer, ...args) {
      const actual = original.map.apply(this, args),
        record = submitted.get(this)
      if (!record || args[0] !== GPUMapMode.READ) return actual
      maps++
      const work = actual.then(async () => {
        if (!armed) return undefined
        armed = false
        held = true
        const { sourceIdentity, serial, key } = record
        heldCopy = { sourceIdentity, serial, key }
        await new Promise<void>((resolve) => {
          releaseHeld = resolve
        })
        held = false
        delivered = true
        return undefined
      })
      pending.add(work)
      void work.finally(() => pending.delete(work)).catch(() => undefined)
      return work
    }
    GPUCommandEncoder.prototype.copyBufferToBuffer = copy
    GPUCommandEncoder.prototype.finish = finish
    GPUQueue.prototype.submit = submit
    GPUBuffer.prototype.mapAsync = map
    const state = () => ({ held, delivered, heldCopy, maps, submissions, omitted })
    return {
      state,
      release,
      close: async () => {
        armed = false
        release()
        try {
          await Promise.allSettled([...pending])
        } finally {
          if (GPUCommandEncoder.prototype.copyBufferToBuffer === copy)
            GPUCommandEncoder.prototype.copyBufferToBuffer = original.copy
          if (GPUCommandEncoder.prototype.finish === finish)
            GPUCommandEncoder.prototype.finish = original.finish
          if (GPUQueue.prototype.submit === submit) GPUQueue.prototype.submit = original.submit
          if (GPUBuffer.prototype.mapAsync === map) GPUBuffer.prototype.mapAsync = original.map
        }
        return state()
      },
    }
  }, HDR_HISTOGRAM_WORDS * 4)
}

test(
  'a completed real histogram map binds to the latest same-key normal view without recomputing',
  foregroundTest(
    'Histogram curve serial requires real rendering opportunities after GPU publication.',
  ),
  async ({ irodori }, info) => {
    test.setTimeout(180000)
    const { app, page } = irodori,
      {
        targets: [target],
      } = await setup(app, page)
    const initial = await ready(page, target),
      gate = await holdCompletedHistogramMap(page)
    let beforeRelease: Awaited<ReturnType<typeof observe>> | undefined,
      final: Awaited<ReturnType<typeof observe>> | undefined
    try {
      target.edits = await page.evaluate(
        ({ id, revision }) => window.irodori.updateEdits(id, { exposureEv: 1.5 }, revision),
        { id: target.id, revision: target.edits.revision },
      )
      target.history = await page.evaluate((id) => window.irodori.getEditHistory(id), target.id)
      await expect
        .poll(async () => (await gate.evaluate((control) => control.state())).held)
        .toBe(true)
      const actual = await gate.evaluate((control) => control.state()),
        copy = actual.heldCopy!
      expect(copy).toBeDefined()
      expect(copy.sourceIdentity).toBe(initial.source)
      expect(copy.serial).toBeGreaterThan(initial.completed)
      expect(copy.key).not.toBe(initial.analysisKey)
      expect(actual.maps).toBe(1)
      expect(actual.submissions).toEqual([copy])
      const canvas = page.getByTestId('main-preview')
      await expect(canvas).toHaveAttribute('data-exposure', '1.5')
      await expect(canvas).toHaveAttribute('data-analysis-pending', 'true')
      await page.getByLabel('Preview zoom', { exact: true }).selectOption('0.25')
      await expect
        .poll(() =>
          canvas.evaluate((element, copy) => {
            const view = JSON.parse(element.dataset.presentedView ?? 'null')
            return (
              Number(element.dataset.completedEditSerial) > copy.serial &&
              element.dataset.completedEditSerial === element.dataset.requestedSerial &&
              element.dataset.displayedAnalysisKey === copy.key &&
              element.dataset.quality === 'normal' &&
              view?.fit === false &&
              view?.scale === 0.25
            )
          }, copy),
        )
        .toBe(true)
      beforeRelease = await observe(page)
      expect(beforeRelease.source).toBe(initial.source)
      expect(beforeRelease.analysisSerial).toBe(initial.analysisSerial)
      expect(beforeRelease.histogram.serial).toBe(initial.histogram.serial)
      expect(beforeRelease.histogram.curveSerial).toBe(initial.histogram.curveSerial)
      expect(beforeRelease.analysisPending).toBe('true')
      expect(beforeRelease.displayedAnalysisKey).toBe(copy.key)
      expect(await gate.evaluate((control) => control.state())).toMatchObject({
        held: true,
        delivered: false,
        maps: 1,
        submissions: [copy],
        omitted: 0,
      })
      await gate.evaluate((control) => control.release())
      final = await ready(page, target)
      expect(final.source).toBe(initial.source)
      expect(final.completed).toBe(beforeRelease.completed)
      expect(final.analysisSerial).toBe(final.completed)
      expect(final.analysisKey).toBe(copy.key)
      expect(final.histogram.serial).toBe(String(final.completed))
      expect(final.histogram.curveSerial).toBe(String(final.completed))
      expect(await gate.evaluate((control) => control.state())).toMatchObject({
        held: false,
        delivered: true,
        maps: 1,
        submissions: [copy],
        omitted: 0,
      })
    } finally {
      let drained
      try {
        // Release the real completed map before waiting on its receiver.
        await gate.evaluate((control) => control.release())
        drained = await gate.evaluate((control) => control.close())
      } finally {
        await gate.dispose()
      }
      await writeFile(
        info.outputPath('hdr-histogram-same-key-map.json'),
        JSON.stringify({ initial, beforeRelease, final, drained }, null, 2),
      )
    }
  },
)
