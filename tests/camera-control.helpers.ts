import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CameraError,
  verification,
  type CameraIdentity,
  type CameraInspection,
  type CameraProvider,
  type CameraSetting,
  type Settings,
} from '../src/main/camera-control/model'
import { CameraService } from '../src/main/camera-control/service'
import { CameraStore } from '../src/main/camera-control/store'

export class FakeCameraProvider implements CameraProvider {
  id = 'fake'
  cameras: CameraIdentity[] = [1, 2].map((index) => ({
    id: `camera-${index}`,
    provider: 'fake',
    model: 'Same Model',
    backendModel: 'Driver Alias',
    port: `usb:001,00${index}`,
    physicalId: `physical-${index}`,
    connection: `connection-${index}`,
    serial: `serial-${index}`,
    identityConfidence: 'serial',
  }))
  values = new Map(
    this.cameras.map((camera) => [
      camera.id,
      { iso: '100', format: 'RAW+JPEG', driveMode: 'Single', shutterSpeed: '1/100' } as Settings,
    ]),
  )
  writes: { camera: string; id: string; value: string }[] = []
  captures: string[] = []
  opened: string[] = []
  closed: string[] = []
  beforeCapture?: () => Promise<void>
  afterCapture?: () => Promise<void>
  failCapture = false
  partial = false
  mismatch = false
  unavailable = false
  async discover() {
    return {
      cameras: structuredClone(this.cameras),
      diagnostics: [{ provider: this.id, available: true, message: 'Test provider' }],
    }
  }
  async open(camera: CameraIdentity) {
    this.opened.push(camera.id)
  }
  async inspect(camera: CameraIdentity): Promise<CameraInspection> {
    if (!this.cameras.some((candidate) => candidate.connection === camera.connection))
      throw new CameraError('disconnected', 'Camera disconnected.')
    const current = this.values.get(camera.id)!
    return {
      settings: Object.entries(current).map(([id, value]) => ({
        id,
        label: id,
        value,
        writable: id !== 'serial' && !(id === 'iso' && this.unavailable),
        choices:
          id === 'iso'
            ? ['100', '125', '200', '400']
            : id === 'format'
              ? ['RAW', 'RAW+JPEG']
              : id === 'driveMode'
                ? ['Single']
                : ['1/50', '1/100', '1/200'],
        verification: verification(),
        reason: this.unavailable ? 'Read-only now' : undefined,
      })),
      capture: { available: true, verification: verification(false) },
      info: { firmware: 'test' },
    }
  }
  async write(camera: CameraIdentity, setting: CameraSetting, value: string) {
    this.writes.push({ camera: camera.id, id: setting.id, value })
    if (!this.mismatch) this.values.get(camera.id)![setting.id] = value
  }
  async capture(camera: CameraIdentity, directory: string, signal: AbortSignal) {
    signal.throwIfAborted()
    this.captures.push(camera.id)
    await this.beforeCapture?.()
    if (this.failCapture) throw new CameraError('timeout', 'Shutter outcome unknown', true)
    const files = []
    for (const extension of this.partial ? ['ARW'] : ['ARW', 'JPG']) {
      const filename = `DSC0001.${extension}`,
        path = join(directory, filename)
      await writeFile(path, `unchanged-original-${extension}`)
      files.push({
        filename,
        path,
        cameraBytes: Buffer.byteLength(`unchanged-original-${extension}`),
      })
    }
    await this.afterCapture?.()
    if (this.partial) throw new CameraError('partial-download', 'JPEG transfer failed', true)
    return files
  }
  async close(camera: CameraIdentity) {
    this.closed.push(camera.id)
  }
  async shutdown() {}
}
export async function cameraFixture() {
  const root = await mkdtemp(join(tmpdir(), 'irodori-camera-test-')),
    provider = new FakeCameraProvider()
  const lock = join(root, 'broker.sqlite')
  const create = () =>
    new CameraService([provider], new CameraStore(join(root, 'data'), lock), async () => ({
      ISO: 100,
      original: true,
    }))
  const service = create()
  await service.list()
  return {
    root,
    provider,
    service,
    create,
    async cleanup() {
      await service.shutdown()
      await rm(root, { recursive: true, force: true })
    },
  }
}
export async function finished(service: CameraService, id: string) {
  for (let index = 0; index < 200; index++) {
    const operation = await service.getOperation(id)
    if (!['queued', 'running'].includes(operation.state)) return operation
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Operation did not finish')
}
export function latch() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
