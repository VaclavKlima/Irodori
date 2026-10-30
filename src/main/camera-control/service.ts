import { mkdir, readdir, stat } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ExifTool } from 'exiftool-vendored'
import { CameraStore, durableJson, hashFile, readJson } from './store.ts'
import {
  CameraError,
  actionRequest,
  advertisedActions,
  digest,
  identifier,
  settings,
  validateSettings,
  type CameraAction,
  type CameraIdentity,
  type CameraInspection,
  type CameraProvider,
  type Settings,
  type ProviderFile,
} from './model.ts'

interface Touched {
  original: string
  lastApplied: string
  intended?: string
  pending: boolean
  restored?: boolean
  /** Values sent by this session whose final camera application is still uncertain. */
  unsettled?: string[]
}
export interface Restoration {
  setting: string
  outcome: 'restored' | 'already-restored' | 'unchanged' | 'conflict' | 'failed'
  original: string
  observed?: string
  message?: string
}
interface SessionRecord {
  id: string
  camera: CameraIdentity
  state: 'open' | 'closed' | 'disconnected'
  initial: CameraInspection
  touched: Record<string, Touched>
  restoration: Restoration[]
  createdAt: string
}
interface Session {
  record: SessionRecord
  provider: CameraProvider
  tail: Promise<unknown>
  closing: boolean
  initializing: boolean
}
export interface CaptureFile {
  filename: string
  path: string
  bytes: number
  sha256: string
  complete: boolean
  cameraPath?: string
  cameraBytes?: number
  metadata: Record<string, unknown>
}
export interface CameraStep {
  index: number
  requested: Settings
  readback: Settings
  releaseAttempted: boolean
  complete: boolean
  files: CaptureFile[]
}
export interface CameraOperation {
  id: string
  sessionId: string
  camera: CameraIdentity
  requestId: string
  request: CameraAction
  fingerprint: string
  state: 'queued' | 'running' | 'completed' | 'cancelled' | 'failed' | 'uncertain' | 'interrupted'
  createdAt: string
  completedAt?: string
  steps: CameraStep[]
  settings?: CameraInspection
  inventory?: {
    available: boolean
    reason?: string
    files: { key: string; bytes: number; filename: string }[]
  }
  restoration: Restoration[]
  failure?: { code: string; message: string; uncertain: boolean }
  directory: string
}
const values = (inspection: CameraInspection) =>
  Object.fromEntries(inspection.settings.map((setting) => [setting.id, setting.value]))
const failure = (error: unknown) => ({
  code: error instanceof CameraError ? error.code : 'camera-error',
  message: String(error),
  uncertain: error instanceof CameraError && error.uncertain,
})
function intend(touched: Touched, value: string): void {
  touched.unsettled = [
    ...new Set([
      ...(touched.unsettled ?? []),
      ...(touched.pending && touched.intended !== undefined ? [touched.intended] : []),
      value,
    ]),
  ]
  touched.intended = value
  touched.pending = true
}
export class CameraService {
  store: CameraStore
  private providers: Map<string, CameraProvider>
  private cameras = new Map<string, CameraIdentity>()
  private sessions = new Map<string, Session>()
  private operations = new Map<string, CameraOperation>()
  private controls = new Map<string, AbortController>()
  private work = new Map<string, Promise<unknown>>()
  private admission: Promise<unknown> = Promise.resolve()
  private stopping = false
  private exif?: ExifTool
  private metadata: (path: string) => Promise<Record<string, unknown>>
  constructor(
    providers: CameraProvider[],
    store: CameraStore,
    metadata?: (path: string) => Promise<Record<string, unknown>>,
  ) {
    this.providers = new Map(providers.map((provider) => [provider.id, provider]))
    this.store = store
    this.metadata =
      metadata ??
      (async (path) => {
        this.exif ??= new ExifTool({ maxProcs: 1 })
        return (await this.exif.read(path)) as unknown as Record<string, unknown>
      })
  }
  private admit<T>(callback: () => Promise<T>): Promise<T> {
    const next = this.admission.then(callback)
    this.admission = next.catch(() => {})
    return next
  }
  private enqueue<T>(session: Session, callback: () => Promise<T>): Promise<T> {
    const next = session.tail.then(callback)
    session.tail = next.catch(() => {})
    return next
  }
  private saveSession(session: Session) {
    return durableJson(this.store.path('sessions', session.record.id), session.record)
  }
  private saveOperation(operation: CameraOperation) {
    return durableJson(this.store.path('operations', operation.id), operation)
  }
  async list() {
    await this.store.init()
    const results = []
    for (const provider of this.providers.values()) results.push(await provider.discover())
    const cameras = results.flatMap((result) => result.cameras)
    this.cameras = new Map(cameras.map((camera) => [camera.id, camera]))
    for (const session of this.sessions.values())
      if (!this.cameras.has(session.record.camera.id) && !session.closing) {
        session.record.state = 'disconnected'
        await this.saveSession(session)
      }
    const recoveries = []
    for (const entry of await readdir(join(this.store.root, 'sessions'))) {
      if (!entry.endsWith('.json')) continue
      const record = await readJson<SessionRecord>(join(this.store.root, 'sessions', entry))
      if (
        record &&
        Object.values(record.touched).some((touched) => touched.pending || !touched.restored)
      )
        recoveries.push({
          sessionId: record.id,
          camera: record.camera,
          state: record.state,
          restoration: record.restoration,
        })
    }
    return {
      cameras,
      diagnostics: results.flatMap((result) => result.diagnostics),
      recoveries,
      broker:
        'One service instance owns camera sessions on this host; operations are serialized per camera.',
    }
  }
  private session(id: string) {
    const session = this.sessions.get(identifier(id))
    if (!session || session.closing || session.record.state !== 'open')
      throw new CameraError(
        'invalid-session',
        'Session is closed or disconnected. Discover and open a new session.',
      )
    return session
  }
  async openSession(cameraId: string, initialSettings: Settings = {}, recoverSessionId?: string) {
    identifier(cameraId)
    settings(initialSettings)
    return this.admit(async () => {
      if (this.stopping) throw new CameraError('shutting-down', 'Camera service is shutting down.')
      await this.list()
      const camera = this.cameras.get(cameraId)
      if (!camera)
        throw new CameraError('disconnected', 'Camera discovery is stale. Discover again.')
      if (
        [...this.sessions.values()].some(
          (session) =>
            (session.record.camera.physicalId === camera.physicalId ||
              session.record.camera.id === camera.id) &&
            session.record.state !== 'closed',
        )
      )
        throw new CameraError(
          'camera-busy',
          'This camera already has a session; close it before reconnecting.',
        )
      const provider = this.providers.get(camera.provider)!
      this.store.claim()
      let session: Session | undefined
      try {
        await provider.open(camera)
        const initial = await provider.inspect(camera)
        session = {
          record: {
            id: randomUUID(),
            camera: structuredClone(camera),
            state: 'open',
            initial,
            touched: {},
            restoration: [],
            createdAt: new Date().toISOString(),
          },
          provider,
          tail: Promise.resolve(),
          closing: false,
          initializing: true,
        }
        this.sessions.set(session.record.id, session)
        await this.saveSession(session)
        if (recoverSessionId) {
          const old = await readJson<SessionRecord>(
            this.store.path('sessions', identifier(recoverSessionId)),
          )
          if (
            !old ||
            old.camera.physicalId !== camera.physicalId ||
            old.camera.identityConfidence !== 'serial'
          )
            throw new CameraError(
              'recovery-identity',
              'Recovery requires the same serial-identified physical camera.',
            )
          session.record.touched = structuredClone(old.touched)
          await this.saveSession(session)
          await this.restore(session)
          if (
            session.record.restoration.some((result) =>
              ['failed', 'conflict'].includes(result.outcome),
            )
          )
            throw new CameraError(
              'recovery-conflict',
              'Recovery has unresolved settings. Inspect retained session journals; no external values were overwritten.',
            )
          old.touched = structuredClone(session.record.touched)
          old.restoration = session.record.restoration
          old.state = 'closed'
          await durableJson(this.store.path('sessions', old.id), old)
        }
        await this.apply(session, initialSettings)
        const result = {
          sessionId: session.record.id,
          camera: session.record.camera,
          settings: await this.inspect(session),
          restoration: session.record.restoration,
        }
        session.initializing = false
        return result
      } catch (error) {
        if (session) {
          await this.restore(session)
          session.record.state = 'closed'
          await this.saveSession(session)
          this.sessions.delete(session.record.id)
        }
        await provider.close(camera).catch(() => {})
        if (!this.sessions.size) this.store.release()
        throw error
      }
    })
  }
  private async inspect(session: Session) {
    try {
      const inspection = await session.provider.inspect(session.record.camera)
      for (const setting of inspection.settings) {
        const touched = session.record.touched[setting.id]
        if (touched && !touched.pending && touched.lastApplied === setting.value)
          setting.verification.writeReadback = true
      }
      if (
        [...this.operations.values()].some(
          (operation) =>
            operation.camera.physicalId === session.record.camera.physicalId &&
            operation.steps.some((step) => step.complete),
        )
      )
        inspection.capture.verification.capture = true
      return inspection
    } catch (error) {
      if (
        error instanceof CameraError &&
        ['disconnected', 'native-transport-ended', 'timeout'].includes(error.code)
      ) {
        session.record.state = 'disconnected'
        await this.saveSession(session)
      }
      throw error
    }
  }
  async listActions(
    cameraId: string,
  ): Promise<CameraInspection & { actions: ReturnType<typeof advertisedActions> }> {
    identifier(cameraId)
    const session = [...this.sessions.values()].find(
      (session) => session.record.camera.id === cameraId && !session.closing,
    )
    if (session?.initializing) return this.admission.then(() => this.listActions(cameraId))
    if (session)
      return this.enqueue(session, async () => {
        const inspection = await this.inspect(session)
        return { ...inspection, actions: advertisedActions(inspection) }
      })
    const opened = await this.openSession(cameraId)
    try {
      return { ...opened.settings, actions: advertisedActions(opened.settings) }
    } finally {
      await this.closeSession(opened.sessionId)
    }
  }
  private async apply(session: Session, requested: Settings) {
    const initial = await this.inspect(session)
    validateSettings(requested, initial)
    for (const [id, value] of Object.entries(requested)) {
      const current = await this.inspect(session)
      validateSettings({ [id]: value }, current)
      const setting = current.settings.find((setting) => setting.id === id)!
      const prior = session.record.touched[id]
      if (prior && (prior.pending || !prior.restored) && setting.value !== prior.lastApplied)
        throw new CameraError(
          'setting-conflict',
          `${id} changed outside this session; no value was overwritten.`,
        )
      if (setting.value === value) continue
      if (prior?.restored && !prior.pending) delete session.record.touched[id]
      const touched = (session.record.touched[id] ??= {
        original: setting.value,
        lastApplied: setting.value,
        pending: false,
      })
      intend(touched, value)
      touched.restored = false
      await this.saveSession(session)
      await session.provider.write(session.record.camera, setting, value, async (applied) => {
        touched.lastApplied = applied
        await this.saveSession(session)
      })
      const readback = (await this.inspect(session)).settings.find(
        (setting) => setting.id === id,
      )?.value
      if (readback !== value)
        throw new CameraError(
          'readback-mismatch',
          `${id}: requested ${value}, read back ${readback}.`,
        )
      touched.lastApplied = value
      touched.pending = false
      // A verified round trip relinquishes ownership before automatic modes can
      // change this readout. A later write starts from its then-current value.
      touched.restored = value === touched.original
      delete touched.intended
      delete touched.unsettled
      await this.saveSession(session)
    }
  }
  private async restore(session: Session) {
    const results: Restoration[] = []
    for (const [id, touched] of Object.entries(session.record.touched).reverse()) {
      const result: Restoration = { setting: id, original: touched.original, outcome: 'failed' }
      if (touched.restored && !touched.pending) {
        result.outcome = 'already-restored'
        results.push(result)
        session.record.restoration = results
        await this.saveSession(session)
        continue
      }
      try {
        const inspection = await this.inspect(session),
          setting = inspection.settings.find((setting) => setting.id === id)
        result.observed = setting?.value
        if (setting?.value === touched.original && !touched.pending) {
          result.outcome = 'unchanged'
          touched.restored = true
        } else if (
          !setting ||
          ![
            touched.lastApplied,
            ...(touched.pending && touched.intended ? [touched.intended] : []),
            ...(touched.pending ? (touched.unsettled ?? []) : []),
          ].includes(setting.value)
        )
          result.outcome = 'conflict'
        else {
          // Restoring known originals can require a choice hidden by the current mode.
          if (!setting.writable || !setting.choices.includes(touched.original))
            throw new CameraError(
              'restoration-unavailable',
              setting.reason ?? 'Original value is currently unavailable.',
            )
          intend(touched, touched.original)
          await this.saveSession(session)
          await session.provider.write(
            session.record.camera,
            setting,
            touched.original,
            async (applied) => {
              touched.lastApplied = applied
              await this.saveSession(session)
            },
          )
          const after = (await this.inspect(session)).settings.find(
            (setting) => setting.id === id,
          )?.value
          if (after !== touched.original)
            throw new CameraError('restoration-readback', 'Original setting did not read back.')
          result.outcome = 'restored'
          result.observed = after
          touched.restored = true
          touched.pending = false
          delete touched.intended
          delete touched.unsettled
        }
      } catch (error) {
        result.message = String(error)
      }
      results.push(result)
      session.record.restoration = results
      await this.saveSession(session)
    }
    session.record.restoration = results
    await this.saveSession(session)
    return results
  }
  async executeAction(sessionId: string, action: unknown, parameters: unknown, requestId: string) {
    identifier(sessionId)
    identifier(requestId)
    const request = actionRequest(action, parameters)
    return this.admit(async () => {
      if (this.stopping) throw new CameraError('shutting-down', 'Camera service is shutting down.')
      const requestPath = this.store.path('requests', digest(requestId))
      const existing = await readJson<{ operationId: string }>(requestPath)
      if (existing) {
        const operation = await this.getOperation(existing.operationId)
        const suppliedSession = this.sessions.get(sessionId)
        if (
          suppliedSession &&
          suppliedSession.record.camera.physicalId !== operation.camera.physicalId
        )
          throw new CameraError(
            'request-conflict',
            'Deduplication ID belongs to a different physical camera.',
          )
        if (JSON.stringify(operation.request) !== JSON.stringify(request))
          throw new CameraError(
            'request-conflict',
            'Deduplication ID was already used with different parameters.',
          )
        return { operationId: operation.id, deduplicated: true }
      }
      const session = this.session(sessionId)
      const operation: CameraOperation = {
        id: randomUUID(),
        sessionId,
        camera: structuredClone(session.record.camera),
        requestId,
        request,
        fingerprint: digest(JSON.stringify(request)),
        state: 'queued',
        createdAt: new Date().toISOString(),
        steps: [],
        restoration: [],
        directory: '',
      }
      operation.directory = join(this.store.root, 'operations', operation.id)
      await mkdir(operation.directory, { mode: 0o700 })
      await this.saveOperation(operation)
      await durableJson(requestPath, { operationId: operation.id })
      this.operations.set(operation.id, operation)
      const control = new AbortController()
      this.controls.set(operation.id, control)
      const work = this.enqueue(session, () => this.run(session, operation, control.signal))
      this.work.set(operation.id, work)
      // Retain errors as operation failures; never leak an unhandled rejection.
      void work
        .catch(() => {})
        .finally(() => {
          this.controls.delete(operation.id)
          this.work.delete(operation.id)
        })
      return { operationId: operation.id, deduplicated: false }
    })
  }
  private async collect(directory: string, providerFiles: ProviderFile[], complete: boolean) {
    const files: CaptureFile[] = []
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const path = join(directory, entry.name),
        source = providerFiles.find((file) => resolve(file.path) === resolve(path))
      if (
        source &&
        (relative(directory, source.path).startsWith('..') || source.filename !== entry.name)
      )
        throw new CameraError(
          'invalid-original',
          'Provider original escaped its operation directory.',
        )
      const bytes = (await stat(path)).size,
        sha256 = await hashFile(path)
      const valid = Boolean(
        complete &&
        source &&
        bytes > 0 &&
        (source.cameraBytes === undefined || source.cameraBytes === bytes) &&
        (source.cameraSha256 === undefined || source.cameraSha256 === sha256),
      )
      let metadata: Record<string, unknown>
      try {
        metadata = await this.metadata(path)
      } catch (error) {
        metadata = { error: String(error) }
      }
      files.push({
        filename: entry.name,
        path,
        bytes,
        sha256,
        complete: valid,
        cameraPath: source?.cameraPath,
        cameraBytes: source?.cameraBytes,
        metadata,
      })
    }
    return files
  }
  private async run(session: Session, operation: CameraOperation, signal: AbortSignal) {
    try {
      signal.throwIfAborted()
      if (session.record.state !== 'open')
        throw new CameraError('invalid-session', 'Session disconnected.')
      operation.state = 'running'
      await this.saveOperation(operation)
      const request = operation.request
      if (request.action === 'read-card-inventory')
        operation.inventory = (await session.provider.inventory?.(session.record.camera)) ?? {
          available: false,
          reason: 'This provider does not expose card inventory.',
          files: [],
        }
      else if (request.action === 'read-settings') operation.settings = await this.inspect(session)
      else if (request.action === 'apply-settings') {
        await this.apply(session, request.parameters.settings)
        operation.settings = await this.inspect(session)
      } else {
        const steps =
          request.action === 'capture' ? [request.parameters.settings] : request.parameters.steps
        for (const requested of steps) {
          signal.throwIfAborted()
          await this.apply(session, requested)
          const inspection = await this.inspect(session)
          if (!inspection.capture.available)
            throw new CameraError(
              'unavailable-action',
              inspection.capture.reason ?? 'Capture unavailable.',
            )
          for (const [id, touched] of Object.entries(session.record.touched))
            if (
              touched.pending ||
              (!touched.restored && values(inspection)[id] !== touched.lastApplied)
            )
              throw new CameraError('setting-conflict', `${id} changed before the shutter release.`)
          signal.throwIfAborted()
          const step: CameraStep = {
            index: operation.steps.length,
            requested,
            readback: values(inspection),
            releaseAttempted: true,
            complete: false,
            files: [],
          }
          const directory = join(operation.directory, `exposure-${step.index + 1}`)
          await mkdir(directory, { mode: 0o700 })
          operation.steps.push(step)
          // Durable before the provider can release the shutter. Never replay this step.
          await this.saveOperation(operation)
          let originals: ProviderFile[] = []
          try {
            originals = await session.provider.capture(session.record.camera, directory, signal)
            step.files = await this.collect(directory, originals, true)
            if (!step.files.length || step.files.some((file) => !file.complete))
              throw new CameraError(
                'partial-download',
                'An associated original failed byte/size validation.',
                true,
              )
            step.complete = true
          } finally {
            if (!step.complete) step.files = await this.collect(directory, originals, false)
            await this.saveOperation(operation)
          }
          signal.throwIfAborted()
        }
      }
      operation.state = 'completed'
    } catch (error) {
      operation.failure = failure(error)
      const uncertain = operation.steps.some((step) => step.releaseAttempted && !step.complete)
      operation.failure.uncertain ||= uncertain
      operation.state = uncertain ? 'uncertain' : signal.aborted ? 'cancelled' : 'failed'
      operation.restoration = await this.restore(session)
    } finally {
      operation.completedAt = new Date().toISOString()
      await this.saveOperation(operation)
      await durableJson(join(operation.directory, 'manifest.json'), operation)
    }
  }
  async getOperation(id: string): Promise<CameraOperation> {
    identifier(id)
    const live = this.operations.get(id)
    if (live) {
      if (!['queued', 'running'].includes(live.state)) await this.work.get(id)
      return structuredClone(live)
    }
    const operation = await readJson<CameraOperation>(this.store.path('operations', id))
    if (!operation) throw new CameraError('unknown-operation', 'Unknown operation ID.')
    if (['queued', 'running'].includes(operation.state)) {
      operation.state = operation.steps.some((step) => step.releaseAttempted && !step.complete)
        ? 'uncertain'
        : 'interrupted'
      operation.failure = {
        code: 'interrupted',
        message:
          'Server ended before completion. Retained results are never replayed. Inspect originals and recover the settings session.',
        uncertain: operation.state === 'uncertain',
      }
    }
    return operation
  }
  async cancelOperation(id: string) {
    identifier(id)
    this.controls.get(id)?.abort()
    await this.work.get(id)
    return this.getOperation(id)
  }
  async closeSession(id: string): Promise<{
    sessionId: string
    restoration: Restoration[]
    closed: boolean
    cleanupError?: string
  }> {
    identifier(id)
    const session = this.sessions.get(id)
    if (session?.initializing) return this.admission.then(() => this.closeSession(id))
    if (!session) {
      const record = await readJson<SessionRecord>(this.store.path('sessions', id))
      if (record?.state === 'closed')
        return { sessionId: id, restoration: record.restoration, closed: true }
      throw new CameraError(
        'invalid-session',
        'No live session; use explicit recovery after rediscovery.',
      )
    }
    session.closing = true
    for (const [operationId, operation] of this.operations)
      if (operation.sessionId === id) this.controls.get(operationId)?.abort()
    return this.enqueue(session, async () => {
      const restoration = await this.restore(session)
      let cleanupError: string | undefined
      try {
        await session.provider.close(session.record.camera)
      } catch (error) {
        cleanupError = String(error)
      }
      session.record.state = 'closed'
      await this.saveSession(session)
      this.sessions.delete(id)
      if (!this.sessions.size) this.store.release()
      return { sessionId: id, restoration, closed: true, cleanupError }
    })
  }
  async shutdown() {
    this.stopping = true
    await this.admission
    for (const id of [...this.sessions.keys()]) await this.closeSession(id)
    for (const provider of this.providers.values()) await provider.shutdown()
    await this.exif?.end()
    this.store.close()
  }
}
