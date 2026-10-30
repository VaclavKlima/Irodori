import { expect, test } from '@playwright/test'
import {
  actionRequest,
  advertisedActions,
  exposureSeconds,
  settings,
  validateSettings,
} from '../src/main/camera-control/model'
import { parseConfig, parseDiscovery, GphotoProvider } from '../src/main/camera-control/gphoto'
import { runProcess } from '../src/main/camera-control/process'
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
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeCameraProvider } from './camera-control.helpers'

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
  const runner = async (request: { args: string[]; env: NodeJS.ProcessEnv; cwd: string }) => {
    calls.push(request)
    return {
      stdout: request.args.includes('--list-all-config')
        ? '/main/imgsettings/iso\nReadonly: 0\nType: RADIO\nCurrent: 100\nChoice: 0 100\nChoice: 1 200\nEND'
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
