import { expect, test } from './electron.fixture'
import { importPhotos } from './import.helpers'

for (const [label, key] of [
  ['Highlights', 'highlights'],
  ['Shadows', 'shadows'],
  ['Whites', 'whites'],
  ['Blacks', 'blacks'],
] as const) {
  test(`${label} gestures, cancellation, control switching, external conflicts and shutdown share history`, async ({
    luma,
  }, info) => {
    const { page, app } = luma
    await importPhotos(app, page, ['tests/fixtures/photos/alpine-lake.jpg'])
    const slider = page.getByRole('slider', { name: label, exact: true })
    const field = page.getByRole('spinbutton', { name: `${label} value` })
    await expect(slider).toBeEnabled({ timeout: 20000 })
    await page.evaluate(() => {
      const errors: string[] = []
      const caption = document.querySelector('[data-testid="preview-resolution"]')!
      const observer = new MutationObserver(() => {
        if (caption.textContent?.includes('unavailable'))
          errors.push(caption.getAttribute('title') ?? '')
      })
      observer.observe(caption, { subtree: true, childList: true, attributes: true })
      Object.assign(window, { highlightsPreviewErrors: errors })
    })
    const id = (await page.evaluate(() => window.luma.listPhotos())).photos[0].id
    const state = () => page.evaluate((id) => window.luma.getEdits(id), id)
    await expect(field).toHaveValue('0')
    await slider.focus()
    for (let i = 0; i < 20; i++) await page.keyboard.down('ArrowRight')
    await expect(slider).toHaveValue('20')
    expect((await state()).revision).toBe(0)
    await expect(page.getByTestId('main-preview')).toHaveAttribute(`data-${key}`, '20')
    await page.keyboard.up('ArrowRight')
    await expect.poll(state).toMatchObject({ revision: 1, settings: { [key]: 20 } })
    await page.keyboard.down('ArrowRight')
    await page.keyboard.press('Escape')
    await page.keyboard.up('ArrowRight')
    await expect(field).toHaveValue('20')
    await page.keyboard.down('ArrowRight')
    await slider.dispatchEvent('pointercancel', { pointerId: 1 })
    await page.keyboard.up('ArrowRight')
    await expect(field).toHaveValue('20')
    for (const value of ['0.5', '101', '-101']) {
      await field.fill(value)
      await field.press('Enter')
      await expect(field).toHaveValue('20')
      expect((await state()).revision).toBe(1)
    }
    await field.fill('-40')
    // Moving directly between controls flushes the old gesture before the new edit.
    const exposure = page.getByRole('spinbutton', { name: 'Exposure value' })
    await exposure.focus()
    await expect.poll(state).toMatchObject({ revision: 2, settings: { [key]: -40 } })
    await expect(exposure).toBeEnabled()
    await exposure.fill('0.5')
    await exposure.press('Enter')
    await expect
      .poll(state)
      .toMatchObject({ revision: 3, settings: { [key]: -40, exposureEv: 0.5 } })
    await field.fill('50')
    await page.evaluate(({ id, key }) => window.luma.updateEdits(id, { [key]: 75 }, 3), { id, key })
    await expect(field).toHaveValue('75')
    await field.press('Enter')
    expect((await state()).revision).toBe(4)
    for (const settings of [
      { [key]: -40, exposureEv: 0.5 },
      { [key]: -40, exposureEv: 0 },
      { [key]: 20, exposureEv: 0 },
    ]) {
      await page.getByRole('button', { name: 'Undo', exact: true }).click()
      await expect.poll(state).toMatchObject({ settings })
    }
    await page.getByRole('button', { name: 'Redo', exact: true }).click()
    await expect.poll(state).toMatchObject({ settings: { [key]: -40 } })
    await page.getByTestId('console-toggle').click()
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1100, 700),
    )
    await slider.scrollIntoViewIfNeeded()
    await expect(slider).toBeInViewport()
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeInViewport()
    await expect
      .poll(
        async () => ({
          text: await page.getByTestId('preview-resolution').innerText(),
          error: await page.getByTestId('preview-resolution').getAttribute('title'),
        }),
        { timeout: 20000 },
      )
      .toMatchObject({ text: 'Full resolution' })
    await expect(page.getByTestId('main-preview')).toBeVisible()
    expect(
      await page.evaluate(
        () => (window as unknown as { highlightsPreviewErrors: string[] }).highlightsPreviewErrors,
      ),
    ).toEqual([])
    await page.screenshot({ path: info.outputPath(`${key}-console-1100x700.png`) })
    await slider.focus()
    await page.keyboard.down('ArrowRight')
    const restarted = await luma.restart()
    await expect(restarted.page.getByRole('spinbutton', { name: `${label} value` })).toHaveValue(
      '-39',
    )
  })

  test(`${label} pointer and numeric edits preserve the view, branch history and flush on photo switch`, async ({
    luma,
  }) => {
    const { app, page } = luma
    await importPhotos(app, page, [
      'tests/fixtures/photos/alpine-lake.jpg',
      'tests/fixtures/photos/mountain-ridge.jpg',
    ])
    await page.getByRole('button', { name: 'Select alpine-lake.jpg', exact: true }).click()
    await expect(page.getByTestId('preview-filename')).toHaveText('alpine-lake.jpg')
    const slider = page.getByRole('slider', { name: label, exact: true })
    const field = page.getByRole('spinbutton', { name: `${label} value` })
    await expect(slider).toBeEnabled({ timeout: 20000 })
    const id = (await page.evaluate(() => window.luma.listPhotos())).photos.find(
      (p) => p.filename === 'alpine-lake.jpg',
    )!.id
    const state = () => page.evaluate((id) => window.luma.getEdits(id), id)
    const viewport = page.getByTestId('preview-viewport')
    const preview = page.getByTestId('main-preview')
    await expect(preview).toHaveAttribute('aria-label', 'alpine-lake.jpg')
    await expect(viewport).toHaveAttribute('data-resolution', 'full')
    await expect(preview).toHaveAttribute('data-editing', 'ready')
    await page.getByRole('combobox', { name: 'Preview zoom' }).selectOption('2')
    await expect(viewport).toHaveAttribute('data-scale', '2')
    // The canvas is focusable; focusing its container can leave keys in the gallery.
    await preview.focus()
    await expect(preview).toBeFocused()
    await preview.press('ArrowLeft')
    await expect(page.getByTestId('preview-filename')).toHaveText('alpine-lake.jpg')
    const pan = await viewport.getAttribute('data-pan-x')
    await slider.scrollIntoViewIfNeeded()
    const box = (await slider.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.75, box.y + box.height / 2, { steps: 8 })
    expect((await state()).revision).toBe(0)
    await page.mouse.up()
    await expect.poll(state).toMatchObject({ revision: 1 })
    await expect(viewport).toHaveAttribute('data-scale', '2')
    await expect(viewport).toHaveAttribute('data-pan-x', pan!)
    await field.fill('')
    await field.pressSequentially('-65')
    await field.press('Enter')
    await expect.poll(state).toMatchObject({ revision: 2, settings: { [key]: -65 } })
    await page.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect.poll(state).toMatchObject({ revision: 3, canRedo: true })
    await field.fill('-30')
    await field.press('Tab')
    await expect
      .poll(state)
      .toMatchObject({ revision: 4, canRedo: false, settings: { [key]: -30 } })
    // A published catalog revision can precede the renderer finishing its save.
    await expect(slider).toBeEnabled()
    await slider.focus()
    await expect(slider).toBeFocused()
    await page.keyboard.down('ArrowRight')
    await expect(slider).toHaveValue('-29')
    await page.getByRole('button', { name: 'Select mountain-ridge.jpg', exact: true }).click()
    await page.keyboard.up('ArrowRight')
    await expect(field).toHaveValue('0')
    await expect.poll(state).toMatchObject({ revision: 5, settings: { [key]: -29 } })
    await page.getByRole('button', { name: 'Select alpine-lake.jpg', exact: true }).click()
    await expect(field).toHaveValue('-29')
    await expect(viewport).toHaveAttribute('data-mode', 'fit')
  })
}
