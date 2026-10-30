import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { exposureSeconds } from '../../src/main/camera-control/model.ts'
import {
  acceptanceAlternate,
  acceptanceOptions,
  acceptanceSettings,
  selectAcceptanceCamera,
} from './acceptance-options.ts'

const args = process.argv.slice(2)
const { selector } = acceptanceOptions(args)
const directory = resolve(
  fileURLToPath(new URL('../../artifacts/camera/acceptance/', import.meta.url)),
  `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`,
)
await mkdir(directory, { recursive: true, mode: 0o700 })
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('../camera-mcp.mjs', import.meta.url))],
  stderr: 'pipe',
})
let stderr = ''
transport.stderr?.on('data', (data) => {
  stderr = (stderr + data.toString()).slice(-16000)
})
const client = new Client({ name: 'irodori-camera-hardware-acceptance', version: '1' })
const evidence = {
  platform: process.platform,
  startedAt: new Date().toISOString(),
  directory,
  controls: {},
  operations: [],
  limitations: [
    'Physical Bazzite/Linux acceptance remains pending.',
    'Active-session USB unplug/replug requires an attended check; this command does not simulate physical removal.',
    'No capture is promoted to a repository fixture; visual, metadata, privacy and permission review remains required.',
  ],
}
let sessionId
async function call(name, input = {}) {
  const result = await client.callTool(
    { name: `irodori_camera_${name}`, arguments: input },
    undefined,
    { timeout: 120000 },
  )
  if (result.isError) throw new Error(JSON.stringify(result.structuredContent ?? result.content))
  return result.structuredContent
}
async function run(action, parameters, label) {
  const accepted = await call('execute_action', {
    sessionId,
    action,
    parameters,
    requestId: `acceptance-${label}-${randomUUID()}`,
  })
  for (let index = 0; index < 1200; index++) {
    const operation = await call('get_operation', { operationId: accepted.operationId })
    if (!['queued', 'running'].includes(operation.state)) {
      evidence.operations.push(operation)
      if (operation.state !== 'completed')
        throw new Error(`${label}: ${JSON.stringify(operation.failure)}`)
      return operation
    }
    await delay(100)
  }
  throw new Error(
    `Operation ${accepted.operationId} did not finish. Never replay its shutter request.`,
  )
}
try {
  await client.connect(transport)
  evidence.tools = (await client.listTools()).tools.map((tool) => tool.name)
  evidence.discovery = await call('list')
  if (!selector) {
    evidence.result = 'discovery-only'
    console.log(JSON.stringify(evidence.discovery, null, 2))
  } else {
    const camera = selectAcceptanceCamera(evidence.discovery.cameras, selector)
    evidence.camera = camera
    evidence.before = await call('list_actions', { cameraId: camera.id })
    if (args.includes('--run') || args.includes('--controls')) {
      const opened = await call('open_session', { cameraId: camera.id })
      sessionId = opened.sessionId
      evidence.cardBefore = (await run('read-card-inventory', {}, 'card-before')).inventory
      // Establish manual, single-frame capture before testing individual controls.
      try {
        await run(
          'apply-settings',
          {
            settings: acceptanceSettings(evidence.before.settings, {
              exposureMode: ['Manual', 'M'],
              driveMode: ['Single', 'Single Shot', 'Single Frame'],
            }),
          },
          'manual-single',
        )
        evidence.controls.exposureMode = { result: 'write-readback' }
      } catch (error) {
        evidence.controls.exposureMode = { result: 'unavailable', error: String(error) }
        if (args.includes('--run')) throw error
      }
      for (const name of ['iso', 'aperture', 'whiteBalance', 'focusMode', 'exposureCompensation']) {
        const context = await call('list_actions', { cameraId: camera.id })
        const setting = context.settings.find((setting) => setting.id === name)
        const alternate = setting && acceptanceAlternate(setting)
        if (!setting?.writable || !alternate) {
          evidence.controls[name] = { result: 'unavailable', setting }
          continue
        }
        try {
          const changed = await run(
            'apply-settings',
            { settings: { [name]: alternate } },
            `control-${name}`,
          )
          const actual = changed.settings.settings.find((setting) => setting.id === name)
          if (actual.value !== alternate || !actual.verification.writeReadback)
            throw new Error('Changed value was not verified.')
          await run('apply-settings', { settings: { [name]: setting.value } }, `restore-${name}`)
          evidence.controls[name] = {
            result: 'write-readback-restored',
            original: setting.value,
            temporary: alternate,
          }
        } catch (error) {
          evidence.controls[name] = { result: 'failed', error: String(error) }
          if (args.includes('--run')) throw error
        }
      }
      if (args.includes('--run')) {
        const context = await call('list_actions', { cameraId: camera.id })
        const requested = {
          format: ['RAW+JPEG', 'RAW+JPEG (Fine)', 'RAW+JPEG (Std)', 'RAW+JPEG (X.Fine)'],
          iso: ['100'],
          focusMode: ['Manual'],
          shutterSpeed: ['1/100'],
        }
        if (context.settings.some((setting) => setting.id === 'pcImageSize'))
          requested.pcImageSize = ['Original']
        if (context.settings.some((setting) => setting.id === 'pcImageFormat'))
          requested.pcImageFormat = ['RAW & JPEG']
        const captureSettings = acceptanceSettings(context.settings, requested)
        const destination = evidence.before.settings.find(
          (setting) => setting.id === 'captureTarget',
        )
        evidence.controls.captureTarget = {
          result: 'preserved',
          value: destination?.value,
        }
        await run('apply-settings', { settings: captureSettings }, 'capture-setup')
        evidence.controls.shutterSpeed = {
          result: 'write-readback',
          values: ['1/100', '1/50', '1/200'],
        }
        evidence.controls.drive = { result: 'single-only', nativeBurst: 'unverified' }
        evidence.controls.bracketing = {
          result: 'unavailable',
          reason: 'Native bracketing has not been independently verified.',
        }
        const single = await run('capture', { settings: {} }, 'single-raw')
        const sequence = await run(
          'exposure-sequence',
          {
            steps: [{ shutterSpeed: '1/200' }, { shutterSpeed: '1/100' }, { shutterSpeed: '1/50' }],
          },
          'three-exposures',
        )
        for (const operation of [single, sequence])
          for (const step of operation.steps) {
            if (
              !step.complete ||
              !step.files.some((file) => /\.arw$/i.test(file.filename)) ||
              !step.files.some((file) => /\.jpe?g$/i.test(file.filename))
            )
              throw new Error('A complete RAW/JPEG pair is required for every exposure.')
            for (const file of step.files) {
              const bytes = await readFile(file.path)
              if (
                createHash('sha256').update(bytes).digest('hex') !== file.sha256 ||
                bytes.length !== file.bytes
              )
                throw new Error('Downloaded original changed after publication.')
              if (Number(file.metadata.ISO) !== Number(step.readback.iso))
                throw new Error('Original ISO metadata differs from verified requested settings.')
              const requested = exposureSeconds(step.readback.shutterSpeed),
                actual = exposureSeconds(file.metadata.ExposureTime)
              if (
                requested === undefined ||
                actual === undefined ||
                Math.abs(actual - requested) > 0.00001
              )
                throw new Error('Original exposure-time metadata differs from requested settings.')
            }
          }
        // Cancellation is explicit and bounded; no further capture may start after it settles.
        const cancel = await call('execute_action', {
          sessionId,
          action: 'exposure-sequence',
          parameters: { steps: [{ iso: '100' }, { iso: '100' }, { iso: '100' }] },
          requestId: `acceptance-cancel-${randomUUID()}`,
        })
        evidence.cancellation = await call('cancel_operation', { operationId: cancel.operationId })
        if (!['cancelled', 'completed'].includes(evidence.cancellation.state))
          throw new Error('Cancellation left an uncertain result.')
      }
      evidence.cardAfter = (await run('read-card-inventory', {}, 'card-after')).inventory
      if (evidence.cardBefore.available && evidence.cardAfter.available) {
        const after = new Map(evidence.cardAfter.files.map((file) => [file.key, file]))
        if (evidence.cardBefore.files.some((file) => after.get(file.key)?.bytes !== file.bytes))
          throw new Error('Existing card inventory changed.')
        evidence.cardPreservation =
          'Existing names and sizes unchanged; no deletion commands exist. Full card byte hashing is outside this check.'
      } else {
        evidence.cardPreservation =
          'No deletion commands exist; full card contents are not addressable through this PC Remote session.'
        evidence.limitations.push(
          'Existing card byte-for-byte comparison is unavailable through this provider/session.',
        )
      }
      evidence.closed = await call('close_session', { sessionId })
      sessionId = undefined
      evidence.after = await call('list_actions', { cameraId: camera.id })
      const before = Object.fromEntries(
        evidence.before.settings.map((setting) => [setting.id, setting.value]),
      )
      const after = Object.fromEntries(
        evidence.after.settings.map((setting) => [setting.id, setting.value]),
      )
      const automatic = new Set(
        ['Program', 'P'].includes(before.exposureMode)
          ? ['aperture', 'shutterSpeed']
          : ['Aperture priority', 'A'].includes(before.exposureMode)
            ? ['shutterSpeed']
            : ['Shutter priority', 'S'].includes(before.exposureMode)
              ? ['aperture']
              : [],
      )
      evidence.automaticReadouts = [...automatic]
      if (
        Object.keys(before).some((key) => !automatic.has(key) && before[key] !== after[key]) ||
        evidence.closed.restoration.some((result) =>
          ['failed', 'conflict'].includes(result.outcome),
        )
      )
        throw new Error('Initial photographic settings were not fully restored.')
      evidence.result = args.includes('--run')
        ? 'capture-sequence-restoration-passed'
        : 'controls-inspected'
    } else {
      evidence.result = 'inspection-only'
      console.log(
        JSON.stringify(
          {
            camera: evidence.camera,
            settings: evidence.before.settings.map(({ id, value, writable }) => ({
              id,
              value,
              writable,
            })),
          },
          null,
          2,
        ),
      )
    }
  }
} catch (error) {
  evidence.result = 'failed'
  evidence.failure = String(error)
  process.exitCode = 1
  console.error(error)
} finally {
  if (sessionId)
    try {
      evidence.closed = await call('close_session', { sessionId })
    } catch (error) {
      evidence.cleanupError = String(error)
    }
  await client.close()
  await transport.close()
  evidence.completedAt = new Date().toISOString()
  await writeFile(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n')
  await writeFile(join(directory, 'stderr.log'), stderr)
  console.log(`${evidence.result}: ${join(directory, 'evidence.json')}`)
}
