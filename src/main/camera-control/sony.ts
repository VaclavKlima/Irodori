import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  CameraError,
  digest,
  verification,
  type CameraIdentity,
  type CameraProvider,
  type CameraSetting,
} from './model.ts'
import {
  Packet,
  deviceInfo,
  encodeValue,
  objectInfo,
  sonyProperties,
  type SonyProperty,
} from './sony-packets.ts'
import type { PtpTransport } from './image-capture.ts'

const names: Record<number, [string, string]> = {
  0x5004: ['format', 'File format'],
  0x5005: ['whiteBalance', 'White balance'],
  0x5007: ['aperture', 'Aperture'],
  0x500a: ['focusMode', 'Focus mode'],
  0x500e: ['exposureMode', 'Exposure mode'],
  0x5013: ['driveMode', 'Drive mode'],
  0xd224: ['exposureCompensation', 'Exposure compensation (1/1000 EV)'],
  0xd226: ['iso', 'ISO'],
  0xd229: ['shutterSpeed', 'Shutter speed'],
  0xd222: ['captureTarget', 'Capture destination'],
  0xd268: ['pcImageSize', 'PC image size'],
  0xd269: ['pcImageFormat', 'RAW+JPEG PC transfer'],
}
const labels: Record<number, Record<number, string>> = {
  0x5004: { 16: 'RAW', 19: 'RAW+JPEG', 2: 'JPEG Standard', 3: 'JPEG Fine', 4: 'JPEG Extra Fine' },
  0x5005: { 2: 'Auto', 4: 'Daylight', 6: 'Tungsten', 7: 'Flash', 32785: 'Cloudy', 32784: 'Shade' },
  0x500a: { 1: 'Manual', 2: 'AF-S', 32773: 'AF-C', 32772: 'DMF', 32774: 'AF-A' },
  0x500e: { 1: 'Manual', 2: 'Program', 3: 'Aperture priority', 4: 'Shutter priority' },
  0x5013: { 1: 'Single', 2: 'Continuous' },
  0xd222: { 1: 'PC Only', 16: 'Camera Only', 17: 'PC+Camera' },
  0xd268: { 1: 'Original', 2: '2M' },
  0xd269: { 0: 'Disabled', 1: 'RAW & JPEG', 2: 'JPEG Only', 3: 'RAW Only' },
}
function display(code: number, value: number | string): string {
  if (typeof value === 'string') return value
  if (code === 0x5007) return `f/${value / 100}`
  if (code === 0xd229) return `${value >>> 16}/${value & 65535}`
  if (code === 0xd226 && value === 16777215) return 'Auto'
  return labels[code]?.[value] ?? String(value)
}
export class SonyImageCaptureProvider implements CameraProvider {
  id = 'image-capture-sony'
  transport: PtpTransport
  private properties = new Map<string, SonyProperty[]>()
  private info = new Map<string, ReturnType<typeof deviceInfo>>()
  private opened = new Set<string>()
  constructor(transport: PtpTransport) {
    this.transport = transport
  }
  async discover() {
    try {
      let cameras = await this.transport.list()
      // First enumeration can take several seconds on macOS.
      if (!cameras.length) cameras = await this.transport.list()
      return {
        cameras: cameras.map((camera) => {
          const physicalId = digest(
            `${camera.vendor}:${camera.product}:${camera.serial || camera.location}`,
          )
          return {
            id: digest(`${physicalId}:${camera.connection}`),
            physicalId,
            provider: this.id,
            model: camera.model,
            backendModel: `Sony PTP ${camera.vendor.toString(16)}:${camera.product.toString(16)}`,
            port: String(camera.location),
            connection: camera.connection,
            serial: camera.serial,
            identityConfidence: camera.serial ? ('serial' as const) : ('connection-only' as const),
          }
        }),
        diagnostics: [
          {
            provider: this.id,
            available: true,
            message:
              'Apple ImageCaptureCore; Sony ZV-1/ZV-1A protocol only. Other cameras remain unavailable.',
          },
        ],
      }
    } catch (error) {
      return {
        cameras: [],
        diagnostics: [{ provider: this.id, available: false, message: String(error) }],
      }
    }
  }
  private ptp(
    camera: CameraIdentity,
    code: number,
    parameters: number[] = [],
    data?: Buffer,
    file?: string,
  ) {
    return this.transport.command(camera.connection, code, parameters, data, file)
  }
  async open(camera: CameraIdentity) {
    await this.transport.open(camera.connection)
    this.opened.add(camera.connection)
    const info = deviceInfo(await this.ptp(camera, 0x1001))
    this.info.set(camera.connection, info)
    camera.firmware = info.firmware
    if (!['ZV-1', 'ZV-1A'].includes(info.model) || info.manufacturer !== 'Sony Corporation')
      throw new CameraError(
        'unsupported-camera',
        'Native provider supports only independently identified Sony ZV-1/ZV-1A cameras.',
      )
    for (const phase of [1, 2]) await this.ptp(camera, 0x9201, [phase, 0, 0])
    const extension = await this.ptp(camera, 0x9202, [200])
    if (extension.length < 2 || extension.readUInt16LE() !== 200)
      throw new CameraError('unsupported-protocol', 'Only Sony protocol 2.00 is implemented.')
    await this.ptp(camera, 0x9201, [3, 0, 0])
    await delay(3000)
  }
  private async read(camera: CameraIdentity) {
    const properties = sonyProperties(await this.ptp(camera, 0x9209))
    this.properties.set(camera.connection, properties)
    return properties
  }
  async inspect(camera: CameraIdentity) {
    const properties = await this.read(camera)
    const settings = properties
      .filter((p) => names[p.code])
      .map((property) => {
        const [id, label] = names[property.code]
        // Mode 2 exposes direct shutter2 and aperture as display-only; the
        // provider uses the specific direct commands cross-checked in libgphoto2.
        const supported =
          property.enabled !== 0 &&
          (property.getSet === 1 || [0xd229, 0x5007].includes(property.code))
        let raw = property.choices
        if (labels[property.code])
          raw = raw.filter(
            (value) => typeof value === 'number' && labels[property.code][value] !== undefined,
          )
        if (property.code === 0x5007)
          raw = [
            180, 200, 220, 250, 280, 320, 350, 400, 450, 500, 560, 630, 710, 800, 900, 1000, 1100,
          ]
        // Keep native burst/bracketing unavailable: one trigger must mean one exposure.
        if (property.code === 0x5013) raw = [1]
        return {
          id,
          label,
          value: display(property.code, property.value),
          writable: supported && raw.length > 0,
          reason: !supported
            ? property.code === 0xd222
              ? 'Save destination is read-only; select PC Only or PC+Camera in the camera menu.'
              : 'Unavailable in the current camera mode.'
            : !raw.length
              ? 'No safely mapped writable choices.'
              : undefined,
          choices: raw.map((value) => display(property.code, value)),
          verification: verification(),
        }
      })
    const drive = properties.find((p) => p.code === 0x5013)?.value
    const pending = Number(properties.find((p) => p.code === 0xd215)?.value ?? 0)
    const target = properties.find((p) => p.code === 0xd222)?.value
    const available = drive === 1 && pending < 0x8000 && target !== 16
    return {
      settings,
      capture: {
        available,
        reason:
          drive !== 1
            ? 'Set driveMode to Single before a software exposure.'
            : pending >= 0x8000
              ? 'Unclaimed originals remain in camera RAM. Reconnect; never drain or retrigger automatically.'
              : target === 16
                ? 'Select PC Only or PC+Camera to download originals.'
                : undefined,
        verification: verification(false),
      },
      info: {
        ...this.info.get(camera.connection),
        protocol: 'Sony SDIO 2.00',
        pendingOriginals: pending,
        unmappedProperties: properties.filter((p) => !names[p.code]),
      },
    }
  }
  private async waitValue(
    camera: CameraIdentity,
    code: number,
    predicate: (property: SonyProperty) => boolean,
  ) {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const property = (await this.read(camera)).find((property) => property.code === code)
      if (property && predicate(property)) return property
      await delay(100)
    }
    throw new CameraError(
      'readback-mismatch',
      `Sony property ${code.toString(16)} did not settle within five seconds.`,
    )
  }
  async write(
    camera: CameraIdentity,
    setting: CameraSetting,
    value: string,
    onApplied?: (value: string) => Promise<void>,
  ) {
    const properties = await this.read(camera)
    const code = Number(Object.keys(names).find((code) => names[Number(code)][0] === setting.id))
    const property = properties.find((p) => p.code === code)
    if (!property) throw new CameraError('unavailable-setting', 'Property disappeared.')
    let raw = property.choices.find((choice) => display(code, choice) === value)
    if (code === 0x5007) raw = Math.round(Number(value.replace('f/', '')) * 100)
    if (raw === undefined || typeof raw !== 'number')
      throw new CameraError('unavailable-setting', 'Unknown property value.')
    if (code === 0x5007) {
      for (let i = 0; i < 32; i++) {
        const current = (await this.read(camera)).find((p) => p.code === code)!
        if (current.value === raw) return
        await this.ptp(camera, 0x9207, [code], Buffer.from([Number(current.value) < raw ? 1 : 255]))
        const after = await this.waitValue(
          camera,
          code,
          (property) => property.value !== current.value,
        )
        await onApplied?.(display(code, after.value))
      }
      throw new CameraError('readback-mismatch', 'Aperture target was not reached within 32 steps.')
    }
    await this.ptp(camera, 0x9205, [code], encodeValue(property.type, raw))
    const applied = await this.waitValue(camera, code, (property) => property.value === raw)
    await onApplied?.(display(code, applied.value))
  }
  async capture(camera: CameraIdentity, directory: string, signal: AbortSignal) {
    signal.throwIfAborted()
    const inspection = await this.inspect(camera)
    if (!inspection.capture.available)
      throw new CameraError('unavailable-action', inspection.capture.reason!)
    let releaseFailure: unknown
    try {
      await this.ptp(camera, 0x9207, [0xd2c1], encodeValue(4, 2))
      await this.ptp(camera, 0x9207, [0xd2c2], encodeValue(4, 2))
      await delay(300)
    } finally {
      // Always release both buttons, including cancellation and rejected capture.
      for (const code of [0xd2c2, 0xd2c1])
        try {
          await this.ptp(camera, 0x9207, [code], encodeValue(4, 1))
        } catch (error) {
          releaseFailure = error
        }
    }
    if (releaseFailure) throw releaseFailure
    const deadline = Date.now() + 45_000
    let pending = 0
    while (Date.now() < deadline) {
      pending = Number((await this.read(camera)).find((p) => p.code === 0xd215)?.value ?? 0)
      if (pending >= 0x8000) break
      await delay(200)
    }
    if (pending < 0x8000)
      throw new CameraError(
        'capture-uncertain',
        'Shutter was requested but no original became available. Do not retry this request.',
        true,
      )
    const files = []
    // A trigger's RAW/JPEG companions are drained together, even on cancellation.
    for (let i = 0; i < 8 && pending >= 0x8000; i++) {
      const info = objectInfo(await this.ptp(camera, 0x1008, [0xffffc001]))
      if (
        !/^[a-zA-Z0-9_. -]{1,128}$/.test(info.filename) ||
        info.filename.startsWith('.') ||
        !info.bytes ||
        info.bytes > 512 * 1024 * 1024
      )
        throw new CameraError(
          'invalid-original',
          'Camera returned an unsafe filename or original size.',
          true,
        )
      const path = join(directory, info.filename)
      await this.ptp(camera, 0x1009, [0xffffc001], undefined, path)
      files.push({
        filename: info.filename,
        path,
        cameraBytes: info.bytes,
        cameraPath: `RAM:ffffc001/${info.filename}`,
      })
      pending = Number((await this.read(camera)).find((p) => p.code === 0xd215)?.value ?? 0)
    }
    if (pending >= 0x8000)
      throw new CameraError('partial-download', 'Additional originals remain in camera RAM.', true)
    const format = inspection.settings.find((setting) => setting.id === 'format')?.value
    if (
      format === 'RAW+JPEG' &&
      (files.length !== 2 ||
        !files.some((file) => /\.arw$/i.test(file.filename)) ||
        !files.some((file) => /\.jpe?g$/i.test(file.filename)))
    )
      throw new CameraError(
        'partial-download',
        'RAW+JPEG capture did not produce both associated originals. Check RAW+J PC Save Img on the camera; do not repeat this shutter request.',
        true,
      )
    return files
  }
  async close(camera: CameraIdentity) {
    if (this.opened.delete(camera.connection)) await this.transport.close(camera.connection)
    this.properties.delete(camera.connection)
    this.info.delete(camera.connection)
  }
  async shutdown() {
    await this.transport.shutdown()
  }
  async inventory(camera: CameraIdentity) {
    try {
      const ids = new Packet(await this.ptp(camera, 0x1004)).array(4)
      const inventory: { key: string; bytes: number; filename: string }[] = []
      for (const storage of ids) {
        const handles = new Packet(await this.ptp(camera, 0x1007, [storage, 0, 0])).array(4)
        if (handles.length > 256)
          return {
            available: false,
            files: [],
            reason: 'Card inventory exceeds the 256-object development inspection bound.',
          }
        for (const handle of handles) {
          const info = objectInfo(await this.ptp(camera, 0x1008, [handle]))
          inventory.push({
            key: `${storage}:${handle}:${info.filename}`,
            bytes: info.bytes,
            filename: info.filename,
          })
        }
      }
      return {
        available: ids.length > 0,
        files: inventory,
        reason: ids.length ? undefined : 'Sony PC Remote exposes no addressable card storage.',
      }
    } catch (error) {
      if (error instanceof CameraError && error.code === 'ptp-rejected')
        return { available: false, files: [], reason: error.message }
      throw error
    }
  }
}
