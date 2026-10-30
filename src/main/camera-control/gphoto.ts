import { mkdir, readFile, readdir, realpath, rmdir, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import {
  CameraError,
  digest,
  verification,
  type CameraIdentity,
  type CameraProvider,
  type CameraSetting,
} from './model.ts'
import { runProcess, type ProcessRunner } from './process.ts'
import { hashFile } from './store.ts'

const mapped: Record<string, string> = {
  iso: 'iso',
  shutterspeed: 'shutterSpeed',
  'f-number': 'aperture',
  aperture: 'aperture',
  whitebalance: 'whiteBalance',
  focusmode: 'focusMode',
  capturemode: 'driveMode',
  imagequality: 'format',
  imageformat: 'format',
  exposurecompensation: 'exposureCompensation',
  capturetarget: 'captureTarget',
  pcsaveimgsize: 'pcImageSize',
  pcsaveimgformat: 'pcImageFormat',
  autoexposuremode: 'exposureMode',
  expprogram: 'exposureMode',
}
const rawOriginal = /\.(?:arw|sr2|srf|dng|crw|cr2|cr3|nef|nrw|orf|rw2|raf|srw|pef|raw)$/i
const multiFrameIso = /multi[ -]*frame\s+noise\s+reduction/i
interface WriteTiming {
  now(): number
  wait(milliseconds: number): Promise<void>
}
interface WriteDiagnostic {
  setting: string
  requested: string
  outcome: 'settling' | 'verified' | 'unverified'
  busyReadCount: number
  elapsedMs: number
  commandError?: { code: string; message: string; uncertain: boolean }
}
const writeTiming: WriteTiming = { now: () => performance.now(), wait: delay }
function originalTypes(format: string | undefined): ('RAW' | 'JPEG')[] | undefined {
  const normalized = format?.replace(/\s+/g, '').toUpperCase()
  if (normalized === 'RAW+JPEG' || normalized === 'RAW+JPG') return ['RAW', 'JPEG']
  if (normalized === 'RAW') return ['RAW']
  if (normalized === 'JPEG' || normalized === 'JPG') return ['JPEG']
  return undefined
}
interface AttachmentStat {
  ino: bigint
  rdev: bigint
  isCharacterDevice(): boolean
  isDirectory(): boolean
}
export interface LinuxUsbAttachmentIo {
  stat(path: string): Promise<AttachmentStat>
  realpath(path: string): Promise<string>
  readFile(path: string): Promise<string>
}
const attachmentIo: LinuxUsbAttachmentIo = {
  stat: (path) => stat(path, { bigint: true }),
  realpath,
  readFile: (path) => readFile(path, 'utf8'),
}

/** Bind the USB object generation, not timestamps changed by ordinary camera I/O. */
export async function linuxUsbAttachment(port: string, io = attachmentIo): Promise<string> {
  try {
    const match = port.match(/^usb:(\d{1,5}),(\d{1,3})$/)
    if (
      !match ||
      Number(match[1]) < 1 ||
      Number(match[1]) > 65535 ||
      Number(match[2]) < 1 ||
      Number(match[2]) > 127
    )
      throw new CameraError('disconnected', 'Invalid USB route for attachment verification.')
    const [, bus, device] = match,
      node = `/dev/bus/usb/${bus.padStart(3, '0')}/${device.padStart(3, '0')}`,
      before = await io.stat(node),
      major = ((before.rdev >> 8n) & 0xfffn) | ((before.rdev >> 32n) & 0xfffff000n),
      minor = (before.rdev & 0xffn) | ((before.rdev >> 12n) & 0xffffff00n),
      link = `/sys/dev/char/${major}:${minor}`,
      object = await io.realpath(link)
    if (!before.isCharacterDevice() || !object.startsWith('/sys/devices/'))
      throw new CameraError('disconnected', 'USB attachment has no valid kernel device object.')
    const generation = await io.stat(object),
      [busnum, devnum, dev] = await Promise.all(
        ['busnum', 'devnum', 'dev'].map((name) => io.readFile(join(object, name))),
      )
    if (
      !generation.isDirectory() ||
      !/^\d+\s*$/.test(busnum) ||
      !/^\d+\s*$/.test(devnum) ||
      Number(busnum) !== Number(bus) ||
      Number(devnum) !== Number(device) ||
      dev.trim() !== `${major}:${minor}`
    )
      throw new CameraError(
        'disconnected',
        'Kernel USB attachment does not match the selected route.',
      )
    const after = await io.stat(node),
      currentObject = await io.realpath(link),
      currentGeneration = await io.stat(currentObject)
    if (
      !after.isCharacterDevice() ||
      before.ino !== after.ino ||
      before.rdev !== after.rdev ||
      currentObject !== object ||
      !currentGeneration.isDirectory() ||
      currentGeneration.ino !== generation.ino
    )
      throw new CameraError('disconnected', 'USB attachment changed during identity verification.')
    return `${port}:${before.ino}:${before.rdev}:${object}:${generation.ino}`
  } catch (error) {
    if (error instanceof CameraError) throw error
    throw new CameraError(
      ['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')
        ? 'usb-access'
        : 'disconnected',
      `USB attachment identity is unavailable: ${error}`,
    )
  }
}
export function parseDiscovery(output: string) {
  return output.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^(.+?)\s+(usb:\d+,\d+)\s*$/)
    return match ? [{ model: match[1].trim(), port: match[2] }] : []
  })
}
export function parseConfig(output: string): CameraSetting[] {
  return output
    .split(/(?=^\/main\/)/m)
    .filter((block) => block.startsWith('/main/'))
    .map((block) => {
      const lines = block.split(/\r?\n/),
        path = lines[0],
        name = path.split('/').at(-1)!
      const field = (key: string) =>
        lines.find((line) => line.startsWith(`${key}: `))?.slice(key.length + 2) ?? ''
      let choices = lines.flatMap((line) => {
        const match = line.match(/^Choice: \d+ (.*)$/)
        return match ? [match[1]] : []
      })
      const id = mapped[name] ?? path
      if (id === 'driveMode')
        choices = choices.filter((choice) => /^(single|single shot|single frame)$/i.test(choice))
      if (id === 'iso') choices = choices.filter((choice) => !multiFrameIso.test(choice))
      const writable =
        Boolean(mapped[name]) &&
        field('Readonly') === '0' &&
        choices.length > 0 &&
        ['RADIO', 'MENU'].includes(field('Type'))
      return {
        id,
        label: field('Label') || name,
        value: field('Current'),
        writable,
        choices,
        reason: writable ? undefined : 'Read-only, unmapped, or no safe discrete choices.',
        verification: verification(),
      }
    })
}
export class GphotoProvider implements CameraProvider {
  id = 'gphoto2'
  private paths = new Map<string, Map<string, string>>()
  private formats = new Map<string, string>()
  private writeDiagnostics = new Map<string, WriteDiagnostic>()
  private captureDiagnostics = new Map<string, string>()
  private recoveredOriginals = new Map<string, string[]>()
  root: string
  runner: ProcessRunner
  executable: string
  runtimeEnv: NodeJS.ProcessEnv
  attachment?: (port: string) => Promise<string>
  private timing: WriteTiming
  constructor(
    root: string,
    runner: ProcessRunner = runProcess,
    executable = 'gphoto2',
    attachment?: (port: string) => Promise<string>,
    runtimeEnv: NodeJS.ProcessEnv = {},
    timing: WriteTiming = writeTiming,
  ) {
    this.root = resolve(root)
    this.runner = runner
    this.executable = executable
    this.attachment = attachment
    this.runtimeEnv = runtimeEnv
    this.timing = timing
  }
  private async run(args: string[], cwd = this.root, timeout = 20_000) {
    const config = join(this.root, 'backend-config', 'gphoto')
    await mkdir(config, { recursive: true })
    // The new config file prevents libgphoto2 falling back to legacy user settings.
    await writeFile(join(config, 'settings'), '')
    return this.runner({
      executable: this.executable,
      args,
      cwd,
      timeout,
      env: {
        PATH: process.env.PATH,
        LANG: 'C',
        LC_ALL: 'C',
        ...this.runtimeEnv,
        XDG_CONFIG_HOME: join(this.root, 'backend-config'),
      },
    })
  }
  private route(camera: CameraIdentity) {
    return ['--camera', camera.backendModel, '--port', camera.port]
  }
  private async fingerprint(port: string) {
    if (this.attachment) return this.attachment(port)
    if (process.platform !== 'linux') return port
    return linuxUsbAttachment(port)
  }
  async discover() {
    try {
      const version = await this.run(['--version'])
      const result = await this.run(['--auto-detect'])
      const cameras = []
      for (const found of parseDiscovery(result.stdout)) {
        const connection = await this.fingerprint(found.port),
          physicalId = digest(`gphoto2:${found.model}:${found.port}`)
        cameras.push({
          id: digest(`${physicalId}:${connection}`),
          provider: this.id,
          model: found.model,
          backendModel: found.model,
          port: found.port,
          physicalId,
          connection,
          identityConfidence: 'connection-only' as const,
        })
      }
      return {
        cameras,
        diagnostics: [{ provider: this.id, available: true, message: version.stdout }],
      }
    } catch (error) {
      return {
        cameras: [],
        diagnostics: [{ provider: this.id, available: false, message: String(error) }],
      }
    }
  }
  private async check(camera: CameraIdentity) {
    if ((await this.fingerprint(camera.port)) !== camera.connection)
      throw new CameraError(
        'disconnected',
        'USB attachment changed. Discover and open a new session.',
      )
  }
  async open(camera: CameraIdentity) {
    await this.check(camera)
    const result = await this.run([...this.route(camera), '--summary'])
    camera.serial = result.stdout.match(/Serial Number:\s*(.+)/i)?.[1]?.trim()
    if (camera.serial && !/^0+$/.test(camera.serial)) {
      camera.physicalId = digest(`${camera.backendModel}:${camera.serial}`)
      camera.identityConfidence = 'serial'
    }
    camera.firmware = result.stdout
      .match(/(?:Device version|Firmware version):\s*(.+)/i)?.[1]
      ?.trim()
  }
  async inspect(camera: CameraIdentity, timeout = 20_000) {
    await this.check(camera)
    let output
    if (/^Sony\b/i.test(camera.backendModel)) {
      // Each CLI opens a new Sony PTP session. Initial descriptors can still
      // contain placeholders. Drain events before reading the configuration,
      // preserving any earlier pending originals outside the current operation.
      const directory = join(this.root, 'backend-recovered', randomUUID())
      await mkdir(directory, { recursive: true, mode: 0o700 })
      let failure: unknown
      try {
        output = await this.run(
          [
            ...this.route(camera),
            '--keep',
            '--filename',
            '%f.%C',
            '--wait-event-and-download=3s',
            '--list-all-config',
          ],
          directory,
          timeout,
        )
      } catch (error) {
        failure = error
      }
      const files = []
      for (const entry of await readdir(directory, { withFileTypes: true }))
        if (entry.isFile()) {
          const path = join(directory, entry.name)
          files.push({
            filename: entry.name,
            bytes: (await stat(path)).size,
            sha256: await hashFile(path),
          })
        }
      if (files.length || failure) {
        if (files.length)
          this.recoveredOriginals.set(camera.id, [
            ...(this.recoveredOriginals.get(camera.id) ?? []),
            directory,
          ])
        await writeFile(
          join(directory, 'inspection.json'),
          JSON.stringify(
            {
              cameraId: camera.id,
              completedAt: new Date().toISOString(),
              association: 'unclaimed; never attributed to a current capture',
              files,
              stdout: output?.stdout.slice(-16_000),
              stderr: output?.stderr.slice(-16_000),
              error: failure ? String(failure).slice(-16_000) : undefined,
            },
            null,
            2,
          ) + '\n',
          { mode: 0o600, flag: 'wx' },
        )
      } else await rmdir(directory)
      if (failure) throw failure
    } else output = await this.run([...this.route(camera), '--list-all-config'], this.root, timeout)
    const { stdout } = output!
    const settings = parseConfig(stdout),
      paths = new Map<string, string>()
    for (const block of stdout
      .split(/(?=^\/main\/)/m)
      .filter((block) => block.startsWith('/main/'))) {
      const path = block.split(/\r?\n/)[0],
        name = path.split('/').at(-1)!
      if (mapped[name]) paths.set(mapped[name], path)
    }
    this.paths.set(camera.id, paths)
    const format = settings.find((setting) => setting.id === 'format')?.value
    if (format === undefined) this.formats.delete(camera.id)
    else this.formats.set(camera.id, format)
    const drive = settings.find((s) => s.id === 'driveMode')
    const unsafeIso = multiFrameIso.test(
      settings.find((setting) => setting.id === 'iso')?.value ?? '',
    )
    const expected = originalTypes(format)
    const recovered = this.recoveredOriginals.get(camera.id),
      available = Boolean(
        drive &&
        drive.choices.includes(drive.value) &&
        !unsafeIso &&
        expected &&
        !recovered?.length,
      )
    return {
      settings,
      capture: {
        available,
        reason: available
          ? undefined
          : recovered?.length
            ? 'Pending originals were recovered separately. Review info.recoveredOriginals and close this session before another capture.'
            : unsafeIso
              ? 'Multi Frame Noise Reduction ISO uses multiple exposures and is unavailable for single-release capture.'
              : !expected
                ? 'The current original format is unknown or unsupported; capture completeness has not been verified.'
                : 'Single-frame drive mode must be read and selected; native burst/bracketing is unverified.',
        verification: verification(false),
      },
      info: {
        backend: 'gphoto2',
        firmware: camera.firmware,
        serial: camera.serial,
        captureFormat: format,
        expectedOriginals: expected,
        captureFormatSupport: expected ? 'supported' : 'unverified',
        latestWriteDiagnostic: this.writeDiagnostics.has(camera.id)
          ? structuredClone(this.writeDiagnostics.get(camera.id))
          : undefined,
        latestCaptureDiagnostic: this.captureDiagnostics.get(camera.id),
        recoveredOriginals: recovered ? [...recovered] : [],
      },
    }
  }
  async write(
    camera: CameraIdentity,
    setting: CameraSetting,
    value: string,
    onApplied?: (value: string) => Promise<void>,
  ) {
    await this.check(camera)
    const path = this.paths.get(camera.id)?.get(setting.id)
    if (!path || !setting.writable || !setting.choices.includes(value))
      throw new CameraError('unavailable-setting', 'Setting is not advertised.')
    let commandError: CameraError | undefined
    try {
      await this.run([...this.route(camera), '--set-config-value', `${path}=${value}`])
    } catch (error) {
      if (
        !(error instanceof CameraError) ||
        !['camera-busy', 'backend-error', 'timeout'].includes(error.code)
      )
        throw error
      commandError = error
    }
    // Acknowledgements and some PTP errors can precede an applied Sony write.
    // Poll the exact route; never repeat the setter or a shutter request.
    const started = this.timing.now(),
      readbackLimit = /^Sony\b/i.test(camera.backendModel) ? 10_000 : 5_000,
      deadline = started + readbackLimit,
      diagnostic: WriteDiagnostic = {
        setting: setting.id,
        requested: value,
        outcome: 'settling',
        busyReadCount: 0,
        elapsedMs: 0,
        ...(commandError
          ? {
              commandError: {
                code: commandError.code,
                message: commandError.message.slice(0, 1000),
                uncertain: commandError.uncertain,
              },
            }
          : {}),
      },
      finish = (outcome: WriteDiagnostic['outcome']) => {
        diagnostic.outcome = outcome
        diagnostic.elapsedMs = Math.max(0, this.timing.now() - started)
        this.writeDiagnostics.set(camera.id, diagnostic)
      }
    this.writeDiagnostics.set(camera.id, diagnostic)
    let observed: string | undefined
    try {
      while (this.timing.now() < deadline) {
        let inspection
        try {
          inspection = await this.inspect(
            camera,
            Math.max(1, Math.ceil(deadline - this.timing.now())),
          )
        } catch (error) {
          if (error instanceof CameraError && error.code === 'timeout') break
          if (!(error instanceof CameraError) || error.code !== 'camera-busy') throw error
          diagnostic.busyReadCount++
        }
        if (inspection) {
          observed = inspection.settings.find((current) => current.id === setting.id)?.value
          if (observed === value && this.timing.now() <= deadline) {
            finish('verified')
            await onApplied?.(value)
            return
          }
        }
        const remaining = deadline - this.timing.now()
        if (remaining > 0) await this.timing.wait(Math.min(150, remaining))
      }
      throw (
        commandError ??
        new CameraError(
          'readback-timeout',
          `${setting.id}: requested ${value} did not settle within ${readbackLimit / 1000} seconds; last readback ${observed}. No write was retried.`,
        )
      )
    } catch (error) {
      if (diagnostic.outcome !== 'verified') finish('unverified')
      throw error
    }
  }
  async capture(camera: CameraIdentity, directory: string, signal: AbortSignal) {
    signal.throwIfAborted()
    await this.check(camera)
    if (this.recoveredOriginals.get(camera.id)?.length)
      throw new CameraError(
        'unavailable-action',
        'Review recovered originals and close this session before another capture. No shutter was requested.',
      )
    // The service inspects immediately before release. Reuse that readback so
    // checking companions never reopens the CLI after a shutter was attempted.
    const format = this.formats.get(camera.id),
      expected = originalTypes(format)
    if (!expected)
      throw new CameraError(
        'unavailable-action',
        'The inspected original format is unknown or unsupported; no shutter was requested.',
      )
    const args = [
        ...this.route(camera),
        '--keep',
        '--filename',
        '%f.%C',
        '--capture-image-and-download',
        '--wait-event-and-download=2s',
      ],
      diagnostics = join(this.root, 'backend-diagnostics'),
      diagnosticPath = join(diagnostics, `${randomUUID()}.json`),
      diagnostic: Record<string, unknown> = {
        cameraId: camera.id,
        startedAt: new Date().toISOString(),
        args,
      }
    await mkdir(diagnostics, { recursive: true, mode: 0o700 })
    try {
      const result = await this.run(args, directory, 65_000)
      // gphoto2 can report capture errors yet exit zero. File validation below
      // remains authoritative; retain output even when no original arrives.
      diagnostic.stdout = result.stdout.slice(-16_000)
      diagnostic.stderr = result.stderr.slice(-16_000)
      diagnostic.command = 'exited-successfully'
    } catch (error) {
      diagnostic.command = 'failed'
      diagnostic.error = String(error).slice(-16_000)
      throw error
    } finally {
      diagnostic.completedAt = new Date().toISOString()
      await writeFile(diagnosticPath, JSON.stringify(diagnostic, null, 2) + '\n', {
        mode: 0o600,
        flag: 'wx',
      })
      this.captureDiagnostics.set(camera.id, diagnosticPath)
    }
    const files = []
    for (const entry of await readdir(directory, { withFileTypes: true }))
      if (entry.isFile()) files.push({ filename: entry.name, path: join(directory, entry.name) })
    if (!files.length)
      throw new CameraError(
        'capture-uncertain',
        `No original was downloaded. Do not repeat the shutter request. Backend diagnostic: ${diagnosticPath}`,
        true,
      )
    const raw = files.filter((file) => rawOriginal.test(file.filename)),
      jpeg = files.filter((file) => /\.jpe?g$/i.test(file.filename))
    if (
      files.length !== expected.length ||
      raw.length !== Number(expected.includes('RAW')) ||
      jpeg.length !== Number(expected.includes('JPEG')) ||
      (expected.length === 2 &&
        raw[0].filename.replace(/\.[^.]+$/, '') !== jpeg[0].filename.replace(/\.[^.]+$/, ''))
    )
      throw new CameraError(
        'partial-download',
        `${format} capture did not produce exactly the expected ${expected.join(' and ')} originals within the bounded event drain. Partial files are retained. Check the PC transfer format on the camera; do not repeat this shutter request.`,
        true,
      )
    return files
  }
  async close(camera: CameraIdentity) {
    this.paths.delete(camera.id)
    this.formats.delete(camera.id)
    this.writeDiagnostics.delete(camera.id)
    this.captureDiagnostics.delete(camera.id)
    this.recoveredOriginals.delete(camera.id)
  }
  async shutdown() {}
}
