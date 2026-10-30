import { BrowserWindow, type BrowserWindowConstructorOptions } from 'electron'

// Only the isolated test entry installs this marker before importing application code.
// Environment variables alone never change normal application or development windows.
const backgroundTest =
  (globalThis as { __irodoriTestUiMode?: string }).__irodoriTestUiMode === 'background'

export function createAppWindow(options: BrowserWindowConstructorOptions): BrowserWindow {
  return new BrowserWindow(
    backgroundTest
      ? {
          ...options,
          show: false,
          focusable: false,
          paintWhenInitiallyHidden: true,
          webPreferences: { ...options.webPreferences, backgroundThrottling: false },
        }
      : options,
  )
}

export function showAppWindow(window: BrowserWindow): void {
  if (!backgroundTest) window.show()
}
