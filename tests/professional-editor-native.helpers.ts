import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Locator, Page, TestInfo } from '@playwright/test'
import { expect } from '@playwright/test'
import sharp from 'sharp'
import type { HdrWorkingAsset } from '../src/shared/hdr'
import type { CropSettings } from '../src/shared/crop'
import type { DetailSourceLineage } from '../src/main/processing/detail-identity'
import { HDR_SOURCE_VERSION } from '../src/shared/hdr'
import { PREVIEW_ASSET_VERSION } from '../src/shared/preview-frame'
import { focusPreviewWindow } from './preview-pan.helpers'
import { captureWindow } from './window-capture.helpers'

export async function nativeOriginalHash(path: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/** Establish focus once, then reject focus loss rather than repairing it during a gesture. */
export async function nativeEditorInput(app: ElectronApplication, page: Page, profile: string) {
  const actualProfile = await app.evaluate(({ app }) => app.getPath('userData'))
  expect(await realpath(actualProfile)).toBe(await realpath(profile))
  await focusPreviewWindow(app, page)
  const window = await app.browserWindow(page)
  const samples: { phase: string; native: unknown; renderer: unknown }[] = []
  const observer = await page.evaluateHandle(() => {
    const events: {
      type: string
      trusted: boolean
      target: string
      key?: string
      charCode?: number
      disabled?: boolean
      readOnly?: boolean
      ariaDisabled?: string | null
    }[] = []
    const record = (event: Event) => {
      const target = event.target as HTMLElement | null
      events.push({
        type: event.type,
        trusted: event.isTrusted,
        target:
          target?.getAttribute('aria-label') ??
          target?.getAttribute('data-testid') ??
          target?.tagName ??
          '',
        ...(event instanceof KeyboardEvent ? { key: event.key, charCode: event.charCode } : {}),
      })
    }
    const types = [
      'keydown',
      'keypress',
      'keyup',
      'input',
      'change',
      'click',
      'focusin',
      'focusout',
    ]
    for (const type of types) document.addEventListener(type, record, true)
    const controls = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        const element = mutation.target
        if (!(element instanceof HTMLInputElement)) continue
        events.push({
          type: 'control-state',
          trusted: false,
          target: element.getAttribute('aria-label') ?? element.id,
          disabled: element.disabled,
          readOnly: element.readOnly,
          ariaDisabled: element.getAttribute('aria-disabled'),
        })
      }
    })
    const panel = document.querySelector('[data-testid="adjustments-panel"]')
    if (panel)
      controls.observe(panel, {
        attributes: true,
        subtree: true,
        attributeFilter: ['disabled', 'readonly', 'aria-disabled'],
      })
    return {
      stop() {
        for (const type of types) document.removeEventListener(type, record, true)
        controls.disconnect()
        return events
      },
    }
  })
  async function guard(phase: string) {
    const native = await window.evaluate((window) => ({
      visible: window.isVisible(),
      focused: window.isFocused(),
      contents: window.webContents.isFocused(),
      minimized: window.isMinimized(),
    }))
    const renderer = await page.evaluate(() => ({
      focused: document.hasFocus(),
      visibility: document.visibilityState,
      activeElement: document.activeElement
        ? {
            tag: document.activeElement.tagName,
            label: document.activeElement.getAttribute('aria-label'),
            testId: document.activeElement.getAttribute('data-testid'),
            ...(document.activeElement instanceof HTMLInputElement
              ? {
                  disabled: document.activeElement.disabled,
                  readOnly: document.activeElement.readOnly,
                  value: document.activeElement.value,
                }
              : {}),
          }
        : null,
    }))
    samples.push({ phase, native, renderer })
    if (
      !native.visible ||
      !native.focused ||
      !native.contents ||
      native.minimized ||
      !renderer.focused ||
      renderer.visibility !== 'visible'
    )
      throw new Error(
        `Native editor focus was lost; no further input will be sent: ${JSON.stringify(samples.at(-1))}`,
      )
  }
  async function send(events: Electron.KeyboardInputEvent[], phase: string) {
    await guard(`before ${phase}`)
    await window.evaluate((window, events) => {
      if (!window.isVisible() || !window.isFocused() || !window.webContents.isFocused())
        throw new Error('The isolated editor lost native focus before keyboard delivery.')
      for (const event of events) window.webContents.sendInputEvent(event)
    }, events)
    await guard(`after ${phase}`)
  }
  const key = (keyCode: string, modifiers: Electron.KeyboardInputEvent['modifiers'] = []) =>
    send(
      [
        { type: 'keyDown', keyCode, modifiers },
        // Chromium button activation needs the Enter character/keypress phase.
        // Electron char events take the actual CR character, not the name "Enter".
        ...(keyCode === 'Enter' ? [{ type: 'char' as const, keyCode: '\r', modifiers }] : []),
        { type: 'keyUp', keyCode, modifiers },
      ],
      keyCode,
    )
  async function focus(locator: Locator) {
    await guard('before control focus')
    await locator.scrollIntoViewIfNeeded()
    await expect(locator).toBeEnabled()
    await locator.focus()
    await expect(locator).toBeFocused()
    await guard('after control focus')
  }
  async function activate(locator: Locator) {
    await focus(locator)
    await key('Enter')
  }
  async function replace(locator: Locator, text: string) {
    await focus(locator)
    await key('A', [process.platform === 'darwin' ? 'meta' : 'control'])
    await send(
      [...text].flatMap((keyCode) => [
        { type: 'keyDown' as const, keyCode },
        { type: 'char' as const, keyCode },
        { type: 'keyUp' as const, keyCode },
      ]),
      `numeric text ${text}`,
    )
  }
  async function number(locator: Locator, text: string) {
    await replace(locator, text)
    await key('Enter')
  }
  return {
    guard,
    send,
    key,
    focus,
    activate,
    replace,
    number,
    async stop() {
      const events = await observer.evaluate((observer) => observer.stop())
      await observer.dispose()
      return { samples, events, route: 'Electron webContents.sendInputEvent' }
    },
  }
}

export async function readyNativeEditor(page: Page, photoId: string, revision: number) {
  const canvas = page.getByTestId('main-preview')
  await expect(canvas).toHaveAttribute('data-backend', 'webgpu-hdr', { timeout: 120000 })
  await expect(canvas).toHaveAttribute('data-editing', 'ready', { timeout: 120000 })
  await expect(canvas).toHaveAttribute('data-presented-settings-revision', String(revision), {
    timeout: 120000,
  })
  await expect(canvas).toHaveCSS('visibility', 'visible')
  await expect(page.getByTestId('preview-viewport')).toHaveAttribute('data-resolution', 'full')
  await expect
    .poll(
      () =>
        canvas.evaluate(
          async (canvas, expected) => {
            const value = canvas as HTMLCanvasElement
            const target = await window.irodori.getDisplayState()
            return (
              value.width > 0 &&
              value.height > 0 &&
              Number(value.dataset.requestedSerial) > 0 &&
              value.dataset.completedEditSerial === value.dataset.requestedSerial &&
              value.dataset.presentedSourceIdentity === value.dataset.requestedSourceIdentity &&
              Number(value.dataset.targetGeneration) === target.generation &&
              target.presentation?.stage === 'presented' &&
              target.presentation.photoId === expected.photoId &&
              target.presentation.revision === expected.revision &&
              target.presentation.targetGeneration === target.generation
            )
          },
          { photoId, revision },
        ),
      { timeout: 120000 },
    )
    .toBe(true)
  await expect(page.getByTestId('preview-viewport').locator('img')).toHaveCount(0)
  const frame = await canvas.evaluate((canvas) => ({
    sourceUrl: canvas.getAttribute('data-src'),
    sourceIdentity: canvas.getAttribute('data-presented-source-identity'),
    revision: Number(canvas.getAttribute('data-presented-settings-revision')),
    serial: Number(canvas.getAttribute('data-completed-edit-serial')),
    parameters: JSON.parse(canvas.getAttribute('data-requested-parameters') ?? '{}') as Record<
      string,
      unknown
    >,
  }))
  expect(frame.revision).toBe(revision)
  expect(frame.sourceUrl).toMatch(new RegExp(`^irodori-photo://library/${photoId}/linear/`))
  return frame
}

/** Observe the actual displayed source metadata; never request a substitute preview. */
export async function nativeSensorSource(profile: string, photoId: string, sourceUrl: string) {
  const url = new URL(sourceUrl)
  const [id, rendition, version, revision, extra] = url.pathname.split('/').filter(Boolean)
  expect(url.protocol).toBe('irodori-photo:')
  expect(url.hostname).toBe('library')
  expect(id).toBe(photoId)
  expect(rendition).toBe('linear')
  expect(version).toBe(PREVIEW_ASSET_VERSION)
  expect(revision).toMatch(/^[a-f0-9-]{8,128}$/)
  expect(extra).toBeUndefined()
  const directory = join(profile, 'library', 'cache', 'previews', version, `${photoId}-${revision}`)
  const metadata = JSON.parse(await readFile(join(directory, 'entry.json'), 'utf8')) as {
    width: number
    height: number
    linear?: { byteLength: number; sha256: string; hdr?: HdrWorkingAsset }
    detailSource?: DetailSourceLineage
    cropSettings?: CropSettings
  }
  const asset = metadata.linear?.hdr
  if (!asset) throw new Error('The displayed preview has no actual linear HDR source descriptor.')
  expect(asset!.source).toMatchObject({
    version: HDR_SOURCE_VERSION,
    processing: 'hdr-v1',
    colorSpace: 'rec2020',
    transfer: 'linear',
    orientation: 'applied-once',
  })
  expect(asset!.source.decoder).toMatch(/^libraw-/)
  expect(asset!.source.cameraProfile).toBeTruthy()
  expect(asset!.source.display).toBeUndefined()
  expect(asset!.source.composite).toBeUndefined()
  expect(asset!.byteLength).toBe(asset!.width * asset!.height * 16)
  expect((await stat(join(directory, 'linear.f32'))).size).toBe(asset!.byteLength)
  expect(metadata.linear!.sha256).toBe(asset!.sha256)
  return {
    dimensions: { width: asset!.width, height: asset!.height },
    asset,
    detailSource: metadata.detailSource,
    cropSettings: metadata.cropSettings,
  }
}

export async function captureNativeEditor(
  app: ElectronApplication,
  page: Page,
  info: TestInfo,
  name: string,
) {
  const path = info.outputPath(`${name}.png`)
  await captureWindow(app, page, path)
  await info.attach(name, { path, contentType: 'image/png' })
  return path
}

/** A native capture must contain varied photo pixels; this is not a quality score. */
export async function nonblankNativePhotograph(page: Page, path: string) {
  const geometry = await page.getByTestId('preview-viewport').evaluate((element) => {
    const bounds = element.getBoundingClientRect(),
      width = Number(element.dataset.imageWidth) * Number(element.dataset.scale),
      height = Number(element.dataset.imageHeight) * Number(element.dataset.scale)
    return {
      viewport: { width: innerWidth, height: innerHeight },
      left: bounds.x + (bounds.width - width) / 2 + Number(element.dataset.panX),
      top: bounds.y + (bounds.height - height) / 2 + Number(element.dataset.panY),
      width,
      height,
    }
  })
  const encoded = await readFile(path),
    metadata = await sharp(encoded).metadata(),
    scaleX = metadata.width! / geometry.viewport.width,
    scaleY = metadata.height! / geometry.viewport.height,
    crop = {
      left: Math.round((geometry.left + geometry.width * 0.15) * scaleX),
      top: Math.round((geometry.top + geometry.height * 0.15) * scaleY),
      width: Math.max(1, Math.floor(geometry.width * 0.7 * scaleX)),
      height: Math.max(1, Math.floor(geometry.height * 0.7 * scaleY)),
    }
  expect(crop.left).toBeGreaterThanOrEqual(0)
  expect(crop.top).toBeGreaterThanOrEqual(0)
  expect(crop.left + crop.width).toBeLessThanOrEqual(metadata.width!)
  expect(crop.top + crop.height).toBeLessThanOrEqual(metadata.height!)
  const pixels = await sharp(encoded).extract(crop).removeAlpha().raw().toBuffer(),
    colors = new Set<number>()
  for (let index = 0; index < pixels.length; index += 3)
    colors.add((pixels[index] << 16) | (pixels[index + 1] << 8) | pixels[index + 2])
  expect(
    colors.size,
    'The captured central photograph cannot be a flat loader or blank canvas',
  ).toBeGreaterThan(32)
  return { crop, distinctRgbColors: colors.size, purpose: 'nonblank native composition only' }
}
