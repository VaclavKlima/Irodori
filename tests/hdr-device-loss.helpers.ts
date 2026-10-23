import type { Page } from '@playwright/test'

/** The actual configured-device fault used by interactive-preview-lifecycle.
 * Blocking only later adapter requests keeps the recovery under test on CPU. */
export async function destroyMainPreviewDevice(page: Page, allowUnavailable = false) {
  return page.evaluateHandle((allowUnavailable) => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')!
    const configuration = canvas.getContext('webgpu')?.getConfiguration()
    if (!configuration) {
      if (allowUnavailable) return { destroyed: false, restore: () => undefined }
      throw new Error('The completed real WebGPU device is unavailable.')
    }
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'gpu')
    Object.defineProperty(navigator, 'gpu', {
      configurable: true,
      value: { requestAdapter: async () => null },
    })
    configuration.device.destroy()
    return {
      destroyed: true,
      restore: () => {
        if (descriptor) Object.defineProperty(navigator, 'gpu', descriptor)
        else if (!Reflect.deleteProperty(navigator, 'gpu'))
          throw new Error('Could not restore the navigator GPU descriptor.')
      },
    }
  }, allowUnavailable)
}
