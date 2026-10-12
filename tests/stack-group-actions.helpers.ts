import type { ElectronApplication, Page } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'

export const groupSources = [
  'alpine-lake',
  'mountain-ridge',
  'forest-light',
  'coastal-dunes',
  'quiet-valley',
].map((name) => `tests/fixtures/photos/${name}.jpg`)

export async function numberedGroupSources(root: string, count: number) {
  const directory = join(root, 'group-sources')
  await mkdir(directory, { recursive: true })
  const paths: string[] = []
  for (let i = 0; i < count; i++) {
    const path = join(directory, `group-photo-${String(i).padStart(3, '0')}.png`)
    await writeFile(
      path,
      await sharp({
        create: { width: 16, height: 12, channels: 3, background: { r: i * 3, g: 20, b: 50 } },
      })
        .png()
        .toBuffer(),
    )
    paths.push(path)
  }
  return paths
}
export async function allGroupPhotos(page: Page) {
  const first = await page.evaluate(() => window.luma.listPhotos())
  const rest =
    first.total > 60 ? (await page.evaluate(() => window.luma.listPhotos(60))).photos : []
  return [...first.photos, ...rest]
}
export async function createGroup(page: Page, ids: string[], expanded = false) {
  return page.evaluate(
    async ({ ids, expanded }) => {
      const stack = await window.luma.groupPhotos(
        ids,
        ids[0],
        (await window.luma.listStacks()).revision,
      )
      return expanded ? window.luma.setStackExpanded(stack.id, true, stack.revision) : stack
    },
    { ids, expanded },
  )
}
export function groupDeletionNames(page: Page) {
  return page
    .getByRole('dialog')
    .getByRole('list', { name: 'Photos to move to Trash' })
    .getByRole('listitem')
    .allTextContents()
}

export async function holdGroupOperation(app: ElectronApplication, channel = 'stacks:snapshot') {
  return app.evaluateHandle(({ ipcMain }, channel) => {
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
    )._invokeHandlers
    const original = handlers.get(channel)!
    const calls: { args: unknown[]; resolve: () => void; reject: () => void }[] = []
    const expectedErrors: string[] = []
    const originalError = console.error
    console.error = (...args) => {
      if (
        args[0] === `Error occurred in handler for '${channel}':` &&
        args[1] instanceof Error &&
        args[1].message === 'Action resolution failed.'
      ) {
        expectedErrors.push(args[1].message)
        return
      }
      originalError(...args)
    }
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (...args) => {
      const result = await original(...args)
      return new Promise((resolve, reject) =>
        calls.push({
          args: args.slice(1),
          resolve: () => resolve(result),
          reject: () => reject(new Error('Action resolution failed.')),
        }),
      )
    })
    return {
      calls,
      expectedErrors,
      restore: () => {
        calls.forEach((call) => call.resolve())
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, original)
        console.error = originalError
      },
    }
  }, channel)
}

export async function expectStackErrors(app: ElectronApplication) {
  return app.evaluateHandle(() => {
    const expectedErrors: string[] = []
    const originalError = console.error
    console.error = (...args) => {
      if (
        args[0] === "Error occurred in handler for 'stacks:snapshot':" &&
        args[1] instanceof Error &&
        ['Stale stack revision. Reload the stack.', 'This stack is unavailable.'].includes(
          args[1].message,
        )
      ) {
        expectedErrors.push(args[1].message)
        return
      }
      originalError(...args)
    }
    return {
      expectedErrors,
      restore: () => {
        console.error = originalError
      },
    }
  })
}

/** Snapshot contract fixtures isolate menu input routing from RAW decoding and publication. */
export async function fixtureGroupMerge(app: ElectronApplication, derivedIds: string[] = []) {
  return app.evaluateHandle(({ ipcMain }, derivedIds) => {
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
    )._invokeHandlers
    const originalSnapshot = handlers.get('stacks:snapshot')!
    const originalMerge = handlers.get('merge:create')!
    let derived = derivedIds
    let format = 'ARW'
    const merges: { ids: string[]; mode: string }[] = []
    ipcMain.removeHandler('stacks:snapshot')
    ipcMain.handle('stacks:snapshot', async (...args) => {
      const value = (await originalSnapshot(
        ...args,
      )) as import('../src/shared/stacks').StackSnapshot
      return {
        ...value,
        photos: value.photos.map((p) => ({
          ...p,
          assetKind: derived.includes(p.id) ? 'derived' : 'original',
          format: derived.includes(p.id) ? 'LUMA HDR' : format,
        })),
      }
    })
    ipcMain.removeHandler('merge:create')
    ipcMain.handle('merge:create', (...args) => {
      merges.push({ ids: [...(args[1] as string[])], mode: args[2] as string })
      return originalMerge(...args)
    })
    return {
      merges,
      set: (value: { derived: string[]; format?: string }) => {
        derived = value.derived
        format = value.format ?? 'ARW'
      },
      restore: () => {
        ipcMain.removeHandler('stacks:snapshot')
        ipcMain.handle('stacks:snapshot', originalSnapshot)
        ipcMain.removeHandler('merge:create')
        ipcMain.handle('merge:create', originalMerge)
      },
    }
  }, derivedIds)
}
