import type { ElectronApplication } from '@playwright/test'
/** Retired IPC channels must remain absent throughout GPU failure/retry. */
export async function observeNativeCpuReplies(app: ElectronApplication) {
  return app.evaluateHandle(({ ipcMain }) => {
    const state = () => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, unknown> })
        ._invokeHandlers
      if ([...handlers.keys()].some((key) => key.startsWith('preview:cpu-')))
        throw new Error('Retired CPU presentation IPC is registered.')
      return {
        requests: [] as unknown[],
        pairs: [] as unknown[],
        limits: [] as unknown[],
        events: [] as unknown[],
        omitted: 0,
        held: null,
      }
    }
    return { state, close: async () => state() }
  })
}
