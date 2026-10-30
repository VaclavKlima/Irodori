import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import {
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  truncate,
  utimes,
  writeFile,
  type FileHandle,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { attestAndFeedCpuSource } from '../src/main/native-cpu-input'
import { writeNativeCpuPair } from '../src/main/native-cpu-pair-sink'
import {
  nativeCpuExistingOwners,
  nativeCpuMemory,
  nativeCpuResidentMemory,
  type CpuMemoryRequest,
} from '../src/shared/native-cpu-memory'
import { HDR_SOURCE_VERSION, type HdrWorkingAsset } from '../src/shared/hdr'

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

async function scratch(
  work: (owner: {
    directory: string
    file: (name: string, bytes?: Uint8Array) => Promise<FileHandle>
  }) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), 'irodori-native-cpu-pure-')),
    handles: FileHandle[] = []
  try {
    await work({
      directory,
      file: async (name, bytes) => {
        const path = join(directory, name)
        if (bytes) await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
        const file = await open(
          path,
          bytes
            ? constants.O_RDONLY | constants.O_NOFOLLOW
            : constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        )
        handles.push(file)
        return file
      },
    })
  } finally {
    await Promise.allSettled(handles.map((file) => file.close()))
    await rm(directory, { recursive: true, force: true })
  }
}

function source(width = 5, height = 129) {
  const pixels = new Float32Array(width * height * 4)
  for (let index = 0; index < width * height; index++)
    pixels.set([index, -index / 4, index % 11, index % 2 ? 0.5 : 1], index * 4)
  const bytes = Buffer.from(pixels.buffer)
  const asset: HdrWorkingAsset = {
    kind: 'hdr-working-v1',
    width,
    height,
    byteLength: bytes.byteLength,
    sha256: hash(bytes),
    strips: Array.from({ length: Math.ceil(height / 64) }, (_, index) => {
      const part = bytes.subarray(
        index * width * 64 * 16,
        Math.min(height, (index + 1) * 64) * width * 16,
      )
      return { byteLength: part.byteLength, sha256: hash(part) }
    }),
    source: {
      version: HDR_SOURCE_VERSION,
      processing: 'hdr-v1',
      colorSpace: 'rec2020',
      whitePoint: 'D65',
      transfer: 'linear',
      alpha: 'straight',
      decoder: 'synthetic-node-contract-fixture',
      orientation: 'applied-once',
      cameraProfile: 'synthetic-node-contract-fixture',
      normalization: {
        black: [0, 0, 0, 0],
        maximum: 65535,
        gains: [1, 1, 1, 1],
        restoreGain: 1,
        referenceWhite: 1,
        sourceSaturation: null,
      },
    },
  }
  return { asset, bytes, pixels }
}

function collectingWriter() {
  const chunks: Buffer[] = []
  let active = 0,
    peak = 0
  const writer = new Writable({
    highWaterMark: 1,
    write(chunk: Buffer, _encoding, callback) {
      peak = Math.max(peak, ++active)
      setImmediate(() => {
        chunks.push(Buffer.from(chunk))
        active--
        callback()
      })
    },
  })
  writer.on('error', () => undefined) // The controller retains this observer through stream close.
  return { writer, chunks, peak: () => peak }
}

test('verified real-file feed respects backpressure and preserves every stable full/draft sample site', async () => {
  await scratch(async ({ file }) => {
    const fixture = source(257, 257),
      input = await file('linear.f32', fixture.bytes),
      sink = collectingWriter()
    const result = await attestAndFeedCpuSource(
      input,
      fixture.asset,
      sink.writer,
      new AbortController().signal,
    )
    expect(result.sourceAttestedByMain).toBe(true)
    expect(sink.writer.writableFinished).toBe(true)
    expect(sink.peak()).toBe(1)
    expect(sink.chunks.map((part) => part.length)).toEqual(
      fixture.asset.strips.map((part) => part.byteLength),
    )
    expect(hash(Buffer.concat(sink.chunks))).toBe(fixture.asset.sha256)
    for (const key of ['sample', 'draft'] as const) {
      const data = result.samples[key],
        count = data.length / 4,
        expected = new Float32Array(count * 4)
      expect(count).toBe(key === 'sample' ? 65536 : 8192)
      for (let index = 0; index < count; index++) {
        const at = Math.floor(((index + 0.5) * 257 * 257) / count)
        expected.set(fixture.pixels.subarray(at * 4, at * 4 + 4), index * 4)
        if (data[index * 4] !== at || data[index * 4 + 3] !== (at % 2 ? 0.5 : 1))
          throw new Error(`Source site/alpha mismatch in ${key} at ${index}.`)
      }
      expect(Buffer.from(data.buffer)).toEqual(Buffer.from(expected.buffer))
    }
    expect(result.samples.sample.buffer).not.toBe(result.samples.draft.buffer)
    const ownedHashes = [result.samples.sample, result.samples.draft].map((data) =>
      hash(new Uint8Array(data.buffer)),
    )
    fixture.pixels.fill(123)
    sink.chunks.forEach((part) => part.fill(0))
    expect(
      [result.samples.sample, result.samples.draft].map((data) =>
        hash(new Uint8Array(data.buffer)),
      ),
    ).toEqual(ownedHashes)
  })
})

for (const corruption of ['strip', 'whole-source'] as const)
  test(`a ${corruption} hash mismatch never sends successful EOF`, async () => {
    await scratch(async ({ file }) => {
      const fixture = source(),
        input = await file('linear.f32', fixture.bytes),
        sink = collectingWriter()
      if (corruption === 'strip') fixture.asset.strips[1].sha256 = '0'.repeat(64)
      else fixture.asset.sha256 = '0'.repeat(64)
      try {
        await expect(
          attestAndFeedCpuSource(input, fixture.asset, sink.writer, new AbortController().signal),
        ).rejects.toThrow(corruption === 'strip' ? 'Damaged CPU working strip' : 'whole-file hash')
        expect(sink.writer.writableEnded).toBe(false)
        expect(sink.chunks.length).toBe(corruption === 'strip' ? 1 : 3)
      } finally {
        sink.writer.destroy()
      }
    })
  })

test('a pending real strip write keeps borrowed storage stable and truncation is rejected after release', async () => {
  await scratch(async ({ directory, file }) => {
    const fixture = source(),
      input = await file('linear.f32', fixture.bytes),
      entered = deferred(),
      release = deferred()
    let writes = 0,
      first: Buffer | undefined,
      copy: Buffer | undefined
    const writer = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, callback) {
        writes++
        if (writes === 1) {
          first = chunk
          copy = Buffer.from(chunk)
          entered.resolve()
          void release.promise.then(() => callback())
        } else callback()
      },
    })
    writer.on('error', () => undefined)
    const work = attestAndFeedCpuSource(input, fixture.asset, writer, new AbortController().signal)
    const rejected = expect(work).rejects.toThrow('Incomplete CPU working strip')
    try {
      await entered.promise
      await tick()
      expect(writer.writableNeedDrain).toBe(true)
      expect(writes).toBe(1)
      expect(first).toEqual(copy)
      await truncate(join(directory, 'linear.f32'), fixture.bytes.length - 16)
      release.resolve()
      await rejected
    } finally {
      release.resolve()
      writer.destroy()
      await work.catch(() => undefined)
    }
  })
})

test('replacing a pathname cannot retarget the already opened source descriptor', async () => {
  await scratch(async ({ directory, file }) => {
    const fixture = source(),
      input = await file('linear.f32', fixture.bytes),
      entered = deferred(),
      release = deferred(),
      chunks: Buffer[] = []
    const writer = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(Buffer.from(chunk))
        if (chunks.length === 1) {
          entered.resolve()
          void release.promise.then(() => callback())
        } else callback()
      },
    })
    writer.on('error', () => undefined)
    const work = attestAndFeedCpuSource(input, fixture.asset, writer, new AbortController().signal)
    try {
      await entered.promise
      await rename(join(directory, 'linear.f32'), join(directory, 'original-held.f32'))
      await writeFile(join(directory, 'linear.f32'), Buffer.alloc(fixture.bytes.length, 0xff), {
        flag: 'wx',
      })
      release.resolve()
      expect((await work).sourceAttestedByMain).toBe(true)
      expect(hash(Buffer.concat(chunks))).toBe(fixture.asset.sha256)
      expect(hash(await readFile(join(directory, 'linear.f32')))).not.toBe(fixture.asset.sha256)
    } finally {
      release.resolve()
      writer.destroy()
      await work.catch(() => undefined)
    }
  })
})

test('mutation of an unread source strip fails its content hash before successful EOF', async () => {
  await scratch(async ({ directory, file }) => {
    const fixture = source(),
      input = await file('linear.f32', fixture.bytes),
      entered = deferred(),
      release = deferred()
    const writer = new Writable({
      write(_chunk, _encoding, callback) {
        entered.resolve()
        void release.promise.then(() => callback())
      },
    })
    writer.on('error', () => undefined)
    const work = attestAndFeedCpuSource(input, fixture.asset, writer, new AbortController().signal)
    const rejected = expect(work).rejects.toThrow('Damaged CPU working strip')
    try {
      await entered.promise
      const mutator = await open(join(directory, 'linear.f32'), 'r+')
      try {
        await mutator.write(Buffer.from([0xff]), 0, 1, fixture.asset.strips[0].byteLength)
      } finally {
        await mutator.close()
      }
      release.resolve()
      await rejected
      expect(writer.writableEnded).toBe(false)
    } finally {
      release.resolve()
      writer.destroy()
      await work.catch(() => undefined)
    }
  })
})

test('an LRU timestamp touch during a blocked feed preserves attested content and successful EOF', async () => {
  await scratch(async ({ directory, file }) => {
    const fixture = source(),
      input = await file('linear.f32', fixture.bytes),
      entered = deferred(),
      release = deferred(),
      original = await input.stat(),
      chunks: Buffer[] = []
    const writer = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(Buffer.from(chunk))
        if (chunks.length === 1) {
          entered.resolve()
          void release.promise.then(() => callback())
        } else callback()
      },
    })
    writer.on('error', () => undefined)
    const work = attestAndFeedCpuSource(input, fixture.asset, writer, new AbortController().signal)
    try {
      await entered.promise
      await utimes(
        join(directory, 'linear.f32'),
        new Date(original.atimeMs),
        new Date(original.mtimeMs + 1000),
      )
      expect((await input.stat()).mtimeMs).toBeGreaterThan(original.mtimeMs)
      release.resolve()
      expect((await work).sourceAttestedByMain).toBe(true)
      expect(writer.writableFinished).toBe(true)
      expect(hash(Buffer.concat(chunks))).toBe(fixture.asset.sha256)
    } finally {
      release.resolve()
      writer.destroy()
      await work.catch(() => undefined)
    }
  })
})

test('abort of a blocked strip rejects without reusing it; caller closes the real stream before source release', async () => {
  await scratch(async ({ file }) => {
    const fixture = source(),
      input = await file('linear.f32', fixture.bytes),
      entered = deferred(),
      closed = deferred(),
      abort = new AbortController()
    let release: ((error?: Error | null) => void) | undefined,
      writes = 0
    const writer = new Writable({
      write(_chunk, _encoding, callback) {
        writes++
        release = (error) => {
          release = undefined
          callback(error)
        }
        entered.resolve()
      },
    })
    writer.on('error', () => undefined)
    writer.once('close', () => closed.resolve())
    const work = attestAndFeedCpuSource(input, fixture.asset, writer, abort.signal)
    const rejected = expect(work).rejects.toThrow('cancelled blocked input')
    try {
      await entered.promise
      const reason = new Error('cancelled blocked input')
      abort.abort(reason)
      writer.destroy(reason)
      release?.(reason)
      await rejected
      await closed.promise
      expect(writes).toBe(1)
    } finally {
      writer.destroy()
      release?.()
      await work.catch(() => undefined)
    }
  })
})

for (const terminal of ['callback-error', 'premature-close', 'abort'] as const)
  test(`terminal stdin ${terminal} cannot become attested EOF success`, async () => {
    await scratch(async ({ file }) => {
      const fixture = source(2, 2),
        input = await file('linear.f32', fixture.bytes),
        final = deferred(),
        abort = new AbortController()
      let finish: ((error?: Error | null) => void) | undefined
      const writer = new Writable({
        write(_chunk, _encoding, callback) {
          callback()
        },
        final(callback) {
          finish = (error) => {
            finish = undefined
            callback(error)
          }
          final.resolve()
        },
      })
      writer.on('error', () => undefined)
      const work = attestAndFeedCpuSource(input, fixture.asset, writer, abort.signal)
      const rejected = expect(work).rejects.toThrow(
        /terminal input|closed before EOF|premature|stream was destroyed/i,
      )
      try {
        await final.promise
        if (terminal === 'callback-error') finish?.(new Error('terminal input callback failure'))
        else if (terminal === 'premature-close') writer.destroy()
        else abort.abort(new Error('terminal input aborted'))
        await rejected
      } finally {
        writer.destroy()
        finish?.()
        await work.catch(() => undefined)
      }
    })
  })

function pairFixture(width = 7, height = 65, sourceWidth = width) {
  const request = Buffer.alloc(832)
  request.write('IRODCPU3')
  request.writeUInt32LE(3, 8)
  for (const [at, value] of [
    [16, sourceWidth],
    [20, height],
    [24, width],
    [28, height],
  ])
    request.writeUInt32LE(value, at)
  request.fill(0x11, 56, 88)
  request.fill(0x22, 88, 120)
  request.writeBigUInt64LE(BigInt(sourceWidth * height * 16), 120)
  const after = Buffer.alloc(width * height * 4),
    before = Buffer.alloc(after.length)
  for (let index = 0; index < after.length; index++) {
    after[index] = index % 4 === 3 ? 255 : index % 251
    before[index] = index % 4 === 3 ? 255 : 250 - (index % 251)
  }
  const header = Buffer.alloc(848)
  header.write('IRODRGB1')
  header.writeUInt32LE(832, 8)
  request.copy(header, 12)
  header.writeUInt32LE(4, 844)
  const parts = [header]
  for (let row = 0; row < height; row += 64) {
    const count = Math.min(64, height - row),
      bytes = width * count * 4,
      strip = Buffer.alloc(24)
    strip.write('IRODROW1')
    for (const [at, value] of [
      [8, row],
      [12, count],
      [16, bytes],
    ])
      strip.writeUInt32LE(value, at)
    parts.push(
      strip,
      after.subarray(row * width * 4, (row + count) * width * 4),
      before.subarray(row * width * 4, (row + count) * width * 4),
    )
  }
  const trailer = Buffer.from(
      JSON.stringify({
        implementation: 'float64-ctl-cpu-strip-v1',
        threads: 4,
        renderedStrips: Math.ceil(height / 64),
        sourceHashVerifiedByChild: false,
        preparationMs: 1,
        readMs: 2,
        renderMs: 3,
        outputMs: 4,
        elapsedMs: 10,
        plannedStripAndWorkerBytes: 4096,
      }),
    ),
    end = Buffer.alloc(12)
  end.write('IRODEND1')
  end.writeUInt32LE(trailer.length, 8)
  return { request, after, before, wire: Buffer.concat([...parts, end, trailer]) }
}
async function* fragments(bytes: Buffer, done?: ReturnType<typeof deferred<void>>) {
  const sizes = [1, 7, 3, 400, 13, 2, 65521]
  for (let at = 0, index = 0; at < bytes.length; index++) {
    const end = Math.min(bytes.length, at + sizes[index % sizes.length])
    yield bytes.subarray(at, end)
    at = end
  }
  done?.resolve()
}

// The corruption table below always uses the fixed 7x65 paired fixture.
const completionOffset = 848 + 2 * 24 + 7 * 65 * 8
function alterCompletion(wire: Buffer, alter: (metrics: Record<string, unknown>) => void) {
  const metrics = JSON.parse(wire.subarray(completionOffset + 12).toString()) as Record<
    string,
    unknown
  >
  alter(metrics)
  const json = Buffer.from(JSON.stringify(metrics)),
    prefix = Buffer.from(wire.subarray(0, completionOffset + 12))
  prefix.writeUInt32LE(json.length, completionOffset + 8)
  return Buffer.concat([prefix, json])
}

test('fragmented paired output uses output24/28, survives partial real writes and waits for zero child close', async () => {
  await scratch(async ({ directory, file }) => {
    const fixture = pairFixture(1024, 65, 1025),
      after = await file('after.rgba'),
      before = await file('before.rgba'),
      eof = deferred(),
      closed = deferred()
    // Force legal partial writes on real FileHandles, without replacing filesystem ownership.
    const original = after.write.bind(after)
    after.write = ((buffer: Uint8Array, offset: number, length: number, position: number | null) =>
      original(buffer, offset, Math.min(length, 16381), position)) as typeof after.write
    let settled = false
    const work = writeNativeCpuPair({
      stdout: fragments(fixture.wire, eof),
      expectedRequest: fixture.request,
      threads: 4,
      after,
      before,
      signal: new AbortController().signal,
      closedSuccessfully: closed.promise,
    })
    void work.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    try {
      await eof.promise
      await tick()
      expect(settled).toBe(false)
      closed.resolve()
      const result = await work
      expect(result).toMatchObject({
        width: 1024,
        height: 65,
        strips: 2,
        after: { byteLength: fixture.after.length, sha256: hash(fixture.after) },
        before: { byteLength: fixture.before.length, sha256: hash(fixture.before) },
      })
      expect(await readFile(join(directory, 'after.rgba'))).toEqual(fixture.after)
      expect(await readFile(join(directory, 'before.rgba'))).toEqual(fixture.before)
    } finally {
      closed.resolve()
      await work.catch(() => undefined)
    }
  })
})

const corruptions: { name: string; mutate: (wire: Buffer) => Buffer }[] = [
  {
    name: 'request echo',
    mutate: (wire) => {
      wire[12 + 56] ^= 1
      return wire
    },
  },
  {
    name: 'request length',
    mutate: (wire) => {
      wire.writeUInt32LE(399, 8)
      return wire
    },
  },
  {
    name: 'thread echo',
    mutate: (wire) => {
      wire.writeUInt32LE(8, 844)
      return wire
    },
  },
  {
    name: 'row order',
    mutate: (wire) => {
      wire.writeUInt32LE(1, 848 + 8)
      return wire
    },
  },
  {
    name: 'oversized row count',
    mutate: (wire) => {
      wire.writeUInt32LE(65, 848 + 12)
      return wire
    },
  },
  {
    name: 'row byte count',
    mutate: (wire) => {
      wire.writeUInt32LE(1, 848 + 16)
      return wire
    },
  },
  {
    name: 'reserved row field',
    mutate: (wire) => {
      wire.writeUInt32LE(1, 848 + 20)
      return wire
    },
  },
  { name: 'truncated header', mutate: (wire) => wire.subarray(0, 100) },
  { name: 'truncated payload', mutate: (wire) => wire.subarray(0, 446) },
  { name: 'truncated trailer', mutate: (wire) => wire.subarray(0, wire.length - 5) },
  {
    name: 'oversized trailer',
    mutate: (wire) => {
      wire.writeUInt32LE(65537, completionOffset + 8)
      return wire
    },
  },
  {
    name: 'false completion identity',
    mutate: (wire) =>
      alterCompletion(wire, (metrics) => {
        metrics.implementation = 'float64-ctl-cpu-strip-v0'
      }),
  },
  {
    name: 'non-numeric completion metric',
    mutate: (wire) =>
      alterCompletion(wire, (metrics) => {
        metrics.readMs = null
      }),
  },
  { name: 'extra output', mutate: (wire) => Buffer.concat([wire, Buffer.from([1])]) },
]
for (const { name, mutate } of corruptions)
  test(`paired sink rejects ${name} before returning a descriptor`, async () => {
    await scratch(async ({ file }) => {
      const fixture = pairFixture(),
        after = await file('after.rgba'),
        before = await file('before.rgba')
      await expect(
        writeNativeCpuPair({
          stdout: fragments(mutate(fixture.wire)),
          expectedRequest: fixture.request,
          threads: 4,
          after,
          before,
          signal: new AbortController().signal,
          closedSuccessfully: Promise.resolve(),
        }),
      ).rejects.toThrow()
    })
  })

test('an oversized pipe chunk is rejected even when the parser only requested a small header', async () => {
  await scratch(async ({ file }) => {
    const fixture = pairFixture(),
      after = await file('after.rgba'),
      before = await file('before.rgba')
    async function* oversized() {
      yield Buffer.alloc(128 * 1024 + 1)
    }
    await expect(
      writeNativeCpuPair({
        stdout: oversized(),
        expectedRequest: fixture.request,
        threads: 4,
        after,
        before,
        signal: new AbortController().signal,
        closedSuccessfully: Promise.resolve(),
      }),
    ).rejects.toThrow('pipe chunk')
    expect((await after.stat()).size).toBe(0)
  })
})

test('a valid trailer and EOF cannot conceal nonzero child close', async () => {
  await scratch(async ({ file }) => {
    const fixture = pairFixture(),
      after = await file('after.rgba'),
      before = await file('before.rgba'),
      eof = deferred(),
      closed = deferred()
    const work = writeNativeCpuPair({
      stdout: fragments(fixture.wire, eof),
      expectedRequest: fixture.request,
      threads: 4,
      after,
      before,
      signal: new AbortController().signal,
      closedSuccessfully: closed.promise,
    })
    const rejected = expect(work).rejects.toThrow('native exit 7')
    await eof.promise
    closed.reject(new Error('native exit 7'))
    await rejected
  })
})

test('caller destruction interrupts a cancelled pending stdout read and drains before file cleanup', async () => {
  await scratch(async ({ file }) => {
    const fixture = pairFixture(),
      after = await file('after.rgba'),
      before = await file('before.rgba'),
      stdout = new PassThrough(),
      abort = new AbortController(),
      closed = deferred(),
      pipeClosed = deferred()
    stdout.on('error', () => undefined)
    stdout.once('close', () => pipeClosed.resolve())
    const work = writeNativeCpuPair({
      stdout,
      expectedRequest: fixture.request,
      threads: 4,
      after,
      before,
      signal: abort.signal,
      closedSuccessfully: closed.promise,
    })
    const rejected = expect(work).rejects.toThrow('cancelled native output')
    try {
      await tick()
      const reason = new Error('cancelled native output')
      abort.abort(reason)
      stdout.destroy(reason)
      closed.reject(reason)
      await rejected
      await pipeClosed.promise
      expect((await after.stat()).size).toBe(0)
    } finally {
      stdout.destroy()
      closed.resolve()
      await Promise.allSettled([work, closed.promise, pipeClosed.promise])
    }
  })
})

const limits = { ramBytes: 4 * 1024 ** 3, gpuBytes: 4 * 1024 ** 3, revision: 3 }
const planRequest = (): CpuMemoryRequest => ({
  sourceWidth: 3,
  sourceHeight: 5,
  outputWidth: 3,
  outputHeight: 5,
  canvasWidth: 7,
  canvasHeight: 9,
  threads: 4,
  oldPairBytes: 2 * 11 * 13 * 4,
  existingOwners: nativeCpuExistingOwners(3, 5, 7, 9),
})

test('sequential comparison sources retain both sample domains without doubling strips, bitmaps or GPU ownership', () => {
  const request = planRequest(),
    ordinary = nativeCpuMemory(request, limits),
    comparison = nativeCpuMemory({ ...request, sourceCount: 2 }, limits)
  expect(comparison.owners.samples).toBe(ordinary.owners.samples * 2)
  expect(comparison.owners.input).toBe(ordinary.owners.input)
  expect(comparison.owners.output).toBe(ordinary.owners.output)
  expect(comparison.owners.newPairConstruction).toBe(ordinary.owners.newPairConstruction)
  expect(comparison.peak.gpuBytes).toBe(ordinary.peak.gpuBytes)
  expect(comparison.nativePeak.ramBytes - ordinary.nativePeak.ramBytes).toBe(
    ordinary.owners.samples,
  )
  const boundary = { ...limits, ramBytes: comparison.peak.ramBytes - 1 }
  expect(nativeCpuMemory(request, boundary).accepted).toBe(true)
  expect(nativeCpuMemory({ ...request, sourceCount: 2 }, boundary).accepted).toBe(false)
  expect(
    nativeCpuResidentMemory({ ...request, sourceCount: 2 }, limits).peak.ramBytes -
      nativeCpuResidentMemory(request, limits).peak.ramBytes,
  ).toBe(ordinary.owners.samples)
  expect(() => nativeCpuMemory({ ...request, sourceCount: 3 as 2 }, limits)).toThrow()
})

test('a one-plane native sink validates the complete unused plane and the actual child close', async () => {
  await scratch(async ({ file, directory }) => {
    const fixture = pairFixture(),
      before = await file('before-only.rgba'),
      result = await writeNativeCpuPair({
        stdout: fragments(fixture.wire),
        expectedRequest: fixture.request,
        threads: 4,
        before,
        closedSuccessfully: Promise.resolve(),
        signal: new AbortController().signal,
      })
    expect(result.before.sha256).toBe(hash(fixture.before))
    expect(await readFile(join(directory, 'before-only.rgba'))).toEqual(fixture.before)
    const failed = await file('failed-before.rgba')
    await expect(
      writeNativeCpuPair({
        stdout: fragments(fixture.wire),
        expectedRequest: fixture.request,
        threads: 4,
        before: failed,
        closedSuccessfully: Promise.reject(new Error('late child failure')),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('late child failure')
    const damaged = Buffer.from(fixture.wire)
    damaged.writeUInt32LE(1, 848 + 20)
    await expect(
      writeNativeCpuPair({
        stdout: fragments(damaged),
        expectedRequest: fixture.request,
        threads: 4,
        before: failed,
        closedSuccessfully: Promise.resolve(),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('row ordering')
  })
})

test('phase owners cover actual strip/sample/pair buffers and independent explicit existing owners', () => {
  const request = planRequest(),
    plan = nativeCpuMemory(request, limits),
    inputStrip = new Float32Array(3 * 5 * 4),
    outputPlane = new Uint8ClampedArray(3 * 5 * 4)
  expect(plan.owners.input).toBe(inputStrip.byteLength * 2)
  expect(plan.owners.output).toBe(outputPlane.byteLength * 4)
  expect(plan.owners.samples).toBe(2 * new Float32Array(3 * 5 * 4).byteLength * 6)
  expect(plan.owners.oldPair).toBe(2 * new Uint8ClampedArray(11 * 13 * 4).byteLength)
  expect(plan.owners.newPairConstruction).toBe(outputPlane.byteLength * 4)
  expect(plan.owners.canvas).toBe(7 * 9 * 32)
  // Independent odd pyramid: 3x5, 2x3, 1x2, 1x1 = 24 one-byte mask sites.
  const histogramBytes = (256 + 512 * 3 + 9) * 4,
    cache = 256 * 1024 ** 2
  expect(request.existingOwners).toEqual({
    ramBytes: cache + 24 * 2 + inputStrip.byteLength * 2 + histogramBytes * 2 + 15 * 8 + 63 * 4,
    gpuBytes: cache + 15 * 4 + 63 * 4,
  })
  expect(plan.peak.ramBytes).toBeGreaterThanOrEqual(plan.nativePeak.ramBytes)
  expect(plan.peak.ramBytes).toBeGreaterThanOrEqual(plan.bitmapPeak.ramBytes)
  expect(Object.isFrozen(plan.owners)).toBe(true)
})

test('RAM and GPU admission each retain their exact boundary and old/retiring owners cannot borrow the other budget', () => {
  const request = planRequest(),
    plan = nativeCpuMemory(request, limits),
    exact = { ramBytes: plan.peak.ramBytes, gpuBytes: plan.peak.gpuBytes, revision: 4 }
  const captured = nativeCpuMemory(request, exact)
  expect(captured.accepted).toBe(true)
  expect(
    nativeCpuMemory(request, { ...exact, ramBytes: exact.ramBytes - 1, gpuBytes: limits.gpuBytes })
      .accepted,
  ).toBe(false)
  expect(
    nativeCpuMemory(request, { ...exact, ramBytes: limits.ramBytes, gpuBytes: exact.gpuBytes - 1 })
      .accepted,
  ).toBe(false)
  const moreRam = nativeCpuMemory(
    {
      ...request,
      existingOwners: {
        ...request.existingOwners,
        ramBytes: request.existingOwners.ramBytes + 4096,
      },
    },
    limits,
  )
  expect(moreRam.peak.ramBytes - plan.peak.ramBytes).toBe(4096)
  expect(moreRam.peak.gpuBytes).toBe(plan.peak.gpuBytes)
  const moreGpu = nativeCpuMemory(
    {
      ...request,
      existingOwners: {
        ...request.existingOwners,
        gpuBytes: request.existingOwners.gpuBytes + 8192,
      },
    },
    limits,
  )
  expect(moreGpu.peak.gpuBytes - plan.peak.gpuBytes).toBe(8192)
  expect(moreGpu.peak.ramBytes).toBe(plan.peak.ramBytes)
  const stacks = nativeCpuMemory({ ...request, threads: 8 }, limits)
  expect(stacks.nativePeak.ramBytes - plan.nativePeak.ramBytes).toBe(4 * 512 * 1024)
  expect(stacks.bitmapPeak).toEqual(plan.bitmapPeak)
  exact.ramBytes = 0
  expect(captured.limits.ramBytes).toBe(plan.peak.ramBytes)
  expect(Object.isFrozen(captured.limits)).toBe(true)
})

test('invalid geometry, source bounds, thread counts and non-exact ownership fail before admission', () => {
  const request = planRequest()
  for (const sourceWidth of [0, -1, 1.5, Number.NaN, 32769]) {
    expect(() => nativeCpuMemory({ ...request, sourceWidth }, limits)).toThrow()
    expect(() => nativeCpuExistingOwners(sourceWidth, 5, 7, 9)).toThrow()
  }
  expect(() =>
    nativeCpuMemory({ ...request, sourceWidth: 32768, sourceHeight: 32768 }, limits),
  ).toThrow('source size')
  const draft = {
    ...request,
    sourceWidth: 1025,
    sourceHeight: 65,
    outputWidth: 1024,
    outputHeight: 65,
    existingOwners: nativeCpuExistingOwners(1025, 65, 7, 9),
  }
  expect(nativeCpuMemory(draft, limits).accepted).toBe(true)
  expect(() =>
    nativeCpuMemory(
      { ...request, sourceWidth: 1025, sourceHeight: 65, outputWidth: 1023, outputHeight: 65 },
      limits,
    ),
  ).toThrow('full or existing draft geometry')
  expect(() => nativeCpuMemory({ ...request, threads: 2 as 4 }, limits)).toThrow()
  expect(() =>
    nativeCpuMemory({ ...request, oldPairBytes: Number.MAX_SAFE_INTEGER + 1 }, limits),
  ).toThrow()
  expect(() => nativeCpuMemory(request, { ...limits, ramBytes: -1 })).toThrow()
  expect(() => nativeCpuMemory(request, { ...limits, revision: 0.5 })).toThrow()
})

test('resident admission releases native and retiring-pair phases while charging both current planes and samples', () => {
  const request = planRequest(),
    construction = nativeCpuMemory(request, limits),
    resident = nativeCpuResidentMemory(request, limits)
  const plane = new Uint8ClampedArray(request.outputWidth * request.outputHeight * 4)
  expect(resident.peak.ramBytes).toBe(
    request.existingOwners.ramBytes +
      plane.byteLength * 2 +
      construction.owners.samples +
      construction.owners.canvas +
      construction.owners.retainedRecovery,
  )
  expect(resident.peak.gpuBytes).toBe(
    request.existingOwners.gpuBytes + plane.byteLength * 2 + construction.owners.canvas,
  )
  expect(resident.peak.ramBytes).toBeLessThan(construction.peak.ramBytes)
  expect(
    nativeCpuResidentMemory({ ...request, oldPairBytes: request.oldPairBytes + 4096 }, limits).peak,
  ).toEqual(resident.peak)
  const exact = { ramBytes: resident.peak.ramBytes, gpuBytes: resident.peak.gpuBytes, revision: 7 }
  expect(nativeCpuResidentMemory(request, exact).accepted).toBe(true)
  expect(
    nativeCpuResidentMemory(request, { ...exact, ramBytes: exact.ramBytes - 1 }).accepted,
  ).toBe(false)
  expect(
    nativeCpuResidentMemory(request, { ...exact, gpuBytes: exact.gpuBytes - 1 }).accepted,
  ).toBe(false)
})
