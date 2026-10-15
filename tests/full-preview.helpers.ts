import type { ElectronApplication } from '@playwright/test'
export async function holdFullPreview(
  app: ElectronApplication,
  channels: ('preview:request' | 'preview:hdr')[] = ['preview:request'],
) {
  return app.evaluateHandle(({ ipcMain }, channels) => {
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
    )._invokeHandlers
    let release!: () => void
    let failure = false
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    for (const channel of channels) {
      const original = handlers.get(channel)!
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (...args) => {
        await pending
        return failure ? { error: 'Preview generation timed out.' } : original(...args)
      })
    }
    return {
      release: () => release(),
      fail: () => {
        failure = true
      },
      succeed: () => {
        failure = false
      },
    }
  }, channels)
}
