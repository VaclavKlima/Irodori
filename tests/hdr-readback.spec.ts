import { expect, test } from '@playwright/test'
import { copyHdrReadbackStrip } from '../src/main/gpu/hdr-readback'
import {
  HdrRecovery,
  HDR_RECOVERY_VERSION,
  type HdrRecoverySnapshot,
} from '../src/renderer/src/preview/hdr-recovery'

const canary = 0x4f123456
const rgbWords = [
  0x00000000, 0x80000000, 0x00000001, 0x80000001, 0x3f800001, 0xbf800001, 0x3f7fffff, 0xbf7fffff,
  0x00800000, 0x80800000, 0x4b800001, 0xcb800001, 0x3eaaaaab, 0xbeaaaaab, 0x7f7fffff, 0xff7fffff,
]
const alphaWords = [0x00000000, 0x80000000, 0x3f000001, 0x3f7fffff, 0x3f800000]

function frameWords(width: number, height: number): Uint32Array {
  const words = new Uint32Array(width * height * 4)
  for (let pixel = 0; pixel < width * height; pixel++) {
    for (let channel = 0; channel < 3; channel++)
      words[pixel * 4 + channel] = rgbWords[(pixel * 3 + channel) % rgbWords.length]
    words[pixel * 4 + 3] = alphaWords[pixel % alphaWords.length]
  }
  return words
}

function destination(length: number) {
  const guard = 9,
    backing = new Uint32Array(guard + length + guard).fill(canary)
  return {
    backing,
    guard,
    values: new Float32Array(backing.buffer, guard * 4, length),
    words: new Uint32Array(backing.buffer, guard * 4, length),
  }
}

function mappedStrip(
  source: Uint32Array,
  width: number,
  top: number,
  count: number,
  rowBytes: number,
) {
  const guard = 7,
    stride = rowBytes / 4,
    backing = new Uint32Array(guard + stride * count + guard).fill(canary),
    words = new Uint32Array(backing.buffer, guard * 4, stride * count)
  for (let row = 0; row < count; row++)
    words.set(source.subarray((top + row) * width * 4, (top + row + 1) * width * 4), row * stride)
  return {
    backing,
    original: backing.slice(),
    values: new Float32Array(backing.buffer, guard * 4, words.length),
  }
}

function expectGuards(target: ReturnType<typeof destination>) {
  const expected = new Uint32Array(target.guard).fill(canary)
  expect(target.backing.subarray(0, target.guard)).toEqual(expected)
  expect(target.backing.subarray(target.guard + target.words.length)).toEqual(expected)
}

// Independently enumerated output rows for the source image [A B C; D E F].
// Pixel labels also retain distinct signed, subnormal, adjacent-ULP and alpha words.
const orientations = [
  { flip: 0, pixels: [0, 1, 2, 3, 4, 5] },
  { flip: 1, pixels: [2, 1, 0, 5, 4, 3] },
  { flip: 2, pixels: [3, 4, 5, 0, 1, 2] },
  { flip: 3, pixels: [5, 4, 3, 2, 1, 0] },
  { flip: 4, pixels: [0, 3, 1, 4, 2, 5] },
  { flip: 5, pixels: [2, 5, 1, 4, 0, 3] },
  { flip: 6, pixels: [3, 0, 4, 1, 5, 2] },
  { flip: 7, pixels: [5, 2, 4, 1, 3, 0] },
]

for (const orientation of orientations)
  test(`HDR readback preserves exact words for flip ${orientation.flip} across padded partial strips and view offsets`, () => {
    const width = 3,
      height = 2,
      source = frameWords(width, height),
      target = destination(source.length)
    for (const top of [0, 1]) {
      const strip = mappedStrip(source, width, top, 1, 256)
      copyHdrReadbackStrip(
        strip.values,
        target.values,
        width,
        height,
        256,
        top,
        1,
        orientation.flip,
      )
      expect(strip.backing).toEqual(strip.original)
      expectGuards(target)
    }
    const expected = Uint32Array.from(
      orientation.pixels.flatMap((pixel) => Array.from(source.subarray(pixel * 4, pixel * 4 + 4))),
    )
    expect(target.words).toEqual(expected)
  })

for (const width of [16, 17])
  test(`unrotated HDR readback copies ${width === 16 ? 'tight' : 'padded'} 64-row strips and the final three rows without touching future rows`, () => {
    const height = 131,
      rowBytes = Math.ceil((width * 16) / 256) * 256,
      source = frameWords(width, height),
      target = destination(source.length)
    for (const top of [0, 64, 128]) {
      const count = Math.min(64, height - top),
        strip = mappedStrip(source, width, top, count, rowBytes)
      copyHdrReadbackStrip(strip.values, target.values, width, height, rowBytes, top, count, 0)
      const completedWords = (top + count) * width * 4
      expect(target.words.subarray(0, completedWords)).toEqual(source.subarray(0, completedWords))
      expect(target.words.subarray(completedWords)).toEqual(
        new Uint32Array(source.length - completedWords).fill(canary),
      )
      expect(strip.backing).toEqual(strip.original)
      expectGuards(target)
    }
  })

for (const rowBytes of [256, 512])
  test(`unrotated HDR readback preserves every Float32 encoding with ${rowBytes}-byte row pitch`, () => {
    // Transport must not perform arithmetic or reinterpret validity; source validation is separate.
    const encodings = [
        ...rgbWords,
        ...alphaWords,
        0x7f800000,
        0xff800000,
        0x7fc01234,
        0xffc05678,
        0x7f801234,
      ],
      width = 16,
      height = 2,
      source = Uint32Array.from(
        { length: width * height * 4 },
        (_, i) => encodings[i % encodings.length],
      ),
      target = destination(source.length),
      strip = mappedStrip(source, width, 0, height, rowBytes)
    copyHdrReadbackStrip(strip.values, target.values, width, height, rowBytes, 0, height, 0)
    expect(target.words).toEqual(source)
    expect(strip.backing).toEqual(strip.original)
    expectGuards(target)
  })

function recoveryDeferred() {
  let resolve!: () => void, reject!: (error: unknown) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

class RecoveryBuffer {
  readonly data: ArrayBuffer
  mapState: GPUBufferMapState = 'unmapped'
  mapCalls = 0
  unmapCalls = 0
  destroyCalls = 0
  rangeCalls = 0
  mapGate: Promise<void> = Promise.resolve()
  synchronousMapFailure?: Error
  constructor(
    readonly size: number,
    readonly usage: number,
  ) {
    this.data = new ArrayBuffer(size)
  }
  mapAsync(mode: number) {
    expect(mode).toBe(1)
    this.mapCalls++
    if (this.synchronousMapFailure) throw this.synchronousMapFailure
    if (this.mapState !== 'unmapped' || this.destroyCalls)
      throw new Error('Invalid recovery map ownership.')
    this.mapState = 'pending'
    return this.mapGate.then(
      () => {
        this.mapState = 'mapped'
      },
      (error) => {
        this.mapState = 'unmapped'
        throw error
      },
    )
  }
  getMappedRange() {
    if (this.mapState !== 'mapped') throw new Error('Recovery buffer is not mapped.')
    this.rangeCalls++
    return this.data
  }
  unmap() {
    if (this.mapState !== 'mapped') throw new Error('Unmapping a recovery buffer without a map.')
    this.unmapCalls++
    this.mapState = 'unmapped'
    // A committed CPU plane must survive invalidation and subsequent buffer reuse.
    new Uint16Array(this.data).fill(0xa55a)
  }
  destroy() {
    if (this.mapState !== 'unmapped') throw new Error('Destroyed a live recovery map.')
    this.destroyCalls++
    new Uint16Array(this.data).fill(0x5aa5)
  }
}

class RecoveryDevice {
  readonly buffers: RecoveryBuffer[] = []
  createBuffer(descriptor: GPUBufferDescriptor) {
    const buffer = new RecoveryBuffer(descriptor.size, descriptor.usage)
    this.buffers.push(buffer)
    return buffer
  }
}

class RecoveryEncoder {
  readonly copies: { bytesPerRow: number; rowsPerImage: number; extent: number[] }[] = []
  copyTextureToBuffer(
    source: { texture: { words: Uint16Array } },
    destination: { buffer: RecoveryBuffer; bytesPerRow: number; rowsPerImage: number },
    extent: number[],
  ) {
    const [width, height] = extent
    this.copies.push({
      bytesPerRow: destination.bytesPerRow,
      rowsPerImage: destination.rowsPerImage,
      extent: [...extent],
    })
    new Uint16Array(destination.buffer.data).fill(0xccdd)
    for (let row = 0; row < height; row++)
      new Uint16Array(destination.buffer.data, row * destination.bytesPerRow, width * 4).set(
        source.texture.words.subarray(row * width * 4, (row + 1) * width * 4),
      )
  }
}

interface RecoveryImage {
  data: Uint16Array<ArrayBuffer>
  colorSpace: string
  pixelFormat: string
}

/** Only the recovery materialization contract is modeled; no canvas color conversion is simulated. */
class RecoveryCanvas {
  width = 0
  height = 0
  readonly dataset: Record<string, string> = {}
  image?: RecoveryImage
  drawn?: RecoveryCanvas
  options?: Record<string, unknown>
  readonly context = {
    getContextAttributes: () => this.options,
    isContextLost: () => false,
    putImageData: (image: RecoveryImage) => {
      this.image = image
    },
    drawImage: (source: RecoveryCanvas) => {
      this.drawn = source
    },
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  }
  getContext(_kind: string, options: Record<string, unknown>) {
    this.options = options
    return this.context
  }
}

async function withRecoveryFakes(
  run: (fakes: { cloneImageData: boolean; canvases: RecoveryCanvas[] }) => Promise<void>,
) {
  const fakes = { cloneImageData: false, canvases: [] as RecoveryCanvas[] }
  const values = {
    GPUBufferUsage: { MAP_READ: 1, COPY_DST: 8 },
    GPUMapMode: { READ: 1 },
    // Storage is inspected as raw Uint16 words; these tests perform no half-float arithmetic.
    Float16Array: Uint16Array,
    ImageData: class {
      readonly data: Uint16Array<ArrayBuffer>
      readonly colorSpace: string
      readonly pixelFormat: string
      constructor(
        data: Uint16Array<ArrayBuffer>,
        _width: number,
        _height: number,
        options: { colorSpace: string; pixelFormat: string },
      ) {
        this.data = fakes.cloneImageData ? new Uint16Array(data) : data
        this.colorSpace = options.colorSpace
        this.pixelFormat = options.pixelFormat
      }
    },
    document: {
      createElement: (name: string) => {
        expect(name).toBe('canvas')
        const canvas = new RecoveryCanvas()
        fakes.canvases.push(canvas)
        return canvas
      },
    },
  }
  const originals = new Map(
    Object.keys(values).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
  )
  try {
    for (const [name, value] of Object.entries(values))
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
    await run(fakes)
  } finally {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
}

function recoveryWords(width: number, height: number, offset = 0) {
  const words = [
    0, 0x8000, 1, 0x8001, 0x03ff, 0x0400, 0x3c00, 0x3c01, 0xbc01, 0x7bff, 0xfbff, 0x7c00, 0xfc00,
    0x7e35, 0xfe12,
  ]
  return Uint16Array.from(
    { length: width * height * 4 },
    (_, index) => words[(index + offset) % words.length],
  )
}

function recoverySnapshot(serial: number, width = 3, height = 2): HdrRecoverySnapshot {
  return {
    serial,
    presentationSerial: serial + 100,
    sourceIdentity: 'source:authenticated-working-hash',
    epoch: 7,
    settingsRevision: 11,
    target: { mode: 'hdr', colorSpace: 'display-p3', peak: 4, headroom: 4, generation: 9 },
    quality: 'normal',
    arithmeticPolicy: 'canonical-test-policy',
    width,
    height,
  }
}

function encodeRecovery(
  owner: HdrRecovery,
  device: RecoveryDevice,
  words: Uint16Array,
  width = 3,
  height = 2,
) {
  const encoder = new RecoveryEncoder()
  const capture = owner.encode(
    device as unknown as GPUDevice,
    encoder as unknown as GPUCommandEncoder,
    { words } as unknown as GPUTexture,
    width,
    height,
  )
  return { capture, encoder, buffer: device.buffers.at(-1)! }
}

function recoveredPlane(owner: HdrRecovery) {
  const canvas = new RecoveryCanvas()
  expect(owner.recover(canvas as unknown as HTMLCanvasElement)).toBe(true)
  expect(canvas.options).toEqual({ colorSpace: 'srgb', willReadFrequently: true })
  const source = canvas.drawn!
  expect(source.options).toEqual({
    colorSpace: 'display-p3',
    colorType: 'float16',
    willReadFrequently: true,
  })
  expect([source.width, source.height]).toEqual([0, 0])
  expect(canvas.dataset.recoveryPolicy).toBe(HDR_RECOVERY_VERSION)
  return { canvas, pixels: source.image!.data }
}

test('HDR recovery depads exact half words into independent CPU storage before publication', async () => {
  await withRecoveryFakes(async () => {
    const owner = new HdrRecovery(),
      device = new RecoveryDevice(),
      words = recoveryWords(3, 2)
    const { capture, encoder, buffer } = encodeRecovery(owner, device, words)
    try {
      expect(encoder.copies).toEqual([{ bytesPerRow: 256, rowsPerImage: 2, extent: [3, 2] }])
      expect(buffer.size).toBe(512)
      expect(buffer.usage).toBe(9)
      expect(() => capture.commit(recoverySnapshot(1))).toThrow('not ready')
      await capture.complete(Promise.resolve())
      expect(owner.snapshot).toBeUndefined()
      expect(buffer.unmapCalls).toBe(1)
      const snapshot = recoverySnapshot(1)
      capture.commit(snapshot)
      snapshot.target.peak = 99
      snapshot.serial = 99
      expect(owner.snapshot).toEqual(recoverySnapshot(1))
      const recovered = recoveredPlane(owner)
      expect(recovered.pixels).toEqual(words)
      expect(recovered.pixels.buffer).not.toBe(buffer.data)
      expect(recovered.pixels.byteLength).toBe(3 * 2 * 8)
      expect(JSON.parse(recovered.canvas.dataset.recoverySnapshot)).toEqual(recoverySnapshot(1))
      new Uint16Array(buffer.data).fill(0x1234)
      expect(recoveredPlane(owner).pixels).toEqual(words)
    } finally {
      capture.release()
      await capture.finished
      await owner.dispose()
    }
  })
})

test('HDR recovery reuses one GPU buffer and alternates two CPU planes without changing an uncommitted snapshot', async () => {
  await withRecoveryFakes(async () => {
    const owner = new HdrRecovery(),
      device = new RecoveryDevice()
    const buffers: ArrayBuffer[] = []
    try {
      for (const serial of [1, 2, 3]) {
        const previous = owner.snapshot
        const words = recoveryWords(3, 2, serial)
        const { capture } = encodeRecovery(owner, device, words)
        try {
          await capture.complete(Promise.resolve())
          expect(owner.snapshot).toEqual(previous)
          if (serial > 1)
            expect(recoveredPlane(owner).pixels).toEqual(recoveryWords(3, 2, serial - 1))
          capture.commit(recoverySnapshot(serial))
          const recovered = recoveredPlane(owner)
          expect(recovered.pixels).toEqual(words)
          buffers.push(recovered.pixels.buffer)
        } finally {
          capture.release()
          await capture.finished
        }
      }
      expect(device.buffers).toHaveLength(1)
      expect(device.buffers[0].mapCalls).toBe(3)
      expect(device.buffers[0].unmapCalls).toBe(3)
      expect(buffers[0]).not.toBe(buffers[1])
      expect(buffers[2]).toBe(buffers[0])
    } finally {
      await owner.dispose()
    }
  })
})

test('releasing a stale HDR capture preserves the committed plane and cannot release its successor', async () => {
  await withRecoveryFakes(async () => {
    const owner = new HdrRecovery(),
      device = new RecoveryDevice()
    const first = encodeRecovery(owner, device, recoveryWords(3, 2))
    await first.capture.complete(Promise.resolve())
    first.capture.commit(recoverySnapshot(1))
    first.capture.release()
    await first.capture.finished
    const stale = encodeRecovery(owner, device, recoveryWords(3, 2, 1))
    await stale.capture.complete(Promise.resolve())
    stale.capture.release()
    await stale.capture.finished
    expect(() => stale.capture.commit(recoverySnapshot(2))).toThrow('not ready')
    expect(owner.snapshot).toEqual(recoverySnapshot(1))
    expect(recoveredPlane(owner).pixels).toEqual(recoveryWords(3, 2))
    const successor = encodeRecovery(owner, device, recoveryWords(3, 2, 2))
    try {
      stale.capture.release()
      expect(() => encodeRecovery(owner, device, recoveryWords(3, 2))).toThrow('unavailable')
      await successor.capture.complete(Promise.resolve())
      successor.capture.commit(recoverySnapshot(3))
      expect(recoveredPlane(owner).pixels).toEqual(recoveryWords(3, 2, 2))
    } finally {
      successor.capture.release()
      await successor.capture.finished
      await owner.dispose()
    }
  })
})

for (const failure of ['fence', 'map', 'synchronous-map'] as const)
  test(`HDR recovery ${failure} rejection drains both promises without reading or committing`, async () => {
    await withRecoveryFakes(async () => {
      const owner = new HdrRecovery(),
        device = new RecoveryDevice(),
        fence = recoveryDeferred(),
        mapping = recoveryDeferred()
      const { capture, buffer } = encodeRecovery(owner, device, recoveryWords(3, 2))
      const reason = new Error(`Injected ${failure} failure.`)
      buffer.mapGate = mapping.promise
      if (failure === 'synchronous-map') buffer.synchronousMapFailure = reason
      const completion = capture.complete(fence.promise)
      const rejected = expect(completion).rejects.toBe(reason)
      let released = false
      void capture.finished.then(() => {
        released = true
      })
      capture.release()
      if (failure === 'fence') fence.reject(reason)
      else if (failure === 'map') mapping.reject(reason)
      await Promise.resolve()
      await Promise.resolve()
      expect(released).toBe(false)
      expect(buffer.destroyCalls).toBe(0)
      if (failure === 'fence') mapping.resolve()
      else fence.resolve()
      await rejected
      await capture.finished
      expect(released).toBe(true)
      expect(buffer.rangeCalls).toBe(0)
      expect(buffer.mapState).toBe('unmapped')
      expect(buffer.unmapCalls).toBe(failure === 'fence' ? 1 : 0)
      expect(owner.snapshot).toBeUndefined()
      expect(() => capture.commit(recoverySnapshot(1))).toThrow('not ready')
      await owner.dispose()
      expect(buffer.destroyCalls).toBe(1)
    })
  })

for (const held of ['fence', 'map'] as const)
  test(`HDR recovery disposal preserves the last CPU snapshot until held ${held} and capture release drain, then frees it`, async () => {
    await withRecoveryFakes(async () => {
      const owner = new HdrRecovery(),
        device = new RecoveryDevice()
      const first = encodeRecovery(owner, device, recoveryWords(3, 2))
      await first.capture.complete(Promise.resolve())
      first.capture.commit(recoverySnapshot(1))
      first.capture.release()
      await first.capture.finished
      const gate = recoveryDeferred()
      const second = encodeRecovery(owner, device, recoveryWords(3, 2, 1))
      if (held === 'map') second.buffer.mapGate = gate.promise
      const completing = second.capture.complete(
        held === 'fence' ? gate.promise : Promise.resolve(),
      )
      let disposed = false
      const disposing = owner.dispose().then(() => {
        disposed = true
      })
      if (held === 'map') second.capture.release()
      await Promise.resolve()
      await Promise.resolve()
      expect(disposed).toBe(false)
      expect(second.buffer.destroyCalls).toBe(0)
      expect(owner.snapshot).toEqual(recoverySnapshot(1))
      expect(recoveredPlane(owner).pixels).toEqual(recoveryWords(3, 2))
      gate.resolve()
      await completing
      if (held === 'fence') {
        expect(disposed).toBe(false)
        expect(second.buffer.destroyCalls).toBe(0)
        second.capture.release()
      }
      await second.capture.finished
      await disposing
      expect(second.buffer.destroyCalls).toBe(1)
      expect(second.buffer.unmapCalls).toBe(2)
      expect(owner.snapshot).toBeUndefined()
      expect(owner.recover(new RecoveryCanvas() as unknown as HTMLCanvasElement)).toBe(false)
      expect(() => second.capture.commit(recoverySnapshot(2))).toThrow('not ready')
      expect(() => encodeRecovery(owner, device, recoveryWords(3, 2))).toThrow('unavailable')
      await owner.dispose()
      expect(second.buffer.destroyCalls).toBe(1)
    })
  })

test('HDR recovery resize reservations retain old CPU owners until the replacement commits or transients drain', async () => {
  await withRecoveryFakes(async () => {
    const owner = new HdrRecovery(),
      device = new RecoveryDevice()
    for (const serial of [1, 2]) {
      const { capture } = encodeRecovery(owner, device, recoveryWords(33, 2, serial), 33, 2)
      await capture.complete(Promise.resolve())
      capture.commit(recoverySnapshot(serial, 33, 2))
      capture.release()
      await capture.finished
    }
    const cpuPlane = 33 * 2 * 8,
      gpuBuffer = 512 * 2
    const oldOwners = gpuBuffer + 3 * cpuPlane
    expect(owner.reservation(33, 2)).toEqual({
      rawReplacementOverlap: { ramBytes: 0, vramBytes: 0 },
      cpuStagingCarry: { ramBytes: oldOwners, vramBytes: gpuBuffer },
    })
    expect(owner.reservation(1, 1)).toEqual({
      rawReplacementOverlap: { ramBytes: oldOwners, vramBytes: gpuBuffer },
      cpuStagingCarry: { ramBytes: oldOwners, vramBytes: gpuBuffer },
    })
    await owner.releaseTransient()
    expect(device.buffers[0].destroyCalls).toBe(1)
    expect(owner.snapshot).toEqual(recoverySnapshot(2, 33, 2))
    expect(recoveredPlane(owner).pixels).toEqual(recoveryWords(33, 2, 2))
    expect(owner.reservation(1, 1)).toEqual({
      rawReplacementOverlap: { ramBytes: 2 * cpuPlane, vramBytes: 0 },
      cpuStagingCarry: { ramBytes: 2 * cpuPlane, vramBytes: 0 },
    })
    const replacement = encodeRecovery(owner, device, recoveryWords(1, 1), 1, 1)
    try {
      expect(owner.snapshot).toEqual(recoverySnapshot(2, 33, 2))
      const activeOwners = 256 + 2 * cpuPlane + 8
      expect(owner.reservation(1, 1)).toEqual({
        rawReplacementOverlap: { ramBytes: activeOwners, vramBytes: 256 },
        cpuStagingCarry: { ramBytes: activeOwners, vramBytes: 256 },
      })
      await replacement.capture.complete(Promise.resolve())
      expect(owner.snapshot).toEqual(recoverySnapshot(2, 33, 2))
      replacement.capture.commit(recoverySnapshot(3, 1, 1))
      expect(owner.reservation(1, 1)).toEqual({
        rawReplacementOverlap: { ramBytes: 0, vramBytes: 0 },
        cpuStagingCarry: { ramBytes: 256 + 2 * 8, vramBytes: 256 },
      })
    } finally {
      replacement.capture.release()
      await replacement.capture.finished
      await owner.dispose()
    }
  })
})

test('HDR recovery materialization rejects an ImageData copy instead of silently adding an uncharged CPU plane', async () => {
  await withRecoveryFakes(async (fakes) => {
    const owner = new HdrRecovery(),
      device = new RecoveryDevice()
    const { capture } = encodeRecovery(owner, device, recoveryWords(3, 2))
    try {
      await capture.complete(Promise.resolve())
      capture.commit(recoverySnapshot(1))
      capture.release()
      await capture.finished
      fakes.cloneImageData = true
      expect(() => owner.recover(new RecoveryCanvas() as unknown as HTMLCanvasElement)).toThrow(
        'did not retain',
      )
      expect(fakes.canvases.at(-1)).toMatchObject({ width: 0, height: 0 })
      expect(owner.snapshot).toEqual(recoverySnapshot(1))
    } finally {
      capture.release()
      await owner.dispose()
    }
  })
})
