import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import type { ElectronApplication, Page } from '@playwright/test'
import sharp from 'sharp'
import { expect, test } from './electron.fixture'
import { foregroundTest } from './foreground'
import { importPhotos } from './import.helpers'
import { ACES_DATA_BYTES, packAces } from '../src/shared/aces-data'
import { ACES_INTERACTIVE_PREVIEW_VERSION } from '../src/shared/aces-preview-wgsl'
import { HDR_CONTENT_TARGET, prepareDisplayRendering } from '../src/shared/display-rendering'

const fixture = 'tests/fixtures/sony-zv1.ARW'
const originalSha256 = '14c9d2912584a3ccc5cf10f554fbe495fc960c36758a14d7d858b36ac5ca88e2'
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
interface Dispatch {
  phase: string
  precision: 'reference' | 'interactive'
  table: number
}
interface Observation {
  phase: string
  dispatches: Dispatch[]
  tables: number[][]
}
interface Capture {
  pixels: Buffer
  width: number
  height: number
  target: Awaited<ReturnType<Window['luma']['getDisplayState']>>
}

test.use({ hdrDisplay: true })

async function installObserver(page: Page, srgbOnly: boolean) {
  await page.addInitScript(
    ({ tableBytes, srgbOnly }) => {
      const modules = new WeakMap<GPUShaderModule, string>()
      const pipelines = new WeakMap<GPUComputePipeline, 'reference' | 'interactive'>()
      const groups = new WeakMap<GPUBindGroup, GPUBuffer>()
      const passPolicies = new WeakMap<GPUComputePassEncoder, 'reference' | 'interactive'>()
      const uploaded = new WeakMap<GPUBuffer, number>()
      const observation: Observation = { phase: 'initialization', dispatches: [], tables: [] }
      Object.assign(window, { interactivePreviewObservation: observation })
      const shader = GPUDevice.prototype.createShaderModule
      GPUDevice.prototype.createShaderModule = function (descriptor) {
        const result = shader.call(this, descriptor)
        modules.set(result, descriptor.code)
        return result
      }
      const pipeline = GPUDevice.prototype.createComputePipelineAsync
      GPUDevice.prototype.createComputePipelineAsync = async function (descriptor) {
        const result = await pipeline.call(this, descriptor)
        const code = modules.get(descriptor.compute.module)
        if (descriptor.compute.entryPoint === 'renderTile' && code)
          pipelines.set(result, code.includes('fn dsPow(') ? 'reference' : 'interactive')
        return result
      }
      const group = GPUDevice.prototype.createBindGroup
      GPUDevice.prototype.createBindGroup = function (descriptor) {
        const result = group.call(this, descriptor)
        for (const entry of descriptor.entries)
          if (entry.binding === 4 && 'buffer' in entry.resource)
            groups.set(result, entry.resource.buffer)
        return result
      }
      const write = GPUQueue.prototype.writeBuffer
      GPUQueue.prototype.writeBuffer = function (buffer, offset, data, dataOffset, size) {
        if (
          offset === 0 &&
          data.byteLength === tableBytes &&
          dataOffset === undefined &&
          size === undefined
        ) {
          const bytes = ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : new Uint8Array(data)
          uploaded.set(buffer, observation.tables.length)
          observation.tables.push(Array.from(bytes))
        }
        write.call(this, buffer, offset, data, dataOffset, size)
      }
      const setPipeline = GPUComputePassEncoder.prototype.setPipeline
      GPUComputePassEncoder.prototype.setPipeline = function (pipeline) {
        const precision = pipelines.get(pipeline)
        if (precision) passPolicies.set(this, precision)
        else passPolicies.delete(this)
        setPipeline.call(this, pipeline)
      }
      const setGroup = GPUComputePassEncoder.prototype.setBindGroup
      GPUComputePassEncoder.prototype.setBindGroup = function (
        this: GPUComputePassEncoder,
        index: number,
        group: GPUBindGroup | null,
        ...offsets: unknown[]
      ) {
        const precision = passPolicies.get(this)
        const table = group ? groups.get(group) : undefined
        if (index === 0 && precision && table) {
          if (observation.dispatches.length >= 4096)
            throw new Error('Interactive preview test exceeded its bounded observation limit.')
          observation.dispatches.push({
            phase: observation.phase,
            precision,
            table: uploaded.get(table) ?? -1,
          })
        }
        Reflect.apply(setGroup, this, [index, group, ...offsets])
      } as GPUComputePassEncoder['setBindGroup']
      if (srgbOnly) {
        const configure = GPUCanvasContext.prototype.configure
        GPUCanvasContext.prototype.configure = function (configuration) {
          if (configuration.colorSpace === 'display-p3')
            throw new Error('This isolated test exposes only the supported sRGB canvas gamut.')
          configure.call(this, configuration)
        }
      }
    },
    { tableBytes: ACES_DATA_BYTES, srgbOnly },
  )
  await page.reload()
}

async function phase(page: Page, value: string) {
  await page.evaluate((phase) => {
    ;(
      window as unknown as { interactivePreviewObservation: Observation }
    ).interactivePreviewObservation.phase = phase
  }, value)
}

async function settled(page: Page, quality = 'normal', policy = 'reference') {
  const canvas = page.getByTestId('main-preview')
  await expect(canvas).toHaveAttribute('data-quality', quality, { timeout: 30000 })
  await expect(canvas).toHaveAttribute('data-presented-policy', policy)
  await expect
    .poll(() =>
      canvas.evaluate(
        (element) => element.dataset.completedEditSerial === element.dataset.requestedSerial,
      ),
    )
    .toBe(true)
  await page.evaluate(async () => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')!
    await canvas.getContext('webgpu')!.getConfiguration()!.device.queue.onSubmittedWorkDone()
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
  })
}

async function numeric(page: Page, name: string, value: number) {
  const input = page.getByRole('spinbutton', { name: `${name} value`, exact: true })
  await input.fill(String(value))
  await input.press('Enter')
  // Normal pixels from the preceding edit can still be on screen before React
  // delivers this numeric draft and its asynchronous catalog acknowledgement.
  // Complete that transaction, including the numeric input's blur, before any
  // following native pointer gesture samples its history baseline.
  const canvas = page.getByTestId('main-preview')
  await canvas.focus()
  const keys = {
    Exposure: 'exposureEv',
    Contrast: 'contrast',
    Highlights: 'highlights',
    Shadows: 'shadows',
    Whites: 'whites',
    Blacks: 'blacks',
  } as const
  const key = keys[name as keyof typeof keys]
  if (!key) throw new Error(`Unsupported numeric setup control: ${name}`)
  const id = (await page.evaluate(() => window.luma.listPhotos())).photos[0].id
  await expect
    .poll(async () => (await page.evaluate((id) => window.luma.getEdits(id), id)).settings[key])
    .toBe(value)
  await expect(canvas).toHaveAttribute(`data-${name.toLowerCase()}`, String(value))
  await expect(canvas).toHaveAttribute('data-gesturing', 'false')
  await settled(page)
  await expect
    .poll(async () => {
      const state = await page.evaluate((id) => window.luma.getEdits(id), id)
      const history = await page.evaluate((id) => window.luma.getEditHistory(id), id)
      return (
        history.revision === state.revision &&
        history.settings[key] === value &&
        history.snapshots[history.cursor].settings[key] === value
      )
    })
    .toBe(true)
}

async function displayMode(page: Page, mode: 'hdr' | 'sdr') {
  await page.getByRole('combobox', { name: 'Preview display mode' }).selectOption(mode)
  await expect
    .poll(() => page.evaluate(() => window.luma.getDisplayState()))
    .toMatchObject({ mode })
  await settled(page)
}

async function comparison(page: Page, mode: 'before' | 'split' | 'after') {
  const canvas = page.getByTestId('main-preview')
  const current = await canvas.getAttribute('data-comparison')
  if (current === mode) return
  if (current === 'before') await page.getByRole('button', { name: 'Before', exact: true }).click()
  else if (current === 'split')
    await page.getByRole('button', { name: 'Compare before and after', exact: true }).click()
  await expect(canvas).toHaveAttribute('data-comparison', 'after')
  if (mode === 'before') await page.getByRole('button', { name: 'Before', exact: true }).click()
  else if (mode === 'split')
    await page.getByRole('button', { name: 'Compare before and after', exact: true }).click()
  await expect(canvas).toHaveAttribute('data-comparison', mode)
  await settled(page)
}

async function ranges(page: Page, enabled: boolean) {
  const button = page.getByRole('button', { name: 'Show HDR ranges', exact: true })
  if ((await button.getAttribute('aria-pressed')) !== String(enabled)) await button.click()
  await expect(page.getByTestId('main-preview')).toHaveAttribute('data-hdr-ranges', String(enabled))
  await settled(page)
}

async function capture(app: ElectronApplication, page: Page, path: string): Promise<Capture> {
  const rectangle = await page.getByTestId('main-preview').boundingBox()
  if (!rectangle) throw new Error('The actual preview has no native capture bounds.')
  const bytes = await (
    await app.browserWindow(page)
  ).evaluate(async (window, rectangle) => {
    const image = await window.capturePage({
      x: Math.round(rectangle.x),
      y: Math.round(rectangle.y),
      width: Math.round(rectangle.width),
      height: Math.round(rectangle.height),
    })
    return Array.from(image.toPNG()) as number[]
  }, rectangle)
  await writeFile(path, Buffer.from(bytes))
  const decoded = await sharp(Buffer.from(bytes))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return {
    pixels: decoded.data,
    width: decoded.info.width,
    height: decoded.info.height,
    target: await page.evaluate(() => window.luma.getDisplayState()),
  }
}

function imageDifference(reference: Capture, candidate: Capture) {
  expect([candidate.width, candidate.height]).toEqual([reference.width, reference.height])
  let maximum = 0,
    squares = 0,
    changed = 0,
    count = 0
  for (let i = 0; i < reference.pixels.length; i++) {
    if (i % 4 === 3) continue
    const delta = Math.abs(reference.pixels[i] - candidate.pixels[i])
    maximum = Math.max(maximum, delta)
    squares += delta * delta
    changed += Number(delta !== 0)
    count++
  }
  return {
    maximumCodeError: maximum,
    rmsCodeError: Math.sqrt(squares / count),
    changedFraction: changed / count,
  }
}

for (const srgbOnly of [false, true])
  test(
    `interactive precision retains target tables, exact refinement and comparisons with ${srgbOnly ? 'sRGB-only' : 'native'} canvas gamut`,
    foregroundTest(
      'Native foreground pointer capture and composited HDR/SDR preview comparisons require the real desktop.',
    ),
    async ({ luma }, info) => {
      test.setTimeout(180000)
      const { app, page } = luma
      const evidence: unknown[] = []
      const expectedPhases: Array<{
        phase: string
        precision: 'reference' | 'interactive'
        hashes: string[]
      }> = []
      try {
        expect(sha(await readFile(fixture))).toBe(originalSha256)
        await installObserver(page, srgbOnly)
        await (await app.browserWindow(page)).evaluate((window) => window.setContentSize(1100, 700))
        await importPhotos(app, page, [fixture], false)
        const canvas = page.getByTestId('main-preview')
        await expect(canvas).toHaveAttribute('data-backend', 'webgpu-hdr', { timeout: 60000 })
        await expect(canvas).toHaveAttribute(
          'data-interactive-policy',
          ACES_INTERACTIVE_PREVIEW_VERSION,
        )
        await settled(page)
        for (const [label, value] of [
          ['Contrast', 60],
          ['Highlights', -70],
          ['Shadows', 65],
          ['Whites', 35],
          ['Blacks', -40],
          ['Exposure', 1.75],
        ] as const)
          await numeric(page, label, value)
        const id = (await page.evaluate(() => window.luma.listPhotos())).photos[0].id
        const canonical = new Map<string, Capture>()
        for (const [name, mode, showRanges, compare] of [
          ['hdr', 'hdr', false, 'after'],
          ['sdr', 'sdr', false, 'after'],
          ['sdr-ranges', 'sdr', true, 'after'],
          ['before', 'sdr', false, 'before'],
          ['split', 'sdr', false, 'split'],
        ] as const) {
          await displayMode(page, mode)
          await ranges(page, showRanges)
          await comparison(page, compare)
          canonical.set(name, await capture(app, page, info.outputPath(`canonical-${name}.png`)))
        }
        const hdrHash = sha(
          new Uint8Array(packAces(prepareDisplayRendering(HDR_CONTENT_TARGET)).buffer),
        )
        for (const [name, baseline, mode, showRanges, compare] of [
          ['hdr-first', 'hdr', 'hdr', false, 'after'],
          ['sdr', 'sdr', 'sdr', false, 'after'],
          ['sdr-ranges', 'sdr-ranges', 'sdr', true, 'after'],
          ['hdr-return', 'hdr', 'hdr', false, 'after'],
          ['before', 'sdr', 'sdr', false, 'before'],
          ['split', 'split', 'sdr', false, 'split'],
        ] as const) {
          await phase(page, `setup-${name}`)
          await comparison(page, 'after')
          await displayMode(page, mode)
          await ranges(page, showRanges)
          await numeric(page, 'Exposure', 1.5)
          await comparison(page, compare)
          if (compare === 'before') {
            const before = await capture(app, page, info.outputPath('before-mode-reference.png'))
            const difference = imageDifference(canonical.get('before')!, before)
            expect(difference.maximumCodeError).toBeLessThanOrEqual(1)
            expect(difference.rmsCodeError).toBeLessThanOrEqual(0.03)
            evidence.push({
              name: 'before-mode-reference',
              difference,
              policy: await canvas.getAttribute('data-presented-policy'),
            })
          }
          const target = await page.evaluate(() => window.luma.getDisplayState())
          const targetHash =
            mode === 'hdr'
              ? hdrHash
              : sha(new Uint8Array(packAces(prepareDisplayRendering(target)).buffer))
          const hashes = showRanges && mode === 'sdr' ? [targetHash, hdrHash] : [targetHash]
          const history = await page.evaluate((id) => window.luma.getEditHistory(id), id)
          expect(history.settings.exposureEv).toBe(1.5)
          const describeHistory = (value: typeof history) => ({
            revision: value.revision,
            cursor: value.cursor,
            count: value.snapshots.length,
            exposure: value.settings.exposureEv,
            tail: value.snapshots.slice(-3).map((snapshot) => ({
              exposure: snapshot.settings.exposureEv,
              createdAt: snapshot.createdAt,
            })),
          })
          const historyEvidence: {
            before: ReturnType<typeof describeHistory>
            after?: ReturnType<typeof describeHistory>
          } = { before: describeHistory(history) }
          evidence.push({ name, history: historyEvidence })
          const label = page.locator('label').filter({ hasText: /^Exposure$/ })
          const sliderId = await label.getAttribute('for')
          if (!sliderId) throw new Error('Actual Exposure slider has no associated label.')
          const slider = page
            .locator('input[type="range"]')
            .and(page.locator(`[id=${JSON.stringify(sliderId)}]`))
          const box = await slider.boundingBox()
          if (!box) throw new Error('Actual Exposure slider is not visible.')
          await phase(page, `pointer-start-${name}`)
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
          await page.mouse.down()
          // Editing Before intentionally returns the product to After. Split
          // remains a canonical comparison throughout its active gesture.
          const activeComparison = compare === 'before' ? 'after' : compare
          await expect(canvas).toHaveAttribute('data-comparison', activeComparison)
          const precision = activeComparison === 'after' ? 'interactive' : 'reference'
          await settled(
            page,
            activeComparison === 'after' ? 'interactive' : 'normal',
            precision === 'interactive' ? ACES_INTERACTIVE_PREVIEW_VERSION : 'reference',
          )
          await phase(page, `gesture-${name}`)
          await slider.evaluate((element) => {
            const input = element as HTMLInputElement
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
              input,
              '1.75',
            )
            input.dispatchEvent(new Event('input', { bubbles: true }))
          })
          await expect(canvas).toHaveAttribute('data-exposure', '1.75')
          await settled(
            page,
            activeComparison === 'after' ? 'interactive' : 'normal',
            precision === 'interactive' ? ACES_INTERACTIVE_PREVIEW_VERSION : 'reference',
          )
          await expect(canvas).toHaveAttribute('data-gesturing', 'true')
          const active = await capture(app, page, info.outputPath(`active-${name}.png`))
          const renderedBeforeRelease = Number(await canvas.getAttribute('data-rendered-tiles'))
          expectedPhases.push({ phase: `gesture-${name}`, precision, hashes })
          await phase(page, `release-${name}`)
          await page.mouse.up()
          await settled(page)
          await expect(canvas).toHaveAttribute('data-gesturing', 'false')
          await expect(canvas).toHaveAttribute('data-source-uploads', '1')
          await expect
            .poll(async () => {
              const actual = await page.evaluate((id) => window.luma.getEditHistory(id), id)
              historyEvidence.after = describeHistory(actual)
              return actual.snapshots.length
            })
            .toBe(history.snapshots.length + 1)
          const final = await capture(app, page, info.outputPath(`settled-${name}.png`))
          const activeDifference = imageDifference(canonical.get(baseline)!, active)
          const finalDifference = imageDifference(canonical.get(baseline)!, final)
          const referenceTarget = canonical.get(baseline)!.target
          expect({ mode: target.mode, colorSpace: target.colorSpace, peak: target.peak }).toEqual({
            mode: referenceTarget.mode,
            colorSpace: referenceTarget.colorSpace,
            peak: referenceTarget.peak,
          })
          if (precision === 'interactive') {
            expect(Number(await canvas.getAttribute('data-rendered-tiles'))).toBeGreaterThan(
              renderedBeforeRelease,
            )
            expectedPhases.push({ phase: `release-${name}`, precision: 'reference', hashes })
          }
          // This native capture is an SDR compositor proof, separate from the
          // independent rgba16float/CTL quality evidence and physical HDR output.
          expect(activeDifference.maximumCodeError, name).toBeLessThanOrEqual(2)
          expect(activeDifference.rmsCodeError, name).toBeLessThanOrEqual(0.1)
          expect(finalDifference.maximumCodeError, name).toBeLessThanOrEqual(1)
          expect(finalDifference.rmsCodeError, name).toBeLessThanOrEqual(0.03)
          evidence.push({
            name,
            target,
            referenceTarget,
            activeDifference,
            finalDifference,
            renderedBeforeRelease,
            renderedAfterRelease: Number(await canvas.getAttribute('data-rendered-tiles')),
          })
        }
        const observation = await page.evaluate(
          () =>
            (window as unknown as { interactivePreviewObservation: Observation })
              .interactivePreviewObservation,
        )
        const actualTableHashes = observation.tables.map((bytes) => sha(new Uint8Array(bytes)))
        await writeFile(
          info.outputPath('interactive-table-bindings.json'),
          JSON.stringify(
            {
              expectedPhases,
              actualTableHashes,
              dispatches: observation.dispatches,
              observer:
                'Actual compute pipeline and bound table bytes; expected tables independently packed in Node from target contracts.',
            },
            null,
            2,
          ),
        )
        for (const expected of expectedPhases) {
          const actual = observation.dispatches.filter(
            (dispatch) => dispatch.phase === expected.phase,
          )
          expect(
            actual.length,
            `${expected.phase} must execute an observed tile pipeline`,
          ).toBeGreaterThan(0)
          expect(
            actual.every((dispatch) => dispatch.precision === expected.precision),
            expected.phase,
          ).toBe(true)
          expect(
            [...new Set(actual.map((dispatch) => actualTableHashes[dispatch.table]))].sort(),
            expected.phase,
          ).toEqual([...new Set(expected.hashes)].sort())
        }
      } finally {
        await page.mouse.up().catch(() => undefined)
        const observation = await page
          .evaluate(
            () =>
              (window as unknown as { interactivePreviewObservation?: Observation })
                .interactivePreviewObservation,
          )
          .catch(() => undefined)
        if (observation) {
          const actualTableHashes = observation.tables.map((bytes) => sha(new Uint8Array(bytes)))
          await writeFile(
            info.outputPath('interactive-table-bindings.json'),
            JSON.stringify(
              {
                expectedPhases,
                actualTableHashes,
                dispatches: observation.dispatches,
                observer:
                  'Actual compute pipeline and bound table bytes; expected tables independently packed in Node from target contracts.',
              },
              null,
              2,
            ),
          )
          for (let i = 0; i < observation.tables.length; i++)
            await writeFile(
              info.outputPath(`observed-table-${i}.bin`),
              new Uint8Array(observation.tables[i]),
            )
        }
        const after = sha(await readFile(fixture))
        await writeFile(
          info.outputPath('interactive-preview-ui.json'),
          JSON.stringify(
            {
              srgbOnly,
              originalSha256,
              originalHashAfter: after,
              originalUnchanged: after === originalSha256,
              evidence,
              limitations:
                'Native compositor PNGs clamp/convert HDR and do not measure physical display output. Independent Float64 CTL and rgba16float quality proofs are separate targets.',
            },
            null,
            2,
          ),
        )
        expect(after).toBe(originalSha256)
      }
    },
  )
