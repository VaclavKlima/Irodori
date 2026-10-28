import { artifactDirectory } from './verification-runner.mjs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { launchTestElectron, assertTestWindowPolicy } from './electron-test-launch.mjs'
import { testUiMode } from './test-ui-mode.mjs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const root = fileURLToPath(new URL('..', import.meta.url))
const output = pathToFileURL(
  join(process.env.LUMA_VERIFICATION_DIR ?? (await artifactDirectory('mcp')), 'mcp') + '/',
)
let endpoint = 'http://127.0.0.1:9222'
const isolated = process.argv.includes('--isolated')
let desktop
let child
let evidenceFile
let profile
const transcript = []

async function waitForIrodori() {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch(`${endpoint}/json/list`, { signal: AbortSignal.timeout(1000) })
      if (response.ok) {
        const targets = await response.json()
        if (
          targets.some(
            (target) =>
              target.type === 'page' && target.title === 'Irodori — Personal photo editing',
          )
        )
          return
      }
    } catch {
      // The Electron window may still be starting.
    }
    await delay(250)
  }
  throw new Error('No Irodori window is available on port 9222. Start npm run dev:mcp first.')
}

function contentText(result) {
  return (result.content ?? [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n')
}

function buttonRef(snapshot, name) {
  const line = snapshot.split('\n').find((line) => line.includes(`button "${name}"`))
  const ref = line?.match(/\[ref=([^\]]+)\]/)?.[1]
  if (!ref) throw new Error(`The accessibility snapshot did not include the ${name} button.`)
  return ref
}

const client = new Client({ name: 'luma-mcp-smoke', version: '0.1.0' })
let transport
try {
  if (isolated) {
    const probe = createServer()
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const port = probe.address().port
    await new Promise((resolve) => probe.close(resolve))
    endpoint = `http://127.0.0.1:${port}`
    profile = await mkdtemp(join(tmpdir(), 'luma-mcp-'))
    const env = { ...process.env }
    delete env.ELECTRON_RENDERER_URL
    delete env.ELECTRON_RUN_AS_NODE
    delete env.FORCE_COLOR
    const launched = await launchTestElectron({
      userDataDir: profile,
      artifacts: fileURLToPath(new URL('launch/', output)),
      args: [`--remote-debugging-port=${port}`],
      env,
      offline: false,
    })
    ;({ app: desktop, child, evidenceFile } = launched)
    const actualProfile = await desktop.evaluate(({ app }) => app.getPath('userData'))
    if ((await realpath(actualProfile)) !== (await realpath(profile)))
      throw new Error('MCP profile isolation failed')
    // Keep exact gesture assertions independent of the workspace's release glide.
    await (await desktop.firstWindow()).emulateMedia({ reducedMotion: 'reduce' })
    await desktop.evaluate(({ dialog }, root) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [
          `${root}/tests/fixtures/photos/alpine-lake.jpg`,
          `${root}/tests/fixtures/photos/mountain-ridge.jpg`,
        ],
      })
    }, root)
  }
  await waitForIrodori()
  await mkdir(output, { recursive: true })
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      fileURLToPath(new URL('../node_modules/@playwright/mcp/cli.js', import.meta.url)),
      `--cdp-endpoint=${endpoint}`,
      '--caps=vision',
      `--output-dir=${fileURLToPath(output)}`,
    ],
    cwd: root,
    stderr: 'pipe',
  })
  transport.stderr?.on('data', (chunk) => process.stderr.write(chunk))
  await client.connect(transport)
  const { tools } = await client.listTools()
  for (const required of [
    'browser_snapshot',
    'browser_click',
    'browser_evaluate',
    'browser_take_screenshot',
  ]) {
    if (!tools.some((tool) => tool.name === required))
      throw new Error(`Missing MCP tool: ${required}`)
  }
  console.log(`Connected to Playwright MCP; discovered ${tools.length} tools.`)

  async function call(name, args = {}) {
    const result = await client.callTool({ name, arguments: args })
    const text = contentText(result)
    transcript.push({ tool: name, text })
    if (result.isError) throw new Error(`${name}: ${text}`)
    return { result, text }
  }

  // The app owns one renderer window. Confirm its title before any UI action.
  const initial = await call('browser_snapshot')
  if (!initial.text.includes('Irodori')) throw new Error('The connected renderer is not Irodori.')
  async function clickButton(name) {
    const snapshot = await call('browser_snapshot')
    await call('browser_click', { element: name, target: buttonRef(snapshot.text, name) })
  }
  async function waitForText(text) {
    for (let attempt = 0; attempt < 60; attempt++) {
      const snapshot = await call('browser_snapshot')
      if (snapshot.text.includes(text)) return snapshot
      await delay(250)
    }
    throw new Error(`MCP never observed: ${text}`)
  }
  if (isolated) {
    await clickButton('Import photos')
    await clickButton('Choose photos')
    await waitForText('Ready to import')
    await desktop.evaluate((_electron, root) => {
      const fs = process.getBuiltinModule('fs')
      const { Readable } = process.getBuiltinModule('stream')
      const { setTimeout: delay } = process.getBuiltinModule('timers/promises')
      const { resolve } = process.getBuiltinModule('path')
      const originals = new Set([
        resolve(root, 'tests/fixtures/photos/alpine-lake.jpg'),
        resolve(root, 'tests/fixtures/photos/mountain-ridge.jpg'),
      ])
      const original = fs.createReadStream
      fs.createReadStream = (path, options) => {
        if (!originals.has(String(path))) return original(path, options)
        const source = original(path, { ...options, highWaterMark: 4096 })
        return Readable.from(
          (async function* () {
            try {
              for await (const chunk of source) {
                await delay(40, undefined, { signal: options?.signal })
                yield chunk
              }
            } finally {
              source.destroy()
            }
          })(),
        )
      }
      process.getBuiltinModule('module').syncBuiltinESMExports()
      // Duplicate review later should scan at normal speed.
      globalThis.restoreCopyStream = () => {
        fs.createReadStream = original
        process.getBuiltinModule('module').syncBuiltinESMExports()
      }
    }, root)
    await clickButton('Import 2 photos')
    const running = await waitForText('progressbar "Importing photos"')
    if (running.text.includes('dialog "Import photos"'))
      throw new Error('Import review did not close.')
    await clickButton('Import photos')
    await waitForText('Cancel task')
    const progressScreenshot = await call('browser_take_screenshot', {
      type: 'png',
      filename: 'artifacts/mcp/background-import.png',
    })
    const progressImage = progressScreenshot.result.content?.find((item) => item.type === 'image')
    if (progressImage)
      await writeFile(
        new URL('background-import.png', output),
        Buffer.from(progressImage.data, 'base64'),
      )
    await waitForText('Import complete')
    await desktop.evaluate(() => {
      globalThis.restoreCopyStream()
      delete globalThis.restoreCopyStream
    })
    await clickButton('Close task details')
    await clickButton('Select alpine-lake.jpg')
    // A blocked foreground preview pauses background import. Install the
    // loading gate only after import, before switching to the other photograph.
    await desktop.evaluate(({ ipcMain }) => {
      const original = ipcMain._invokeHandlers.get('preview:request')
      const pending = new Promise((resolve) => {
        globalThis.releaseFullPreviewForMcp = resolve
      })
      ipcMain.removeHandler('preview:request')
      ipcMain.handle('preview:request', async (...args) => {
        await pending
        return original(...args)
      })
    })
    await clickButton('Select mountain-ridge.jpg')
    await waitForText('Loading full resolution…')
    await call('browser_evaluate', {
      function: `() => {
        const viewport = document.querySelector('[data-testid="preview-viewport"]');
        if (viewport.dataset.resolution !== 'loading' || viewport.querySelector('img'))
          throw new Error('Expected a neutral loader without a camera JPEG');
        return {resolution: viewport.dataset.resolution};
      }`,
    })
    await desktop.evaluate(() => {
      globalThis.releaseFullPreviewForMcp()
      delete globalThis.releaseFullPreviewForMcp
    })
    await waitForText('Full resolution')
    // Exercise zoom and a real pointer drag through MCP's coordinate tools.
    await call('browser_click', { target: '[data-testid="main-preview"]' })
    await call('browser_press_key', { key: '1' })
    const center = await call('browser_evaluate', {
      function: `() => {
        const viewport = document.querySelector('[data-testid="preview-viewport"]');
        if (Number(viewport.dataset.scale) !== 1) throw new Error('Native zoom was not applied');
        const box = viewport.getBoundingClientRect();
        return {x: box.x + box.width / 2, y: box.y + box.height / 2};
      }`,
    })
    const point = JSON.parse(center.text.split('### Result\n')[1].split('\n###')[0])
    await call('browser_mouse_drag_xy', {
      startX: point.x,
      startY: point.y,
      endX: point.x - 70,
      endY: point.y - 40,
    })
    await call('browser_evaluate', {
      function: `() => {
        const viewport = document.querySelector('[data-testid="preview-viewport"]');
        if (Math.abs(Number(viewport.dataset.panX) + 70) > 1 || Math.abs(Number(viewport.dataset.panY) + 40) > 1)
          throw new Error('Pointer drag did not pan the preview');
        return {scale: viewport.dataset.scale, x: viewport.dataset.panX, y: viewport.dataset.panY};
      }`,
    })
    await call('browser_mouse_wheel', { deltaX: 20, deltaY: 15 })
    await call('browser_evaluate', {
      function: `() => {
        const viewport = document.querySelector('[data-testid="preview-viewport"]');
        if (Number(viewport.dataset.scale) !== 1 || Math.abs(Number(viewport.dataset.panX) + 90) > 1 || Math.abs(Number(viewport.dataset.panY) + 55) > 1)
          throw new Error('Scroll did not pan without zooming');
        return {scale: viewport.dataset.scale, x: viewport.dataset.panX, y: viewport.dataset.panY};
      }`,
    })
    // Chromium exposes native touchpad pinches as Ctrl-wheel events.
    await call('browser_evaluate', {
      function: `async () => {
        const viewport = document.querySelector('[data-testid="preview-viewport"]');
        const box = viewport.getBoundingClientRect();
        viewport.dispatchEvent(new WheelEvent('wheel', {
          cancelable: true, ctrlKey: true, deltaY: -100,
          clientX: box.x + box.width / 2, clientY: box.y + box.height / 2,
        }));
        await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
        return {scale: viewport.dataset.scale};
      }`,
    })
    await call('browser_evaluate', {
      function: `() => {
        const viewport = document.querySelector('[data-testid="preview-viewport"]');
        if (Math.abs(Number(viewport.dataset.scale) - Math.exp(1)) > 0.00001)
          throw new Error('Pinch zoom did not follow the gesture scale');
        return {scale: viewport.dataset.scale};
      }`,
    })
    await call('browser_evaluate', {
      function: `() => {
        const viewport = document.querySelector('[data-testid="preview-viewport"]');
        const image = document.querySelector('[data-testid="main-preview"]');
        const scale = Number(viewport.dataset.scale);
        if (viewport.dataset.resolution !== 'full' || !image.dataset.src.includes('/full/'))
          throw new Error('Full resolution was not displayed');
        if (scale <= 1 || Math.abs(image.getBoundingClientRect().width * devicePixelRatio - image.width) > 1 || Number(viewport.dataset.imageWidth) <= 0)
          throw new Error('Full-resolution zoom did not preserve native pixel dimensions');
        return {resolution: viewport.dataset.resolution, width: Number(viewport.dataset.imageWidth), height: Number(viewport.dataset.imageHeight), scale};
      }`,
    })
    const zoomScreenshot = await call('browser_take_screenshot', {
      type: 'png',
      filename: fileURLToPath(new URL('preview-zoom.png', output)),
    })
    const zoomImage = zoomScreenshot.result.content?.find((item) => item.type === 'image')
    if (zoomImage)
      await writeFile(new URL('preview-zoom.png', output), Buffer.from(zoomImage.data, 'base64'))
    await clickButton('Fit preview')
    await call('browser_evaluate', {
      function: `() => {
        const viewport = document.querySelector('[data-testid="preview-viewport"]');
        if (viewport.dataset.mode !== 'fit' || Number(viewport.dataset.panX) || Number(viewport.dataset.panY))
          throw new Error('Fit did not reset the preview');
        return {mode: viewport.dataset.mode};
      }`,
    })
    // Reopening the same files exercises duplicate detection through MCP too.
    await clickButton('Import photos')
    await clickButton('Choose photos')
    await waitForText('Ready to import')
    await clickButton('Import 2 photos')
    await waitForText('Import complete')
    await call('browser_evaluate', {
      function: `async () => {
        const tasks = await window.luma.listTasks();
        const duplicateTask = tasks.find(task => task.outcomes?.duplicates === 2);
        if (!duplicateTask || duplicateTask.outcomes.imported !== 0 || (await window.luma.listPhotos()).total !== 2)
          throw new Error('Deferred duplicate checks did not preserve the catalog');
        return duplicateTask.outcomes;
      }`,
    })
    // Exercise the renderer selection and confirmation through MCP, with isolated Trash.
    await desktop.evaluate(({ app, shell }) => {
      const fs = process.getBuiltinModule('fs')
      const path = process.getBuiltinModule('path')
      const trash = path.join(app.getPath('userData'), 'test-trash')
      fs.mkdirSync(trash, { recursive: true })
      shell.trashItem = async (source) => {
        await fs.promises.rename(source, path.join(trash, path.basename(source)))
      }
    })
    await clickButton('Select mountain-ridge.jpg')
    const selectionSnapshot = await call('browser_snapshot')
    await call('browser_click', {
      element: 'Select alpine-lake.jpg with Shift',
      target: buttonRef(selectionSnapshot.text, 'Select alpine-lake.jpg'),
      modifiers: ['Shift'],
    })
    await waitForText('2 selected')
    await call('browser_press_key', { key: 'Backspace' })
    await waitForText('Move 2 photos to Trash?')
    await clickButton('Move to Trash')
    await waitForText('Your photographs, at home.')
    const deleted = await call('browser_evaluate', {
      function: 'async () => ({total: (await window.luma.listPhotos()).total})',
    })
    if (!/"total":\s*0/.test(deleted.text))
      throw new Error('The confirmed selection was not deleted.')
    // A real RAW exercises the independent lens controls through the same MCP connection.
    await desktop.evaluate(({ dialog }, root) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [`${root}/tests/fixtures/sony-zv1.ARW`],
      })
    }, root)
    await clickButton('Import photos')
    await clickButton('Choose photos')
    await waitForText('Ready to import')
    await clickButton('Import 1 photos')
    await waitForText('Lens corrections')
    await clickButton('Lens corrections')
    await call('browser_evaluate', {
      function: `async () => {
      for (let i=0;i<120;i++) {
        if(document.querySelector('[data-testid="preview-viewport"]')?.dataset.resolution === 'full') return true;
        await new Promise(r=>setTimeout(r,250));
      }
      throw new Error('Corrected RAW did not reach the canvas');
    }`,
    })
    const lensSnapshot = await call('browser_snapshot')
    const lensLine = lensSnapshot.text
      .split('\n')
      .find((line) => line.includes('checkbox "Distortion"'))
    const lensRef = lensLine?.match(/\[ref=([^\]]+)\]/)?.[1]
    if (!lensRef) throw new Error('MCP did not expose the distortion checkbox')
    await call('browser_click', { element: 'Distortion correction', target: lensRef })
    await call('browser_evaluate', {
      function: `async () => {
      const id = (await window.luma.listPhotos()).photos[0].id;
      for(let i=0;i<120;i++) {
        const state=await window.luma.getLensSettings(id);
        if(state.revision===1 && !state.settings.distortion && document.querySelector('[data-testid="preview-viewport"]')?.dataset.resolution==='full') return state;
        await new Promise(r=>setTimeout(r,250));
      }
      throw new Error('Lens toggle did not persist and render');
    }`,
    })
    // Reload the existing Electron document; MCP intentionally disallows file-URL navigation.
    await (await desktop.firstWindow()).reload({ waitUntil: 'domcontentloaded' })
    await waitForText('Lens corrections')
    await clickButton('Lens corrections')
    await call('browser_evaluate', {
      function: `async () => {
      const id=(await window.luma.listPhotos()).photos[0].id;
      const state=await window.luma.getLensSettings(id);
      if(state.settings.distortion || state.revision!==1) throw new Error('Lens settings did not survive reload');
      return state;
    }`,
    })
    await call('browser_take_screenshot', {
      type: 'png',
      filename: fileURLToPath(new URL('lens-corrections.png', output)),
    })
    await clickButton('Select sony-zv1.ARW')
    await call('browser_press_key', { key: 'Delete' })
    await waitForText('Move photo to Trash?')
    await clickButton('Move to Trash')
    await waitForText('Your photographs, at home.')
  } else {
    const photoButton = initial.text.match(/button "(Select [^"]+)"/)
    if (photoButton) await clickButton(photoButton[1])
    else {
      await clickButton('Import photos')
      await clickButton('Cancel')
    }
  }
  const state = await call('browser_evaluate', {
    function: `() => ({ consoleOpen: document.querySelector('[data-testid="console-toggle"]').getAttribute('aria-expanded') })`,
  })
  if (
    !state.text.includes('"consoleOpen": "true"') &&
    !state.text.includes('"consoleOpen":"true"')
  ) {
    const current = await call('browser_snapshot')
    await call('browser_click', {
      element: 'Console toggle in the status bar',
      target: buttonRef(current.text, 'Console'),
    })
  }
  const final = await call('browser_snapshot')
  if (!/disconnected/i.test(final.text))
    throw new Error('The disconnected console was not visible.')
  const screenshot = await call('browser_take_screenshot', {
    type: 'png',
    filename: fileURLToPath(new URL('workspace.png', output)),
  })
  const inlineImage = screenshot.result.content?.find((item) => item.type === 'image')
  if (inlineImage)
    await writeFile(new URL('workspace.png', output), Buffer.from(inlineImage.data, 'base64'))
  await writeFile(
    new URL('protocol-check.json', output),
    JSON.stringify(transcript, null, 2) + '\n',
  )
  if (isolated)
    await writeFile(
      new URL('execution.json', output),
      JSON.stringify({ uiMode: testUiMode() }) + '\n',
    )
  console.log(
    `Passed: MCP discovery, snapshot, ${isolated ? 'background import, progress details, consistent full-resolution previews, persistent RAW lens controls, zoom, pointer drag, Fit reset, duplicate detection, multiple selection, confirmed deletion' : 'library interaction'}, console, and screenshot.`,
  )
  console.log(`Artifacts: ${fileURLToPath(output)}`)
} catch (error) {
  await mkdir(output, { recursive: true })
  await writeFile(
    new URL('protocol-check.json', output),
    JSON.stringify(transcript, null, 2) + '\n',
  )
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  await client.close().catch(() => undefined)
  await transport?.close().catch(() => undefined)
  await desktop
    ?.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
    })
    .catch(() => undefined)
  await desktop?.close().catch(() => undefined)
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve))
    child.kill('SIGKILL')
    await exited
  }
  if (profile) {
    await rm(profile, { recursive: true, force: true })
    try {
      await access(profile)
      console.error('MCP temporary profile was not removed')
      process.exitCode = 1
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error(error)
        process.exitCode = 1
      }
    }
  }
  if (evidenceFile) {
    await assertTestWindowPolicy(evidenceFile).catch((error) => {
      console.error(error.message)
      process.exitCode = 1
    })
  }
}
