import type { ElectronApplication, Page } from '@playwright/test'
import sharp from 'sharp'
import { expect } from './electron.fixture'
import { importPhotos } from './import.helpers'
import {
  MERGE_LIMITS,
  MERGE_VERSION,
  type MergeReview,
  type MergeRecipe,
} from '../src/shared/merge'

export async function setupMergePreview(
  app: ElectronApplication,
  page: Page,
  width = 1600,
  height = 1000,
  holdInitial = false,
  sourceCount = 2,
  textured = false,
  spatialMask = false,
) {
  await importPhotos(app, page)
  const photos = (await page.evaluate(() => window.irodori.listPhotos())).photos
  const native = await app.browserWindow(page)
  await native.evaluate((w) => {
    w.unmaximize()
    w.setContentSize(1100, 700)
  })
  await page.getByTestId('console-toggle').click()
  const assets = await Promise.all(
    [
      [width, height],
      [800, 600],
    ].map(async ([width, height]) => {
      const urls = await Promise.all(
        ['#646464', '#414141', '#b500a040'].map(
          async (background) =>
            `data:image/png;base64,${(
              await (
                spatialMask && background === '#b500a040'
                  ? sharp(
                      Buffer.from(
                        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width / 2}" height="${height}" fill="#b500a0" fill-opacity="0.25"/></svg>`,
                      ),
                    )
                  : textured && background !== '#b500a040'
                    ? sharp('tests/fixtures/photos/alpine-lake.jpg')
                        .resize(width, height)
                        .ensureAlpha()
                    : sharp({ create: { width, height, channels: 4, background } })
              )
                .png()
                .toBuffer()
            ).toString('base64')}`,
        ),
      )
      return { width, height, urls }
    }),
  )
  const review: MergeReview = {
    id: '00000000-0000-4000-8000-000000000000',
    revision: 0,
    scratchBytes: 1024,
    sources: Array.from({ length: sourceCount }, (_, i) => ({
      photo:
        i < photos.length
          ? photos[i]
          : { ...photos[i % photos.length], id: i.toString(16).padStart(64, '0') },
      relativeEv: 0,
      capture: { shutterSeconds: 1 / 125, iso: 400, aperture: 4, focalLength: 9.4 },
      metadata: {} as MergeReview['sources'][number]['metadata'],
    })),
    settings: {
      mode: 'hdr',
      autoAlign: true,
      deghost: true,
      strength: 50,
      autoCrop: true,
      referenceId: photos[1].id,
    },
  }
  const recipe: MergeRecipe = {
    resolution: 'native',
    version: MERGE_VERSION,
    constants: MERGE_LIMITS,
    settings: review.settings,
    sources: [],
    width,
    height,
    crop: { left: 0, top: 0, width, height },
    maskDimensions: { width, height },
    affectedPercent: 2,
    referenceClippedPercent: 0,
    maskSha256: '',
  }
  const control = await app.evaluateHandle(
    ({ ipcMain }, { review, recipe, assets, holdInitial }) => {
      let active = structuredClone(review),
        disposed = 0,
        creates = 0
      const holds = new Map<number, { wait: Promise<void>; release: () => void }>()
      const failures = new Set<number>(),
        mismatches = new Set<number>()
      const calls: { revision: number; arguments: number }[] = []
      function hold(revision: number) {
        let release!: () => void
        const wait = new Promise<void>((resolve) => {
          release = resolve
        })
        holds.set(revision, { wait, release })
      }
      if (holdInitial) hold(0)
      const originalContext = (
        ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
      )._invokeHandlers.get('photo-actions:context')!
      const handlers = {
        'photo-actions:context': async (...args: unknown[]) => {
          const context = (await originalContext(
            ...args,
          )) as import('../src/shared/photo-actions').PhotoActionsContext
          // The native-preview contract fixture supplies eligible inputs independently of RAW decoding.
          context.selection = context.selection.map((p) => ({ ...p, format: 'ARW' }))
          context.availability['selection-hdr'] = { kind: 'applicable' }
          context.availability['selection-noise'] = { kind: 'applicable' }
          return context
        },

        'merge:create': (_event: unknown, _ids: string[], mode: 'hdr' | 'noise') => {
          active = {
            ...structuredClone(review),
            id: `00000000-0000-4000-8000-${String(++creates).padStart(12, '0')}`,
            settings: { ...review.settings, mode },
          }
          return { result: active }
        },
        'merge:active': () => ({ result: active }),
        'merge:update': (
          _event: unknown,
          id: string,
          revision: number,
          settings: MergeReview['settings'],
        ) => {
          if (id !== active.id || revision !== active.revision)
            throw new Error('Stale fixture revision')
          active = { ...active, revision: revision + 1, settings }
          return { result: active }
        },
        'merge:preview': async (...args: unknown[]) => {
          const revision = args[2] as number,
            snapshot = structuredClone(active)
          calls.push({ revision, arguments: args.length - 1 })
          await holds.get(revision)?.wait
          if (failures.has(revision))
            return {
              error: {
                code: 'processing',
                message: 'Injected native render failure.',
                filenames: [],
                diagnostics: [],
              },
            }
          const image = assets[snapshot.settings.autoCrop ? 0 : 1]
          return {
            result: {
              reviewId: snapshot.id,
              revision,
              width: image.width + Number(mismatches.has(revision)),
              height: image.height,
              resultUrl: image.urls[0],
              referenceUrl: image.urls[1],
              overlayUrl: image.urls[2],
              recipe: {
                ...recipe,
                settings: snapshot.settings,
                crop: { ...recipe.crop, width: image.width, height: image.height },
              },
            },
          }
        },
        'merge:dispose': () => {
          disposed++
          return { result: undefined }
        },
      }
      for (const [name, handler] of Object.entries(handlers)) {
        ipcMain.removeHandler(name)
        ipcMain.handle(name, handler)
      }
      return {
        hold,
        release: (revision: number) => holds.get(revision)?.release(),
        fail: (revision: number) => failures.add(revision),
        mismatch: (revision: number) => mismatches.add(revision),
        state: () => ({ calls, disposed, revision: active.revision }),
      }
    },
    { review, recipe, assets, holdInitial },
  )
  await page.getByTestId(`photo-card-${photos[0].id}`).click()
  await page.getByTestId(`photo-card-${photos[1].id}`).click({ modifiers: ['Shift'] })
  async function open(mode = 'Merge selected photos to HDR…') {
    await page.getByRole('button', { name: 'Actions', exact: true }).click()
    await page.getByRole('menuitem', { name: mode, exact: true }).click()
  }
  await open()
  const viewport = page.getByTestId('merge-viewport'),
    zoom = page.getByRole('combobox', { name: 'Merge preview zoom' })
  if (!holdInitial) await expect(viewport).toHaveAttribute('data-ready', 'true')
  const view = () =>
    viewport.evaluate((el) => ({
      scale: Number(el.dataset.scale),
      x: Number(el.dataset.panX),
      y: Number(el.dataset.panY),
      fit: el.dataset.fit === 'true',
    }))
  return { control, viewport, zoom, view, native, open }
}
