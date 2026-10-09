import { useEffect, useState } from 'react'
import { SDR_TARGET, type DisplayTarget, type DisplayCapabilities } from '../../../shared/hdr'
import { hdrDevice, probeHdrCanvas } from '../preview/hdr-device'

export function useDisplayState() {
  const [state, setState] = useState<DisplayTarget>(SDR_TARGET)
  useEffect(() => {
    let stopped = false,
      generation = 0
    let listeners = new AbortController()
    let observed: ScreenDetails | undefined
    let monitors: HdrScreen[] = []
    let signature = ''
    const displaySignature = (details: ScreenDetails) =>
      JSON.stringify({
        current: details.screens.indexOf(details.currentScreen),
        screens: details.screens.map((screen) => [
          screen.label,
          screen.left,
          screen.top,
          screen.width,
          screen.height,
          screen.hdrHeadroom,
          screen.devicePixelRatio,
        ]),
        scale: window.devicePixelRatio,
      })
    const observe = (details: ScreenDetails) => {
      signature = displaySignature(details)
      if (
        observed === details &&
        monitors.length === details.screens.length &&
        monitors.every((monitor, index) => monitor === details.screens[index])
      )
        return
      listeners.abort()
      listeners = new AbortController()
      observed = details
      monitors = [...details.screens]
      const changed = () => {
        void probe()
      }
      for (const type of ['currentscreenchange', 'screenschange'])
        details.addEventListener(type, changed, { signal: listeners.signal })
      for (const monitor of new Set([...monitors, details.currentScreen]))
        for (const type of ['hdrheadroomchange', 'change'])
          monitor.addEventListener(type, changed, { signal: listeners.signal })
    }
    const accept = (value: DisplayTarget) => {
      if (!stopped)
        setState((previous) =>
          value.generation >= previous.generation &&
          JSON.stringify(value) !== JSON.stringify(previous)
            ? value
            : previous,
        )
    }
    void window.luma.getDisplayState().then(accept)
    const off = window.luma.onDisplayState(accept)
    const probe = async () => {
      const current = ++generation
      const caps: DisplayCapabilities = {
        hardware: false,
        extended: false,
        p3: false,
        headroomStops: null,
        reason: '',
      }
      try {
        let details: ScreenDetails | undefined
        try {
          details = await window.getScreenDetails?.()
          if (stopped || current !== generation) return
          // Observe before awaiting GPU work: Wayland can announce the entered output meanwhile.
          if (details) observe(details)
          caps.permission = details ? 'granted' : 'unavailable'
        } catch {
          caps.permission = 'denied'
          caps.failure = 'permission-denied'
          caps.reason = 'Window-management permission denied; display headroom is unavailable.'
        }
        const monitor = details?.currentScreen
        if (monitor) {
          caps.monitor = {
            label: monitor.label ?? 'Unnamed monitor',
            left: monitor.left ?? 0,
            top: monitor.top ?? 0,
            width: monitor.width,
            height: monitor.height,
            scale: monitor.devicePixelRatio ?? window.devicePixelRatio,
          }
          caps.headroomStops = monitor.hdrHeadroom ?? null
        }
        const device = await hdrDevice()
        caps.hardware = true
        const info = device.adapterInfo
        caps.adapter = {
          vendor: info.vendor,
          architecture: info.architecture,
          device: info.device,
          description: info.description,
        }
        if (stopped || current !== generation) return
        const canvas = document.createElement('canvas'),
          context = canvas.getContext('webgpu')
        caps.failure ??= 'canvas-unsupported'
        if (!context) throw new Error('WebGPU canvas is unavailable.')
        const { p3, extended } = await probeHdrCanvas(device, context)
        if (stopped || current !== generation) return
        accept(
          await window.luma.reportDisplayCapabilities({
            ...caps,
            hardware: true,
            extended,
            p3: p3 && window.matchMedia('(color-gamut: p3)').matches,
            failure:
              caps.permission === 'denied'
                ? 'permission-denied'
                : caps.headroomStops === null
                  ? 'headroom-unavailable'
                  : caps.headroomStops <= 0
                    ? 'no-headroom'
                    : undefined,
            reason:
              caps.reason ||
              (caps.headroomStops === null
                ? 'Display headroom is unavailable.'
                : caps.headroomStops <= 0
                  ? 'The current monitor reports no HDR headroom.'
                  : ''),
          }),
        )
        void device.lost.then(() => {
          if (!stopped && current === generation)
            void window.luma.reportDisplayCapabilities({
              ...caps,
              failure: 'device-lost',
              hardware: false,
              extended: false,
              p3: false,
              headroomStops: caps.headroomStops,
              reason: 'Presentation device lost. Rechecking on focus or resume.',
            })
        })
      } catch (error) {
        if (!stopped && current === generation)
          accept(
            await window.luma.reportDisplayCapabilities({
              ...caps,
              failure: caps.failure ?? 'adapter-unavailable',
              reason: caps.reason || String(error).slice(0, 512),
            }),
          )
      }
    }
    const refresh = () => {
      void probe()
    }
    const resume = window.luma.onDisplayRefresh(refresh)
    window.addEventListener('focus', refresh)
    window.addEventListener('resize', refresh)
    document.addEventListener('visibilitychange', refresh)
    // Some compositors update ScreenDetails without a corresponding move/resize event.
    // Compare only metadata; unchanged displays do not repeat GPU capability probes.
    const monitorCheck = setInterval(() => {
      if (!document.hidden && observed && signature !== displaySignature(observed)) refresh()
    }, 1000)
    refresh()
    return () => {
      stopped = true
      generation++
      listeners.abort()
      clearInterval(monitorCheck)
      off()
      resume()
      window.removeEventListener('focus', refresh)
      window.removeEventListener('resize', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [])
  return state
}
