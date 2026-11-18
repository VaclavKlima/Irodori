import { test, expect } from './electron.fixture'
import { foregroundTest } from './foreground'
import { activateButton } from './button.helpers'
import { importPhotos } from './import.helpers'
import { mkdir } from 'node:fs/promises'
import { hdrJpegFixture } from './hdr-jpeg.helpers'
import type { Page } from '@playwright/test'

/** Delay B's completed canvas fence without replacing any GPU work or pixel values. */
async function holdSecondComparisonFence(page: Page) {
  return page.evaluateHandle(() => {
    const originals = {
      current: GPUCanvasContext.prototype.getCurrentTexture,
      view: GPUTexture.prototype.createView,
      pass: GPUCommandEncoder.prototype.beginRenderPass,
      finish: GPUCommandEncoder.prototype.finish,
      submit: GPUQueue.prototype.submit,
      fence: GPUQueue.prototype.onSubmittedWorkDone,
    }
    const textures = new WeakSet<GPUTexture>(),
      views = new WeakSet<GPUTextureView>(),
      encoders = new WeakSet<GPUCommandEncoder>(),
      commands = new WeakSet<GPUCommandBuffer>(),
      queues = new WeakSet<GPUQueue>()
    let armed = true,
      closed = false,
      held = false,
      releaseHeld: (() => void) | undefined
    const release = () => {
      releaseHeld?.()
      releaseHeld = undefined
    }
    GPUCanvasContext.prototype.getCurrentTexture = function (this: GPUCanvasContext) {
      const texture = originals.current.call(this)
      if ((this.canvas as HTMLCanvasElement).dataset.testid === 'edit-comparison-b')
        textures.add(texture)
      return texture
    }
    GPUTexture.prototype.createView = function (this: GPUTexture, ...args) {
      const view = originals.view.apply(this, args)
      if (textures.has(this)) views.add(view)
      return view
    }
    GPUCommandEncoder.prototype.beginRenderPass = function (this: GPUCommandEncoder, descriptor) {
      if (
        Array.from(descriptor.colorAttachments).some(
          (attachment) => attachment && views.has(attachment.view as GPUTextureView),
        )
      )
        encoders.add(this)
      return originals.pass.call(this, descriptor)
    }
    GPUCommandEncoder.prototype.finish = function (this: GPUCommandEncoder, ...args) {
      const command = originals.finish.apply(this, args)
      if (encoders.has(this)) commands.add(command)
      return command
    }
    GPUQueue.prototype.submit = function (this: GPUQueue, input) {
      const values = Array.from(input)
      originals.submit.call(this, values)
      if (values.some((value) => commands.has(value))) queues.add(this)
    }
    GPUQueue.prototype.onSubmittedWorkDone = function (this: GPUQueue) {
      const actual = originals.fence.call(this)
      if (!armed || !queues.has(this)) return actual
      armed = false
      return actual.then(async () => {
        if (closed) return undefined
        held = true
        await new Promise<void>((resolve) => {
          releaseHeld = resolve
        })
        held = false
        return undefined
      })
    }
    return {
      state: () => ({ held }),
      release,
      close: () => {
        closed = true
        armed = false
        release()
        GPUCanvasContext.prototype.getCurrentTexture = originals.current
        GPUTexture.prototype.createView = originals.view
        GPUCommandEncoder.prototype.beginRenderPass = originals.pass
        GPUCommandEncoder.prototype.finish = originals.finish
        GPUQueue.prototype.submit = originals.submit
        GPUQueue.prototype.onSubmittedWorkDone = originals.fence
      },
    }
  })
}

test(
  'Versions and comparison fit native 1100 × 700 with Console open',
  foregroundTest(
    'Native minimum-size layout, keyboard focus and compositor screenshots require foreground presentation.',
  ),
  async ({ irodori: { app, page } }, info) => {
    test.setTimeout(90000)
    await importPhotos(app, page, ['tests/fixtures/photos/alpine-lake.jpg'], true, 'keyboard')
    const photo = (await page.evaluate(() => window.irodori.listPhotos())).photos[0]
    await page.evaluate(async (id) => {
      const state = await window.irodori.getEdits(id)
      await window.irodori.createEditCheckpoint({
        photoId: id,
        name: 'Natural',
        expectedRevision: state.revision,
      })
      const next = await window.irodori.updateEdits(
        id,
        { exposureEv: 0.5, contrast: 10 },
        state.revision,
      )
      await window.irodori.createEditCheckpoint({
        photoId: id,
        name: 'Stronger',
        expectedRevision: next.revision,
      })
    }, photo.id)
    const native = await app.browserWindow(page)
    await native.evaluate((window) => {
      window.unmaximize()
      const [, outer] = window.getSize(),
        [, content] = window.getContentSize()
      window.setMinimumSize(1100, 700 + outer - content)
      window.setContentSize(1100, 700)
    })
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([1100, 700])
    await activateButton(page.getByTestId('console-toggle'))
    await activateButton(page.getByRole('tab', { name: 'Versions', exact: true }))
    const list = page.getByRole('list', { name: 'Saved checkpoints' })
    await expect(list).toHaveAttribute('aria-busy', 'false')
    await list.focus()
    await list.press('End')
    await expect(
      page.getByRole('button', { name: 'Natural checkpoint', exact: true }),
    ).toBeFocused()
    const inspector = page.getByTestId('adjustments-panel')
    const bounds = (await inspector.boundingBox())!
    for (const label of ['Save checkpoint…', 'Compare', 'Restore selected']) {
      const button = page.getByRole('button', { name: label, exact: true })
      await expect(button).toBeVisible()
      const box = (await button.boundingBox())!
      expect(box.y).toBeGreaterThanOrEqual(bounds.y)
      expect(box.y + box.height).toBeLessThanOrEqual(bounds.y + bounds.height)
    }
    expect(await list.evaluate((element) => element.clientHeight)).toBeGreaterThanOrEqual(44)
    await page.screenshot({ path: info.outputPath('versions-minimum-console.png'), scale: 'css' })
    await activateButton(page.getByRole('button', { name: 'Save checkpoint…', exact: true }))
    const dialog = page.getByRole('dialog', { name: 'Save checkpoint' })
    await expect(dialog.getByRole('textbox', { name: 'Checkpoint name' })).toBeFocused()
    const dialogBounds = (await dialog.boundingBox())!
    for (const label of ['Cancel', 'Save checkpoint']) {
      const button = dialog.getByRole('button', { name: label, exact: true })
      const box = (await button.boundingBox())!
      expect(box.y + box.height).toBeLessThanOrEqual(dialogBounds.y + dialogBounds.height)
      expect(box.y + box.height).toBeLessThanOrEqual(700)
    }
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await activateButton(page.getByRole('button', { name: 'Compare', exact: true }))
    const comparison = page.getByTestId('edit-comparison-preview')
    await expect(comparison).toHaveAttribute('data-status', 'ready', { timeout: 45000 })
    await expect(page.getByTestId('console-panel')).toBeVisible()
    const photograph = page.getByLabel('Version comparison photograph', { exact: true })
    await photograph.focus()
    await photograph.press('y')
    await expect(comparison).toHaveAttribute('data-mode', 'split')
    await page.screenshot({
      path: info.outputPath('versions-split-minimum-console.png'),
      scale: 'css',
    })
    await photograph.press('Escape')
    await expect(comparison).toHaveCount(0)
    await expect(page.getByTestId('main-preview')).toBeFocused()
    await expect(page.getByRole('button', { name: 'Compare', exact: true })).toBeEnabled()
  },
)

test.describe('authored HDR version composition', () => {
  test.use({ hdrDisplay: true })
  test(
    'both historical HDR slots retain extended canvases and a complete-pair barrier through display changes',
    foregroundTest(
      'Composed extended HDR canvases, entered monitor selection and native screenshots require foreground presentation; this does not measure physical luminance.',
    ),
    async ({ irodori: { app, page } }, info) => {
      test.setTimeout(180000)
      const directory = info.outputPath('authored-hdr')
      await mkdir(directory)
      const input = await hdrJpegFixture(directory)
      await importPhotos(app, page, [input.path], false, 'keyboard')
      await page.evaluate(() => window.irodori.setPreviewPreference('hdr'))
      await expect(page.getByTestId('main-preview')).toHaveAttribute('data-backend', 'webgpu-hdr', {
        timeout: 60000,
      })
      const photo = (await page.evaluate(() => window.irodori.listPhotos())).photos[0]
      const saved = await page.evaluate(async (photoId) => {
        const maskId = crypto.randomUUID()
        let state = await window.irodori.getEdits(photoId)
        state = await window.irodori.updateEdits(
          photoId,
          {
            exposureEv: 0.15,
            detailSharpening: { version: 1, amount: 10, radius: 1, threshold: 10 },
          },
          state.revision,
        )
        state = await window.irodori.mutateMasks(photoId, state.revision, {
          operations: [
            {
              kind: 'create',
              id: maskId,
              name: 'HDR subject',
              gradient: { kind: 'linear', start: { x: 0.25, y: 0 }, end: { x: 0.8, y: 1 } },
            },
            { kind: 'update', id: maskId, light: { contrast: 5 }, texture: 8 },
          ],
        })
        const a = await window.irodori.createEditCheckpoint({
          photoId,
          expectedRevision: state.revision,
          name: 'Natural HDR',
        })
        state = await window.irodori.updateEdits(
          photoId,
          {
            exposureEv: 0.4,
            noiseReduction: { version: 1, luminance: 8, chroma: 5 },
            detailSharpening: { version: 1, amount: 30, radius: 1, threshold: 5 },
          },
          state.revision,
        )
        state = await window.irodori.mutateMasks(photoId, state.revision, {
          operations: [{ kind: 'update', id: maskId, light: { contrast: 15 }, texture: 25 }],
        })
        const b = await window.irodori.createEditCheckpoint({
          photoId,
          expectedRevision: state.revision,
          name: 'Stronger HDR',
        })
        return { a, b, history: await window.irodori.getEditHistory(photoId) }
      }, photo.id)
      expect(saved.a.settings.maskStack[0]).toMatchObject({
        enabled: true,
        texture: 8,
        light: { contrast: 5 },
      })
      expect(saved.b.settings.maskStack[0]).toMatchObject({
        enabled: true,
        texture: 25,
        light: { contrast: 15 },
      })
      const native = await app.browserWindow(page)
      await native.evaluate((window) => {
        window.unmaximize()
        const [, outer] = window.getSize(),
          [, content] = window.getContentSize()
        window.setMinimumSize(1100, 700 + outer - content)
        window.setContentSize(1100, 700)
      })
      await activateButton(page.getByTestId('console-toggle'))
      await activateButton(page.getByRole('tab', { name: 'Versions', exact: true }))
      await activateButton(
        page.getByRole('button', { name: 'Natural HDR checkpoint', exact: true }),
      )
      await page.getByRole('combobox', { name: 'Comparison A' }).selectOption(saved.a.id)
      await activateButton(
        page.getByRole('button', { name: 'Stronger HDR checkpoint', exact: true }),
      )
      await page.getByRole('combobox', { name: 'Comparison B' }).selectOption(saved.b.id)
      const held = await holdSecondComparisonFence(page)
      const comparison = page.getByTestId('edit-comparison-preview'),
        a = page.getByTestId('edit-comparison-a'),
        b = page.getByTestId('edit-comparison-b')
      try {
        await activateButton(
          page
            .getByRole('region', { name: 'Versions', exact: true })
            .getByRole('button', { name: 'Compare', exact: true }),
        )
        await expect
          .poll(() => held.evaluate((state) => state.state().held), { timeout: 60000 })
          .toBe(true)
        await expect(a).toHaveAttribute('data-editing', 'ready')
        await expect(comparison).toHaveAttribute('data-status', 'pending')
        // A completed child may explicitly be visible; the pair owner still hides both.
        await expect(a).toHaveCSS('visibility', 'visible')
        expect(
          await a.evaluate(
            (canvas) => getComputedStyle(canvas.parentElement!.parentElement!).opacity,
          ),
        ).toBe('0')
        await page.screenshot({
          path: info.outputPath('hdr-pair-pending-second-member.png'),
          scale: 'css',
        })
        await held.evaluate((state) => state.release())
        await expect(comparison).toHaveAttribute('data-status', 'ready', { timeout: 60000 })
        await expect(b).toHaveAttribute('data-editing', 'ready')
        const configuration = async () =>
          comparison.locator('canvas').evaluateAll((elements) =>
            elements.map((element) => {
              const canvas = element as HTMLCanvasElement,
                configuration = canvas.getContext('webgpu')!.getConfiguration()
              return {
                format: configuration?.format,
                colorSpace: configuration?.colorSpace,
                toneMapping: configuration?.toneMapping?.mode,
                backend: canvas.dataset.backend,
                generation: canvas.dataset.targetGeneration,
                view: canvas.dataset.presentedView,
                revision: canvas.dataset.presentedSettingsRevision,
                source: canvas.dataset.presentedSourceIdentity,
                mode: canvas.dataset.comparison,
                preparedMasks: canvas.dataset.preparedMaskKey,
              }
            }),
          )
        let configs = await configuration()
        expect(configs).toHaveLength(2)
        const firstGeneration = configs[0].generation
        for (const config of configs)
          expect(config).toMatchObject({
            format: 'rgba16float',
            toneMapping: 'extended',
            backend: 'webgpu-hdr',
            mode: 'after',
          })
        expect(configs[0].colorSpace).toBe(configs[1].colorSpace)
        expect(configs[0].generation).toBe(configs[1].generation)
        expect(configs[0].view).toBe(configs[1].view)
        expect(configs[0].revision).toBe(String(saved.a.capturedFromRevision))
        expect(configs[1].revision).toBe(String(saved.b.capturedFromRevision))
        expect(configs[0].source).not.toBe(configs[1].source)
        for (const config of configs) expect(config.preparedMasks).toMatch(/^[a-f0-9]{64}$/)
        const photograph = page.getByLabel('Version comparison photograph', { exact: true })
        await expect(photograph).toHaveAttribute('data-scale', '1')
        await photograph.focus()
        await photograph.press('+')
        await photograph.press('ArrowRight')
        await expect(comparison).toHaveAttribute('data-status', 'ready')
        configs = await configuration()
        expect(configs[0].view).toBe(configs[1].view)
        expect(JSON.parse(configs[0].view!)).toMatchObject({ scale: 2, x: -40 })
        await photograph.press('y')
        await expect(comparison).toHaveAttribute('data-mode', 'split')
        await page.screenshot({ path: info.outputPath('hdr-pair-native-split.png'), scale: 'css' })
        const transitions = await page.evaluateHandle(() => {
          const owner = document.querySelector('[data-testid="edit-comparison-preview"]')!,
            states: string[] = []
          const observer = new MutationObserver(() =>
            states.push(owner.getAttribute('data-status')!),
          )
          observer.observe(owner, { attributes: true, attributeFilter: ['data-status'] })
          return { states: () => [...states], close: () => observer.disconnect() }
        })
        try {
          await page.evaluate(() => window.irodori.setPreviewPreference('sdr'))
          await expect(comparison).toHaveAttribute('data-status', 'ready', { timeout: 60000 })
          await page.evaluate(() => window.irodori.setPreviewPreference('hdr'))
          await expect(comparison).toHaveAttribute('data-status', 'ready', { timeout: 60000 })
          configs = await configuration()
          expect(configs[0].generation).toBe(configs[1].generation)
          expect(configs[0].generation).not.toBe(firstGeneration)
          expect(configs[0].view).toBe(configs[1].view)
          for (const config of configs)
            expect(config).toMatchObject({
              format: 'rgba16float',
              toneMapping: 'extended',
              backend: 'webgpu-hdr',
            })
          expect(await transitions.evaluate((state) => state.states())).toContain('pending')
        } finally {
          await transitions.evaluate((state) => state.close())
          await transitions.dispose()
        }
        expect(await page.evaluate((id) => window.irodori.getEditHistory(id), photo.id)).toEqual(
          saved.history,
        )
        await expect(page.getByTestId('console-panel')).toBeVisible()
        await page.screenshot({
          path: info.outputPath('hdr-pair-native-restored-hdr.png'),
          scale: 'css',
        })
        await activateButton(
          comparison.getByRole('button', { name: 'End comparison', exact: true }),
        )
        await expect(comparison).toHaveCount(0)
      } finally {
        await held.evaluate((state) => state.close())
        await held.dispose()
      }
    },
  )
})
