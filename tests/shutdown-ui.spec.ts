/* eslint-disable no-empty-pattern -- Playwright requires destructured fixtures when only testInfo is used. */
import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  launchShutdown,
  injectShutdown,
  shutdownState,
  clearFault,
  type ShutdownFixture,
} from './shutdown.helpers'
import { importPhotos } from './import.helpers'

test('missing acknowledgement uses the real 10-second deadline; Retry saves afresh and Electron actually exits', async ({}, info) => {
  const f = await launchShutdown(info)
  const evidence = info.outputPath('recovery.json')
  try {
    await injectShutdown(f, 'silence', ['retry'])
    await f.app.evaluate(({ dialog }, file) => {
      const show = dialog.showMessageBox
      dialog.showMessageBox = async (...args: unknown[]) => {
        process.getBuiltinModule('fs').writeFileSync(file, JSON.stringify(args.at(-1)))
        return show(...(args as [Electron.BrowserWindow, Electron.MessageBoxOptions]))
      }
    }, evidence)
    const started = Date.now()
    await f.quit()
    await f.exited()
    expect(Date.now() - started).toBeGreaterThanOrEqual(9900)
    const box = JSON.parse(await readFile(evidence, 'utf8'))
    expect(box).toMatchObject({
      title: 'Saving could not be confirmed',
      buttons: ['Keep open', 'Retry saving', 'Quit anyway'],
      defaultId: 0,
      cancelId: 0,
    })
    expect(box.detail).toContain('did not respond within 10 seconds')
    expect(box.detail).not.toMatch(/disk failure/i)
  } finally {
    await f.cleanup()
  }
})

test('synchronous preload save errors preserve their reason; Keep open restores editing, task admission and Console state', async ({}, info) => {
  const f = await launchShutdown(info)
  try {
    await importPhotos(f.app, f.page)
    await f.page.getByTestId('console-toggle').click()
    await injectShutdown(f, 'none', ['keep'])
    await f.page.evaluate(() => {
      const stop = window.irodori.onFlushEdits(() => {
        throw new Error('Injected synchronous save failure')
      })
      Object.assign(window, { stopShutdownFailure: stop })
    })
    await f.quit()
    await expect.poll(async () => (await shutdownState(f)).dialogs.length).toBe(1)
    expect((await shutdownState(f)).dialogs[0]).toMatchObject({
      title: 'Could not finish saving',
      detail: expect.stringContaining('Injected synchronous save failure'),
    })
    expect(f.child.exitCode).toBeNull()
    await expect(f.page.getByTestId('console-panel')).toBeVisible()
    await f.page.evaluate(() =>
      (window as unknown as { stopShutdownFailure(): void }).stopShutdownFailure(),
    )
    const state = await f.page.evaluate(async () => {
      const id = (await window.irodori.listPhotos()).photos[0].id
      const edits = await window.irodori.getEdits(id)
      return window.irodori.updateEdits(id, { exposureEv: 0.75 }, edits.revision)
    })
    expect(state.settings.exposureEv).toBe(0.75)
    await f.quit()
    await f.exited()
  } finally {
    await f.cleanup()
  }
})

for (const fault of ['crash', 'reload', 'hang'] as const)
  test(`renderer ${fault} has independent native recovery and orderly process exit`, async ({}, info) => {
    const f = await launchShutdown(info)
    try {
      await injectShutdown(f, fault, fault === 'reload' ? ['keep'] : ['quit'])
      await f.quit()
      if (fault === 'reload') {
        await expect.poll(async () => (await shutdownState(f)).dialogs.length).toBe(1)
        const box = (await shutdownState(f)).dialogs[0]
        expect(box.detail).toContain('reloaded or navigated')
        await expect(f.page.getByTestId('app-version')).not.toBeEmpty()
        await clearFault(f)
        await f.quit()
      }
      await f.exited()
    } finally {
      await f.cleanup()
    }
  })

test('Quit anyway waits for an accepted catalog publication, preserves original bytes and reopens its committed history', async ({}, info) => {
  const f = await launchShutdown(info)
  let reopened: ShutdownFixture | undefined
  try {
    await importPhotos(f.app, f.page)
    const photo = (await f.page.evaluate(() => window.irodori.listPhotos())).photos[0]
    const originalPath = join(f.root, 'library/originals', photo.id, 'original.jpg')
    const original = await readFile(originalPath)
    await f.app.evaluate(() => {
      const Worker = process.getBuiltinModule('worker_threads').Worker
      const post = Worker.prototype.postMessage
      const heldWorkers = new WeakSet<InstanceType<typeof Worker>>()
      const pending: (() => void)[] = []
      Worker.prototype.postMessage = function (...args: Parameters<typeof post>) {
        const message = args[0] as { type?: string; command?: { operation?: string } }
        if (
          heldWorkers.has(this) ||
          (message.type === 'mutate' && message.command?.operation === 'edits.commit')
        ) {
          heldWorkers.add(this)
          pending.push(() => post.call(this, ...args))
          Object.assign(globalThis, {
            shutdownPublicationHeld: true,
            releaseShutdownPublication: () => {
              Worker.prototype.postMessage = post
              heldWorkers.delete(this)
              for (const send of pending.splice(0)) send()
            },
          })
          return
        }
        post.call(this, ...args)
      }
    })
    await f.page.evaluate((id) => {
      void window.irodori.updateEdits(id, { exposureEv: 1.5 }, 0).catch(() => {})
    }, photo.id)
    await expect
      .poll(() =>
        f.app.evaluate(
          () =>
            (globalThis as unknown as { shutdownPublicationHeld: boolean }).shutdownPublicationHeld,
        ),
      )
      .toBe(true)
    await injectShutdown(f, 'error', ['quit'])
    await f.quit()
    await expect.poll(async () => (await shutdownState(f)).dialogs.length).toBe(1)
    // Accepted work retains its renderer. New mutations are refused while the drain waits.
    await expect
      .poll(() =>
        f.page.evaluate(
          async (id) =>
            window.irodori.updateEdits(id, { exposureEv: 2 }, 0).then(
              () => 'accepted',
              (error) => String(error),
            ),
          photo.id,
        ),
      )
      .toContain('closing')
    expect(f.child.exitCode).toBeNull()
    const resourceReply = await f.app.evaluate(
      ({ BrowserWindow, ipcMain }) =>
        new Promise<{ replied: boolean; error?: string }>((resolve, reject) => {
          const contents = BrowserWindow.getAllWindows()[0].webContents
          const token = process.getBuiltinModule('crypto').randomUUID()
          const timer = setTimeout(() => {
            ipcMain.removeListener('resources:image-reply', reply)
            reject(new Error('The draining editor lost its resource-reply handler.'))
          }, 3000)
          const reply = (
            event: Electron.IpcMainEvent,
            returned: string,
            _bytes: unknown,
            error?: string,
          ) => {
            if (
              returned !== token ||
              event.sender !== contents ||
              event.senderFrame !== contents.mainFrame
            )
              return
            clearTimeout(timer)
            ipcMain.removeListener('resources:image-reply', reply)
            resolve({ replied: true, error })
          }
          ipcMain.on('resources:image-reply', reply)
          contents.send('resources:image-query', token)
        }),
    )
    expect(resourceReply).toEqual({ replied: true, error: undefined })
    await f.app.evaluate(() =>
      (
        globalThis as unknown as { releaseShutdownPublication(): void }
      ).releaseShutdownPublication(),
    )
    await f.exited()
    expect(await readFile(originalPath)).toEqual(original)
    reopened = await launchShutdown(info, f.root)
    const edits = await reopened.page.evaluate((id) => window.irodori.getEdits(id), photo.id)
    expect(edits).toMatchObject({ revision: 1, settings: { exposureEv: 1.5 }, canUndo: true })
    expect(await readFile(originalPath)).toEqual(original)
    await reopened.quit()
    await reopened.exited()
  } finally {
    await reopened?.cleanup()
    await f.cleanup()
  }
})

test('repeated Quit and window Close share one native recovery choice', async ({}, info) => {
  const f = await launchShutdown(info)
  try {
    await injectShutdown(f, 'error', ['keep'])
    await f.app.evaluate(({ app, BrowserWindow, dialog }) => {
      const show = dialog.showMessageBox
      dialog.showMessageBox = async (...args: unknown[]) => {
        // Re-enter both owners while the first dialog is still awaiting its result.
        app.quit()
        BrowserWindow.getAllWindows()[0].close()
        return show(...(args as [Electron.BrowserWindow, Electron.MessageBoxOptions]))
      }
      setImmediate(() => app.quit())
    })
    await expect.poll(async () => (await shutdownState(f)).dialogs.length).toBe(1)
    await clearFault(f)
    await f.quit()
    await f.exited()
  } finally {
    await f.cleanup()
  }
})
