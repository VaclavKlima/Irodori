import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Page, TestInfo } from '@playwright/test'
import { expect, test } from './electron.fixture'
import { foregroundTest } from './foreground'
import { importPhotos } from './import.helpers'
import { maximizeEditorOnMonitor } from './editor-native-window.helpers'
import { focusPreviewWindow } from './preview-pan.helpers'
import {
  installRawHalfRecoveryProbe,
  armPendingRecoveryDeparture,
  recoveryProbeAction,
  recoveryProbeState,
  compareRawHalfRecovery,
  type RawHalfRecoverySnapshot,
} from './raw-half-recovery.helpers'

const fixture = 'tests/fixtures/sony-zv1.ARW',
  raster = 'tests/fixtures/photos/alpine-lake.jpg',
  originalSha256 = '14c9d2912584a3ccc5cf10f554fbe495fc960c36758a14d7d858b36ac5ca88e2',
  policy = 'float16-cpu-snapshot-v1',
  parameters = {
    exposureEv: 1.25,
    contrast: 45,
    highlights: -55,
    shadows: 40,
    whites: 20,
    blacks: -25,
    whiteBalance: { mode: 'custom' as const, kelvin: 4500, tint: 12 },
  },
  foreground = foregroundTest(
    'Actual maximized P3/HDR canvas presentation, same-buffer recovery pixels and device loss require the native foreground desktop.',
  )
test.use({ hdrDisplay: true })

const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
async function expectedEdits(page: Page) {
  const canvas = page.getByTestId('main-preview')
  for (const [field, value] of Object.entries(parameters)) {
    if (field === 'whiteBalance') continue
    await expect(canvas).toHaveAttribute(
      `data-${field === 'exposureEv' ? 'exposure' : field}`,
      String(value),
    )
  }
  await expect
    .poll(async () => JSON.parse((await canvas.getAttribute('data-white-balance')) ?? 'null'))
    .toEqual(parameters.whiteBalance)
}
async function normal(page: Page, expected?: { afterSerial: number; fit: boolean }) {
  const canvas = page.getByTestId('main-preview')
  await expect(canvas).toHaveAttribute('data-backend', 'webgpu-hdr', { timeout: 120_000 })
  await expect(canvas).toHaveAttribute('data-editing', 'ready', { timeout: 120_000 })
  await expect(canvas).toHaveAttribute('data-quality', 'normal', { timeout: 120_000 })
  await expect(canvas).toHaveAttribute('data-presented-policy', 'reference')
  await expect(canvas).toHaveAttribute('data-retention-method', 'raw-half-cpu')
  await expectedEdits(page)
  await expect
    .poll(
      () =>
        canvas.evaluate((element, expected) => {
          const snapshot = element.dataset.recoverySnapshot
              ? JSON.parse(element.dataset.recoverySnapshot)
              : null,
            view = element.dataset.presentedView ? JSON.parse(element.dataset.presentedView) : null
          return (
            !!snapshot &&
            String(snapshot.serial) === element.dataset.completedEditSerial &&
            element.dataset.completedEditSerial === element.dataset.requestedSerial &&
            (!expected || (snapshot.serial > expected.afterSerial && view?.fit === expected.fit))
          )
        }, expected),
      { timeout: 120_000 },
    )
    .toBe(true)
  return canvas.evaluate((element) => ({
    snapshot: JSON.parse(element.dataset.recoverySnapshot!) as RawHalfRecoverySnapshot,
    completedSerial: element.dataset.completedEditSerial,
    presentationSerial: element.dataset.presentationSerial,
    sourceIdentity: element.dataset.presentedSourceIdentity,
    view: element.dataset.presentedView ? JSON.parse(element.dataset.presentedView) : null,
    width: (element as HTMLCanvasElement).width,
    height: (element as HTMLCanvasElement).height,
  }))
}

async function prepare(app: ElectronApplication, page: Page, withRaster = false) {
  expect(hash(await readFile(fixture))).toBe(originalSha256)
  await installRawHalfRecoveryProbe(page)
  const workspaces = page.getByRole('navigation', { name: 'Workspaces' })
  await workspaces.getByRole('button', { name: 'Library', exact: true }).click()
  await page.evaluate(() => window.irodori.setPreviewPreference('sdr'))
  await importPhotos(app, page, withRaster ? [raster, fixture] : [fixture], false)
  const raw = (await page.evaluate(() => window.irodori.listPhotos())).photos.find(
    (photo) => photo.filename === 'sony-zv1.ARW',
  )!
  const state = await page.evaluate((id) => window.irodori.getEdits(id), raw.id)
  await page.evaluate(
    ({ id, parameters, revision }) => window.irodori.updateEdits(id, parameters, revision),
    { id: raw.id, parameters, revision: state.revision },
  )
  await workspaces.getByRole('button', { name: 'Editor', exact: true }).click()
  await page.getByRole('button', { name: 'Select sony-zv1.ARW', exact: true }).click()
  await normal(page)
  let native: unknown
  if (process.platform === 'linux') {
    await focusPreviewWindow(app, page)
    native = await maximizeEditorOnMonitor(app, page)
  } else {
    const window = await app.browserWindow(page)
    await window.evaluate((window) => window.maximize())
    native = await window.evaluate((window) => ({
      maximized: window.isMaximized(),
      bounds: window.getBounds(),
      contentBounds: window.getContentBounds(),
    }))
  }
  await normal(page)
  expect(
    await page
      .getByTestId('main-preview')
      .evaluate((element) =>
        Math.max((element as HTMLCanvasElement).width, (element as HTMLCanvasElement).height),
      ),
  ).toBeGreaterThan(1024)
  return {
    raw,
    native,
    history: await page.evaluate((id) => window.irodori.getEditHistory(id), raw.id),
    edits: await page.evaluate((id) => window.irodori.getEdits(id), raw.id),
  }
}

async function save(
  page: Page,
  info: TestInfo,
  userDataDir: string,
  photoId: string | undefined,
  detail: unknown[],
) {
  const state = await recoveryProbeState(page).catch(() => null)
  await writeFile(
    info.outputPath('raw-half-recovery-evidence.json'),
    JSON.stringify(
      {
        policy,
        proposedEmergencyMaximumRgbCodeDifference: 1,
        alphaExact: true,
        oldStrictZeroControl:
          'Retained as separate failed evidence; no claim that this test passes the old zero-byte bound.',
        normalEditingAndExportBounds: 'Unchanged.',
        scope: 'Isolated normal application, real decoded Sony source; no timing acceptance.',
        profileIsolation: userDataDir,
        display: await page.evaluate(() => window.irodori.getDisplayState()).catch(() => null),
        photoId,
        detail,
        state,
        history: photoId
          ? await page
              .evaluate((id) => window.irodori.getEditHistory(id), photoId)
              .catch(() => null)
          : null,
        diagnostics: await page
          .evaluate(() => window.irodori.getPreviewDiagnostics())
          .catch(() => null),
      },
      null,
      2,
    ),
  )
}

async function nativePixels(app: ElectronApplication, page: Page) {
  const bounds = await page.getByTestId('main-preview').boundingBox()
  if (!bounds) throw new Error('The current photo has no native canvas bounds.')
  return (await app.browserWindow(page)).evaluate(
    async (window, bounds) =>
      Array.from(
        (
          await window.capturePage({
            x: Math.round(bounds.x),
            y: Math.round(bounds.y),
            width: Math.round(bounds.width),
            height: Math.round(bounds.height),
          })
        )
          .resize({ width: 96, height: 64 })
          .toBitmap() as Uint8Array,
      ),
    bounds,
  )
}

async function retainedState(page: Page) {
  return page.getByTestId('retained-preview').evaluate(async (element) => {
    const canvas = element as HTMLCanvasElement,
      pixels =
        canvas.width && canvas.height
          ? canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
          : new Uint8ClampedArray(),
      sha256 = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', pixels.buffer as ArrayBuffer)),
        (value) => value.toString(16).padStart(2, '0'),
      ).join('')
    return {
      width: canvas.width,
      height: canvas.height,
      sha256,
      serial: canvas.dataset.presentationSerial,
      recoverySnapshot: canvas.dataset.recoverySnapshot ?? null,
      recoveryPolicy: canvas.dataset.recoveryPolicy ?? null,
      materialized: canvas.dataset.recoveryMaterialized ?? null,
      visibility: getComputedStyle(canvas).visibility,
    }
  })
}

for (const mode of ['sdr', 'hdr'] as const)
  test(
    `${mode.toUpperCase()} P3 real-photo raw-half recovery uses proposed one-code emergency policy after actual device loss`,
    foreground,
    async ({ irodori }, info) => {
      test.setTimeout(300_000)
      const { app, page, userDataDir } = irodori,
        detail: unknown[] = []
      let id: string | undefined
      try {
        const prepared = await prepare(app, page)
        id = prepared.raw.id
        detail.push({ prepared })
        expect(
          hash(await readFile(join(userDataDir, 'library', 'originals', id, 'original.arw'))),
        ).toBe(originalSha256)
        await page.getByRole('combobox', { name: 'Preview display mode' }).selectOption(mode)
        await expect
          .poll(() => page.evaluate(() => window.irodori.getDisplayState()))
          .toMatchObject({ mode, colorSpace: 'display-p3' })
        const target = await page.evaluate(() => window.irodori.getDisplayState())
        if (mode === 'hdr') expect(target.headroom).toBeGreaterThan(1)
        const beforeZoom = await normal(page)
        await recoveryProbeAction(page, 'armOracle')
        await page.getByLabel('Preview zoom', { exact: true }).selectOption('1')
        const completed = await normal(page, {
          afterSerial: beforeZoom.snapshot.serial,
          fit: false,
        })
        await expect.poll(async () => (await recoveryProbeState(page)).oracleCaptures).toBe(1)
        expect(completed.snapshot).toMatchObject({
          serial: Number(completed.completedSerial),
          sourceIdentity: completed.sourceIdentity,
          settingsRevision: prepared.edits.revision,
          quality: 'normal',
          arithmeticPolicy: 'reference',
          width: completed.width,
          height: completed.height,
          target: {
            mode,
            colorSpace: 'display-p3',
            generation: target.generation,
            peak: target.peak,
            headroom: target.headroom,
          },
        })
        const beforeLoss = await recoveryProbeState(page)
        detail.push({ target, completed, beforeLoss })
        await page.getByTestId('main-preview').evaluate((element) => {
          const config = (element as HTMLCanvasElement).getContext('webgpu')!.getConfiguration()
          if (!config) throw new Error('The completed native GPU device is unavailable.')
          config.device.destroy()
        })
        await expect(page.getByTestId('retained-preview')).toBeVisible({ timeout: 30_000 })
        await expect(page.getByTestId('retained-preview')).toHaveAttribute(
          'data-recovery-policy',
          policy,
        )
        await expect(page.getByTestId('retained-preview')).toHaveAttribute(
          'data-recovery-materialized',
          'true',
        )
        expect((await recoveryProbeState(page)).recoveryMaterializations).toBeGreaterThan(
          beforeLoss.recoveryMaterializations,
        )
        const proof = await compareRawHalfRecovery(page),
          { referencePng, retainedPng, ...metrics } = proof
        detail.push({ metrics })
        await writeFile(
          info.outputPath(`${mode}-direct-cpu-oracle.png`),
          Buffer.from(referencePng.split(',')[1], 'base64'),
        )
        await writeFile(
          info.outputPath(`${mode}-raw-half-recovery.png`),
          Buffer.from(retainedPng.split(',')[1], 'base64'),
        )
        await save(page, info, userDataDir, id, detail)
        expect(proof.reference).toMatchObject({
          source: completed.sourceIdentity,
          requestedSerial: completed.completedSerial,
          submitted: true,
          readColorSpace: 'srgb',
          context: { colorSpace: 'srgb', willReadFrequently: true },
          configuration: {
            format: 'rgba16float',
            colorSpace: 'display-p3',
            alphaMode: 'opaque',
            toneMapping: { mode: mode === 'hdr' ? 'extended' : 'standard' },
          },
        })
        expect(proof.retained).toMatchObject({
          recoveryPolicy: policy,
          recoverySnapshot: completed.snapshot,
          presentationSerial: completed.presentationSerial,
        })
        expect(proof.retained.bounds).toEqual(proof.reference.bounds)
        expect(Math.max(proof.width, proof.height)).toBe(1024)
        expect(proof.maximumRgbDifference).toBeLessThanOrEqual(1)
        expect(proof.maximumAlphaDifference).toBe(0)
        expect(proof.proposedOneCode).toBe(true)
        // Strict-zero remains a reported comparison, rather than a silently replaced assertion.
        await expect(page.getByTestId('main-preview')).toHaveAttribute(
          'data-backend',
          'canvas2d-hdr-sdr',
          { timeout: 30_000 },
        )
        await expect(page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready', {
          timeout: 180_000,
        })
        await expect(page.getByTestId('main-preview')).toHaveAttribute('data-quality', 'normal', {
          timeout: 180_000,
        })
        await expect(page.getByTestId('main-preview')).toHaveAttribute(
          'data-exposure',
          String(parameters.exposureEv),
        )
        await expectedEdits(page)
        expect(await page.evaluate((id) => window.irodori.getEditHistory(id), id)).toEqual(
          prepared.history,
        )
        expect((await recoveryProbeState(page)).errors).toEqual([])
      } finally {
        await save(page, info, userDataDir, id, detail)
        await recoveryProbeAction(page, 'close').catch(() => undefined)
      }
    },
  )

test(
  'photo departure skips discarded recovery materialization while same-photo suspension preserves it',
  foreground,
  async ({ irodori }, info) => {
    test.setTimeout(300_000)
    const { app, page, userDataDir } = irodori,
      detail: unknown[] = []
    let id: string | undefined
    try {
      const prepared = await prepare(app, page, true)
      id = prepared.raw.id
      const completed = await normal(page),
        beforeDeparture = await recoveryProbeState(page),
        oldOwners = await page.getByTestId('main-preview').evaluateHandle((canvas) => ({
          canvas,
          recovery: document.querySelector('[data-testid="retained-preview"]'),
        }))
      try {
        await page.getByRole('button', { name: 'Select alpine-lake.jpg', exact: true }).click()
        const canvas = page.getByTestId('main-preview')
        await expect(canvas).toHaveAttribute('aria-label', 'alpine-lake.jpg')
        await expect(canvas).toHaveAttribute('data-editing', 'ready', { timeout: 120_000 })
        await page.evaluate(async () => {
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          )
          await new Promise<void>((resolve) => setTimeout(resolve, 0))
        })
        expect(
          await oldOwners.evaluate(({ canvas, recovery }) => ({
            canvasConnected: canvas.isConnected,
            recoveryConnected: recovery?.isConnected,
          })),
        ).toEqual({ canvasConnected: false, recoveryConnected: false })
        const departed = await recoveryProbeState(page)
        expect(departed.recoveryMaterializations).toBe(beforeDeparture.recoveryMaterializations)
        detail.push({ completed, beforeDeparture, departed })
      } finally {
        await oldOwners.dispose()
      }
      await page.getByRole('button', { name: 'Select sony-zv1.ARW', exact: true }).click()
      const returned = await normal(page),
        beforeSuspension = await recoveryProbeState(page),
        recovery = await page.getByTestId('retained-preview').elementHandle()
      if (!recovery) throw new Error('The same-photo recovery owner is unavailable.')
      try {
        await page
          .getByRole('navigation', { name: 'Workspaces' })
          .getByRole('button', { name: 'Library', exact: true })
          .click()
        await expect
          .poll(async () => (await recoveryProbeState(page)).recoveryMaterializations)
          .toBeGreaterThan(beforeSuspension.recoveryMaterializations)
        expect(await recovery.evaluate((canvas) => canvas.isConnected)).toBe(true)
        expect(await recovery.getAttribute('data-recovery-materialized')).toBe('true')
        expect(
          JSON.parse((await recovery.getAttribute('data-recovery-snapshot')) ?? 'null'),
        ).toEqual(returned.snapshot)
        detail.push({ returned, beforeSuspension, suspended: await recoveryProbeState(page) })
      } finally {
        await recovery.dispose()
      }
      await page
        .getByRole('navigation', { name: 'Workspaces' })
        .getByRole('button', { name: 'Editor', exact: true })
        .click()
      await normal(page)
      expect(await page.evaluate((id) => window.irodori.getEditHistory(id), id)).toEqual(
        prepared.history,
      )
      expect((await recoveryProbeState(page)).errors).toEqual([])
    } finally {
      await save(page, info, userDataDir, id, detail)
      await recoveryProbeAction(page, 'close').catch(() => undefined)
    }
  },
)

test(
  'held raw-half readback reversal and photo switch cannot publish stale recovery pixels',
  foreground,
  async ({ irodori }, info) => {
    test.setTimeout(300_000)
    const { app, page, userDataDir } = irodori,
      detail: unknown[] = []
    let id: string | undefined
    try {
      const prepared = await prepare(app, page, true)
      id = prepared.raw.id
      await recoveryProbeAction(page, 'armReadback')
      await page.getByLabel('Preview zoom', { exact: true }).selectOption('1')
      await expect.poll(async () => (await recoveryProbeState(page)).mapped).toBe(true)
      const reversalHeld = await recoveryProbeState(page)
      await page.getByLabel('Preview zoom', { exact: true }).selectOption('fit')
      await recoveryProbeAction(page, 'release')
      const reversed = await normal(page, { afterSerial: reversalHeld.heldSerial!, fit: true })
      expect(reversed.view.fit).toBe(true)
      expect(reversed.snapshot.serial).toBeGreaterThan(reversalHeld.heldSerial!)
      expect(reversed.snapshot.sourceIdentity).toContain(`/library/${id}/`)
      detail.push({ reversalHeld, reversed })
      await recoveryProbeAction(page, 'armReadback')
      await page.getByLabel('Preview zoom', { exact: true }).selectOption('1')
      await expect.poll(async () => (await recoveryProbeState(page)).mapped).toBe(true)
      const switchHeld = await recoveryProbeState(page)
      await page.getByRole('button', { name: 'Select alpine-lake.jpg', exact: true }).click()
      const canvas = page.getByTestId('main-preview')
      await expect(canvas).toHaveAttribute('aria-label', 'alpine-lake.jpg')
      await expect(canvas).toHaveAttribute('data-editing', 'ready', { timeout: 120_000 })
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      )
      const beforeRelease = await nativePixels(app, page),
        retainedBeforeRelease = await retainedState(page)
      await recoveryProbeAction(page, 'release')
      await expect.poll(async () => (await recoveryProbeState(page)).held).toBe(false)
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      )
      await expect(canvas).toHaveAttribute('aria-label', 'alpine-lake.jpg')
      await expect(page.getByTestId('retained-preview')).not.toBeVisible()
      const afterRelease = await nativePixels(app, page)
      expect(await retainedState(page)).toEqual(retainedBeforeRelease)
      let nativeMaximumDifference = 0
      expect(afterRelease).toHaveLength(beforeRelease.length)
      for (let i = 0; i < afterRelease.length; i++)
        if (i % 4 !== 3)
          nativeMaximumDifference = Math.max(
            nativeMaximumDifference,
            Math.abs(afterRelease[i] - beforeRelease[i]),
          )
      detail.push({
        switchHeld,
        retainedBeforeRelease,
        afterReleaseState: await recoveryProbeState(page),
        nativeMaximumDifference,
      })
      await save(page, info, userDataDir, id, detail)
      expect(nativeMaximumDifference).toBeLessThanOrEqual(1)
      expect(await page.evaluate((id) => window.irodori.getEditHistory(id), id)).toEqual(
        prepared.history,
      )
      await page.getByRole('button', { name: 'Select sony-zv1.ARW', exact: true }).click()
      const returned = await normal(page)
      expect(returned.snapshot.sourceIdentity).toContain(`/library/${id}/`)
      expect((await recoveryProbeState(page)).errors).toEqual([])
      detail.push({ returned })
    } finally {
      await recoveryProbeAction(page, 'release').catch(() => undefined)
      await save(page, info, userDataDir, id, detail)
      await recoveryProbeAction(page, 'close').catch(() => undefined)
    }
  },
)

test(
  'photo departure cancels only the real pending recovery map and drains its submitted fence before the next HDR owner',
  foreground,
  async ({ irodori }, info) => {
    test.setTimeout(300_000)
    const { app, page, userDataDir } = irodori,
      detail: unknown[] = []
    let id: string | undefined
    try {
      const prepared = await prepare(app, page, true)
      id = prepared.raw.id
      const before = await normal(page),
        beforeProbe = await recoveryProbeState(page)
      await armPendingRecoveryDeparture(page, 'alpine-lake.jpg')
      await page.getByLabel('Preview zoom', { exact: true }).selectOption('1')
      const canvas = page.getByTestId('main-preview')
      await expect(canvas).toHaveAttribute('aria-label', 'alpine-lake.jpg', { timeout: 120_000 })
      await expect(canvas).toHaveAttribute('data-editing', 'ready', { timeout: 120_000 })
      await expect
        .poll(async () => (await recoveryProbeState(page)).pendingDeparture?.destroyedAt)
        .toBeGreaterThan(0)
      const departed = await recoveryProbeState(page),
        pending = departed.pendingDeparture
      detail.push({ before, beforeProbe, departed })
      if (
        !pending ||
        pending.pendingAt === undefined ||
        pending.switchRequestedAt === undefined ||
        pending.mapRejectedAt === undefined ||
        pending.fenceResolvedAt === undefined ||
        pending.destroyedAt === undefined
      )
        throw new Error(
          'The actual pending map, rejection, submitted fence and buffer drain were not all observed.',
        )
      expect(pending.source).toBe(before.sourceIdentity)
      expect(pending.serial).toBeGreaterThan(before.snapshot.serial)
      expect(pending.requestId).toBeTruthy()
      expect(pending.fenceLinked).toBe(true)
      expect(pending.mapStateAtEntry).toBe('pending')
      expect(pending.pendingAt).toBeGreaterThanOrEqual(pending.submittedAt)
      expect(pending.switchRequestedAt).toBeGreaterThanOrEqual(pending.pendingAt)
      expect(pending.mapErrorName).toBe('AbortError')
      expect(pending.mapFulfilledAt).toBeUndefined()
      expect(pending.fenceRejectedAt).toBeUndefined()
      expect(pending.unmaps).toHaveLength(1)
      expect(pending.unmaps[0]).toMatchObject({ before: 'pending', after: 'unmapped' })
      expect(pending.unmaps[0].at).toBeGreaterThanOrEqual(pending.switchRequestedAt)
      expect(pending.mapRejectedAt).toBeGreaterThanOrEqual(pending.unmaps[0].at)
      expect(pending.destroyedAt).toBeGreaterThanOrEqual(pending.mapRejectedAt)
      expect(pending.destroyedAt).toBeGreaterThanOrEqual(pending.fenceResolvedAt)
      expect(pending.stalePublication).toBe(false)
      expect(departed.departedCanvasConnected).toBe(false)
      expect(departed.recoveryMaterializations).toBe(beforeProbe.recoveryMaterializations)
      expect(departed.errors).toEqual([])
      await expect(page.getByTestId('retained-preview')).not.toBeVisible()
      await page.getByRole('button', { name: 'Select sony-zv1.ARW', exact: true }).click()
      const returned = await normal(page),
        returnedOwner = await canvas.evaluate((element) => ({
          requestId: element.dataset.previewRequestId,
          requestStartedAt: Number(element.dataset.sourceRequestStartedAt),
          ownerWaitFinishedAt: Number(element.dataset.sourceOwnerWaitFinishedAt),
        })),
        after = await recoveryProbeState(page)
      expect(returned.snapshot.sourceIdentity).toContain(`/library/${id}/`)
      expect(returned.snapshot.settingsRevision).toBe(prepared.edits.revision)
      expect(returnedOwner.requestId).not.toBe(pending.requestId)
      expect(returnedOwner.ownerWaitFinishedAt).toBeGreaterThanOrEqual(pending.destroyedAt)
      expect(returnedOwner.requestStartedAt).toBeGreaterThanOrEqual(pending.destroyedAt)
      expect(after.pendingDeparture?.nextHdrSubmittedAt).toBeGreaterThanOrEqual(pending.destroyedAt)
      expect(after.pendingDeparture?.stalePublication).toBe(false)
      expect(after.errors).toEqual([])
      expect(await page.evaluate((id) => window.irodori.getEditHistory(id), id)).toEqual(
        prepared.history,
      )
      detail.push({ returned, returnedOwner, after })
    } finally {
      await recoveryProbeAction(page, 'release').catch(() => undefined)
      await save(page, info, userDataDir, id, detail)
      await recoveryProbeAction(page, 'close').catch(() => undefined)
    }
  },
)
