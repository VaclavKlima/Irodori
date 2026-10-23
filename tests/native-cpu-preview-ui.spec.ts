import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import type { ElectronApplication, Page, TestInfo } from '@playwright/test'
import { expect, test } from './electron.fixture'
import { selectEditorPreviewPolicy } from '../src/shared/editor-preview-policy'
import { importPhotos } from './import.helpers'
import { activateButton } from './button.helpers'
import { foregroundTest } from './foreground'
import { sampleEditorMemory } from './editor-memory.helpers'
import { destroyMainPreviewDevice } from './hdr-device-loss.helpers'
import {
  observeNativeCpuReplies,
  observeCpuPublications,
  requireTrustedNativeBridge,
  expectCpuPair,
  canonicalAfterPixels,
  holdNativeCpuBitmapReceiver,
  observeNativeCpuAnalysisBaseline,
  readNativeCpuClippingCanvas,
} from './native-cpu-preview-ui.helpers'

const fixture = 'tests/fixtures/sony-zv1.ARW'
const raster = 'tests/fixtures/photos/alpine-lake.jpg'
const originalSha256 = '14c9d2912584a3ccc5cf10f554fbe495fc960c36758a14d7d858b36ac5ca88e2'
const parameters = {
  exposureEv: 1.25,
  contrast: 45,
  highlights: -55,
  shadows: 40,
  whites: 20,
  blacks: -25,
  whiteBalance: { mode: 'custom' as const, kelvin: 4500, tint: 12 },
}
type Replies = Awaited<ReturnType<typeof observeNativeCpuReplies>>
type Publications = Awaited<ReturnType<typeof observeCpuPublications>>
type Loss = Awaited<ReturnType<typeof destroyMainPreviewDevice>>
test.use({ hdrDisplay: true })
test.skip(
  process.platform !== 'linux' || process.arch !== 'x64',
  'Trusted native CPU application support is currently Linux x64; other platforms are incomplete.',
)
test.setTimeout(180000)

async function prepare(app: ElectronApplication, page: Page, withRaster = false) {
  expect(
    createHash('sha256')
      .update(await readFile(fixture))
      .digest('hex'),
  ).toBe(originalSha256)
  await requireTrustedNativeBridge(page)
  await page.evaluate(() => window.luma.setPreviewPreference('sdr'))
  await importPhotos(app, page, withRaster ? [raster, fixture] : [fixture], false, 'keyboard')
  const raw = (await page.evaluate(() => window.luma.listPhotos())).photos.find(
    (p) => p.filename === 'sony-zv1.ARW',
  )!
  expect(raw.id).toBe(originalSha256)
  const initial = await page.evaluate((id) => window.luma.getEdits(id), raw.id)
  await page.evaluate(
    ({ id, revision, parameters }) => window.luma.updateEdits(id, parameters, revision),
    { id: raw.id, revision: initial.revision, parameters },
  )
  await activateButton(page.getByRole('button', { name: 'Select sony-zv1.ARW', exact: true }))
  await expect(page.getByTestId('main-preview')).toHaveAttribute('data-backend', 'webgpu-hdr', {
    timeout: 120000,
  })
  await expect(page.getByTestId('main-preview')).toHaveAttribute('data-quality', 'normal', {
    timeout: 120000,
  })
  await expect(page.getByTestId('main-preview')).toHaveAttribute('data-exposure', '1.25')
  for (const [name, value] of Object.entries(parameters)) {
    const attribute =
      name === 'exposureEv' ? 'exposure' : name === 'whiteBalance' ? 'white-balance' : name
    await expect(page.getByTestId('main-preview')).toHaveAttribute(
      `data-${attribute}`,
      name === 'whiteBalance' ? JSON.stringify(value) : String(value),
    )
  }
  const appInfo = await page.evaluate(() => window.luma.getAppInfo())
  if (!selectEditorPreviewPolicy(appInfo.platform).presentationCache)
    await expect(page.getByTestId('main-preview')).toHaveAttribute(
      'data-presentation-cache',
      'disabled',
    )
  else
    await expect(page.getByTestId('main-preview')).toHaveAttribute(
      'data-presentation-cache',
      /^(?!disabled$).+/,
    )
  await expect
    .poll(() =>
      page
        .getByTestId('main-preview')
        .evaluate(
          (element) =>
            element.dataset.analysisPending === 'false' &&
            !!element.dataset.analysisKey &&
            element.dataset.analysisKey === element.dataset.displayedAnalysisKey,
        ),
    )
    .toBe(true)
  await expect(page.locator('#histogram')).toHaveAttribute('data-samples', '65536')
  await expect(page.locator('#histogram')).toHaveAttribute('data-pending', 'false')
  const requestId = randomUUID()
  let prepared
  try {
    prepared = await page.evaluate(
      ({ id, requestId }) => window.luma.requestHdrPreview(id, requestId, false, 'hdr'),
      { id: raw.id, requestId },
    )
  } finally {
    await page.evaluate((id) => window.luma.releaseFullPreview(id), requestId)
  }
  if (!prepared?.linear?.hdr) throw new Error('The real corrected Sony working source is missing.')
  expect(prepared.appliedCorrections).toEqual({
    distortion: true,
    vignetting: true,
    chromaticAberration: true,
  })
  return {
    raw,
    source: {
      renderingIdentity: prepared.renderId,
      sha256: prepared.linear.hdr.sha256,
      width: prepared.linear.hdr.width,
      height: prepared.linear.hdr.height,
    },
    edits: await page.evaluate((id) => window.luma.getEdits(id), raw.id),
    history: await page.evaluate((id) => window.luma.getEditHistory(id), raw.id),
    lens: await page.evaluate((id) => window.luma.getLensSettings(id), raw.id),
  }
}

async function lastNormal(
  replies: Replies,
  photoId: string,
  revision: number,
  ranges = false,
  excludeSession?: string,
) {
  await expect
    .poll(
      async () =>
        (await replies.evaluate((c) => c.state())).pairs
          .slice()
          .reverse()
          .find(
            (p) =>
              p.source.photoId === photoId &&
              p.settingsRevision === revision &&
              p.quality === 'normal' &&
              p.hdrRanges === ranges &&
              p.sessionId !== excludeSession,
          ),
      { timeout: 120000 },
    )
    .toBeTruthy()
  return (await replies.evaluate((c) => c.state())).pairs
    .slice()
    .reverse()
    .find(
      (p) =>
        p.source.photoId === photoId &&
        p.settingsRevision === revision &&
        p.quality === 'normal' &&
        p.hdrRanges === ranges &&
        p.sessionId !== excludeSession,
    )!
}

async function unchanged(page: Page, prepared: Awaited<ReturnType<typeof prepare>>) {
  expect(await page.evaluate((id) => window.luma.getEdits(id), prepared.raw.id)).toEqual(
    prepared.edits,
  )
  expect(await page.evaluate((id) => window.luma.getEditHistory(id), prepared.raw.id)).toEqual(
    prepared.history,
  )
  expect(await page.evaluate((id) => window.luma.getLensSettings(id), prepared.raw.id)).toEqual(
    prepared.lens,
  )
  for (const [name, value] of Object.entries(parameters)) {
    const attribute =
      name === 'exposureEv' ? 'exposure' : name === 'whiteBalance' ? 'white-balance' : name
    await expect(page.getByTestId('main-preview')).toHaveAttribute(
      `data-${attribute}`,
      name === 'whiteBalance' ? JSON.stringify(value) : String(value),
    )
  }
}

async function comparisonSamples(page: Page) {
  return page.getByTestId('main-preview').evaluate(async (element) => {
    const canvas = element as HTMLCanvasElement,
      context = canvas.getContext('2d')!
    const samples = [0.25, 0.5, 0.75].flatMap((y) =>
      [0.25, 0.75].map((x) =>
        Array.from(
          context.getImageData(Math.floor(canvas.width * x), Math.floor(canvas.height * y), 1, 1)
            .data,
        ),
      ),
    )
    if (canvas.width * canvas.height * 4 > 32 * 1024 ** 2)
      throw new Error('Comparison diagnostic exceeds its 32 MiB test allowance.')
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
    const digest = await crypto.subtle.digest('SHA-256', pixels)
    return {
      samples,
      sha256: Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, '0')).join(''),
    }
  })
}

async function finish(
  page: Page,
  info: TestInfo,
  replies: Replies,
  publications: Publications,
  loss?: Loss,
) {
  try {
    const frontend = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')
      return {
        viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
        visibility: document.visibilityState,
        canvas: canvas
          ? {
              width: canvas.width,
              height: canvas.height,
              dataset: Object.fromEntries(
                Object.entries(canvas.dataset)
                  .slice(0, 128)
                  .map(([key, value]) => [key, value?.slice(0, 2048)]),
              ),
            }
          : null,
      }
    })
    await activateButton(
      page
        .getByRole('navigation', { name: 'Workspaces' })
        .getByRole('button', { name: 'Library', exact: true }),
    )
    const state = await replies.evaluate((c) => c.close())
    await publications.evaluate((c) => c.close())
    const published = await publications.evaluate((c) => c.state())
    await writeFile(
      info.outputPath('native-cpu-preview-ui.json'),
      JSON.stringify(
        {
          profile: 'electron.fixture isolated temporary profile; actual sensor Sony source',
          configuredDeviceDestroyed: loss
            ? await loss.evaluate((control) => control.destroyed)
            : false,
          timingAcceptance: false,
          frontend,
          native: state,
          published,
          diagnostics: await page.evaluate(() => window.luma.getPreviewDiagnostics()),
        },
        null,
        2,
      ),
    )
    expect(state.omitted).toBe(0)
    expect(published.omitted).toBe(0)
    const pairs = new Map(state.pairs.map((p) => [p.pairId, p]))
    for (const publication of published.publications) {
      const pair = pairs.get(publication.pairId)
      expect(pair, 'Every visible CPU pair must come from a real main response.').toBeDefined()
      expect(publication.renderingIdentity).toBe(pair!.source.renderingIdentity)
      expect(publication.source).toContain(`luma-photo://library/${pair!.source.photoId}/linear/`)
      expect(publication.source).toContain(pair!.source.workingSha256)
      expect(publication.revision).toBe(pair!.settingsRevision)
      expect(publication.quality).toBe(pair!.quality)
    }
    expect(
      createHash('sha256')
        .update(await readFile(fixture))
        .digest('hex'),
    ).toBe(originalSha256)
  } finally {
    await replies.evaluate((c) => c.close()).catch(() => undefined)
    await publications.evaluate((c) => c.close()).catch(() => undefined)
    await loss?.evaluate((c) => c.restore()).catch(() => undefined)
    await Promise.all([replies.dispose(), publications.dispose(), loss?.dispose()])
  }
}

test('real Sony loss publishes trusted native draft then normal, preserving enabled edits, comparison and analysis', async ({
  luma,
}, info) => {
  const { app, page } = luma,
    prepared = await prepare(app, page)
  const plot = page.locator('#histogram svg[role="slider"]')
  await expect(plot).toHaveAttribute('data-animating', 'false')
  const referenceCurves = await plot
    .locator('path')
    .evaluateAll((paths) => paths.map((path) => path.getAttribute('d')))
  const memorySamples = [await sampleEditorMemory(app, 'gpu-before-native-fallback')]
  const replies = await observeNativeCpuReplies(app),
    publications = await observeCpuPublications(page)
  let loss: Loss | undefined
  try {
    await replies.evaluate((c) => c.arm('normal'))
    loss = await destroyMainPreviewDevice(page)
    await expect
      .poll(
        async () =>
          (await replies.evaluate((c) => c.state())).requests.some(
            (request) => request.quality === 'normal',
          ),
        { timeout: 120000 },
      )
      .toBe(true)
    memorySamples.push(await sampleEditorMemory(app, 'native-normal-request-in-flight'))
    await expect
      .poll(async () => !!(await replies.evaluate((c) => c.state())).held, { timeout: 120000 })
      .toBe(true)
    const gated = await replies.evaluate((c) => c.state())
    const draft = gated.pairs.find((p) => p.quality === 'draft')!
    expect(draft).toBeDefined()
    await expectCpuPair(page, draft)
    expect(Math.max(draft.after.width, draft.after.height)).toBe(1024)
    expect(draft.sourceDimensions).toEqual({
      width: prepared.source.width,
      height: prepared.source.height,
    })
    await unchanged(page, prepared)
    await replies.evaluate((c) => c.release())
    const pair = await lastNormal(replies, prepared.raw.id, prepared.edits.revision)
    await expectCpuPair(page, pair)
    memorySamples.push(await sampleEditorMemory(app, 'native-normal-pair-presented'))
    expect(pair.source).toMatchObject({
      photoId: prepared.raw.id,
      renderingIdentity: prepared.source.renderingIdentity,
      workingSha256: prepared.source.sha256,
    })
    expect(pair.after.width).toBe(prepared.source.width)
    expect(pair.after.height).toBe(prepared.source.height)
    expect(pair.parameters).toEqual(parameters)
    await canonicalAfterPixels(page, pair)
    const sample = await page.evaluate(async (samples) => {
      const response = await fetch(samples.url)
      if (!response.ok) throw new Error(`Real CPU sample capability failed: ${response.status}`)
      const body = await response.arrayBuffer(),
        values = new Float32Array(body)
      return {
        bytes: body.byteLength,
        sha256: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', body)), (n) =>
          n.toString(16).padStart(2, '0'),
        ).join(''),
        finite: values.every(Number.isFinite),
        opaque: values.every((value, index) => index % 4 !== 3 || value === 1),
      }
    }, pair.samples)
    expect(pair.samples).toMatchObject({ sampleCount: 65536, draftCount: 8192 })
    expect(sample.bytes).toBe((pair.samples.sampleCount + pair.samples.draftCount) * 16)
    expect(sample).toEqual({
      bytes: pair.samples.byteLength,
      sha256: pair.samples.sha256,
      finite: true,
      opaque: true,
    })
    await expect(page.locator('#histogram')).toHaveAttribute('data-samples', '65536')
    await expect(page.locator('#histogram')).toHaveAttribute('data-pending', 'false')
    await expect(plot).toHaveAttribute('data-animating', 'false')
    const curves = await page
      .locator('#histogram svg[role="slider"] path')
      .evaluateAll((paths) => paths.map((p) => p.getAttribute('d')))
    expect(curves).toHaveLength(3)
    await writeFile(
      info.outputPath('native-cpu-histogram-comparison.json'),
      JSON.stringify({ referenceCurves, curves }, null, 2),
    )
    expect(referenceCurves).toHaveLength(3)
    expect(
      curves.every((curve, index) => curve === referenceCurves[index]),
      'All three settled histogram paths must match exactly; complete paths are in the comparison artifact.',
    ).toBe(true)
    await page.getByLabel('Preview zoom', { exact: true }).selectOption('fit')
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
    const after = await comparisonSamples(page)
    await activateButton(page.getByRole('button', { name: 'Before', exact: true }))
    await expect(page.getByTestId('main-preview')).toHaveAttribute('data-comparison', 'before')
    const before = await comparisonSamples(page)
    expect(before.sha256).not.toBe(after.sha256)
    await activateButton(
      page.getByRole('button', { name: 'Compare before and after', exact: true }),
    )
    await expect(page.getByTestId('main-preview')).toHaveAttribute('data-comparison', 'split')
    expect((await comparisonSamples(page)).samples).toEqual(
      before.samples.map((value, i) => (i % 2 === 0 ? value : after.samples[i])),
    )
    await activateButton(
      page.getByRole('button', { name: 'Compare before and after', exact: true }),
    )
    await expectCpuPair(page, pair)
    await page.getByRole('button', { name: 'Show HDR ranges', exact: true }).press('Enter')
    const ranges = await lastNormal(replies, prepared.raw.id, prepared.edits.revision, true)
    await expectCpuPair(page, ranges)
    await expect(page.getByTestId('main-preview')).toHaveAttribute('data-hdr-ranges', 'true')
    await expect
      .poll(() =>
        page
          .locator('#histogram svg[role="slider"] path')
          .evaluateAll((paths) => paths.map((p) => p.getAttribute('d'))),
      )
      .toEqual(curves)
    await unchanged(page, prepared)
  } finally {
    await writeFile(
      info.outputPath('native-cpu-memory-snapshots.json'),
      JSON.stringify(
        {
          timingAcceptance: false,
          peakClaimed: false,
          scope:
            'Explicit owned-process PSS/RSS and per-client DRM snapshots; counters are separate and non-additive.',
          memorySamples,
        },
        null,
        2,
      ),
    )
    await finish(page, info, replies, publications, loss)
  }
})

test('a completed old native reply cannot publish across rapid revision and photo cancellation', async ({
  luma,
}, info) => {
  const { app, page } = luma,
    prepared = await prepare(app, page, true)
  const replies = await observeNativeCpuReplies(app),
    publications = await observeCpuPublications(page)
  let loss: Loss | undefined
  try {
    loss = await destroyMainPreviewDevice(page)
    await expectCpuPair(page, await lastNormal(replies, prepared.raw.id, prepared.edits.revision))
    await replies.evaluate((c) => c.arm('normal'))
    const first = await page.evaluate(
      ({ id, revision }) => window.luma.updateEdits(id, { exposureEv: 1.5 }, revision),
      { id: prepared.raw.id, revision: prepared.edits.revision },
    )
    await expect
      .poll(async () => !!(await replies.evaluate((c) => c.state())).held, { timeout: 120000 })
      .toBe(true)
    const old = (await replies.evaluate((c) => c.state())).held!
    const final = await page.evaluate(
      ({ id, revision }) => window.luma.updateEdits(id, { exposureEv: 1.75 }, revision),
      { id: prepared.raw.id, revision: first.revision },
    )
    const history = await page.evaluate((id) => window.luma.getEditHistory(id), prepared.raw.id)
    await activateButton(page.getByRole('button', { name: 'Select alpine-lake.jpg', exact: true }))
    await expect(page.getByTestId('main-preview')).toHaveAttribute('aria-label', 'alpine-lake.jpg')
    const marker = (await publications.evaluate((c) => c.state())).publications.length
    await replies.evaluate((c) => c.release())
    await expect
      .poll(async () =>
        (await replies.evaluate((c) => c.state())).events.some(
          (e) => e.phase === 'delivered' && e.pairId === old.pairId,
        ),
      )
      .toBe(true)
    await activateButton(page.getByRole('button', { name: 'Select sony-zv1.ARW', exact: true }))
    const pair = await lastNormal(replies, prepared.raw.id, final.revision, false, old.sessionId)
    await expectCpuPair(page, pair)
    expect(pair.sessionId).not.toBe(old.sessionId)
    expect(
      (await publications.evaluate((c) => c.state())).publications
        .slice(marker)
        .some((p) => p.pairId === old.pairId),
    ).toBe(false)
    expect(await page.evaluate((id) => window.luma.getEditHistory(id), prepared.raw.id)).toEqual(
      history,
    )
    expect(final.settings).toEqual({ ...prepared.edits.settings, exposureEv: 1.75 })
    await canonicalAfterPixels(page, pair)
  } finally {
    await finish(page, info, replies, publications, loss)
  }
})

test('saved Settings leave the active native owner frozen and apply to its next source session', async ({
  luma,
}, info) => {
  const { app, page } = luma
  await page.evaluate(() =>
    window.luma.setResourceSettings({ version: 1, ramMiB: 4096, vramMiB: 2048 }),
  )
  const prepared = await prepare(app, page, true)
  const replies = await observeNativeCpuReplies(app),
    publications = await observeCpuPublications(page)
  let loss: Loss | undefined
  try {
    loss = await destroyMainPreviewDevice(page)
    const active = await lastNormal(replies, prepared.raw.id, prepared.edits.revision)
    await expectCpuPair(page, active)
    const saved = await page.evaluate(() =>
      window.luma.setResourceSettings({ version: 1, ramMiB: 2048, vramMiB: 1024 }),
    )
    const edited = await page.evaluate(
      ({ id, revision }) => window.luma.updateEdits(id, { exposureEv: 1.5 }, revision),
      { id: prepared.raw.id, revision: prepared.edits.revision },
    )
    const sameOwner = await lastNormal(replies, prepared.raw.id, edited.revision)
    await expectCpuPair(page, sameOwner)
    expect(sameOwner.sessionId).toBe(active.sessionId)
    expect(sameOwner.policy).toEqual(active.policy)
    await activateButton(page.getByRole('button', { name: 'Select alpine-lake.jpg', exact: true }))
    await expect(page.getByTestId('main-preview')).toHaveAttribute('aria-label', 'alpine-lake.jpg')
    const oldRequests = (await replies.evaluate((c) => c.state())).requests.length
    await activateButton(page.getByRole('button', { name: 'Select sony-zv1.ARW', exact: true }))
    await expect
      .poll(async () => (await replies.evaluate((c) => c.state())).requests.length)
      .toBeGreaterThan(oldRequests)
    await expect
      .poll(async () =>
        (await replies.evaluate((c) => c.state())).pairs.some(
          (p) => p.quality === 'normal' && p.sessionId !== active.sessionId,
        ),
      )
      .toBe(true)
    const next = (await replies.evaluate((c) => c.state())).pairs
      .slice()
      .reverse()
      .find((p) => p.quality === 'normal' && p.sessionId !== active.sessionId)!
    await expectCpuPair(page, next)
    expect(next.policy.revision).toBeGreaterThan(active.policy.revision)
    expect(next.policy.ram.requestedMiB).toBe(saved.settings.ramMiB)
    expect(next.policy.vram.requestedMiB).toBe(saved.settings.vramMiB)
    expect(next.source).toMatchObject({
      photoId: active.source.photoId,
      renderingIdentity: active.source.renderingIdentity,
      workingSha256: active.source.workingSha256,
    })
    expect(next.parameters).toEqual({ ...parameters, exposureEv: 1.5 })
  } finally {
    await finish(page, info, replies, publications, loss)
  }
})

async function memoryLimitedPreview(
  luma: { app: ElectronApplication; page: Page },
  info: TestInfo,
  checkNativePixels: boolean,
) {
  const { app, page } = luma
  await (await app.browserWindow(page)).evaluate((window) => window.setContentSize(1100, 700))
  await page.evaluate(() =>
    window.luma.setResourceSettings({ version: 1, ramMiB: 4096, vramMiB: 2048 }),
  )
  // Prepare the genuine sensor source under sufficient limits, then reuse its cache.
  const prepared = await prepare(app, page, true)
  const replies = await observeNativeCpuReplies(app),
    publications = await observeCpuPublications(page)
  let loss: Loss | undefined
  try {
    await page.evaluate(() =>
      window.luma.setResourceSettings({ version: 1, ramMiB: 640, vramMiB: 1024 }),
    )
    await activateButton(page.getByRole('button', { name: 'Select alpine-lake.jpg', exact: true }))
    await expect(page.getByTestId('main-preview')).toHaveAttribute('aria-label', 'alpine-lake.jpg')
    await activateButton(page.getByRole('button', { name: 'Select sony-zv1.ARW', exact: true }))
    await expect
      .poll(() => page.getByTestId('main-preview').getAttribute('data-backend'), {
        timeout: 120000,
      })
      .toMatch(/^(webgpu-hdr|canvas2d-hdr-sdr)$/)
    // Recheck actual configuration atomically: resource admission can replace
    // the GPU canvas between the backend observation and this fault operation.
    loss = await destroyMainPreviewDevice(page, true)
    await expect
      .poll(async () => (await replies.evaluate((c) => c.state())).requests.length, {
        timeout: 30000,
      })
      .toBeGreaterThan(0)
    const limited = page.getByTestId('preview-memory-limitation')
    await expect(limited).toHaveText('Reduced detail: preview memory limit reached.', {
      timeout: 120000,
    })
    await expect(page.getByTestId('preview-resolution')).toHaveAttribute('role', 'status')
    await expect(limited).toBeVisible()
    const state = await replies.evaluate((c) => c.state())
    const draft = state.pairs
      .slice()
      .reverse()
      .find((p) => p.quality === 'draft')!
    const denial = state.limits.find((l) => l.sessionId === draft.sessionId)!
    expect(denial).toBeDefined()
    expect(state.requests.find((r) => r.requestId === denial.requestId)).toMatchObject({
      quality: 'normal',
      source: draft.source,
      expectedSettingsRevision: prepared.edits.revision,
    })
    expect(denial.policy).toEqual(draft.policy)
    expect(draft.policy.ram.requestedMiB).toBe(640)
    await expectCpuPair(page, draft)
    await expect(page.getByTestId('main-preview')).toHaveAttribute('data-full-blocked', 'true')
    await unchanged(page, prepared)
    const edit = await page.evaluate(
      ({ id, revision }) => window.luma.updateEdits(id, { exposureEv: 1.5 }, revision),
      { id: prepared.raw.id, revision: prepared.edits.revision },
    )
    await expect
      .poll(async () =>
        (await replies.evaluate((c) => c.state())).pairs.some(
          (p) => p.quality === 'draft' && p.settingsRevision === edit.revision,
        ),
      )
      .toBe(true)
    const editedDraft = (await replies.evaluate((c) => c.state())).pairs
      .slice()
      .reverse()
      .find((p) => p.quality === 'draft' && p.settingsRevision === edit.revision)!
    await expectCpuPair(page, editedDraft)
    expect(editedDraft.sessionId).toBe(draft.sessionId)
    expect(editedDraft.policy).toEqual(draft.policy)
    await expect(page.getByTestId('main-preview')).toHaveAttribute('data-exposure', '1.5')
    await expect(limited).toBeVisible()
    await page.evaluate(() =>
      window.luma.setResourceSettings({ version: 1, ramMiB: 2048, vramMiB: 2048 }),
    )
    const final = await page.evaluate(
      ({ id, revision }) => window.luma.updateEdits(id, { exposureEv: 1.75 }, revision),
      { id: prepared.raw.id, revision: edit.revision },
    )
    await expect
      .poll(async () =>
        (await replies.evaluate((c) => c.state())).pairs.some(
          (p) => p.quality === 'draft' && p.settingsRevision === final.revision,
        ),
      )
      .toBe(true)
    const frozen = (await replies.evaluate((c) => c.state())).pairs
      .slice()
      .reverse()
      .find((p) => p.quality === 'draft' && p.settingsRevision === final.revision)!
    await expectCpuPair(page, frozen)
    expect(frozen.sessionId).toBe(draft.sessionId)
    expect(frozen.policy).toEqual(draft.policy)
    await expect
      .poll(
        async () => {
          const current = await replies.evaluate((c) => c.state())
          return current.limits.some(
            (limit) =>
              limit.sessionId === draft.sessionId &&
              current.requests.some(
                (request) =>
                  request.requestId === limit.requestId &&
                  request.expectedSettingsRevision === final.revision &&
                  request.quality === 'normal',
              ),
          )
        },
        { timeout: 120000 },
      )
      .toBe(true)
    expect(
      (await replies.evaluate((c) => c.state())).pairs.some(
        (pair) =>
          pair.sessionId === draft.sessionId &&
          pair.settingsRevision === final.revision &&
          pair.quality === 'normal',
      ),
    ).toBe(false)
    await expect(page.getByTestId('main-preview')).toHaveAttribute('data-full-blocked', 'true')
    await expect(limited).toBeVisible()
    const history = await page.evaluate((id) => window.luma.getEditHistory(id), prepared.raw.id)
    await activateButton(page.getByRole('button', { name: 'Select alpine-lake.jpg', exact: true }))
    await expect(page.getByTestId('main-preview')).toHaveAttribute('aria-label', 'alpine-lake.jpg')
    await activateButton(page.getByRole('button', { name: 'Select sony-zv1.ARW', exact: true }))
    const next = await lastNormal(replies, prepared.raw.id, final.revision, false, draft.sessionId)
    await expectCpuPair(page, next)
    expect(next.policy.ram.requestedMiB).toBe(2048)
    expect(next.policy.revision).toBeGreaterThan(draft.policy.revision)
    await expect(page.getByTestId('main-preview')).not.toHaveAttribute('data-full-blocked', 'true')
    await expect(limited).not.toBeVisible()
    expect(await page.evaluate((id) => window.luma.getEditHistory(id), prepared.raw.id)).toEqual(
      history,
    )
    expect(next.parameters).toEqual({ ...parameters, exposureEv: 1.75 })
    if (checkNativePixels) await canonicalAfterPixels(page, next)
  } finally {
    await finish(page, info, replies, publications, loss)
  }
}

test('native memory denial keeps draft edits usable and freezes limits until the next owner', async ({
  luma,
}, info) => {
  await memoryLimitedPreview(luma, info, false)
})

test(
  'normal memory denial retains a matching native draft and later edits until a new owner receives higher limits',
  foregroundTest(
    'The complete memory lifecycle includes a native 100% redraw after resizing; this Wayland hidden window does not deliver the required compositor frame, including under hidden-safe capture.',
  ),
  async ({ luma }, info) => {
    await memoryLimitedPreview(luma, info, true)
  },
)

test('a completed real CPU bitmap receiver drains before the next photo allocates its GPU source', async ({
  luma,
}, info) => {
  const { app, page } = luma,
    prepared = await prepare(app, page, true)
  const replies = await observeNativeCpuReplies(app),
    publications = await observeCpuPublications(page),
    receiver = await holdNativeCpuBitmapReceiver(page, {
      width: prepared.source.width,
      height: prepared.source.height,
    })
  let loss: Loss | undefined
  try {
    loss = await destroyMainPreviewDevice(page)
    await expect
      .poll(async () => (await receiver.evaluate((control) => control.state())).held, {
        timeout: 120000,
      })
      .toBe(true)
    const pair = await lastNormal(replies, prepared.raw.id, prepared.edits.revision)
    expect(pair.diagnostics.outputValidatedAfterChildClose).toBe(true)
    await expect(page.getByTestId('main-preview')).toHaveAttribute('data-quality', 'draft')
    expect(
      (await publications.evaluate((control) => control.state())).publications.some(
        (publication) => publication.pairId === pair.pairId,
      ),
    ).toBe(false)
    await loss.evaluate((control) => control.restore())
    await receiver.evaluate((control) => control.beginSwitch())
    await activateButton(page.getByRole('button', { name: 'Select alpine-lake.jpg', exact: true }))
    await expect(page.getByTestId('main-preview')).toHaveAttribute('aria-label', 'alpine-lake.jpg')
    await activateButton(page.getByRole('button', { name: 'Select sony-zv1.ARW', exact: true }))
    await expect(page.getByTestId('main-preview')).toHaveAttribute('aria-label', 'sony-zv1.ARW')
    // HDR admission itself waits for the retired receiver. The selected RAW
    // stays neutral before any replacement descriptor or GPU resource exists.
    await expect(page.getByTestId('main-preview')).toHaveAttribute('data-preview-request-id', '')
    // Observe a bounded scheduling interval; this resource-ordering check does
    // not depend on compositor callbacks or claim presentation timing.
    await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 250)))
    const blocked = await receiver.evaluate((control) => control.state())
    expect(blocked).toMatchObject({ completed: true, held: true, receiverClosed: false })
    expect(blocked.events.filter((event) => event.kind.startsWith('gpu-'))).toEqual([])
    await expect(page.getByTestId('main-preview')).not.toHaveAttribute('data-editing', 'ready')
    await receiver.evaluate((control) => control.release())
    await expect(page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready', {
      timeout: 120000,
    })
    await expect(page.getByTestId('main-preview')).toHaveAttribute('data-quality', 'normal')
    await expect(page.getByTestId('main-preview')).toHaveAttribute('data-backend', 'webgpu-hdr')
    await expect(page.getByTestId('main-preview')).toHaveAttribute('data-exposure', '1.25')
    const settled = await receiver.evaluate((control) => control.state())
    expect(settled).toMatchObject({
      completed: true,
      held: false,
      receiverClosed: true,
      omitted: 0,
    })
    const allocations = settled.events.filter((event) => event.kind.startsWith('gpu-'))
    expect(allocations.length).toBeGreaterThan(0)
    expect(allocations.every((allocation) => allocation.receiverClosed)).toBe(true)
    expect(
      allocations.some(
        (allocation) =>
          allocation.kind === 'gpu-texture' &&
          allocation.format === 'rgba32float' &&
          allocation.width === prepared.source.width &&
          allocation.height === prepared.source.height,
      ),
    ).toBe(true)
    expect(
      (await publications.evaluate((control) => control.state())).publications.some(
        (publication) => publication.pairId === pair.pairId,
      ),
    ).toBe(false)
    await unchanged(page, prepared)
  } finally {
    try {
      const evidence = await receiver.evaluate((control) => control.close())
      await writeFile(
        info.outputPath('native-cpu-browser-receiver-drain.json'),
        JSON.stringify({ timingAcceptance: false, ...evidence }, null, 2),
      )
    } finally {
      try {
        await receiver.dispose()
      } finally {
        await finish(page, info, replies, publications, loss)
      }
    }
  }
})

test('records genuine native CPU gesture analysis and full clipping consumer baseline without desktop focus', async ({
  luma,
}, info) => {
  test.setTimeout(300000)
  const { app, page } = luma,
    prepared = await prepare(app, page)
  const replies = await observeNativeCpuReplies(app),
    publications = await observeCpuPublications(page),
    analysis = await observeNativeCpuAnalysisBaseline(page, {
      sha256: prepared.source.sha256,
      width: prepared.source.width,
      height: prepared.source.height,
    })
  let loss: Loss | undefined
  let maskDigest: unknown, overlay: unknown
  const exposure = page.getByRole('spinbutton', { name: 'Exposure value' })
  try {
    loss = await destroyMainPreviewDevice(page)
    const pair = await lastNormal(replies, prepared.raw.id, prepared.edits.revision)
    await expectCpuPair(page, pair)
    expect(pair.source.workingSha256).toBe(prepared.source.sha256)
    const histogram = page.locator('#histogram')
    await expect(histogram).toHaveAttribute('data-samples', '65536')
    await analysis.evaluate((control) => control.mark('gesture'))
    await exposure.fill('1.5')
    await expect(page.getByTestId('main-preview')).toHaveAttribute('data-gesturing', 'true')
    await expect(histogram).toHaveAttribute('data-samples', '8192', { timeout: 30000 })
    const gesture = await analysis.evaluate((control) => control.state())
    expect(
      gesture.statistics.some(
        (reply) =>
          reply.request.phase === 'gesture' &&
          reply.request.sampleCount === 8192 &&
          reply.visiblePixels === 8192,
      ),
    ).toBe(true)
    expect(
      gesture.histogramDom.some((record) => record.phase === 'gesture' && record.samples === 8192),
    ).toBe(true)
    expect(await page.evaluate((id) => window.luma.getEditHistory(id), prepared.raw.id)).toEqual(
      prepared.history,
    )
    await analysis.evaluate((control) => control.mark('restore'))
    await exposure.press('Escape')
    await expect(histogram).toHaveAttribute('data-samples', '65536')
    await expect(page.getByTestId('main-preview')).toHaveAttribute('data-exposure', '1.25', {
      timeout: 120000,
    })
    await expect.poll(async () => (await readNativeCpuClippingCanvas(page)).visible).toBe(0)
    const clipping = page.getByRole('button', { name: 'Canvas channel clipping', exact: true })
    await analysis.evaluate((control) => control.mark('clip'))
    await activateButton(clipping)
    await expect(clipping).toHaveAttribute('aria-pressed', 'true')
    await expect
      .poll(
        async () => {
          const current = (await analysis.evaluate((control) => control.state())).mask
          return current?.request.phase === 'clip' && current.drawnAt !== null
        },
        { timeout: 180000 },
      )
      .toBe(true)
    const completed = await analysis.evaluate((control) => control.state())
    expect(completed.mask!.request).toMatchObject({
      sourceSha256: pair.source.workingSha256,
      masks: true,
      domain: 'content-hdr',
      parameters,
      target: { mode: 'sdr', colorSpace: 'srgb', peak: 1 },
    })
    // Read/hash only after the actual draw timing has been captured. Neither
    // this diagnostic work nor hidden elapsed time is an interaction gate.
    overlay = await readNativeCpuClippingCanvas(page)
    expect(overlay).toMatchObject({ visible: expect.any(Number), amber: expect.any(Number) })
    expect((overlay as { amber: number }).amber).toBeGreaterThan(0)
    expect((overlay as { visible: number }).visible).toBe((overlay as { amber: number }).amber)
    maskDigest = await analysis.evaluate((control) => control.hashMask())
    expect((maskDigest as { bitCounts: number[] }).bitCounts[0]).toBeGreaterThan(0)
    await analysis.evaluate((control) => control.mark('clear'))
    await activateButton(clipping)
    await expect(clipping).toHaveAttribute('aria-pressed', 'false')
    await expect.poll(async () => (await readNativeCpuClippingCanvas(page)).visible).toBe(0)
    await unchanged(page, prepared)
    await expect(page.getByTestId('main-preview')).toHaveAttribute('data-cpu-renderer', 'native')
  } finally {
    await exposure.press('Escape').catch(() => undefined)
    try {
      const observed = await analysis.evaluate((control) => control.close())
      await writeFile(
        info.outputPath('native-cpu-analysis-baseline.json'),
        JSON.stringify(
          {
            acceptance: false,
            scope:
              'one hidden functional/cost observation; desktop load and OS caches uncontrolled',
            timing:
              'worker post to real worker reply and actual Canvas2D draw; histogram DOM commit excludes SVG RAF animation and scanout',
            imageRevision: prepared.edits.revision,
            maskDigest,
            overlay,
            observed,
          },
          null,
          2,
        ),
      )
      expect(observed.omitted).toBe(0)
    } finally {
      try {
        await analysis.dispose()
      } finally {
        await finish(page, info, replies, publications, loss)
      }
    }
  }
})
