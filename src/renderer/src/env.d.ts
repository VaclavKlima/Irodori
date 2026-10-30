/// <reference types="vite/client" />

import type { IrodoriApi } from '../../shared/contracts'

declare global {
  interface HdrScreen extends Screen, EventTarget {
    hdrHeadroom?: number
    label?: string
    left?: number
    top?: number
    devicePixelRatio?: number
  }
  interface ScreenDetails extends EventTarget {
    currentScreen: HdrScreen
    screens: HdrScreen[]
  }
  interface Window {
    irodori: IrodoriApi
    getScreenDetails?: () => Promise<ScreenDetails>
    hdrDiagnostic: { onResume: (callback: () => void) => () => void }
  }
}
