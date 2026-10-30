import { expect, test } from '@playwright/test'
import {
  CameraError,
  actionRequest,
  advertisedActions,
  exposureSeconds,
  settings,
  validateSettings,
} from '../src/main/camera-control/model'
import {
  parseConfig,
  parseDiscovery,
  GphotoProvider,
  linuxUsbAttachment,
  type LinuxUsbAttachmentIo,
} from '../src/main/camera-control/gphoto'
import { runProcess } from '../src/main/camera-control/process'
import { CameraService } from '../src/main/camera-control/service'
import { CameraStore } from '../src/main/camera-control/store'
import {
  Packet,
  deviceInfo,
  encodeValue,
  objectInfo,
  sonyProperties,
} from '../src/main/camera-control/sony-packets'
import { SonyImageCaptureProvider } from '../src/main/camera-control/sony'
import type { PtpTransport } from '../src/main/camera-control/image-capture'
import { ImageCaptureTransport } from '../src/main/camera-control/image-capture'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeCameraProvider, finished } from './camera-control.helpers'

test('bounded action schemas reject unsafe, unknown and native operations', async () => {
  expect(
    actionRequest('exposure-sequence', {
      steps: Array.from({ length: 32 }, () => ({ iso: '100' })),
    }).action,
  ).toBe('exposure-sequence')
  for (const count of [0, 33])
    expect(() => actionRequest('exposure-sequence', { steps: Array(count).fill({}) })).toThrow(
      '1–32',
    )
  for (const action of ['delete', 'format', 'firmware', 'native-burst', 'native-bracketing'])
    expect(() => actionRequest(action, {})).toThrow('not advertised')
  for (const value of [
    { iso: 100 },
    { '--hook-script': 'malicious' },
    { iso: '100\n--delete-all-files' },
    null,
    [],
  ])
    expect(() => settings(value)).toThrow()
  expect(() => actionRequest('capture', { settings: {}, path: '/tmp' })).toThrow('Expected fields')
  const provider = new FakeCameraProvider(),
    inspection = await provider.inspect(provider.cameras[0])
  validateSettings({ iso: '100' }, inspection)
  expect(() => validateSettings({ iso: '64000' }, inspection)).toThrow()
  const actions = advertisedActions(inspection)
  expect(
    actions.find((a) => a.id === 'exposure-sequence')?.parameters?.properties.steps,
  ).toMatchObject({ minItems: 1, maxItems: 32 })
  expect(actions.find((a) => a.id === 'native-bracketing')?.available).toBe(false)
})

test('gphoto parsing separates same-model ports, read-only and safe photographic choices', () => {
  expect(
    parseDiscovery(
      'Model Port\n---\nSony ZV-1 (PC Control) usb:001,001\nSony ZV-1 (PC Control) usb:001,002',
    ),
  ).toEqual([
    { model: 'Sony ZV-1 (PC Control)', port: 'usb:001,001' },
    { model: 'Sony ZV-1 (PC Control)', port: 'usb:001,002' },
  ])
  const result = parseConfig(
    '/main/imgsettings/iso\nLabel: ISO\nReadonly: 0\nType: RADIO\nCurrent: 100\nChoice: 0 100\nChoice: 1 200\nEND\n/main/actions/formatcard\nLabel: Format\nReadonly: 0\nType: RADIO\nCurrent: no\nChoice: 0 yes\nEND\n/main/capturesettings/capturemode\nReadonly: 0\nType: RADIO\nCurrent: Single\nChoice: 0 Single\nChoice: 1 Continuous\nEND\n/main/settings/whitebalance\nReadonly: 1\nType: RADIO\nCurrent: Auto\nChoice: 0 Auto\nEND',
  )
  expect(result.map((s) => [s.id, s.writable])).toEqual([
    ['iso', true],
    ['/main/actions/formatcard', false],
    ['driveMode', true],
    ['whiteBalance', false],
  ])
  expect(result[2].choices).toEqual(['Single'])
})

test('gphoto uses exact routing, isolated config, fixed arguments, keep and bounded waits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-gphoto-test-'))
  const calls: { args: string[]; env: NodeJS.ProcessEnv; cwd: string }[] = []
  let iso = '100'
  const runner = async (request: { args: string[]; env: NodeJS.ProcessEnv; cwd: string }) => {
    calls.push(request)
    if (request.args.includes('--set-config-value')) iso = '200'
    return {
      stdout: request.args.includes('--list-all-config')
        ? `/main/imgsettings/iso\nReadonly: 0\nType: RADIO\nCurrent: ${iso}\nChoice: 0 100\nChoice: 1 200\nEND\n/main/capturesettings/imagequality\nReadonly: 1\nType: RADIO\nCurrent: RAW\nChoice: 0 RAW\nEND`
        : '',
      stderr: '',
    }
  }
  try {
    const provider = new GphotoProvider(root, runner, 'gphoto2', async (port) => port),
      camera = new FakeCameraProvider().cameras[1]
    camera.connection = camera.port // Windows/macOS fake; Linux real attachment checks are separately scoped.
    await provider.open(camera)
    const inspection = await provider.inspect(camera)
    await provider.write(camera, inspection.settings[0], '200')
    await expect(provider.capture(camera, root, new AbortController().signal)).rejects.toThrow(
      'No original',
    )
    for (const call of calls) {
      expect(call.args.slice(0, 4)).toEqual(['--camera', 'Driver Alias', '--port', 'usb:001,002'])
      expect(call.env.HOME).toBeUndefined()
      expect(call.env.XDG_CONFIG_HOME).toBe(join(root, 'backend-config'))
      expect(call.env.GPHOTO2_DRIVER_DIR).toBeUndefined()
    }
    expect(calls.at(-1)!.args).toContain('--keep')
    expect(calls.at(-1)!.args).toContain('--wait-event-and-download=2s')
    expect(await readFile(join(root, 'backend-config/gphoto/settings'), 'utf8')).toBe('')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Linux attachment identity survives device I/O timestamps and changes on kernel object replacement', async () => {
  const port = 'usb:001,006',
    node = '/dev/bus/usb/001/006',
    object = '/sys/devices/pci-test/usb1/1-6'
  let timestamp = 1n,
    nodeInode = 1891n,
    objectInode = 87230n
  const io: LinuxUsbAttachmentIo = {
    async stat(path) {
      expect([node, object]).toContain(path)
      return {
        ino: path === node ? nodeInode : objectInode,
        rdev: path === node ? 48389n : 0n,
        ctimeNs: timestamp,
        mtimeNs: timestamp,
        isCharacterDevice: () => path === node,
        isDirectory: () => path === object,
      }
    },
    async realpath(path) {
      expect(path).toBe('/sys/dev/char/189:5')
      return object
    },
    async readFile(path) {
      return {
        [join(object, 'busnum')]: '1\n',
        [join(object, 'devnum')]: '6\n',
        [join(object, 'dev')]: '189:5\n',
      }[path]
    },
  }
  const original = await linuxUsbAttachment(port, io)
  timestamp++
  expect(await linuxUsbAttachment(port, io)).toBe(original)
  objectInode++
  expect(await linuxUsbAttachment(port, io)).not.toBe(original)
  objectInode--
  nodeInode++
  expect(await linuxUsbAttachment(port, io)).not.toBe(original)
})

test('Linux attachment checks decode full device numbers and refuse missing, mismatched or racing identities', async () => {
  const object = '/sys/devices/pci-test/usb1/1-6',
    major = 0x12345n,
    minor = 0x1234567n,
    encoded =
      ((major & 0xfffn) << 8n) |
      ((major & 0xfffff000n) << 32n) |
      (minor & 0xffn) |
      ((minor & 0xffffff00n) << 12n)
  let deviceReads = 0,
    replaceDuringRead = false,
    busnum = '1',
    unavailable: string | undefined
  const io: LinuxUsbAttachmentIo = {
    async stat(path) {
      const node = path.startsWith('/dev/')
      if (node) deviceReads++
      return {
        ino: node ? (replaceDuringRead && deviceReads % 2 === 0 ? 2n : 1n) : 3n,
        rdev: node ? encoded : 0n,
        isCharacterDevice: () => node,
        isDirectory: () => !node,
      }
    },
    async realpath(path) {
      expect(path).toBe(`/sys/dev/char/${major}:${minor}`)
      if (unavailable)
        throw Object.assign(new Error('Unavailable test device object.'), { code: unavailable })
      return object
    },
    async readFile(path) {
      return {
        [join(object, 'busnum')]: busnum,
        [join(object, 'devnum')]: '6',
        [join(object, 'dev')]: `${major}:${minor}`,
      }[path]
    },
  }
  expect(await linuxUsbAttachment('usb:001,006', io)).toContain(`${encoded}:${object}:3`)
  busnum = '2'
  await expect(linuxUsbAttachment('usb:001,006', io)).rejects.toMatchObject({
    code: 'disconnected',
  })
  busnum = '1'
  unavailable = 'ENOENT'
  await expect(linuxUsbAttachment('usb:001,006', io)).rejects.toMatchObject({
    code: 'disconnected',
  })
  unavailable = 'EACCES'
  await expect(linuxUsbAttachment('usb:001,006', io)).rejects.toMatchObject({ code: 'usb-access' })
  unavailable = undefined
  deviceReads = 0
  replaceDuringRead = true
  await expect(linuxUsbAttachment('usb:001,006', io)).rejects.toMatchObject({
    code: 'disconnected',
  })
})

const rawJpegConfig =
  '/main/capturesettings/imagequality\nReadonly: 0\nType: RADIO\nCurrent: RAW+JPEG\nChoice: 0 RAW\nChoice: 1 RAW+JPEG\nChoice: 2 JPEG\nEND\n/main/capturesettings/capturemode\nReadonly: 0\nType: RADIO\nCurrent: Single Shot\nChoice: 0 Single Shot\nEND'

test('Sony inspection settles actual descriptors without releasing a shutter or inventing missing values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-sony-inspect-settle-')),
    camera = new FakeCameraProvider().cameras[0],
    calls: { args: string[]; cwd: string }[] = []
  camera.backendModel = 'Sony ZV-1 (PC Control)'
  camera.connection = camera.port
  const provider = new GphotoProvider(
    root,
    async (request) => {
      calls.push(request)
      return {
        stdout: request.args.includes('--wait-event-and-download=3s')
          ? rawJpegConfig
          : rawJpegConfig.replace('Current: Single Shot', 'Current: Unknown value 0000'),
        stderr: '',
      }
    },
    'gphoto2',
    async (port) => port,
  )
  try {
    const result = await provider.inspect(camera)
    expect(result.settings.find(({ id }) => id === 'driveMode')?.value).toBe('Single Shot')
    expect(result.capture.available).toBe(true)
    expect(result.info.recoveredOriginals).toEqual([])
    expect(calls).toHaveLength(1)
    expect(calls[0].args.slice(-2)).toEqual(['--wait-event-and-download=3s', '--list-all-config'])
    expect(calls[0].args).toContain('--keep')
    expect(calls[0].args).not.toContain('--capture-image-and-download')
    expect(calls[0].args).not.toContain('--set-config-value')
    expect(await readdir(join(root, 'backend-recovered'))).toEqual([])
  } finally {
    await provider.close(camera)
    await rm(root, { recursive: true, force: true })
  }
})

for (const failedDownload of [false, true])
  test(`Sony inspection preserves unclaimed originals and blocks capture after ${failedDownload ? 'partial transfer failure' : 'pending transfer'}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'irodori-sony-inspect-recover-')),
      camera = new FakeCameraProvider().cameras[0],
      calls: { args: string[]; cwd: string }[] = []
    camera.backendModel = 'Sony ZV-1 (PC Control)'
    camera.connection = camera.port
    const provider = new GphotoProvider(
      root,
      async (request) => {
        calls.push(request)
        if (calls.length === 1) {
          await writeFile(join(request.cwd, 'DSC0001.ARW'), 'unclaimed-original-bytes')
          if (failedDownload) throw new CameraError('timeout', 'Pending transfer timed out.', true)
        }
        return { stdout: rawJpegConfig, stderr: '' }
      },
      'gphoto2',
      async (port) => port,
    )
    try {
      if (failedDownload)
        await expect(provider.inspect(camera)).rejects.toMatchObject({ code: 'timeout' })
      else {
        const inspection = await provider.inspect(camera)
        expect(inspection.capture.available).toBe(false)
        expect(inspection.capture.reason).toContain('Pending originals')
      }
      const next = await provider.inspect(camera),
        directories = next.info.recoveredOriginals as string[]
      expect(directories).toEqual([calls[0].cwd])
      expect(next.capture.available).toBe(false)
      await expect(
        provider.capture(camera, root, new AbortController().signal),
      ).rejects.toMatchObject({ code: 'unavailable-action', uncertain: false })
      expect(calls).toHaveLength(2)
      expect(calls.some(({ args }) => args.includes('--capture-image-and-download'))).toBe(false)
      const manifest = JSON.parse(await readFile(join(directories[0], 'inspection.json'), 'utf8'))
      expect(manifest.association).toContain('unclaimed')
      expect(manifest.files).toMatchObject([{ filename: 'DSC0001.ARW', bytes: 24 }])
      expect(manifest.files[0].sha256).toMatch(/^[a-f0-9]{64}$/)
      if (failedDownload) expect(manifest.error).toContain('Pending transfer timed out')
      await provider.close(camera)
      expect(await readFile(join(directories[0], 'DSC0001.ARW'), 'utf8')).toBe(
        'unclaimed-original-bytes',
      )
    } finally {
      await provider.close(camera)
      await rm(root, { recursive: true, force: true })
    }
  })

test('Sony writes verify through independent quarantined inspection without repeating the setter', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-sony-write-events-')),
    calls: string[][] = [],
    camera = new FakeCameraProvider().cameras[0]
  camera.backendModel = 'Sony ZV-1 (PC Control)'
  camera.connection = camera.port
  const provider = new GphotoProvider(
    root,
    async ({ args }) => {
      calls.push(args)
      // A stale setter response must not supply verification.
      return {
        stdout: rawJpegConfig.replace(
          'Current: RAW+JPEG',
          args.includes('--set-config-value') || calls.length === 1
            ? 'Current: RAW'
            : 'Current: RAW+JPEG',
        ),
        stderr: '',
      }
    },
    'gphoto2',
    async (port) => port,
  )
  try {
    const inspection = await provider.inspect(camera),
      applied: string[] = []
    await provider.write(
      camera,
      inspection.settings.find((setting) => setting.id === 'format')!,
      'RAW+JPEG',
      async (value) => {
        expect(calls.at(-1)).toContain('--list-all-config')
        applied.push(value)
      },
    )
    const setters = calls.filter((args) => args.includes('--set-config-value'))
    expect(setters).toHaveLength(1)
    expect(setters[0].slice(-2)).toEqual([
      '--set-config-value',
      '/main/capturesettings/imagequality=RAW+JPEG',
    ])
    expect(calls.some((args) => args.some((arg) => arg.startsWith('--wait-event=')))).toBe(false)
    expect(calls.filter((args) => args.includes('--wait-event-and-download=3s'))).toHaveLength(2)
    expect(applied).toEqual(['RAW+JPEG'])
  } finally {
    await provider.close(camera)
    await rm(root, { recursive: true, force: true })
  }
})

for (const backendFailure of [false, true])
  test(`Sony capture keeps diagnostics without a discarding event wait after ${backendFailure ? 'a backend error' : 'a zero-exit missing original'}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'irodori-sony-capture-diagnostics-')),
      calls: string[][] = [],
      camera = new FakeCameraProvider().cameras[0]
    camera.backendModel = 'Sony ZV-1 (PC Control)'
    camera.connection = camera.port
    const provider = new GphotoProvider(
      root,
      async ({ args }) => {
        calls.push(args)
        if (args.includes('--capture-image-and-download') && backendFailure)
          throw new CameraError('backend-error', 'Capture was rejected by the backend.', true)
        return {
          stdout: args.includes('--list-all-config') ? rawJpegConfig : 'Capture was rejected.',
          stderr: '',
        }
      },
      'gphoto2',
      async (port) => port,
    )
    try {
      await provider.inspect(camera)
      await expect(
        provider.capture(camera, root, new AbortController().signal),
      ).rejects.toMatchObject({
        code: backendFailure ? 'backend-error' : 'capture-uncertain',
        uncertain: true,
      })
      const inspection = await provider.inspect(camera),
        path = inspection.info.latestCaptureDiagnostic as string,
        diagnostic = JSON.parse(await readFile(path, 'utf8')),
        capture = calls.filter((args) => args.includes('--capture-image-and-download'))
      expect(capture).toHaveLength(1)
      expect(capture[0].slice(-2)).toEqual([
        '--capture-image-and-download',
        '--wait-event-and-download=2s',
      ])
      expect(calls.some((args) => args.some((arg) => arg.startsWith('--wait-event=')))).toBe(false)
      expect(capture[0]).toContain('--keep')
      expect(path.startsWith(join(root, 'backend-diagnostics'))).toBe(true)
      expect(diagnostic.args).toEqual(capture[0])
      expect(diagnostic.command).toBe(backendFailure ? 'failed' : 'exited-successfully')
      if (backendFailure) expect(diagnostic.error).toContain('Capture was rejected by the backend.')
      else expect(diagnostic.stdout).toBe('Capture was rejected.')
      expect(diagnostic.completedAt).toBeTruthy()
    } finally {
      await provider.close(camera)
      await rm(root, { recursive: true, force: true })
    }
  })

test('gphoto waits for delayed write readback once, then refreshes the expected companion cache', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-gphoto-settle-'))
  let elapsed = 0,
    setters = 0,
    polls = 0
  const applied: string[] = [],
    provider = new GphotoProvider(
      root,
      async (request) => {
        if (request.args.includes('--set-config-value')) setters++
        if (request.args.includes('--list-all-config')) {
          if (setters) polls++
          return {
            stdout:
              setters && polls >= 3
                ? rawJpegConfig
                : rawJpegConfig.replace('Current: RAW+JPEG', 'Current: RAW'),
            stderr: '',
          }
        }
        if (request.args.includes('--capture-image-and-download'))
          await writeFile(join(request.cwd, 'DSC0001.ARW'), 'partial-after-format-change')
        return { stdout: '', stderr: '' }
      },
      'gphoto2',
      async (port) => port,
      {},
      {
        now: () => elapsed,
        async wait(milliseconds) {
          elapsed += milliseconds
        },
      },
    ),
    camera = new FakeCameraProvider().cameras[0]
  camera.connection = camera.port
  try {
    const inspection = await provider.inspect(camera)
    await provider.write(
      camera,
      inspection.settings.find((setting) => setting.id === 'format')!,
      'RAW+JPEG',
      async (value) => {
        expect(polls).toBe(3)
        applied.push(value)
      },
    )
    expect(setters).toBe(1)
    expect(applied).toEqual(['RAW+JPEG'])
    expect(elapsed).toBe(300)
    await expect(
      provider.capture(camera, root, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'partial-download', uncertain: true })
    expect(await readFile(join(root, 'DSC0001.ARW'), 'utf8')).toBe('partial-after-format-change')
  } finally {
    await provider.close(camera)
    await rm(root, { recursive: true, force: true })
  }
})

test('gphoto rejects an unsettled write at its bounded readback deadline without repeating the setter', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-gphoto-settle-timeout-')),
    timeouts: number[] = [],
    applied: string[] = []
  let elapsed = 0,
    setters = 0
  const provider = new GphotoProvider(
      root,
      async (request) => {
        if (request.args.includes('--set-config-value')) setters++
        if (setters && request.args.includes('--list-all-config')) timeouts.push(request.timeout!)
        return {
          stdout: request.args.includes('--list-all-config')
            ? rawJpegConfig.replace('Current: RAW+JPEG', 'Current: RAW')
            : '',
          stderr: '',
        }
      },
      'gphoto2',
      async (port) => port,
      {},
      {
        now: () => elapsed,
        async wait(milliseconds) {
          expect(milliseconds).toBeLessThanOrEqual(150)
          elapsed += milliseconds
        },
      },
    ),
    camera = new FakeCameraProvider().cameras[0]
  camera.connection = camera.port
  try {
    const inspection = await provider.inspect(camera)
    await expect(
      provider.write(
        camera,
        inspection.settings.find((setting) => setting.id === 'format')!,
        'RAW+JPEG',
        async (value) => {
          applied.push(value)
        },
      ),
    ).rejects.toMatchObject({ code: 'readback-timeout' })
    expect(setters).toBe(1)
    expect(applied).toEqual([])
    expect(elapsed).toBe(5000)
    expect(timeouts[0]).toBe(5000)
    expect(timeouts.at(-1)).toBe(50)
    expect(timeouts.every((timeout) => timeout > 0 && timeout <= 5000)).toBe(true)
  } finally {
    await provider.close(camera)
    await rm(root, { recursive: true, force: true })
  }
})

for (const code of ['camera-busy', 'backend-error', 'timeout'])
  test(`gphoto verifies a delayed applied write after a ${code} setter error without sending it again`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'irodori-gphoto-applied-error-')),
      applied: string[] = []
    let elapsed = 0,
      setters = 0,
      polls = 0,
      iso = '12800'
    const provider = new GphotoProvider(
        root,
        async (request) => {
          if (request.args.includes('--set-config-value')) {
            setters++
            throw new CameraError(code, 'PTP command diagnostic. '.repeat(100), true)
          }
          if (request.args.includes('--list-all-config') && setters && ++polls >= 3) iso = '400'
          return {
            stdout:
              rawJpegConfig +
              `\n/main/imgsettings/iso\nReadonly: 0\nType: RADIO\nCurrent: ${iso}\nChoice: 0 400\nChoice: 1 12800\nEND`,
            stderr: '',
          }
        },
        'gphoto2',
        async (port) => port,
        {},
        {
          now: () => elapsed,
          async wait(milliseconds) {
            elapsed += milliseconds
          },
        },
      ),
      camera = new FakeCameraProvider().cameras[0]
    camera.connection = camera.port
    try {
      const initial = await provider.inspect(camera)
      await provider.write(
        camera,
        initial.settings.find((setting) => setting.id === 'iso')!,
        '400',
        async (value) => {
          expect(polls).toBe(3)
          applied.push(value)
        },
      )
      expect(setters).toBe(1)
      expect(applied).toEqual(['400'])
      expect(elapsed).toBe(300)
      const after = await provider.inspect(camera)
      expect(after.info.latestWriteDiagnostic).toMatchObject({
        setting: 'iso',
        requested: '400',
        outcome: 'verified',
        busyReadCount: 0,
        elapsedMs: 300,
        commandError: { code, uncertain: true },
      })
      expect(after.info.latestWriteDiagnostic?.commandError?.message.length).toBe(1000)
    } finally {
      await provider.close(camera)
      await rm(root, { recursive: true, force: true })
    }
  })

test('gphoto retries a transient busy read within the same write deadline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-gphoto-busy-read-')),
    applied: string[] = []
  let elapsed = 0,
    setters = 0,
    polls = 0
  const provider = new GphotoProvider(
      root,
      async (request) => {
        if (request.args.includes('--set-config-value')) setters++
        if (request.args.includes('--list-all-config') && setters && ++polls === 1)
          throw new CameraError('camera-busy', 'PTP read busy.')
        return {
          stdout:
            rawJpegConfig +
            `\n/main/imgsettings/iso\nReadonly: 0\nType: RADIO\nCurrent: ${setters ? '400' : '12800'}\nChoice: 0 400\nChoice: 1 12800\nEND`,
          stderr: '',
        }
      },
      'gphoto2',
      async (port) => port,
      {},
      {
        now: () => elapsed,
        async wait(milliseconds) {
          elapsed += milliseconds
        },
      },
    ),
    camera = new FakeCameraProvider().cameras[0]
  camera.connection = camera.port
  try {
    const initial = await provider.inspect(camera)
    await provider.write(
      camera,
      initial.settings.find((setting) => setting.id === 'iso')!,
      '400',
      async (value) => {
        applied.push(value)
      },
    )
    expect(setters).toBe(1)
    expect(polls).toBe(2)
    expect(elapsed).toBe(150)
    expect(applied).toEqual(['400'])
    expect((await provider.inspect(camera)).info.latestWriteDiagnostic).toMatchObject({
      outcome: 'verified',
      busyReadCount: 1,
      elapsedMs: 150,
    })
  } finally {
    await provider.close(camera)
    await rm(root, { recursive: true, force: true })
  }
})

test('gphoto retains an unverified setter error when its requested value never arrives', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-gphoto-error-unsettled-')),
    commandError = new CameraError('camera-busy', 'PTP setter was busy.'),
    applied: string[] = []
  let elapsed = 0,
    setters = 0
  const provider = new GphotoProvider(
      root,
      async (request) => {
        if (request.args.includes('--set-config-value')) {
          setters++
          throw commandError
        }
        return { stdout: rawJpegConfig.replace('Current: RAW+JPEG', 'Current: RAW'), stderr: '' }
      },
      'gphoto2',
      async (port) => port,
      {},
      {
        now: () => elapsed,
        async wait(milliseconds) {
          elapsed += milliseconds
        },
      },
    ),
    camera = new FakeCameraProvider().cameras[0]
  camera.connection = camera.port
  try {
    const initial = await provider.inspect(camera)
    await expect(
      provider.write(
        camera,
        initial.settings.find((setting) => setting.id === 'format')!,
        'RAW+JPEG',
        async (value) => {
          applied.push(value)
        },
      ),
    ).rejects.toBe(commandError)
    expect(setters).toBe(1)
    expect(elapsed).toBe(5000)
    expect(applied).toEqual([])
    expect((await provider.inspect(camera)).info.latestWriteDiagnostic).toMatchObject({
      outcome: 'unverified',
      elapsedMs: 5000,
      commandError: { code: 'camera-busy' },
    })
  } finally {
    await provider.close(camera)
    await rm(root, { recursive: true, force: true })
  }
})

test('gphoto does not retry a disconnected read during write settling', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-gphoto-settle-disconnect-')),
    applied: string[] = []
  let setters = 0,
    polls = 0
  const provider = new GphotoProvider(
      root,
      async (request) => {
        if (request.args.includes('--set-config-value')) setters++
        if (request.args.includes('--list-all-config') && setters) {
          polls++
          throw new CameraError('disconnected', 'Test camera disconnected.')
        }
        return { stdout: rawJpegConfig.replace('Current: RAW+JPEG', 'Current: RAW'), stderr: '' }
      },
      'gphoto2',
      async (port) => port,
      {},
      {
        now: () => 0,
        async wait() {
          throw new Error('Disconnected reads must not wait or retry.')
        },
      },
    ),
    camera = new FakeCameraProvider().cameras[0]
  camera.connection = camera.port
  try {
    const initial = await provider.inspect(camera)
    await expect(
      provider.write(
        camera,
        initial.settings.find((setting) => setting.id === 'format')!,
        'RAW+JPEG',
        async (value) => {
          applied.push(value)
        },
      ),
    ).rejects.toMatchObject({ code: 'disconnected' })
    expect(setters).toBe(1)
    expect(polls).toBe(1)
    expect(applied).toEqual([])
  } finally {
    await provider.close(camera)
    await rm(root, { recursive: true, force: true })
  }
})

test('gphoto excludes multi-frame noise-reduction ISO choices and refuses capture while one is selected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-gphoto-single-iso-'))
  let iso = '12800'
  const provider = new GphotoProvider(
      root,
      async () => ({
        stdout:
          rawJpegConfig +
          `\n/main/imgsettings/iso\nReadonly: 0\nType: RADIO\nCurrent: ${iso}\nChoice: 0 80 Multi Frame Noise Reduction\nChoice: 1 100 Multi Frame Noise Reduction\nChoice: 2 400\nChoice: 3 12800\nEND`,
        stderr: '',
      }),
      'gphoto2',
      async (port) => port,
    ),
    camera = new FakeCameraProvider().cameras[0]
  camera.connection = camera.port
  try {
    const inspection = await provider.inspect(camera)
    expect(inspection.settings.find((setting) => setting.id === 'iso')?.choices).toEqual([
      '400',
      '12800',
    ])
    expect(inspection.capture.available).toBe(true)
    expect(() => validateSettings({ iso: '80 Multi Frame Noise Reduction' }, inspection)).toThrow()
    iso = '80 Multi Frame Noise Reduction'
    const unsafe = await provider.inspect(camera)
    expect(unsafe.capture.available).toBe(false)
    expect(unsafe.capture.reason).toContain('multiple exposures')
  } finally {
    await provider.close(camera)
    await rm(root, { recursive: true, force: true })
  }
})

for (const example of [
  { format: 'RAW', filenames: ['DSC0001.ARW'], valid: true, reason: 'one RAW original' },
  { format: 'JPEG', filenames: ['DSC0001.JPG'], valid: true, reason: 'one JPEG original' },
  { format: 'RAW', filenames: ['DSC0001.JPG'], valid: false, reason: 'a JPEG instead of RAW' },
  { format: 'JPEG', filenames: ['DSC0001.ARW'], valid: false, reason: 'a RAW instead of JPEG' },
  {
    format: 'RAW',
    filenames: ['DSC0001.ARW', 'DSC0002.ARW'],
    valid: false,
    reason: 'multiple RAW exposures',
  },
  {
    format: 'JPEG',
    filenames: ['DSC0001.JPG', 'DSC0002.JPG'],
    valid: false,
    reason: 'multiple JPEG exposures',
  },
  {
    format: 'RAW+JPEG',
    filenames: ['DSC0001.ARW', 'DSC0002.JPG'],
    valid: false,
    reason: 'unassociated RAW/JPEG names',
  },
])
  test(`gphoto ${example.valid ? 'accepts' : 'retains and refuses'} ${example.reason} for ${example.format}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'irodori-gphoto-format-')),
      calls: string[][] = [],
      provider = new GphotoProvider(
        root,
        async (request) => {
          calls.push(request.args)
          if (request.args.includes('--capture-image-and-download'))
            for (const filename of example.filenames)
              await writeFile(join(request.cwd, filename), `original-${filename}`)
          return {
            stdout: request.args.includes('--list-all-config')
              ? rawJpegConfig.replace('Current: RAW+JPEG', `Current: ${example.format}`)
              : '',
            stderr: '',
          }
        },
        'gphoto2',
        async (port) => port,
      ),
      camera = new FakeCameraProvider().cameras[0]
    camera.connection = camera.port
    try {
      const inspection = await provider.inspect(camera)
      expect(inspection.capture.available).toBe(true)
      expect(inspection.info.captureFormatSupport).toBe('supported')
      expect(inspection.info.expectedOriginals).toEqual(
        example.format === 'RAW+JPEG' ? ['RAW', 'JPEG'] : [example.format],
      )
      const capture = provider.capture(camera, root, new AbortController().signal)
      if (example.valid)
        expect((await capture).map((file) => file.filename)).toEqual(example.filenames)
      else
        await expect(capture).rejects.toMatchObject({ code: 'partial-download', uncertain: true })
      expect(calls).toHaveLength(2)
      expect(calls.filter((args) => args.includes('--capture-image-and-download'))).toHaveLength(1)
      expect(calls.some((args) => args.includes('--set-config-value'))).toBe(false)
      expect(calls[1]).toContain('--keep')
      expect(calls[1]).toContain('--wait-event-and-download=2s')
      for (const filename of example.filenames)
        expect(await readFile(join(root, filename), 'utf8')).toBe(`original-${filename}`)
    } finally {
      await provider.close(camera)
      await rm(root, { recursive: true, force: true })
    }
  })

test('gphoto keeps unknown formats discoverable but refuses capture before any shutter request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-gphoto-unknown-format-')),
    calls: string[][] = [],
    provider = new GphotoProvider(
      root,
      async (request) => {
        calls.push(request.args)
        return {
          stdout: request.args.includes('--auto-detect')
            ? 'Unknown Format Camera usb:001,006'
            : request.args.includes('--list-all-config')
              ? rawJpegConfig.replace('Current: RAW+JPEG', 'Current: HEIF')
              : '',
          stderr: '',
        }
      },
      'gphoto2',
      async (port) => port,
    )
  try {
    const discovery = await provider.discover(),
      camera = discovery.cameras[0],
      inspection = await provider.inspect(camera)
    expect(discovery.cameras).toHaveLength(1)
    expect(inspection.info.captureFormat).toBe('HEIF')
    expect(inspection.info.captureFormatSupport).toBe('unverified')
    expect(inspection.info.expectedOriginals).toBeUndefined()
    expect(inspection.capture.available).toBe(false)
    expect(inspection.capture.reason).toContain('unknown or unsupported')
    await expect(
      provider.capture(camera, root, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'unavailable-action', uncertain: false })
    expect(
      calls.some(
        (args) =>
          args.includes('--capture-image-and-download') || args.includes('--set-config-value'),
      ),
    ).toBe(false)
  } finally {
    await provider.shutdown()
    await rm(root, { recursive: true, force: true })
  }
})

test('gphoto drains both advertised RAW/JPEG originals in one kept shutter command despite cancellation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-gphoto-pair-')),
    calls: { args: string[]; cwd: string }[] = [],
    controller = new AbortController(),
    provider = new GphotoProvider(
      root,
      async (request) => {
        calls.push(request)
        if (request.args.includes('--capture-image-and-download')) {
          await writeFile(join(request.cwd, 'DSC0001.ARW'), 'raw-original')
          controller.abort()
          await writeFile(join(request.cwd, 'DSC0001.JPG'), 'jpeg-original')
        }
        return {
          stdout: request.args.includes('--list-all-config') ? rawJpegConfig : '',
          stderr: '',
        }
      },
      'gphoto2',
      async (port) => port,
    ),
    camera = new FakeCameraProvider().cameras[1]
  camera.connection = camera.port
  try {
    const inspection = await provider.inspect(camera)
    expect(inspection.info.expectedOriginals).toEqual(['RAW', 'JPEG'])
    const files = await provider.capture(camera, root, controller.signal)
    expect(files.map((file) => file.filename).sort()).toEqual(['DSC0001.ARW', 'DSC0001.JPG'])
    expect(await readFile(join(root, 'DSC0001.ARW'), 'utf8')).toBe('raw-original')
    expect(await readFile(join(root, 'DSC0001.JPG'), 'utf8')).toBe('jpeg-original')
    expect(calls).toHaveLength(2)
    expect(calls[1].args.filter((arg) => arg === '--capture-image-and-download')).toHaveLength(1)
    expect(calls[1].args).toEqual([
      '--camera',
      'Driver Alias',
      '--port',
      'usb:001,002',
      '--keep',
      '--filename',
      '%f.%C',
      '--capture-image-and-download',
      '--wait-event-and-download=2s',
    ])
  } finally {
    await provider.close(camera)
    await rm(root, { recursive: true, force: true })
  }
})

for (const missing of ['RAW', 'JPEG'])
  test(`gphoto refuses a missing ${missing} companion without retrying or removing its partial original`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'irodori-gphoto-partial-')),
      filename = missing === 'RAW' ? 'DSC0001.JPG' : 'DSC0001.ARW'
    let releases = 0
    const provider = new GphotoProvider(
        root,
        async (request) => {
          if (request.args.includes('--capture-image-and-download')) {
            releases++
            await writeFile(join(request.cwd, filename), 'unchanged-partial-original')
          }
          return {
            stdout: request.args.includes('--list-all-config') ? rawJpegConfig : '',
            stderr: '',
          }
        },
        'gphoto2',
        async (port) => port,
      ),
      camera = new FakeCameraProvider().cameras[0]
    camera.connection = camera.port
    try {
      await provider.inspect(camera)
      await expect(
        provider.capture(camera, root, new AbortController().signal),
      ).rejects.toMatchObject({ code: 'partial-download', uncertain: true })
      expect(releases).toBe(1)
      expect(await readFile(join(root, filename), 'utf8')).toBe('unchanged-partial-original')
    } finally {
      await provider.close(camera)
      await rm(root, { recursive: true, force: true })
    }
  })

test('gphoto partial companion files remain in an uncertain service operation and manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-gphoto-service-partial-'))
  let releases = 0
  const provider = new GphotoProvider(
      root,
      async (request) => {
        if (request.args.includes('--capture-image-and-download')) {
          releases++
          await writeFile(join(request.cwd, 'DSC0001.ARW'), 'unchanged-partial-raw')
        }
        return {
          stdout: request.args.includes('--auto-detect')
            ? 'Sony Test Camera usb:001,006'
            : request.args.includes('--list-all-config')
              ? rawJpegConfig
              : '',
          stderr: '',
        }
      },
      'gphoto2',
      async (port) => port,
    ),
    service = new CameraService(
      [provider],
      new CameraStore(join(root, 'data'), join(root, 'broker.sqlite')),
      async () => ({ test: true }),
    )
  try {
    const camera = (await service.list()).cameras[0],
      opened = await service.openSession(camera.id),
      accepted = await service.executeAction(
        opened.sessionId,
        'capture',
        { settings: {} },
        'missing-jpeg',
      ),
      operation = await finished(service, accepted.operationId)
    expect(operation.state).toBe('uncertain')
    expect(operation.failure).toMatchObject({ code: 'partial-download', uncertain: true })
    expect(operation.steps).toHaveLength(1)
    expect(operation.steps[0].complete).toBe(false)
    expect(operation.steps[0].files).toHaveLength(1)
    expect(operation.steps[0].files[0].complete).toBe(false)
    expect(await readFile(operation.steps[0].files[0].path, 'utf8')).toBe('unchanged-partial-raw')
    expect(
      JSON.parse(await readFile(join(operation.directory, 'manifest.json'), 'utf8')).state,
    ).toBe('uncertain')
    expect(releases).toBe(1)
  } finally {
    await service.shutdown()
    await rm(root, { recursive: true, force: true })
  }
})

test('subprocesses reject missing dependencies, bounded output, timeout and zero-exit errors', async () => {
  const request = {
    executable: process.execPath,
    args: [],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH },
  }
  await expect(
    runProcess({ ...request, executable: '/nonexistent/irodori-camera' }),
  ).rejects.toMatchObject({ code: 'missing-backend' })
  await expect(
    runProcess({
      ...request,
      args: ['-e', 'process.stdout.write("x".repeat(100000));setTimeout(()=>{},10000)'],
      limit: 100,
    }),
  ).rejects.toMatchObject({ code: 'output-limit' })
  await expect(
    runProcess({ ...request, args: ['-e', 'setTimeout(()=>{},10000)'], timeout: 50 }),
  ).rejects.toMatchObject({ code: 'timeout', uncertain: true })
  await expect(
    runProcess({
      ...request,
      args: ['-e', 'process.stderr.write("*** Error *** Could not claim USB device")'],
    }),
  ).rejects.toMatchObject({ code: 'camera-busy' })
})

function sonyPacket(code: number, value: number, choices: number[], getSet = 1, enabled = 1) {
  const prefix = Buffer.alloc(8)
  prefix.writeUInt32LE(1)
  const header = Buffer.alloc(6)
  header.writeUInt16LE(code)
  header.writeUInt16LE(4, 2)
  header[4] = getSet
  header[5] = enabled
  const count = Buffer.alloc(2)
  count.writeUInt16LE(choices.length)
  return Buffer.concat([
    prefix,
    header,
    encodeValue(4, value),
    encodeValue(4, value),
    Buffer.from([2]),
    count,
    ...choices.map((value) => encodeValue(4, value)),
  ])
}
test('Sony packet readers reject malformed lengths, unknown types and trailing data', () => {
  const packet = sonyPacket(0x5005, 2, [2, 4])
  expect(sonyProperties(packet)[0]).toMatchObject({ code: 0x5005, value: 2, choices: [2, 4] })
  for (let length = 0; length < packet.length; length++)
    expect(() => sonyProperties(packet.subarray(0, length))).toThrow()
  expect(() => sonyProperties(Buffer.concat([packet, Buffer.from([1])]))).toThrow('remainder')
  expect(() => new Packet(Buffer.from([255])).string()).toThrow('Truncated')
  expect(() => new Packet(Buffer.alloc(4, 255)).array()).toThrow('Oversized')
  expect(() => new Packet(Buffer.alloc(32)).value(11)).toThrow('Unsupported')
  expect(() => deviceInfo(Buffer.alloc(2))).toThrow()
  expect(() => objectInfo(Buffer.alloc(12))).toThrow()
})

test('native Sony maps only safe photographic controls and refuses pending originals or burst', async () => {
  let packet = sonyPacket(0x5013, 2, [1, 2])
  const transport: PtpTransport = {
    list: async () => [
      {
        connection: 'attachment',
        model: 'ZV-1A',
        serial: 'serial',
        vendor: 1356,
        product: 3140,
        location: 1,
      },
    ],
    open: async () => {},
    close: async () => {},
    shutdown: async () => {},
    command: async () => packet,
  }
  const provider = new SonyImageCaptureProvider(transport),
    camera = (await provider.discover()).cameras[0]
  const inspection = await provider.inspect(camera)
  expect(inspection.settings[0].choices).toEqual(['Single'])
  expect(inspection.capture.available).toBe(false)
  packet = sonyPacket(0xd215, 0x8001, [], 0)
  expect((await provider.inspect(camera)).capture.available).toBe(false)
  expect((await provider.discover()).cameras[0].model).toBe('ZV-1A')
  expect(camera.backendModel).toContain('54c:c44')
})

test('exposure metadata parses fractions and refuses NaN, missing, zero or invalid evidence', () => {
  for (const value of [0.01, '0.01', '1/100']) expect(exposureSeconds(value)).toBe(0.01)
  for (const value of [undefined, NaN, Infinity, 'bad', '1/0', '', 0, '0/1'])
    expect(exposureSeconds(value)).toBeUndefined()
})

test('native Sony waits for delayed writes and journals each settled aperture notch', async () => {
  let value = 400,
    pending = 400,
    reads = 0
  const steps: string[] = []
  const native: PtpTransport = {
    list: async () => [],
    open: async () => {},
    close: async () => {},
    shutdown: async () => {},
    command: async (_camera, code, _parameters, data) => {
      if (code === 0x9207) {
        pending = data![0] === 1 ? 400 : value === 400 ? 350 : 320
        reads = 0
        return Buffer.alloc(0)
      }
      if (++reads === 3) value = pending
      return sonyPacket(0x5007, value, [], 0, 2)
    },
  }
  const provider = new SonyImageCaptureProvider(native),
    camera = new FakeCameraProvider().cameras[0]
  const setting = (await provider.inspect(camera)).settings[0]
  await provider.write(camera, setting, 'f/3.2', async (value) => {
    steps.push(value)
  })
  expect(steps).toEqual(['f/3.5', 'f/3.2'])
  expect(value).toBe(320)
})

test('native Sony releases both shutter buttons when the full press fails', async () => {
  const commands: { code: number; parameter?: number; value?: number }[] = []
  const packet = sonyPacket(0x5013, 1, [1, 2])
  const native: PtpTransport = {
    list: async () => [],
    open: async () => {},
    close: async () => {},
    shutdown: async () => {},
    command: async (_camera, code, parameters, data) => {
      commands.push({ code, parameter: parameters?.[0], value: data?.readUInt16LE() })
      if (code === 0x9207 && parameters?.[0] === 0xd2c2 && data?.readUInt16LE() === 2)
        throw new Error('Full press rejected')
      return code === 0x9209 ? packet : Buffer.alloc(0)
    },
  }
  const provider = new SonyImageCaptureProvider(native)
  await expect(
    provider.capture(new FakeCameraProvider().cameras[0], '/unused', new AbortController().signal),
  ).rejects.toThrow('Full press rejected')
  expect(
    commands
      .filter((command) => command.code === 0x9207)
      .map((command) => [command.parameter, command.value]),
  ).toEqual([
    [0xd2c1, 2],
    [0xd2c2, 2],
    [0xd2c2, 1],
    [0xd2c1, 1],
  ])
})

test('gphoto discovery and reattachment are tested without physical USB on every platform', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-gphoto-routing-'))
  let attachment = 'initial'
  const provider = new GphotoProvider(
    root,
    async (request) => ({
      stdout: request.args.includes('--auto-detect')
        ? 'Sony Same Model usb:001,001\nSony Same Model usb:001,002'
        : request.args.includes('--summary')
          ? 'Serial Number: unique-serial'
          : 'gphoto test',
      stderr: '',
    }),
    'gphoto2',
    async (port) => `${port}:${attachment}`,
  )
  try {
    const cameras = (await provider.discover()).cameras
    expect(cameras).toHaveLength(2)
    expect(cameras[0].id).not.toBe(cameras[1].id)
    await provider.open(cameras[0])
    expect(cameras[0].identityConfidence).toBe('serial')
    attachment = 'reconnected'
    await expect(provider.inspect(cameras[0])).rejects.toMatchObject({ code: 'disconnected' })
    expect((await provider.discover()).cameras[0].id).not.toBe(cameras[0].id)
    await writeFile(join(root, 'marker'), 'no camera touched')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('native transport routes PTP responses and invalidates open connections when its process ends', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-native-transport-')),
    script = join(root, 'helper.cjs')
  await writeFile(
    script,
    `const {createInterface}=require('node:readline');
createInterface({input:process.stdin}).on('line',line=>{
const r=JSON.parse(line),send=result=>process.stdout.write(JSON.stringify({id:r.id,result})+'\\n');
if(r.op==='list')send([{connection:'camera',model:'ZV-1A',serial:'test',vendor:1356,product:3140,location:1}]);
else if(r.op==='open')send({opened:true});
else if(r.op==='ptp'){
if(r.code===0x1001)process.exit(0);
else send({data:Buffer.from('original-data').toString('base64'),response:Buffer.from('0c0000000300012001000000','hex').toString('base64')});
}else send({closed:true});
});`,
  )
  const transport = new ImageCaptureTransport(process.execPath, [script])
  try {
    expect((await transport.list())[0].connection).toBe('camera')
    await transport.open('camera')
    expect((await transport.command('camera', 0x9209)).toString()).toBe('original-data')
    await expect(transport.command('camera', 0x1001)).rejects.toMatchObject({
      code: 'native-transport-ended',
      uncertain: true,
    })
    await expect(transport.command('camera', 0x9209)).rejects.toMatchObject({
      code: 'disconnected',
    })
  } finally {
    await transport.shutdown()
    await rm(root, { recursive: true, force: true })
  }
})
