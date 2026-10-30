import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { expect, test } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { activateButton } from './button.helpers'
import { assertHdrMemory, readHdrMemory } from './hdr-memory-policy.helpers'
import { testUiMode } from '../scripts/test-ui-mode.mjs'

const GiB = 1024 ** 3
test.use({ hdrDisplay: true })

/** Layout and DOM hit testing do not depend on a hidden window's IntersectionObserver delivery. */
async function visibleModalAction(button: Locator) {
  const state = await button.evaluate((element) => {
    const bounds = element.getBoundingClientRect(),
      dialog = element.closest('dialog'),
      styles: { tag: string; visible: boolean; clipping: boolean }[] = []
    for (let owner: Element | null = element; owner; owner = owner.parentElement) {
      const style = getComputedStyle(owner),
        rect = owner.getBoundingClientRect(),
        left = rect.left + owner.clientLeft,
        top = rect.top + owner.clientTop,
        clipX = /^(auto|scroll|hidden|clip)$/.test(style.overflowX),
        clipY = /^(auto|scroll|hidden|clip)$/.test(style.overflowY)
      styles.push({
        tag: owner.tagName,
        visible:
          style.display !== 'none' && style.visibility === 'visible' && Number(style.opacity) > 0,
        clipping:
          (!clipX || (bounds.left >= left && bounds.right <= left + owner.clientWidth)) &&
          (!clipY || (bounds.top >= top && bounds.bottom <= top + owner.clientHeight)),
      })
      // A top-layer dialog escapes clipping by its ordinary DOM ancestors.
      if (owner === dialog) break
    }
    // Sample inside the rounded button shape; its bounding-box corners are transparent.
    const insetX = bounds.width / 4,
      insetY = bounds.height / 4,
      points = [
        [bounds.left + insetX, bounds.top + insetY],
        [bounds.right - insetX, bounds.top + insetY],
        [bounds.left + insetX, bounds.bottom - insetY],
        [bounds.right - insetX, bounds.bottom - insetY],
        [bounds.left + bounds.width / 2, bounds.top + bounds.height / 2],
      ]
    return {
      viewport: [innerWidth, innerHeight],
      rect: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      insideViewport:
        bounds.left >= 0 &&
        bounds.top >= 0 &&
        bounds.right <= innerWidth &&
        bounds.bottom <= innerHeight,
      topLayerModal: !!dialog?.open && dialog.matches(':modal'),
      styles,
      hits: points.map(([x, y]) => {
        const hit = document.elementFromPoint(x, y)
        return !!hit && element.contains(hit)
      }),
    }
  })
  expect(state.viewport).toEqual([1100, 700])
  expect(state.rect.width).toBeGreaterThan(0)
  expect(state.rect.height).toBeGreaterThan(0)
  expect(state.insideViewport, JSON.stringify(state)).toBe(true)
  expect(state.topLayerModal, JSON.stringify(state)).toBe(true)
  expect(
    state.styles.every((owner) => owner.visible && owner.clipping),
    JSON.stringify(state),
  ).toBe(true)
  expect(state.hits.every(Boolean), JSON.stringify(state)).toBe(true)
  return state
}

async function failureState(page: Page, path: string) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const observation = page.evaluate(async () => {
      const read = async (operation: () => Promise<unknown>) => {
        let timeout: ReturnType<typeof setTimeout> | undefined
        try {
          return await Promise.race([
            Promise.resolve()
              .then(operation)
              .then(
                (value) => {
                  const json = JSON.stringify(value)
                  if (json === undefined)
                    return { status: 'unavailable', reason: 'Diagnostic returned no value' }
                  return json.length <= 32768
                    ? { status: 'available', value }
                    : { status: 'truncated', jsonPrefix: json.slice(0, 32768) }
                },
                (error) => ({ status: 'unavailable', error: String(error).slice(0, 1024) }),
              ),
            new Promise((resolve) => {
              timeout = setTimeout(
                () => resolve({ status: 'unavailable', reason: '1500ms diagnostic deadline' }),
                1500,
              )
            }),
          ])
        } finally {
          clearTimeout(timeout)
        }
      }
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]'),
        tasks = read(() => window.irodori.listTasks()),
        diagnostics = read(() => window.irodori.getPreviewDiagnostics()),
        photos = read(async () => {
          const result = await window.irodori.listPhotos()
          return {
            count: result.photos.length,
            photos: result.photos
              .slice(0, 8)
              .map(({ id, filename, width, height }) => ({ id, filename, width, height })),
          }
        })
      return {
        observedAt: new Date().toISOString(),
        document: {
          visibilityState: document.visibilityState,
          hasFocus: document.hasFocus(),
          readyState: document.readyState,
          viewport: [innerWidth, innerHeight],
        },
        canvas: canvas
          ? {
              width: canvas.width,
              height: canvas.height,
              dataset: Object.fromEntries(
                Object.entries(canvas.dataset)
                  .slice(0, 128)
                  .map(([key, value]) => [key, value?.slice(0, 1024)]),
              ),
            }
          : null,
        tasks: await tasks,
        previewDiagnostics: await diagnostics,
        photos: await photos,
      }
    })
    const state = await Promise.race([
      observation,
      new Promise((resolve) => {
        timer = setTimeout(
          () => resolve({ status: 'unavailable', reason: 'Renderer diagnostic exceeded 2000ms' }),
          2000,
        )
      }),
    ])
    await writeFile(path, JSON.stringify(state, null, 2))
  } catch (error) {
    await writeFile(
      path,
      JSON.stringify({ status: 'unavailable', error: String(error).slice(0, 2048) }),
    ).catch(() => undefined)
  } finally {
    clearTimeout(timer)
  }
}

/** Normal keyboard activation keeps this feature test independent of native pointer actionability. */
async function importWithKeyboard(app: ElectronApplication, page: Page) {
  await importPhotos(
    app,
    page,
    ['tests/fixtures/photos/alpine-lake.jpg', 'tests/fixtures/sony-zv1.ARW'],
    false,
    'keyboard',
  )
}

async function minimumWindow(app: ElectronApplication, page: Page) {
  const native = await app.browserWindow(page)
  await native.evaluate((window) => {
    window.unmaximize()
    window.setContentSize(1100, 700)
  })
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([1100, 700])
  return native
}

async function preferences(page: Page) {
  const { settings, revision, status, issue } = await page.evaluate(() =>
    window.irodori.getResourceSettings(),
  )
  return { settings, revision, status, issue }
}

async function openSettings(page: Page) {
  const button = page.getByRole('button', { name: 'Settings', exact: true })
  await activateButton(button)
  const dialog = page.getByRole('dialog', { name: 'Preview memory', exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('combobox', { name: 'RAM budget mode', exact: true })).toBeEnabled()
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  await expect(dialog).toContainText('RAW and HDR preview buffers and caches')
  await expect(dialog).toContainText(
    'Applies when a preview opens. Other processing and application/driver overhead are additional.',
  )
  return dialog
}

async function setCustomBudgets(page: Page, ram: string, gpu: string) {
  const dialog = await openSettings(page)
  await dialog
    .getByRole('combobox', { name: 'RAM budget mode', exact: true })
    .selectOption('custom')
  await dialog.getByRole('textbox', { name: 'RAM budget in GiB', exact: true }).fill(ram)
  await dialog
    .getByRole('combobox', { name: 'GPU memory budget mode', exact: true })
    .selectOption('custom')
  await dialog.getByRole('textbox', { name: 'GPU memory budget in GiB', exact: true }).fill(gpu)
  await expect(dialog.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled()
  await activateButton(dialog.getByRole('button', { name: 'Apply', exact: true }))
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeFocused()
}

async function normalPreview(page: Page) {
  const canvas = page.getByTestId('main-preview')
  await expect(canvas).toHaveAttribute('data-backend', 'webgpu-hdr', { timeout: 90000 })
  await expect(canvas).toHaveAttribute('data-quality', 'normal', { timeout: 90000 })
  await expect(canvas).toHaveAttribute('data-presented-policy', 'reference')
  await expect(canvas).toHaveAttribute('data-presented-arithmetic-policy', 'reference')
  await expect(canvas).toHaveAttribute('data-editing', 'ready')
  await expect
    .poll(
      () =>
        canvas.evaluate(
          (element) =>
            !!element.dataset.presentedSourceIdentity &&
            element.dataset.completedEditSerial === element.dataset.requestedSerial &&
            element.dataset.analysisPending === 'false' &&
            !!element.dataset.analysisKey &&
            element.dataset.analysisKey === element.dataset.displayedAnalysisKey,
        ),
      { timeout: 90000 },
    )
    .toBe(true)
  const memory = await canvas.evaluate(readHdrMemory)
  assertHdrMemory(memory, 'real Sony preview')
  return {
    memory,
    contract: await canvas.evaluate((element) => ({
      sourceIdentity: element.dataset.presentedSourceIdentity,
      sourceUploads: element.dataset.sourceUploads,
      exposure: element.dataset.exposure,
      comparison: element.dataset.comparison,
      policy: element.dataset.resourcePolicy,
    })),
  }
}

test('Preview memory is a real modal in Editor and Library at 1100x700 with Console, explicit Apply and keyboard recovery', async ({
  irodori,
}, info) => {
  const { app, page } = irodori,
    native = await minimumWindow(app, page)
  await activateButton(page.getByTestId('console-toggle'))
  await expect(page.getByTestId('console-panel')).toBeVisible()
  const initial = await preferences(page)
  expect(initial.settings).toEqual({ version: 1, ramMiB: null, vramMiB: null })
  let dialog = await openSettings(page)
  await expect(dialog.getByRole('combobox', { name: 'RAM budget mode', exact: true })).toHaveValue(
    'automatic',
  )
  await expect(
    dialog.getByRole('combobox', { name: 'GPU memory budget mode', exact: true }),
  ).toHaveValue('automatic')
  await expect(dialog.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled()
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab')
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true)
  }
  // Native dialog modality must reject programmatic focus outside its active subtree as well.
  await page
    .locator('nav[aria-label="Workspaces"] button')
    .first()
    .evaluate((button) => (button as HTMLButtonElement).focus())
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true)
  await dialog
    .getByRole('combobox', { name: 'RAM budget mode', exact: true })
    .selectOption('custom')
  const ram = dialog.getByRole('textbox', { name: 'RAM budget in GiB', exact: true })
  for (const partial of ['', '.', '-1']) {
    await ram.fill(partial)
    await expect(ram).toHaveAttribute('aria-invalid', 'true')
    await expect(dialog.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled()
  }
  await ram.fill('1.25')
  await expect(ram).toHaveAttribute('aria-invalid', 'false')
  await dialog
    .getByRole('combobox', { name: 'GPU memory budget mode', exact: true })
    .selectOption('custom')
  const gpu = dialog.getByRole('textbox', { name: 'GPU memory budget in GiB', exact: true })
  for (const invalid of ['0', '1.0001']) {
    await gpu.fill(invalid)
    await expect(gpu).toHaveAttribute('aria-invalid', 'true')
    await expect(dialog.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled()
  }
  await gpu.fill('0.5')
  await expect(dialog.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled()
  expect(await preferences(page)).toEqual(initial)
  const box = await dialog.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(1100)
  expect(box!.y + box!.height).toBeLessThanOrEqual(700)
  // The body owns any necessary scrolling; modal actions remain inside the native viewport.
  const body = dialog.locator('form')
  expect(await body.evaluate((element) => getComputedStyle(element).overflowY)).toBe('auto')
  await body.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  const nativeBounds = await native.evaluate((window) => window.getContentBounds())
  expect({ width: nativeBounds.width, height: nativeBounds.height }).toEqual({
    width: 1100,
    height: 700,
  })
  const actions = [
    await visibleModalAction(dialog.getByRole('button', { name: 'Apply', exact: true })),
    await visibleModalAction(dialog.getByRole('button', { name: 'Cancel', exact: true })),
  ]
  await writeFile(
    info.outputPath('resource-settings-geometry.json'),
    JSON.stringify({ nativeBounds, actions }, null, 2),
  )
  await body.evaluate((element) => {
    element.scrollTop = 0
  })
  // Visual capture is an artifact only, requested through an explicit foreground invocation.
  if (testUiMode() === 'foreground') {
    const png = await native.evaluate(async (window) =>
        (await window.capturePage()).toPNG().toString('base64'),
      ),
      capture = info.outputPath('resource-settings-1100-console.png')
    await writeFile(capture, Buffer.from(png, 'base64'))
    await info.attach('Preview memory with Console at 1100x700', {
      path: capture,
      contentType: 'image/png',
    })
  }
  await activateButton(dialog.getByRole('button', { name: 'Cancel', exact: true }))
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeFocused()
  expect(await preferences(page)).toEqual(initial)
  dialog = await openSettings(page)
  await expect(dialog.getByRole('combobox', { name: 'RAM budget mode', exact: true })).toHaveValue(
    'automatic',
  )
  await dialog
    .getByRole('combobox', { name: 'RAM budget mode', exact: true })
    .selectOption('custom')
  await dialog.getByRole('textbox', { name: 'RAM budget in GiB', exact: true }).fill('2')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeFocused()
  expect(await preferences(page)).toEqual(initial)
  await activateButton(page.getByRole('button', { name: 'Library', exact: true }))
  await expect(page.getByTestId('all-photos')).toBeVisible()
  await expect(page.getByTestId('console-panel')).toBeVisible()
  dialog = await openSettings(page)
  await dialog
    .getByRole('combobox', { name: 'RAM budget mode', exact: true })
    .selectOption('custom')
  await dialog.getByRole('textbox', { name: 'RAM budget in GiB', exact: true }).fill('.5')
  await activateButton(dialog.getByRole('button', { name: 'Apply', exact: true }))
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeFocused()
  expect(await preferences(page)).toMatchObject({
    settings: { version: 1, ramMiB: 512, vramMiB: null },
    revision: initial.revision + 1,
  })
  dialog = await openSettings(page)
  await expect(dialog.getByRole('textbox', { name: 'RAM budget in GiB', exact: true })).toHaveValue(
    '0.5',
  )
  await dialog
    .getByRole('combobox', { name: 'RAM budget mode', exact: true })
    .selectOption('automatic')
  await activateButton(dialog.getByRole('button', { name: 'Apply', exact: true }))
  await expect(dialog).toHaveCount(0)
  expect(await preferences(page)).toMatchObject({
    settings: initial.settings,
    revision: initial.revision + 2,
  })
})

test('real Sony preview keeps active limits and edits while saved budgets apply to the next photo and survive restart', async ({
  irodori,
}, info) => {
  test.setTimeout(180000)
  let { page } = irodori
  try {
    await minimumWindow(irodori.app, page)
    await setCustomBudgets(page, '2', '2')
    const initialPreferences = await preferences(page)
    expect(initialPreferences.settings).toEqual({ version: 1, ramMiB: 2048, vramMiB: 2048 })
    await importWithKeyboard(irodori.app, page)
    await page.getByLabel('Preview display mode').selectOption('sdr')
    await activateButton(page.getByRole('button', { name: 'Select sony-zv1.ARW', exact: true }))
    await normalPreview(page)
    const photos = (await page.evaluate(() => window.irodori.listPhotos())).photos,
      raw = photos.find((photo) => photo.filename === 'sony-zv1.ARW')!
    expect(raw).toBeDefined()
    const exposure = page.getByRole('spinbutton', { name: 'Exposure value', exact: true })
    await exposure.fill('1.25')
    await exposure.press('Enter')
    await page.getByTestId('main-preview').focus()
    await expect(page.getByTestId('main-preview')).toHaveAttribute('data-exposure', '1.25')
    await expect
      .poll(() => page.evaluate((id) => window.irodori.getEditHistory(id), raw.id))
      .toMatchObject({ revision: 1, settings: { exposureEv: 1.25 }, cursor: 1 })
    const before = await normalPreview(page),
      edits = await page.evaluate((id) => window.irodori.getEdits(id), raw.id),
      history = await page.evaluate((id) => window.irodori.getEditHistory(id), raw.id)
    expect(before.memory.ramBudgetBytes).toBe(2 * GiB)
    expect(before.memory.vramBudgetBytes).toBe(2 * GiB)
    expect(before.contract.sourceIdentity).toBeTruthy()
    expect(Number(before.contract.sourceUploads)).toBeGreaterThan(0)
    await setCustomBudgets(page, '4', '3')
    const saved = await page.evaluate(() => window.irodori.getResourceSettings())
    expect(saved.settings).toEqual({ version: 1, ramMiB: 4096, vramMiB: 3072 })
    expect(saved.revision).toBe(initialPreferences.revision + 1)
    expect(saved.policy.revision).toBeGreaterThan(before.memory.resourcePolicyRevision)
    const active = await normalPreview(page)
    expect(active.memory.ramBudgetBytes).toBe(before.memory.ramBudgetBytes)
    expect(active.memory.vramBudgetBytes).toBe(before.memory.vramBudgetBytes)
    expect(active.memory.resourcePolicyRevision).toBe(before.memory.resourcePolicyRevision)
    expect(active.contract).toEqual(before.contract)
    expect(await page.evaluate((id) => window.irodori.getEdits(id), raw.id)).toEqual(edits)
    expect(await page.evaluate((id) => window.irodori.getEditHistory(id), raw.id)).toEqual(history)
    await activateButton(page.getByRole('button', { name: 'Select alpine-lake.jpg', exact: true }))
    await expect(page.getByTestId('main-preview')).toHaveAttribute('aria-label', 'alpine-lake.jpg')
    await expect(page.getByTestId('preview-viewport')).toHaveAttribute('data-resolution', 'full')
    await expect(page.getByTestId('main-preview')).toBeVisible()
    const raster = photos.find((photo) => photo.filename === 'alpine-lake.jpg')!
    expect(raster).toBeDefined()
    const rasterEdits = await page.evaluate((id) => window.irodori.getEdits(id), raster.id),
      rasterReceipt = () =>
        page.getByTestId('main-preview').evaluate((element) => {
          const canvas = element as HTMLCanvasElement,
            viewport = document.querySelector('[data-testid="preview-viewport"]')!,
            rect = viewport.getBoundingClientRect(),
            dpr = window.devicePixelRatio || 1,
            expectedWidth = Math.max(1, Math.round(rect.width * dpr)),
            expectedHeight = Math.max(1, Math.round(rect.height * dpr))
          return {
            viewport: { width: rect.width, height: rect.height },
            dpr,
            backing: { width: canvas.width, height: canvas.height },
            expectedBacking: { width: expectedWidth, height: expectedHeight },
            geometryMatches:
              rect.width > 0 &&
              rect.height > 0 &&
              canvas.width === expectedWidth &&
              canvas.height === expectedHeight,
            backend: canvas.dataset.backend,
            editing: canvas.dataset.editing,
            source: canvas.dataset.src,
            // The legacy presenter writes these only after issuing the actual draw.
            draw: {
              exposure: canvas.dataset.exposure,
              contrast: canvas.dataset.contrast,
              highlights: canvas.dataset.highlights,
              shadows: canvas.dataset.shadows,
              whites: canvas.dataset.whites,
              blacks: canvas.dataset.blacks,
              whiteBalance: canvas.dataset.whiteBalance,
              comparison: canvas.dataset.comparison,
            },
          }
        })
    await expect.poll(rasterReceipt).toMatchObject({
      geometryMatches: true,
      backend: expect.stringMatching(/^(webgl2|canvas2d)$/),
      editing: 'ready',
      draw: {
        exposure: String(rasterEdits.settings.exposureEv),
        contrast: String(rasterEdits.settings.contrast),
        highlights: String(rasterEdits.settings.highlights),
        shadows: String(rasterEdits.settings.shadows),
        whites: String(rasterEdits.settings.whites),
        blacks: String(rasterEdits.settings.blacks),
        whiteBalance: JSON.stringify(rasterEdits.settings.whiteBalance),
        comparison: 'after',
      },
    })
    const rasterDraw = await rasterReceipt()
    await activateButton(page.getByRole('button', { name: 'Select sony-zv1.ARW', exact: true }))
    const next = await normalPreview(page)
    expect(next.memory.ramBudgetBytes).toBe(saved.policy.ram.effectiveBytes)
    expect(next.memory.vramBudgetBytes).toBe(saved.policy.vram.effectiveBytes)
    expect(next.memory.ramBudgetBytes).toBe(4 * GiB)
    expect(next.memory.vramBudgetBytes).toBe(3 * GiB)
    expect(next.memory.resourcePolicyRevision).toBeGreaterThan(before.memory.resourcePolicyRevision)
    expect(next.contract.sourceIdentity).toBe(before.contract.sourceIdentity)
    expect(next.contract.exposure).toBe('1.25')
    expect(await page.evaluate((id) => window.irodori.getEditHistory(id), raw.id)).toEqual(history)
    ;({ page } = await irodori.restart())
    await activateButton(page.getByRole('button', { name: 'Select sony-zv1.ARW', exact: true }))
    const restarted = await normalPreview(page),
      persisted = await preferences(page)
    expect(persisted.settings).toEqual(saved.settings)
    expect(persisted.status).toBe('loaded')
    expect(persisted.revision).toBe(0)
    expect(restarted.memory.ramBudgetBytes).toBe(4 * GiB)
    expect(restarted.memory.vramBudgetBytes).toBe(3 * GiB)
    expect(restarted.contract.sourceIdentity).toBe(before.contract.sourceIdentity)
    expect(await page.evaluate((id) => window.irodori.getEdits(id), raw.id)).toEqual(edits)
    expect(await page.evaluate((id) => window.irodori.getEditHistory(id), raw.id)).toEqual(history)
    const dialog = await openSettings(page)
    await expect(
      dialog.getByRole('textbox', { name: 'RAM budget in GiB', exact: true }),
    ).toHaveValue('4')
    await expect(
      dialog.getByRole('textbox', { name: 'GPU memory budget in GiB', exact: true }),
    ).toHaveValue('3')
    await page.keyboard.press('Escape')
    await writeFile(
      info.outputPath('resource-settings-preview.json'),
      JSON.stringify(
        {
          initialPreferences,
          savedPreferences: { settings: saved.settings, revision: saved.revision },
          before,
          active,
          rasterDraw,
          next,
          restarted,
          persisted,
          photoId: raw.id,
          editRevision: edits.revision,
          historyCursor: history.cursor,
          historyCount: history.snapshots.length,
        },
        null,
        2,
      ),
    )
  } catch (error) {
    const path = info.outputPath('resource-settings-failure-state.json')
    await failureState(page, path)
    await info
      .attach('Resource settings failure state', { path, contentType: 'application/json' })
      .catch(() => undefined)
    throw error
  }
})
