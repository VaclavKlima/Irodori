import { test, expect } from './electron.fixture'
import { foregroundTest } from './foreground'
import { importPhotos } from './import.helpers'
import { activateButton } from './button.helpers'
import { navigateInspector } from './inspector.helpers'
import { createMask } from './mask-panel.helpers'
import { captureWindow } from './window-capture.helpers'

const nativeCapture = foregroundTest(
  'Native pointer panning and compositor captures verify automatic selections at Fit and 100% with Console open.',
)

for (const fixture of [
  {
    selection: 'sky',
    label: 'Select Sky',
    path: 'assets/tests/images/raster/wikimedia/sky-selection/originals/Sunset_through_branches_0528.jpg',
  },
  {
    selection: 'background',
    label: 'Select Background',
    path: 'assets/tests/images/raster/wikimedia/object-selection/originals/European_Robin_(Erithacus_rubecula)_with_mealworm.jpeg',
  },
] as const) {
  test(
    `automatic ${fixture.selection} has a visible registered proposal at Fit and native detail with Console open`,
    nativeCapture,
    async ({ irodori: { app, page } }, info) => {
      test.setTimeout(120000)
      await (await app.browserWindow(page)).evaluate((window) => window.setContentSize(1100, 700))
      await page.evaluate(() => window.irodori.setPreviewPreference('sdr'))
      await importPhotos(app, page, [fixture.path], true, 'keyboard')
      await activateButton(page.getByTestId('console-toggle'))
      await navigateInspector(page, 'Masks')
      await expect(page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready')
      await createMask(page, fixture.label)
      const use = page.getByRole('button', { name: 'Use mask', exact: true })
      await expect(use).toBeEnabled({ timeout: 60000 })
      await expect(use).toBeInViewport({ ratio: 1 })
      await expect(page.getByTestId('mask-coverage-overlay')).toBeVisible()
      await captureWindow(
        app,
        page,
        info.outputPath(`${fixture.selection}-proposal-fit-console.png`),
      )
      await page.getByRole('combobox', { name: 'Preview zoom', exact: true }).selectOption('1')
      await expect(page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready')
      await expect
        .poll(() =>
          page
            .getByTestId('main-preview')
            .evaluate(
              (canvas) => JSON.parse((canvas as HTMLElement).dataset.presentedView ?? '{}').scale,
            ),
        )
        .toBe(1)
      await expect(use).toBeEnabled()
      await captureWindow(
        app,
        page,
        info.outputPath(`${fixture.selection}-proposal-native-console.png`),
      )
      const photoId = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id
      const beforePan = await page.evaluate((id) => window.irodori.getEdits(id), photoId)
      const viewport = page.getByTestId('preview-viewport')
      const beforeX = await viewport.getAttribute('data-pan-x')
      const bounds = await viewport.boundingBox()
      expect(bounds).toBeTruthy()
      await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2)
      await page.mouse.down({ button: 'middle' })
      await page.mouse.move(
        bounds!.x + bounds!.width / 2 + 60,
        bounds!.y + bounds!.height / 2 + 30,
        {
          steps: 6,
        },
      )
      await page.mouse.up({ button: 'middle' })
      await expect(viewport).not.toHaveAttribute('data-pan-x', beforeX!)
      await expect(use).toBeEnabled()
      expect(await page.evaluate((id) => window.irodori.getEdits(id), photoId)).toEqual(beforePan)
      await activateButton(use)
      await expect(use).toHaveCount(0)
      const edited = await page.evaluate(async (id) => {
        const state = await window.irodori.getEdits(id)
        return window.irodori.mutateMasks(id, state.revision, {
          operations: [
            { kind: 'update', id: state.settings.maskStack[0].id, light: { exposureEv: 1 } },
          ],
        })
      }, photoId)
      await page.getByRole('checkbox', { name: 'Show overlay', exact: true }).uncheck()
      await expect(page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready')
      await expect(page.getByTestId('main-preview')).toHaveAttribute(
        'data-frame-geometry-revision',
        String(edited.revision),
      )
      await expect
        .poll(() =>
          page.evaluate(
            async ({ photoId, expectedRevision }) => {
              const context = await window.irodori.getPhotoPresentationContext({
                photoId,
                expectedRevision,
              })
              return context.frame.status
            },
            { photoId, expectedRevision: edited.revision },
          ),
        )
        .toBe('presented')
      await captureWindow(
        app,
        page,
        info.outputPath(`${fixture.selection}-local-light-native-console.png`),
      )
    },
  )
}
