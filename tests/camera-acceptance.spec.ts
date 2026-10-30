import { expect, test } from '@playwright/test'
import {
  acceptanceOptions,
  selectAcceptanceCamera,
  acceptanceValue,
  acceptancePatch,
  acceptanceAlternate,
  automaticCameraReadouts,
  restorationDifferences,
} from '../scripts/camera/acceptance-options'
import { FakeCameraProvider } from './camera-control.helpers'

test('hardware acceptance requires an exact camera and one exclusive mode before connecting', () => {
  expect(acceptanceOptions([])).toEqual({ mode: 'discover', selector: undefined })
  expect(acceptanceOptions(['--inspect', '--camera-id', 'exact_camera'])).toEqual({
    mode: 'inspect',
    selector: { kind: 'camera-id', value: 'exact_camera' },
  })
  expect(acceptanceOptions(['--serial', 'usb-serial', '--run'])).toEqual({
    mode: 'run',
    selector: { kind: 'serial', value: 'usb-serial' },
  })
  expect(acceptanceOptions(['--serial', 'serial']).mode).toBe('inspect')
  for (const args of [
    ['--run'],
    ['--inspect'],
    ['--controls', '--camera-id'],
    ['--inspect', '--controls', '--camera-id', 'camera'],
    ['--inspect', '--run', '--camera-id', 'camera'],
    ['--run', '--controls', '--serial', 'serial'],
    ['--run', '--camera-id', 'camera', '--serial', 'serial'],
    ['--run', '--serial', 'serial', '--serial', 'other'],
    ['--run', '--camera-id', '../camera'],
    ['--run', '--serial', 'serial\ncommand'],
    ['--anything'],
  ])
    expect(() => acceptanceOptions(args)).toThrow()
})

test('connection-only Linux discovery selects the exact advertised ID without probing another camera', () => {
  const cameras = new FakeCameraProvider().cameras
  const connected = cameras.map((camera) => ({ ...camera, serial: undefined }))
  expect(selectAcceptanceCamera(connected, { kind: 'camera-id', value: connected[1].id })).toBe(
    connected[1],
  )
  expect(() => selectAcceptanceCamera(connected, { kind: 'serial', value: 'absent' })).toThrow(
    'absent or ambiguous',
  )
  expect(() =>
    selectAcceptanceCamera([connected[0], { ...connected[0] }], {
      kind: 'camera-id',
      value: connected[0].id,
    }),
  ).toThrow('ambiguous')
})

test('portable choices preserve advertised spelling and read-only originals while excluding guessed writes', async () => {
  const provider = new FakeCameraProvider(),
    inspection = await provider.inspect(provider.cameras[0]),
    settings = inspection.settings
  const mode = settings.find((setting) => setting.id === 'iso')!
  mode.id = 'exposureMode'
  mode.value = 'P'
  mode.choices = ['P', 'M']
  expect(acceptanceValue(settings, 'exposureMode', ['Manual', 'M'])).toBe('M')
  expect(acceptancePatch(settings, 'exposureMode', 'M')).toEqual({ exposureMode: 'M' })
  expect(() => acceptancePatch(settings, 'exposureMode', 'Manual')).toThrow('not advertised')
  mode.value = 'M'
  mode.writable = false
  expect(acceptanceValue(settings, 'exposureMode', ['Manual', 'M'])).toBe('M')
  expect(acceptancePatch(settings, 'exposureMode', 'M')).toEqual({})
  expect(() => acceptancePatch(settings, 'exposureMode', 'P')).toThrow('read-only')
  mode.id = 'iso'
  mode.value = '12800'
  mode.choices = ['100 Multi Frame Noise Reduction', '400', '12800']
  mode.writable = true
  expect(acceptanceValue(settings, 'iso', ['100', '400'])).toBe('400')
  expect(() => acceptanceValue(settings, 'iso', ['100'])).toThrow('unavailable')
})

test('automatic camera readout exemptions match both native and gphoto exposure-program names', () => {
  for (const mode of ['P', 'Program'])
    expect(automaticCameraReadouts(mode)).toEqual(['aperture', 'shutterSpeed'])
  for (const mode of ['A', 'Aperture priority'])
    expect(automaticCameraReadouts(mode)).toEqual(['shutterSpeed'])
  for (const mode of ['S', 'Shutter priority'])
    expect(automaticCameraReadouts(mode)).toEqual(['aperture'])
  for (const mode of ['M', 'Manual', 'unknown']) expect(automaticCameraReadouts(mode)).toEqual([])
})

test('hardware control probes prefer adjacent advertised values over large lens or exposure jumps', async () => {
  const provider = new FakeCameraProvider(),
    settings = (await provider.inspect(provider.cameras[0])).settings,
    setting = settings.find((setting) => setting.id === 'iso')!
  setting.value = '12800'
  setting.choices = ['Auto ISO', '100 Multi Frame Noise Reduction', '400', '6400', '10000', '12800']
  expect(acceptanceAlternate(setting)).toBe('10000')
  setting.id = 'exposureCompensation'
  setting.value = '0'
  setting.choices = ['3', '0.3', '0', '-0.3', '-3']
  expect(acceptanceAlternate(setting)).toBe('0.3')
  setting.id = 'aperture'
  setting.value = 'f/4'
  setting.choices = ['f/2.8', 'f/3.5', 'f/4', 'f/4.5', 'f/11']
  expect(acceptanceAlternate(setting)).toBe('f/4.5')
  setting.writable = false
  expect(acceptanceAlternate(setting)).toBeUndefined()
})

test('restoration checks retain every photographic setting without treating diagnostic counters as edits', () => {
  const before = [
      { id: 'exposureMode', value: 'P' },
      { id: 'iso', value: '400' },
      { id: 'format', value: 'RAW' },
      { id: 'aperture', value: 'f/4' },
      { id: 'shutterSpeed', value: '1/100' },
      { id: '/main/status/batterylevel', value: '90%' },
    ],
    after = before.map((setting) => ({ ...setting }))
  after[3].value = '(null)'
  after[4].value = '1/80'
  after[5].value = '80%'
  expect(restorationDifferences(before, after)).toEqual([])
  after[1].value = '6400'
  expect(restorationDifferences(before, after)).toEqual(['iso'])
  expect(
    restorationDifferences(
      before,
      after.filter(({ id }) => id !== 'format'),
    ),
  ).toEqual(['iso', 'format'])
  before[0].value = after[0].value = 'M'
  expect(restorationDifferences(before, after)).toEqual(['iso', 'aperture', 'shutterSpeed'])
})
