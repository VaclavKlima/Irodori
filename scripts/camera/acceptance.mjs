import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { exposureSeconds } from '../../src/main/camera-control/model.ts'
import {
  acceptanceOptions,
  selectAcceptanceCamera,
  acceptanceValue,
  acceptancePatch,
  acceptanceAlternate,
  automaticCameraReadouts,
  restorationDifferences,
} from './acceptance-options.ts'

const { mode, selector } = acceptanceOptions(process.argv.slice(2))
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
  if (mode === 'discover') {
    evidence.result = 'discovery-only'
    console.log(JSON.stringify(evidence.discovery, null, 2))
  } else {
    const camera = selectAcceptanceCamera(evidence.discovery.cameras, selector)
    evidence.camera = camera
    evidence.before = await call('list_actions', { cameraId: camera.id })
    if (mode === 'run' || mode === 'controls') {
      const opened = await call('open_session', { cameraId: camera.id })
      sessionId = opened.sessionId
      evidence.sessionBefore = opened.settings
      evidence.cardBefore = (await run('read-card-inventory', {}, 'card-before')).inventory
      // Establish manual, single-frame capture before testing individual controls.
      try {
        const context = await call('list_actions', { cameraId: camera.id })
        evidence.setupContext = context
        const manual = acceptanceValue(context.settings, 'exposureMode', ['Manual', 'M'])
        const modePatch = acceptancePatch(context.settings, 'exposureMode', manual)
        if (Object.keys(modePatch).length)
          await run('apply-settings', { settings: modePatch }, 'manual-mode')
        evidence.controls.exposureMode = {
          result: modePatch.exposureMode ? 'write-readback' : 'already-selected',
          value: manual,
        }
        // Program changes can alter control availability and refresh Sony
        // property enums. Validate the drive against its new actual readback.
        const singleContext = await call('list_actions', { cameraId: camera.id })
        evidence.singleContext = singleContext
        const single = acceptanceValue(singleContext.settings, 'driveMode', [
          'Single',
          'Single Shot',
          'Single Frame',
        ])
        const patch = acceptancePatch(singleContext.settings, 'driveMode', single)
        if (Object.keys(patch).length)
          await run('apply-settings', { settings: patch }, 'single-drive')
        evidence.controls.driveMode = {
          result: patch.driveMode ? 'write-readback' : 'already-selected',
          value: single,
        }
      } catch (error) {
        evidence.controls.setup = { result: 'unavailable', error: String(error) }
        if (mode === 'run') throw error
      }
      for (const name of ['iso', 'aperture', 'whiteBalance', 'focusMode', 'exposureCompensation']) {
        const context = await call('list_actions', { cameraId: camera.id })
        const setting = context.settings.find((setting) => setting.id === name)
        const alternate = acceptanceAlternate(setting)
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
          if (mode === 'run') throw error
        }
      }
      if (mode === 'run') {
        const context = await call('list_actions', { cameraId: camera.id })
        const format = acceptanceValue(context.settings, 'format', [
          'RAW+JPEG',
          'RAW+JPEG (Fine)',
          'RAW+JPEG (Std)',
          'RAW+JPEG (X.Fine)',
          'RAW & JPEG',
        ])
        const iso = acceptanceValue(context.settings, 'iso', ['100', '400', '125', '80', '200'])
        const focus = acceptanceValue(context.settings, 'focusMode', ['Manual'])
        const shutter = acceptanceValue(context.settings, 'shutterSpeed', ['1/100'])
        const captureSettings = {
          ...acceptancePatch(context.settings, 'format', format),
          ...acceptancePatch(context.settings, 'iso', iso),
          ...acceptancePatch(context.settings, 'focusMode', focus),
          ...acceptancePatch(context.settings, 'shutterSpeed', shutter),
        }
        const destination = context.settings.find((setting) => setting.id === 'captureTarget')
        evidence.controls.captureTarget = {
          result: 'preserved',
          value: destination?.value,
        }
        const imageSize = context.settings.find((setting) => setting.id === 'pcImageSize')
        if (imageSize)
          Object.assign(
            captureSettings,
            acceptancePatch(
              context.settings,
              'pcImageSize',
              acceptanceValue(context.settings, 'pcImageSize', ['Original']),
            ),
          )
        const transfer = context.settings.find((setting) => setting.id === 'pcImageFormat')
        if (transfer?.writable && transfer.choices.includes('RAW & JPEG'))
          Object.assign(
            captureSettings,
            acceptancePatch(context.settings, 'pcImageFormat', 'RAW & JPEG'),
          )
        else if (
          transfer &&
          transfer.value !== 'RAW & JPEG' &&
          !['PC Only', 'sdram'].includes(destination?.value)
        )
          throw new Error('RAW/JPEG PC transfer requires physical camera setup.')
        if (Object.keys(captureSettings).length)
          await run('apply-settings', { settings: captureSettings }, 'capture-setup')
        const prepared = await call('list_actions', { cameraId: camera.id })
        acceptanceValue(prepared.settings, 'shutterSpeed', ['1/200'])
        acceptanceValue(prepared.settings, 'shutterSpeed', ['1/50'])
        evidence.captureRecipe = {
          format,
          iso,
          focusMode: focus,
          shutterSpeed: shutter,
          captureTarget: destination?.value,
        }
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
          parameters: { steps: [{ iso }, { iso }, { iso }] },
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
      evidence.automaticReadouts = automaticCameraReadouts(
        evidence.sessionBefore.settings.find((setting) => setting.id === 'exposureMode')?.value ??
          '',
      )
      evidence.restorationDifferences = restorationDifferences(
        evidence.sessionBefore.settings,
        evidence.after.settings,
      )
      if (
        evidence.restorationDifferences.length ||
        evidence.closed.restoration.some((result) =>
          ['failed', 'conflict'].includes(result.outcome),
        )
      )
        throw new Error('Initial photographic settings were not fully restored.')
      const failedControls = Object.values(evidence.controls).some(
        (control) => control.result === 'failed',
      )
      const unavailableControls = Object.values(evidence.controls).some(
        (control) => control.result === 'unavailable',
      )
      evidence.result =
        mode === 'run'
          ? 'capture-sequence-restoration-passed'
          : failedControls
            ? 'controls-failed'
            : unavailableControls
              ? 'controls-incomplete'
              : 'controls-passed'
      if (mode === 'controls' && (failedControls || unavailableControls))
        process.exitCode = failedControls ? 1 : 2
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
