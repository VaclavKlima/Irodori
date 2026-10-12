import { test, expect } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { foregroundImport } from './import-foreground.helpers'
import { join } from 'node:path'
import { mkdir, readdir } from 'node:fs/promises'

test('visible editing pauses transfer, heartbeats persist during a gesture, and idle/reload/cancellation release it', async ({
  luma,
}, info) => {
  const { app, page } = luma
  await (
    await app.browserWindow(page)
  ).evaluate((window) => {
    window.setContentSize(1100, 700)
    window.focus()
  })
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([1100, 700])
  await importPhotos(app, page)
  await expect(page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready')
  await page.getByRole('button', { name: 'Console', exact: true }).click()
  const id = await foregroundImport(app, page, info)
  await page.getByTestId('task-progress').click()
  await expect(page.getByTestId(`task-${id}`)).toContainText('0 / 6 photos imported')
  const slider = page.getByRole('slider', { name: 'Exposure', exact: true })
  await slider.focus()
  await page.keyboard.down('ArrowRight')
  await expect
    .poll(() =>
      page.evaluate(
        async (id) => (await window.luma.listTasks()).find((t) => t.id === id)?.waitingReason,
        id,
      ),
    )
    .toBe('foreground')
  const held = await page.evaluate(async (id) => {
    const demand = (await window.luma.listTasks()).find((t) => t.id === id)!
    // An admitted chunk finishes before copying hands off foreground priority.
    await new Promise((resolve) => setTimeout(resolve, 150))
    const before = (await window.luma.listTasks()).find((t) => t.id === id)!
    await new Promise((resolve) => setTimeout(resolve, 1200))
    return { demand, before, after: (await window.luma.listTasks()).find((t) => t.id === id)! }
  }, id)
  expect(held.before.transfer!.bytes - held.demand.transfer!.bytes).toBeLessThanOrEqual(4096)
  expect(held.after.transfer!.bytes).toBe(held.before.transfer!.bytes)
  expect(held.after.progress!.total).toBe(held.before.progress!.total)
  await page.keyboard.up('ArrowRight')
  await expect
    .poll(() =>
      page.evaluate(
        async (id) =>
          (await window.luma.listTasks()).find((t) => t.id === id)?.transfer?.bytes ?? 0,
        id,
      ),
    )
    .toBeGreaterThan(held.after.transfer!.bytes)
  await page.reload()
  await expect(page.getByTestId('workspace')).toBeVisible()
  await expect
    .poll(() =>
      page.locator('[data-testid^="photo-card-"] img').evaluateAll(
        (images) =>
          images.length >= 2 &&
          images.every((image) => {
            const thumbnail = image as HTMLImageElement
            return thumbnail.complete && thumbnail.naturalWidth > 0
          }),
      ),
    )
    .toBe(true)
  await page.evaluate((id) => window.luma.cancelTask(id), id)
  expect(
    await page.evaluate(
      async (id) => (await window.luma.listTasks()).find((t) => t.id === id)?.status,
      id,
    ),
  ).toBe('cancelled')
  expect(await readdir(join(luma.userDataDir, 'library', 'staging'))).toEqual([])
})
test('confirmed deletion takes the status bar while accepted import waits and remains independently cancellable', async ({
  luma,
}, info) => {
  const { app, page } = luma
  await importPhotos(app, page)
  const trash = join(luma.userDataDir, 'isolated-trash')
  await mkdir(trash)
  await app.evaluate(({ shell }, trash) => {
    const fs = process.getBuiltinModule('fs') as typeof import('node:fs')
    const paths = process.getBuiltinModule('path') as typeof import('node:path')
    shell.trashItem = async (path) => {
      await new Promise<void>((resolve) =>
        Object.assign(globalThis, { finishIsolatedTrash: resolve }),
      )
      await fs.promises.rename(path, paths.join(trash, paths.basename(path)))
    }
  }, trash)
  const id = await foregroundImport(app, page, info)
  await page.getByTestId('main-preview').focus()
  await page.keyboard.press('Delete')
  await expect(page.getByRole('dialog', { name: /Delete/ })).toBeVisible()
  await page.getByRole('button', { name: 'Move to Trash', exact: true }).click()
  await expect(page.getByTestId('task-progress')).toContainText('Moving photos to Trash')
  await page.getByTestId('task-progress').click()
  await expect(page.getByTestId(`task-${id}`)).toContainText('Waiting for merge or deletion')
  await app.evaluate(() =>
    (globalThis as typeof globalThis & { finishIsolatedTrash: () => void }).finishIsolatedTrash(),
  )
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const task = (await window.luma.listTasks()).find((t) => t.kind === 'delete')!
        return { status: task.status, errors: await window.luma.getTaskErrors(task.id) }
      }),
    )
    .toEqual({ status: 'completed', errors: { total: 0, errors: [] } })
  expect(await readdir(trash)).toHaveLength(1)
  await page.evaluate((id) => window.luma.cancelTask(id), id)
  expect(await readdir(join(luma.userDataDir, 'library', 'staging'))).toEqual([])
})
