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
import { Writable } from 'node:stream'
import { attestAndFeedCpuMaskSource } from '../src/main/native-cpu-input'
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

test('verified real-file feed respects backpressure without allocating presentation samples', async () => {
  await scratch(async ({ file }) => {
    const fixture = source(257, 257),
      input = await file('linear.f32', fixture.bytes),
      sink = collectingWriter()
    const result = await attestAndFeedCpuMaskSource(
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
          attestAndFeedCpuMaskSource(
            input,
            fixture.asset,
            sink.writer,
            new AbortController().signal,
          ),
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
    const work = attestAndFeedCpuMaskSource(
      input,
      fixture.asset,
      writer,
      new AbortController().signal,
    )
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
    const work = attestAndFeedCpuMaskSource(
      input,
      fixture.asset,
      writer,
      new AbortController().signal,
    )
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
    const work = attestAndFeedCpuMaskSource(
      input,
      fixture.asset,
      writer,
      new AbortController().signal,
    )
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
    const work = attestAndFeedCpuMaskSource(
      input,
      fixture.asset,
      writer,
      new AbortController().signal,
    )
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
    const work = attestAndFeedCpuMaskSource(input, fixture.asset, writer, abort.signal)
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
