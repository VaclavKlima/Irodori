import { test, expect } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { activateButton } from './button.helpers'
import { agentCliFixture, runAgentHook } from './agent-cli.helpers'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { agentTools } from '../src/main/agent/policy'

test('inspection rectangles are temporary, editable and cancellable at the Console-open minimum size', async ({
  irodori,
}, testInfo) => {
  const { app, page } = irodori
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await importPhotos(app, page, [
    'tests/fixtures/photos/alpine-lake.jpg',
    'tests/fixtures/photos/mountain-ridge.jpg',
  ])
  await activateButton(page.getByRole('button', { name: 'Select alpine-lake.jpg', exact: true }))
  await expect(page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready')
  const nativeWindow = await app.browserWindow(page)
  await nativeWindow.evaluate((window) => {
    window.unmaximize()
    window.setContentSize(1100, 700)
  })
  await activateButton(page.getByTestId('console-toggle'))
  await activateButton(page.getByRole('button', { name: 'Inspect region', exact: true }))
  const x = page.getByRole('textbox', { name: 'Inspection X', exact: true })
  await expect(x).toBeEnabled()
  const viewport = page.getByTestId('preview-viewport')
  const area = (await viewport.boundingBox())!
  await page.mouse.move(area.x + 100, area.y + 220)
  await page.mouse.down()
  await page.mouse.move(area.x + 160, area.y + 260)
  await page.mouse.up()
  await expect(page.getByTestId('inspection-region-frame')).toBeVisible()
  await activateButton(page.getByRole('button', { name: 'Clear', exact: true }))
  await expect(page.getByTestId('inspection-region-frame')).toHaveCount(0)
  for (const [label, value] of [
    ['X', '400'],
    ['Y', '350'],
    ['Width', '200'],
    ['Height', '150'],
  ]) {
    const field = page.getByRole('textbox', { name: `Inspection ${label}`, exact: true })
    await field.fill(value)
    await field.press('Enter')
  }
  const context = page.getByTestId('console-inspection-context')
  await expect(context).toHaveText('Next prompt · Region 400, 350 · 200 × 150 photo pixels')
  await x.fill('-5')
  await x.press('Enter')
  await expect(x).toHaveValue('400')
  await x.fill('555')
  await x.press('Escape')
  await expect(x).toHaveValue('400')
  await activateButton(page.getByRole('button', { name: 'Locate at 100%', exact: true }))
  await expect(page.getByTestId('preview-viewport')).toHaveAttribute('data-scale', '1')
  const frame = page.getByTestId('inspection-region-frame')
  await expect.poll(async () => (await frame.boundingBox())?.width).toBe(200)
  const before = await frame.boundingBox()
  expect(before).toBeTruthy()
  await page.mouse.move(before!.x + before!.width / 2, before!.y + before!.height / 2)
  await page.mouse.down()
  await page.mouse.move(before!.x + before!.width / 2 + 20, before!.y + before!.height / 2 + 10)
  await page.mouse.up()
  await expect(context).toContainText('Region 420, 360')
  const resize = page.locator('[data-region-handle="se"]')
  const handle = (await resize.boundingBox())!
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await page.mouse.down()
  await page.mouse.move(handle.x + handle.width / 2 + 10, handle.y + handle.height / 2 + 10)
  await page.mouse.up()
  await expect(context).toContainText('210 × 160')
  const moved = await frame.boundingBox()
  await page.mouse.move(moved!.x + moved!.width / 2, moved!.y + moved!.height / 2)
  await page.mouse.down()
  await page.mouse.move(moved!.x + moved!.width / 2 + 10, moved!.y + moved!.height / 2)
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await expect(context).toContainText('Region 420, 360')
  await expect(page.getByTestId('inspection-region-controls')).toBeVisible()
  await x.fill('555')
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('window:blur')
  })
  await expect(x).toHaveValue('420')
  // Interruption retains the committed rectangle for the next prompt.
  for (const interruption of ['capture', 'window'] as const) {
    const position = (await frame.boundingBox())!
    await page.mouse.move(position.x + position.width / 2, position.y + position.height / 2)
    await page.mouse.down()
    await page.mouse.move(position.x + position.width / 2 + 15, position.y + position.height / 2)
    if (interruption === 'capture')
      await page.getByTestId('inspection-region-overlay').dispatchEvent('lostpointercapture')
    else
      await app.evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) window.webContents.send('window:blur')
      })
    await page.mouse.up()
    await expect(context).toContainText('Region 420, 360')
  }
  const panBefore = await viewport.getAttribute('data-pan-x')
  const panFrame = (await frame.boundingBox())!
  await page.mouse.move(panFrame.x + panFrame.width / 2, panFrame.y + panFrame.height / 2)
  await page.mouse.down({ button: 'middle' })
  await page.mouse.move(panFrame.x + panFrame.width / 2 + 15, panFrame.y + panFrame.height / 2)
  await page.mouse.up({ button: 'middle' })
  await expect(viewport).not.toHaveAttribute('data-pan-x', panBefore!)
  await expect(context).toContainText('Region 420, 360')
  await page.screenshot({ path: testInfo.outputPath('1100-console-inspection.png'), scale: 'css' })
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
  const controls = await page.getByTestId('inspection-region-controls').boundingBox()
  expect(controls!.x + controls!.width).toBeLessThan(1100)
  const id = (await page.evaluate(() => window.irodori.listPhotos())).photos.find(
    (p) => p.filename === 'alpine-lake.jpg',
  )!.id
  expect((await page.evaluate((id) => window.irodori.getEdits(id), id)).revision).toBe(0)
  await activateButton(page.getByRole('button', { name: 'Done', exact: true }))
  await expect(context).toBeVisible()
  await page.evaluate(async (id) => {
    const edit = await window.irodori.getEdits(id)
    await window.irodori.updateEdits(id, { exposureEv: 0.2 }, edit.revision)
  }, id)
  await expect(context).toContainText('Region 420, 360')
  await page.evaluate(async (id) => {
    const edit = await window.irodori.getEdits(id)
    const before = await window.irodori.getPreviewContext(id, edit.revision)
    const next = await window.irodori.updateEdits(
      id,
      { crop: { ...edit.settings.crop, aspectRatio: before.width / before.height } },
      edit.revision,
    )
    const after = await window.irodori.getPreviewContext(id, next.revision)
    if (before.gridIdentity !== after.gridIdentity)
      throw new Error('An aspect lock alone changed the photograph coordinate grid.')
  }, id)
  await expect(context).toContainText('Region 420, 360')
  await activateButton(page.getByRole('button', { name: 'Select mountain-ridge.jpg', exact: true }))
  await expect(context).toHaveCount(0)
  await activateButton(page.getByRole('button', { name: 'Select alpine-lake.jpg', exact: true }))
  await expect(context).toHaveCount(0)
})

test('Console freezes the selected region after pending edit flush and rejects a changed grid', async ({
  irodori,
}) => {
  const { app, page } = irodori
  await importPhotos(app, page, ['tests/fixtures/photos/alpine-lake.jpg'])
  await expect(page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready')
  await activateButton(page.getByRole('button', { name: 'Inspect region', exact: true }))
  const field = page.getByRole('textbox', { name: 'Inspection X', exact: true })
  await expect(field).toBeEnabled()
  await field.fill('200')
  await field.press('Enter')
  const id = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id
  const executable = await agentCliFixture(irodori.userDataDir)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, executable)
  await page.evaluate(() => window.irodori.chooseAgentExecutable())
  await activateButton(page.getByTestId('console-toggle'))
  await activateButton(page.getByRole('button', { name: 'Connect Codex', exact: true }))
  const file = join(irodori.userDataDir, 'agent/workspace/fixture-connection.json')
  await expect
    .poll(async () => {
      try {
        return JSON.parse(await readFile(file, 'utf8')).session
      } catch {
        return null
      }
    })
    .toBeTruthy()
  const connection = JSON.parse(await readFile(file, 'utf8'))
  const env = {
    IRODORI_AGENT_CONNECTION: JSON.stringify(connection.connection),
    IRODORI_AGENT_REQUEST: join(irodori.userDataDir, 'agent/workspace/request.json'),
    IRODORI_AGENT_TOOLS: JSON.stringify(agentTools),
  }
  const exposure = page.getByRole('slider', { name: 'Exposure', exact: true })
  await exposure.focus()
  await page.keyboard.down('ArrowRight')
  const hook = JSON.parse(
    await runAgentHook(env, {
      hook_event_name: 'UserPromptSubmit',
      session_id: connection.session,
      turn_id: 'region',
      prompt: 'Inspect this detail.',
    }),
  )
  await page.keyboard.up('ArrowRight')
  const frozen = JSON.parse(hook.hookSpecificOutput.additionalContext.split('\n')[1])
  expect(frozen).toMatchObject({ inspection: { photoId: id, region: { units: 'pixels', x: 200 } } })
  expect(frozen.active.revision).toBeGreaterThan(0)
  // A geometry change invalidates even an equally sized 180-degree rotation.
  await page.evaluate(async (id) => {
    const edit = await window.irodori.getEdits(id)
    await window.irodori.updateEdits(
      id,
      { crop: { ...edit.settings.crop, quarterTurns: 2 } },
      edit.revision,
    )
  }, id)
  await expect(page.getByTestId('console-inspection-context')).toHaveCount(0)
  expect(frozen.inspection.region.x).toBe(200)
})
