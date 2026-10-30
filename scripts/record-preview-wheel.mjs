import { chromium } from 'playwright'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const help = `Record wheel input and preview zoom in an already running Irodori development window.

Usage: node scripts/record-preview-wheel.mjs [options]
  --duration <seconds>  Recording duration, 1–3600 (default: 60)
  --limit <records>     Maximum total records, 10–100000 (default: 10000)
  --endpoint <url>      Loopback CDP HTTP endpoint (default: http://127.0.0.1:9222)
  --help               Show this help without connecting

Press Ctrl+C to finish early and save. Output: artifacts/wheel/<unique run>/.
The recorder observes input; it never imports photos or changes the view.
`

function options(args) {
  const result = { duration: 60, limit: 10000, endpoint: 'http://127.0.0.1:9222' }
  for (let i = 0; i < args.length; i++) {
    const key = args[i]
    if (!['--duration', '--limit', '--endpoint'].includes(key) || !args[i + 1])
      throw new Error(`Unknown or incomplete option: ${key}. Use --help.`)
    result[key.slice(2)] = key === '--endpoint' ? args[++i] : Number(args[++i])
  }
  if (!Number.isFinite(result.duration) || result.duration < 1 || result.duration > 3600)
    throw new Error('--duration must be between 1 and 3600 seconds.')
  if (!Number.isInteger(result.limit) || result.limit < 10 || result.limit > 100000)
    throw new Error('--limit must be an integer between 10 and 100000.')
  const endpoint = new URL(result.endpoint)
  if (
    endpoint.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== '/'
  )
    throw new Error('--endpoint must be a loopback HTTP origin without credentials or a path.')
  result.endpoint = endpoint.origin
  return result
}

/* eslint-disable no-undef -- This callback executes in Electron's renderer. */
function installRecorder(limit) {
  const selector = '[data-testid="preview-viewport"], [data-testid="merge-viewport"]'
  const start = performance.now()
  const controller = new AbortController()
  const signal = controller.signal
  const frames = new Set()
  const pending = []
  let count = 0
  let wheelId = 0
  let done = false
  let physicalControl = null
  let evidence = null
  const now = () => Math.round((performance.now() - start) * 100) / 100
  const view = (element) => {
    const data = element.dataset
    const canvas = element.querySelector(
      'canvas[data-testid="main-preview"], canvas[data-testid="merge-preview"]',
    )
    const canvasView = (name) => {
      try {
        const value = JSON.parse(canvas?.dataset[name] ?? 'null')
        return value ? { fit: value.fit, scale: value.scale, x: value.x, y: value.y } : null
      } catch {
        return null
      }
    }
    return {
      viewport: data.testid,
      scale: Number(data.scale),
      fit: data.mode === 'fit' || data.fit === 'true',
      x: Number(data.panX),
      y: Number(data.panY),
      ready: data.ready ?? (data.resolution === 'full' && data.loading !== 'true'),
      imageWidth: Number(data.imageWidth) || null,
      imageHeight: Number(data.imageHeight) || null,
      width: element.clientWidth,
      height: element.clientHeight,
      requestedView: canvasView('requestedView'),
      presentedView: canvasView('presentedView'),
    }
  }
  const observer = new MutationObserver((mutations) => {
    const elements = new Set(mutations.map((mutation) => mutation.target.closest(selector)))
    for (const element of elements) if (element) add({ type: 'view', view: view(element) })
  })
  const stop = () => {
    done = true
    controller.abort()
    observer.disconnect()
    for (const id of frames) cancelAnimationFrame(id)
    frames.clear()
  }
  const add = (record) => {
    if (done) return
    pending.push({ ms: now(), ...record })
    count++
    if (count >= limit) stop()
  }
  const modifiers = (event) => {
    if (event.ctrlKey === physicalControl && !event.type.startsWith('key')) return
    physicalControl = event.ctrlKey
    evidence = { source: event.type, ms: now(), trusted: event.isTrusted }
    add({ type: 'modifier', ctrlKey: physicalControl, ...evidence })
  }
  for (const type of ['keydown', 'keyup', 'pointerdown', 'pointermove', 'pointerup'])
    document.addEventListener(type, modifiers, { capture: true, signal })
  const clear = (event) => {
    physicalControl = null
    evidence = null
    add({
      type: event.type,
      trusted: event.isTrusted,
      visibility: document.visibilityState,
      hidden: document.hidden,
      hasFocus: document.hasFocus(),
    })
  }
  window.addEventListener('blur', clear, { signal })
  document.addEventListener('visibilitychange', clear, { signal })
  const afterFrame = (callback) => {
    if (done) return
    const id = requestAnimationFrame(() => {
      frames.delete(id)
      callback()
    })
    frames.add(id)
  }
  document.addEventListener(
    'wheel',
    (event) => {
      const element = event.target instanceof Element ? event.target.closest(selector) : null
      if (!element) return
      const id = ++wheelId
      const box = element.getBoundingClientRect()
      add({
        type: 'wheel',
        id,
        trusted: event.isTrusted,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        physicalControl,
        controlEvidence: evidence,
        pointer: { x: event.clientX - box.left, y: event.clientY - box.top },
        before: view(element),
      })
      afterFrame(() => {
        add({ type: 'dispatch', id, consumed: event.defaultPrevented })
        add({ type: 'frame', id, frame: 1, view: view(element) })
        afterFrame(() => add({ type: 'frame', id, frame: 2, view: view(element) }))
      })
    },
    { capture: true, passive: true, signal },
  )
  observer.observe(document.documentElement, {
    subtree: true,
    attributes: true,
    attributeFilter: [
      'data-scale',
      'data-mode',
      'data-fit',
      'data-pan-x',
      'data-pan-y',
      'data-requested-view',
      'data-presented-view',
    ],
  })
  return {
    initial: [...document.querySelectorAll(selector)].map(view),
    take: () => ({ records: pending.splice(0), done }),
    stop,
  }
}
/* eslint-enable no-undef */

async function record(config) {
  const root = fileURLToPath(new URL('../artifacts/wheel/', import.meta.url))
  await mkdir(root, { recursive: true })
  const output = await mkdtemp(join(root, `${new Date().toISOString().replaceAll(':', '-')}-`))
  const startedAt = new Date().toISOString()
  const records = []
  const finish = new AbortController()
  let reason = 'duration'
  let browser
  let recorder
  let initial = []
  let failure
  const interrupted = () => {
    reason = 'signal'
    finish.abort()
  }
  process.once('SIGINT', interrupted)
  process.once('SIGTERM', interrupted)
  const timer = setTimeout(() => finish.abort(), config.duration * 1000)
  const take = async () => {
    const batch = await recorder.evaluate((state) => state.take())
    records.push(...batch.records)
    return batch.done
  }
  try {
    browser = await chromium.connectOverCDP(config.endpoint, { timeout: 5000, noDefaults: true })
    const candidates = []
    for (const page of browser.contexts().flatMap((context) => context.pages()))
      if ((await page.title()) === 'Irodori') candidates.push(page)
    if (candidates.length !== 1)
      throw new Error(`Expected one Irodori renderer; found ${candidates.length}.`)
    recorder = await candidates[0].evaluateHandle(installRecorder, config.limit)
    initial = await recorder.evaluate((state) => state.initial)
    console.log(`Recording for ${config.duration}s. Press Ctrl+C to save early.`)
    console.log('Over the photo: hold Ctrl, scroll one notch up, pause, then one notch down.')
    console.log(`Artifacts: ${output}`)
    while (!finish.signal.aborted) {
      if (await take()) {
        reason = 'record-limit'
        break
      }
      await delay(250, undefined, { signal: finish.signal }).catch(() => {})
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
    reason = 'error'
    process.exitCode = 1
  } finally {
    clearTimeout(timer)
    process.removeListener('SIGINT', interrupted)
    process.removeListener('SIGTERM', interrupted)
    if (recorder) {
      await recorder
        .evaluate((state) => state.stop())
        .then(take)
        .catch((error) => {
          failure ??= `Renderer recording ended before cleanup: ${error.message}`
          reason = 'error'
          process.exitCode = 1
        })
      await recorder.dispose().catch(() => {})
    }
    // For connectOverCDP, close disconnects this client's transport; it does not send Browser.close.
    await browser?.close().catch(() => {})
    const endedAt = new Date().toISOString()
    const wheels = records.filter((entry) => entry.type === 'wheel')
    const summary = [
      '# Preview wheel recording',
      '',
      `- Start: ${startedAt}`,
      `- Duration: ${((Date.parse(endedAt) - Date.parse(startedAt)) / 1000).toFixed(2)} s`,
      `- Finished: ${reason}`,
      `- Records: ${records.length} / ${config.limit}`,
      `- Wheel events: ${wheels.length} (${wheels.filter((entry) => entry.trusted).length} trusted)`,
      `- Ctrl-wheel with observed physical Control: ${wheels.filter((entry) => entry.ctrlKey && entry.physicalControl === true).length}`,
      `- Ctrl-wheel without observed physical Control: ${wheels.filter((entry) => entry.ctrlKey && entry.physicalControl !== true).length}`,
      ...(failure ? [`- Error: ${failure}`] : []),
      '',
      'Wheel events are not physical notch counts. Frame records show sampled application view state, not GPU completion or display scanout.',
      '',
    ].join('\n')
    await writeFile(
      join(output, 'recording.json'),
      JSON.stringify(
        { version: 1, startedAt, endedAt, reason, failure, config, initial, records },
        null,
        2,
      ) + '\n',
    )
    await writeFile(join(output, 'summary.md'), summary)
    console.log(
      `Saved ${wheels.length} wheel events and ${records.length} total records: ${output}`,
    )
    if (failure) console.error(failure)
  }
}

if (process.argv.includes('--help')) console.log(help)
else {
  try {
    await record(options(process.argv.slice(2)))
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
