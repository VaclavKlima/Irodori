import { expect, test } from '@playwright/test'
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeHdrStrip, type HdrStripWriter } from '../src/main/processing/write-hdr-strip'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('HDR strip writes preserve source view offsets and surrounding file bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-hdr-strip-')),
    path = join(root, 'linear.bin'),
    backing = Uint8Array.from([91, 92, 0, 255, 127, 128, 1, 254, 93, 94]),
    original = backing.slice(),
    bytes = backing.subarray(2, 8)
  try {
    await writeFile(path, Uint8Array.from([31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41]))
    const handle = await open(path, 'r+')
    try {
      await writeHdrStrip(handle, bytes, 3)
    } finally {
      await handle.close()
    }
    expect(await readFile(path)).toEqual(
      Buffer.from([31, 32, 33, 0, 255, 127, 128, 1, 254, 40, 41]),
    )
    expect(backing).toEqual(original)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('HDR strip short writes reuse the supplied view and advance absolute positions serially', async () => {
  const backing = Uint8Array.from([81, 82, 11, 22, 33, 44, 55, 66, 83]),
    original = backing.slice(),
    bytes = backing.subarray(2, 8),
    output = new Uint8Array(13).fill(99),
    calls: { bytes: Uint8Array; offset: number; length: number; position: number }[] = [],
    progress = [2, 1, 3]
  let active = 0,
    maximum = 0
  const writer: HdrStripWriter = {
    async write(source, offset, length, position) {
      active++
      maximum = Math.max(maximum, active)
      calls.push({ bytes: source, offset, length, position })
      await Promise.resolve()
      const count = progress[calls.length - 1]
      output.set(source.subarray(offset, offset + count), position)
      active--
      return { bytesWritten: count }
    },
  }
  await writeHdrStrip(writer, bytes, 4)
  expect(calls.map(({ offset, length, position }) => [offset, length, position])).toEqual([
    [0, 6, 4],
    [2, 4, 6],
    [3, 3, 7],
  ])
  for (const call of calls) expect(call.bytes).toBe(bytes)
  expect(output).toEqual(Uint8Array.from([99, 99, 99, 99, 11, 22, 33, 44, 55, 66, 99, 99, 99]))
  expect(backing).toEqual(original)
  expect(maximum).toBe(1)
  expect(active).toBe(0)
})

test('HDR strip failure preserves the unwritten tail and propagates the original error', async () => {
  const bytes = Uint8Array.from([10, 20, 30, 40, 50]),
    output = new Uint8Array(10).fill(77),
    failure = new Error('isolated write failure')
  let calls = 0
  const writer: HdrStripWriter = {
    async write(source, offset, _length, position) {
      calls++
      if (calls > 1) throw failure
      output.set(source.subarray(offset, offset + 2), position)
      return { bytesWritten: 2 }
    },
  }
  await expect(writeHdrStrip(writer, bytes, 3)).rejects.toBe(failure)
  expect(calls).toBe(2)
  expect(output).toEqual(Uint8Array.from([77, 77, 77, 10, 20, 77, 77, 77, 77, 77]))
  expect(bytes).toEqual(Uint8Array.from([10, 20, 30, 40, 50]))
})

for (const progress of [0, -1, 0.5, NaN, Infinity, 5])
  test(`HDR strip rejects invalid write progress ${progress}`, async () => {
    let calls = 0
    const writer: HdrStripWriter = {
      async write() {
        calls++
        return { bytesWritten: progress }
      },
    }
    await expect(writeHdrStrip(writer, Uint8Array.from([1, 2, 3, 4]), 0)).rejects.toThrow(
      'Cannot write HDR strip.',
    )
    expect(calls).toBe(1)
  })

test('HDR strip cancellation before entry performs no I/O', async () => {
  const controller = new AbortController(),
    reason = new Error('Stopped before writing the HDR strip.')
  let calls = 0
  controller.abort(reason)
  const writer: HdrStripWriter = {
    async write() {
      calls++
      return { bytesWritten: 1 }
    },
  }
  await expect(writeHdrStrip(writer, Uint8Array.from([1, 2]), 0, controller.signal)).rejects.toBe(
    reason,
  )
  expect(calls).toBe(0)
})

test('empty HDR strips perform no I/O and still reject entry cancellation', async () => {
  const controller = new AbortController()
  let calls = 0
  const writer: HdrStripWriter = {
    async write() {
      calls++
      return { bytesWritten: 0 }
    },
  }
  await writeHdrStrip(writer, new Uint8Array(), 9)
  controller.abort()
  await expect(writeHdrStrip(writer, new Uint8Array(), 9, controller.signal)).rejects.toThrow()
  expect(calls).toBe(0)
})

test('an issued HDR strip write failure survives concurrent cancellation', async () => {
  const controller = new AbortController(),
    started = deferred<void>(),
    release = deferred<void>(),
    failure = new Error('in-flight write failed')
  let calls = 0
  const writer: HdrStripWriter = {
    async write() {
      calls++
      started.resolve()
      await release.promise
      throw failure
    },
  }
  const result = writeHdrStrip(writer, Uint8Array.from([1, 2]), 0, controller.signal)
  const rejection = expect(result).rejects.toBe(failure)
  await started.promise
  controller.abort()
  release.resolve()
  await rejection
  expect(calls).toBe(1)
})

for (const count of [2, 4])
  test(`HDR strip cancellation drains an issued ${count === 4 ? 'complete' : 'partial'} write before rejecting`, async () => {
    const controller = new AbortController(),
      reason = new Error('Stopped during the HDR strip write.'),
      started = deferred<void>(),
      release = deferred<void>(),
      bytes = Uint8Array.from([12, 23, 34, 45]),
      output = new Uint8Array(8).fill(88)
    let calls = 0,
      settled = false
    const writer: HdrStripWriter = {
      async write(source, offset, _length, position) {
        calls++
        expect(source).toBe(bytes)
        started.resolve()
        await release.promise
        output.set(source.subarray(offset, offset + count), position)
        return { bytesWritten: count }
      },
    }
    const outcome = writeHdrStrip(writer, bytes, 2, controller.signal).then(
      () => {
        settled = true
        return null
      },
      (error: unknown) => {
        settled = true
        return error
      },
    )
    await started.promise
    controller.abort(reason)
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(output).toEqual(new Uint8Array(8).fill(88))
    release.resolve()
    expect(await outcome).toBe(reason)
    expect(calls).toBe(1)
    expect(output).toEqual(
      Uint8Array.from(
        count === 4 ? [88, 88, 12, 23, 34, 45, 88, 88] : [88, 88, 12, 23, 88, 88, 88, 88],
      ),
    )
  })
