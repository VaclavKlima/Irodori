import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  CameraError,
  digest,
  verification,
  type CameraIdentity,
  type CameraProvider,
  type CameraSetting,
} from './model.ts'
import { runProcess, type ProcessRunner } from './process.ts'

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
  root: string
  runner: ProcessRunner
  executable: string
  runtimeEnv: NodeJS.ProcessEnv
  attachment?: (port: string) => Promise<string>
  constructor(
    root: string,
    runner: ProcessRunner = runProcess,
    executable = 'gphoto2',
    attachment?: (port: string) => Promise<string>,
    runtimeEnv: NodeJS.ProcessEnv = {},
  ) {
    this.root = resolve(root)
    this.runner = runner
    this.executable = executable
    this.attachment = attachment
    this.runtimeEnv = runtimeEnv
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
    const [, bus, device] = port.match(/^usb:(\d+),(\d+)$/)!
    let value
    try {
      value = await stat(`/dev/bus/usb/${bus.padStart(3, '0')}/${device.padStart(3, '0')}`, {
        bigint: true,
      })
    } catch (error) {
      throw new CameraError(
        (error as NodeJS.ErrnoException).code === 'EACCES' ? 'usb-access' : 'disconnected',
        `USB attachment is unavailable: ${error}`,
      )
    }
    return `${port}:${value.ino}:${value.ctimeNs}`
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
  async inspect(camera: CameraIdentity) {
    await this.check(camera)
    const { stdout } = await this.run([...this.route(camera), '--list-all-config'])
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
    const drive = settings.find((s) => s.id === 'driveMode')
    const available = Boolean(drive && drive.choices.includes(drive.value))
    return {
      settings,
      capture: {
        available,
        reason: available
          ? undefined
          : 'Single-frame drive mode must be read and selected; native burst/bracketing is unverified.',
        verification: verification(false),
      },
      info: { backend: 'gphoto2', firmware: camera.firmware, serial: camera.serial },
    }
  }
  async write(camera: CameraIdentity, setting: CameraSetting, value: string) {
    await this.check(camera)
    const path = this.paths.get(camera.id)?.get(setting.id)
    if (!path || !setting.writable || !setting.choices.includes(value))
      throw new CameraError('unavailable-setting', 'Setting is not advertised.')
    await this.run([...this.route(camera), '--set-config-value', `${path}=${value}`])
  }
  async capture(camera: CameraIdentity, directory: string, signal: AbortSignal) {
    signal.throwIfAborted()
    await this.check(camera)
    await this.run(
      [
        ...this.route(camera),
        '--keep',
        '--filename',
        '%f.%C',
        '--capture-image-and-download',
        '--wait-event-and-download=2s',
      ],
      directory,
      65_000,
    )
    const files = []
    for (const entry of await readdir(directory, { withFileTypes: true }))
      if (entry.isFile()) files.push({ filename: entry.name, path: join(directory, entry.name) })
    if (!files.length)
      throw new CameraError(
        'capture-uncertain',
        'No original was downloaded. Do not repeat the shutter request.',
        true,
      )
    return files
  }
  async close(camera: CameraIdentity) {
    this.paths.delete(camera.id)
  }
  async shutdown() {}
}
