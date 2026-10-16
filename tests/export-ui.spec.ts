import { mkdir, readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { test, expect } from './electron.fixture'
import { choose, importPhotos } from './import.helpers'
import { holdBrowseSelections, seedLargeBrowser } from './all-photos.helpers'
import { DEFAULT_BROWSE_QUERY } from '../src/shared/browse'

test('an active export permits a new file import while preserving the current photo and selection', async ({
  luma,
}) => {
  const { app, page } = luma
  await importPhotos(app, page)
  const photos = (await page.evaluate(() => window.luma.listPhotos())).photos
  await page.getByTestId(`photo-card-${photos[0].id}`).click()
  await page.getByTestId(`photo-card-${photos[1].id}`).click({ modifiers: ['ControlOrMeta'] })
  await expect(page.getByTestId('preview-filename')).toHaveText(photos[1].filename)
  for (const photo of photos)
    await expect(page.getByTestId(`photo-card-${photo.id}`)).toHaveAttribute(
      'aria-selected',
      'true',
    )
  const destination = join(luma.userDataDir, 'exports')
  await mkdir(destination)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, destination)
  // Hold only the real export worker's initial IPC message. Admission, source
  // validation, cancellation, scanning and both background jobs remain production code.
  const hold = await app.evaluateHandle(() => {
    const children = process.getBuiltinModule(
      'child_process',
    ) as typeof import('node:child_process')
    const original = children.fork
    const pending: (() => void)[] = []
    let held = true,
      calls = 0
    children.fork = ((...args: Parameters<typeof children.fork>) => {
      const child = original(...args)
      if (String(args[0]).endsWith('export-worker.js')) {
        const send = child.send
        child.send = ((...message: unknown[]) => {
          if (!held) return Reflect.apply(send, child, message) as boolean
          calls++
          pending.push(() => {
            if (child.connected && !child.killed) Reflect.apply(send, child, message)
          })
          return true
        }) as typeof child.send
      }
      return child
    }) as typeof children.fork
    process.getBuiltinModule('module').syncBuiltinESMExports()
    const release = () => {
      held = false
      for (const send of pending.splice(0)) send()
    }
    return {
      get calls() {
        return calls
      },
      release,
      restore: () => {
        release()
        children.fork = original
        process.getBuiltinModule('module').syncBuiltinESMExports()
      },
    }
  })
  try {
    await page.getByRole('button', { name: 'Export photo', exact: true }).click()
    const chooser = page.getByRole('dialog', { name: 'Export JPEG', exact: true })
    await chooser.getByRole('button', { name: 'Change folder…' }).click()
    await chooser.getByRole('button', { name: /High quality/ }).click()
    await expect.poll(() => hold.evaluate((gate) => gate.calls)).toBeGreaterThan(0)
    const exportId = await page.evaluate(
      async () =>
        (await window.luma.listTasks()).find(
          (task) => task.kind === 'export' && task.status === 'running',
        )!.id,
    )
    await page.getByRole('button', { name: 'Close task details', exact: true }).click()
    await page.getByRole('button', { name: 'Import photos', exact: true }).click()
    await choose(app, page, ['tests/fixtures/photos/forest-light.jpg'])
    await expect(page.getByTestId('import-status')).toContainText('Ready to import', {
      timeout: 30000,
    })
    await expect(page.getByTestId('import-status')).toContainText('1 awaiting checks')
    const previousImports = await page.evaluate(async () =>
      (await window.luma.listTasks())
        .filter((task) => task.kind === 'import')
        .map((task) => task.id),
    )
    await page.getByRole('button', { name: 'Import 1 photos', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const importId = await page.evaluate(
      async (previous) =>
        (await window.luma.listTasks()).find(
          (task) => task.kind === 'import' && !previous.includes(task.id),
        )!.id,
      previousImports,
    )
    await expect(page.getByTestId('preview-filename')).toHaveText(photos[1].filename)
    for (const photo of photos)
      await expect(page.getByTestId(`photo-card-${photo.id}`)).toHaveAttribute(
        'aria-selected',
        'true',
      )
    await hold.evaluate((gate) => gate.release())
    await expect
      .poll(
        () =>
          page.evaluate(
            async (ids) =>
              Object.fromEntries(
                (await window.luma.listTasks())
                  .filter((task) => ids.includes(task.id))
                  .map((task) => [task.id, task.status]),
              ),
            [exportId, importId],
          ),
        { timeout: 30000 },
      )
      .toEqual({ [exportId]: 'completed', [importId]: 'completed' })
    expect((await page.evaluate(() => window.luma.listPhotos())).total).toBe(3)
    await expect(page.getByTestId('preview-filename')).toHaveText(photos[1].filename)
    for (const photo of photos)
      await expect(page.getByTestId(`photo-card-${photo.id}`)).toHaveAttribute(
        'aria-selected',
        'true',
      )
    expect((await readdir(destination)).sort()).toEqual(['alpine-lake.jpg', 'mountain-ridge.jpg'])
    expect(await readdir(join(luma.userDataDir, 'library', 'staging'))).toEqual([])
    expect(
      await readdir(join(luma.userDataDir, 'library', 'export-work', exportId)).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      }),
    ).toEqual([])
  } finally {
    await hold.evaluate((gate) => gate.restore())
    await hold.dispose()
  }
})

test('chooser reuses the destination, picker cancellation changes no preferences and retained results show counts', async ({
  luma,
}) => {
  const { app, page } = luma
  await importPhotos(app, page, ['tests/fixtures/photos/alpine-lake.jpg'])
  const destination = join(luma.userDataDir, 'exports')
  await mkdir(destination)
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
  })
  await page.getByRole('button', { name: 'Export photo', exact: true }).click()
  const chooser = page.getByRole('dialog', { name: 'Export JPEG', exact: true })
  await expect(chooser).toContainText('1 photo · 0 HDR · 1 SDR')
  await expect(chooser.getByRole('button', { name: /Last custom/ })).toBeDisabled()
  await chooser.getByRole('button', { name: /High quality/ }).click()
  await expect(chooser).toBeVisible()
  expect((await page.evaluate(() => window.luma.getExportPreferences())).destination).toBeNull()
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, destination)
  await chooser.getByRole('button', { name: 'Change folder…' }).click()
  await expect(chooser).toContainText(destination)
  await chooser.getByRole('button', { name: /High quality/ }).click()
  await expect(chooser).toHaveCount(0)
  await expect(page.getByTestId('task-details')).toContainText(
    '1 exported · 0 skipped · 0 failed',
    { timeout: 20000 },
  )
  await expect(page.getByRole('button', { name: 'Show in folder', exact: true })).toBeVisible()
  await expect.poll(() => readdir(destination)).toEqual(['alpine-lake.jpg'])
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => {
      throw new Error('Remembered destination must avoid the picker.')
    }
  })
  await page.getByRole('button', { name: 'Export photo', exact: true }).click()
  await chooser.getByRole('button', { name: /Maximum quality/ }).click()
  await expect.poll(() => readdir(destination)).toEqual(['alpine-lake (2).jpg', 'alpine-lake.jpg'])
})

test('Custom is keyboard-accessible at minimum size, persists only on acceptance, and Last custom survives restart', async ({
  luma,
}) => {
  let { app, page } = luma
  await importPhotos(app, page, ['tests/fixtures/photos/alpine-lake.jpg'])
  const destination = join(luma.userDataDir, 'exports')
  await mkdir(destination)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, destination)
  const nativeWindow = await app.browserWindow(page)
  await nativeWindow.evaluate((w) => w.setContentSize(1100, 700))
  await page.getByTestId('console-toggle').click()
  await page.getByRole('button', { name: 'Export photo', exact: true }).click()
  await page.getByRole('button', { name: /Custom…/ }).click()
  const custom = page.getByRole('dialog', { name: 'Custom JPEG export' })
  await expect(custom).toBeVisible()
  await custom.getByRole('combobox', { name: 'Output', exact: true }).selectOption('hdr')
  await expect(custom).toContainText('1 photo does not support HDR JPEG')
  await expect(custom.getByRole('button', { name: 'Export', exact: true })).toBeDisabled()
  await custom.getByRole('combobox', { name: 'Output', exact: true }).selectOption('sdr')
  await custom.getByRole('spinbutton', { name: 'JPEG quality value' }).fill('84')
  await custom.getByRole('spinbutton', { name: 'JPEG quality value' }).press('Escape')
  await expect(custom.getByRole('spinbutton', { name: 'JPEG quality value' })).toHaveValue('90')
  await custom.getByRole('spinbutton', { name: 'JPEG quality value' }).fill('84')
  await custom.getByRole('spinbutton', { name: 'JPEG quality value' }).press('Enter')
  await custom.getByRole('combobox', { name: 'Names', exact: true }).selectOption('sequence')
  await custom.getByLabel('Prefix', { exact: true }).fill('Trip-')
  await custom.getByRole('combobox', { name: 'Size', exact: true }).selectOption('longest')
  await custom.getByLabel('Longest edge (px)').fill('101')
  await custom.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect((await page.evaluate(() => window.luma.getExportPreferences())).lastCustom).toBeNull()
  await page.getByRole('button', { name: 'Export photo', exact: true }).click()
  await page.getByRole('button', { name: /Custom…/ }).click()
  await custom.getByRole('spinbutton', { name: 'JPEG quality value' }).fill('83')
  await custom.getByRole('spinbutton', { name: 'JPEG quality value' }).press('Enter')
  await custom.getByRole('combobox', { name: 'Metadata', exact: true }).selectOption('none')
  await page.screenshot({ path: test.info().outputPath('export-custom-1100.png') })
  const box = await custom.boundingBox()
  expect(box!.height).toBeLessThanOrEqual(660)
  await custom.getByRole('button', { name: 'Export', exact: true }).click()
  await expect(custom).toHaveCount(0)
  await expect.poll(() => readdir(destination)).toEqual(['alpine-lake.jpg'])
  ;({ app, page } = await luma.restart())
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => {
      throw new Error('Unexpected picker after restart.')
    }
  })
  await page.getByRole('button', { name: 'Export photo', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('JPEG quality 83')
  await page.getByRole('button', { name: /Last custom/ }).click()
  await expect.poll(() => readdir(destination)).toHaveLength(2)
  expect((await page.evaluate(() => window.luma.getExportPreferences())).lastCustom).toMatchObject({
    quality: 83,
    metadata: 'none',
  })
})

test('header export awaits pending ranges and includes unloaded photos hidden by a later Library filter', async ({
  luma,
}) => {
  test.setTimeout(90000)
  await seedLargeBrowser(luma.app, luma.page, luma.userDataDir, 125)
  const { app, page } = await luma.restart()
  await page
    .getByRole('navigation', { name: 'Workspaces' })
    .getByRole('button', { name: 'Library', exact: true })
    .click()
  const references = await page.evaluate(
    (query) => window.luma.getBrowseSection(query, '2026-10-04'),
    DEFAULT_BROWSE_QUERY,
  )
  await page.getByTestId(`browse-photo-${references[0].id}`).click()
  const hold = await holdBrowseSelections(app)
  try {
    await page.getByTestId(`browse-photo-${references[2].id}`).click({ modifiers: ['Shift'] })
    await expect.poll(() => hold.evaluate((h) => h.calls.length)).toBe(1)
    await page.getByRole('checkbox', { name: 'Select 4 October 2026', exact: true }).click()
    await page.getByRole('searchbox', { name: 'Search photos' }).fill(references.at(-1)!.filename)
    await expect(page.getByTestId('browse-selection-count')).toContainText('1 matching')
    await page.getByRole('button', { name: 'Export photo', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await hold.evaluate((h) => h.calls[0].release())
    await expect.poll(() => hold.evaluate((h) => h.calls.length)).toBe(2)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await hold.evaluate((h) => h.calls[1].release())
    await expect(page.getByRole('dialog')).toContainText('125 photos · 0 HDR · 125 SDR')
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.getByTestId(`browse-photo-${references.at(-1)!.id}`).click({ button: 'right' })
    await expect(
      page.getByRole('menuitem', { name: 'Export this photo…', exact: true }),
    ).toBeVisible()
    await page.getByRole('menuitem', { name: 'Export this photo…', exact: true }).click()
    await expect(page.getByRole('dialog')).toContainText('1 photo · 0 HDR · 1 SDR')
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  } finally {
    await hold.evaluate((h) => h.restore())
    await hold.dispose()
  }
})

test('editing MCP shares export validation, opaque destination grants and retained job results', async ({
  luma,
}) => {
  const { app, page } = luma
  await importPhotos(app, page, ['tests/fixtures/photos/alpine-lake.jpg'])
  const destination = join(luma.userDataDir, 'exports')
  await mkdir(destination)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, destination)
  const grant = await page.evaluate(() => window.luma.chooseExportDestination())
  const id = (await page.evaluate(() => window.luma.listPhotos())).photos[0].id
  const client = new Client({ name: 'export-test', version: '1' })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('scripts/editor-mcp.mjs')],
    env: { ...(process.env as Record<string, string>), LUMA_PROFILE: luma.userDataDir },
  })
  try {
    await client.connect(transport)
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args })
      expect(result.isError).not.toBe(true)
      return result.structuredContent as Record<string, unknown>
    }
    expect(await call('luma_get_export_capabilities')).toMatchObject({
      format: 'jpeg',
      hdr: 'iso-21496-1',
    })
    const preparation = await call('luma_prepare_export', { ids: [id] })
    const rejected = await client.callTool({
      name: 'luma_start_export',
      arguments: {
        exportRequest: {
          preparationId: preparation.id,
          destinationId: '/arbitrary/path',
          action: 'high',
        },
      },
    })
    expect(rejected.isError).toBe(true)
    const result = await call('luma_start_export', {
      exportRequest: { preparationId: preparation.id, destinationId: grant!.id, action: 'high' },
    })
    await expect
      .poll(async () => (await call('luma_get_export_results', { taskId: result.taskId })).results)
      .toMatchObject([{ photoId: id, status: 'exported', outputName: 'alpine-lake.jpg' }])
    expect((await readFile(join(destination, 'alpine-lake.jpg'))).byteLength).toBeGreaterThan(100)
  } finally {
    await client.close()
    await transport.close()
  }
})
