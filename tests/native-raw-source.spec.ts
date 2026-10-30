import { expect, test } from '@playwright/test'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createConnection, createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NativeRawSourceClient } from '../src/main/native-raw-source'
import type { NativeRawPipeHeader, NativeRawSnapshot } from '../src/main/native-raw-pipe'
import type { NativeRawMainMessage, NativeRawWorkerContext } from '../src/main/preview-types'
import { DEFAULT_RESOURCE_SETTINGS, resolveResourcePolicy } from '../src/shared/resource-policy'

// Transport/receiver controls only. The small plane is synthetic; its Sony camera
// metadata uses the verified production profile. No RAW decoding or native exit is
// fabricated as evidence: main exit notifications below are explicitly test inputs.
const nonce = '1'.repeat(32)
function context(): NativeRawWorkerContext {
  return {
    nonce,
    originalSha256: 'a'.repeat(64),
    parentWorkingKey: 'b'.repeat(64),
    policy: resolveResourcePolicy(
      DEFAULT_RESOURCE_SETTINGS,
      {
        ram: { totalBytes: 16 * 1024 ** 3, availableBytes: 12 * 1024 ** 3 },
        gpu: { status: 'unknown', reason: 'unavailable' },
      },
      1,
    ),
    rendererReservation: { ramBytes: 0, vramBytes: 0 },
  }
}
function jsonFrame(magic: string, value: unknown) {
  const body = Buffer.from(JSON.stringify(value)),
    prefix = Buffer.alloc(12)
  prefix.write(magic, 0, 8, 'ascii')
  prefix.writeUInt32LE(body.length, 8)
  return Buffer.concat([prefix, body])
}
function protocolFixture(fallback = false, wrongLibrary = false) {
  const snapshot: NativeRawSnapshot = {
    libraryVersion: wrongLibrary ? '0.99.0-Release' : '0.22.1-Release',
    make: 'Sony',
    model: 'ZV-1A',
    unpackFunction: 'sony_arw2_load_raw()',
    width: 48,
    height: 32,
    rawWidth: 64,
    rawHeight: 32,
    rawPitch: 128,
    left: 0,
    top: 0,
    flip: 5,
    colors: 3,
    isFoveon: false,
    pixelAspect: 1,
    cfa: [0, 1, 3, 2],
    black: [800, 800, 800, 800],
    commonBlack: 800,
    cblack: [0, 0, 0, 0, 0, 0],
    colorMaximum: 16380,
    camMul: [2324, 1024, 2068, 1024],
    matrix: [
      1.547621488571167, -0.33338290452957153, -0.21423858404159546, 0, -0.2264191061258316,
      1.6466017961502075, -0.42018264532089233, 0, 0.006545631680637598, -0.48746058344841003,
      1.4809149503707886, 0,
    ],
    camXyz: [
      0.828000009059906, -0.2987000048160553, -0.07029999792575836, -0.3531000018119812,
      1.1644999980926514, 0.21330000460147858, -0.054999999701976776, 0.1542000025510788,
      0.5311999917030334, 0, 0, 0,
    ],
    linearMax: [15360, 15360, 15360, 15360],
  }
  const header: NativeRawPipeHeader = {
    contract: 'irodori-parallel-sony-arw2-rows-v1',
    protocol: 'u16le-live-rows-v2',
    opened: { ...structuredClone(snapshot), rawPitch: 0 },
    unpacked: snapshot,
    packedBytes: 4096,
    sourceLayout: { rowSamples: 64, rowCount: 32, strideSamples: 64 },
    rowKernel: fallback
      ? {
          status: 'upstream-fallback',
          requestedThreads: 8,
          reason: 'unsupported-flags-or-layout',
        }
      : {
          status: 'rust-complete',
          requestedThreads: 8,
          participants: 8,
          observedThreads: 8,
          rows: 32,
          blocks: 128,
          samples: 2048,
          errorCode: 0,
          descriptor: {
            dataOffset: 64,
            mappedBytes: 2112,
            compressedBytes: 2048,
            rowBytes: 64,
            rows: 32,
            order: 0x4949,
            flags: 0,
            curveWords: 65536,
          },
          timings: { descriptorMs: 0.25, rustDispatchMs: 0.5 },
        },
  }
  const payload = Buffer.alloc(4096)
  for (let sample = 0; sample < 2048; sample++) payload.writeUInt16LE(1000, sample * 2)
  // Four active saturated sites; two saturated right-padding sites must not count.
  for (const [row, column, value] of [
    [0, 0, 15360],
    [0, 1, 15359],
    [1, 0, 16000],
    [1, 1, 65535],
    [31, 47, 15360],
    [0, 48, 65535],
    [31, 63, 32768],
    [2, 2, 0x1234],
  ])
    payload.writeUInt16LE(value, (row * 64 + column) * 2)
  const completion = {
    contract: 'irodori-parallel-sony-arw2-rows-v1',
    complete: true,
    packedBytes: 4096,
    rowsWritten: 32,
    timings: {
      inputMapMs: 0.5,
      openMs: 1,
      unpackMs: 2,
      prepareLiveRowsMs: 0.25,
      headerWriteMs: 0.1,
      payloadWriteWithBackpressureMs: 0.3,
      recycleMs: 0.2,
      totalBeforeTrailerMs: 4.35,
    },
    process: {
      threads: 1,
      peakRssBytes: 65536,
      addressSpaceLimitBytes: 2147483648,
      librawRawAllocationLimitBytes: 268435456,
      packedLimitBytes: 134217728,
    },
  }
  return {
    header,
    payload,
    packet: Buffer.concat([
      jsonFrame('IRODRAW2', header),
      payload,
      jsonFrame('IRODEND2', completion),
    ]),
  }
}
function mainExit(code: number | null = 0): NativeRawMainMessage {
  return {
    type: 'raw-source-exit',
    nonce,
    code,
    signal: null,
    diagnostics: {
      validationMs: 0,
      sourceBytes: 2112,
      peakRamBytes: 8192,
      peakGpuBytes: 0,
      childMs: 1,
      armedMs: 0.25,
    },
  }
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve))

async function socketPair() {
  const directory = await mkdtemp(join(tmpdir(), 'irodori-raw-receiver-')),
    path = join(directory, 'stream'),
    server = createServer({ allowHalfOpen: true }),
    listening = once(server, 'listening'),
    connected = once(server, 'connection')
  server.listen(path)
  await listening
  const writer = createConnection({ path, allowHalfOpen: true }),
    opened = once(writer, 'connect'),
    [reader] = (await connected) as [Socket]
  await opened
  reader.pause()
  // Closing a rejected receiver can reset its real writer. Keep that OS event
  // observed without treating it as a second receiver failure or console error.
  const writerErrors: string[] = []
  writer.on('error', (error) =>
    writerErrors.push((error as NodeJS.ErrnoException).code ?? error.message),
  )
  return {
    reader,
    writer,
    writerErrors,
    close: async () => {
      const readersClosed = reader.closed ? Promise.resolve() : once(reader, 'close'),
        writersClosed = writer.closed ? Promise.resolve() : once(writer, 'close')
      reader.destroy()
      writer.destroy()
      await Promise.allSettled([readersClosed, writersClosed])
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
      await rm(directory, { recursive: true, force: true })
    },
  }
}
function receiver() {
  const messages: { type: string; nonce: string }[] = [],
    client = new NativeRawSourceClient((message) => messages.push(message))
  let status: 'pending' | 'fulfilled' | 'rejected' = 'pending'
  const result = client.prepare(context()).then(
    (value) => {
      status = 'fulfilled'
      return { ok: true as const, value }
    },
    (error: unknown) => {
      status = 'rejected'
      return { ok: false as const, error: String(error) }
    },
  )
  return { client, messages, result, status: () => status }
}
async function writeAndObserve(pair: Awaited<ReturnType<typeof socketPair>>, bytes: Buffer) {
  let received = 0
  const receivedAll = new Promise<void>((resolve) => {
    const data = (part: Buffer) => {
      received += part.length
      if (received >= bytes.length) {
        pair.reader.off('data', data)
        resolve()
      }
    }
    pair.reader.on('data', data)
  })
  await new Promise<void>((resolve, reject) =>
    pair.writer.write(bytes, (error) => (error ? reject(error) : resolve())),
  )
  await receivedAll
  await turn()
}

// Real main-owner actual-child-close/process-group retirement is covered separately
// in native-raw-owner-lifecycle; these tests supply that control notification only.
test('real EOF alone remains unpublished; a successful main close receipt admits one exact sensor owner and source math', async () => {
  const pair = await socketPair(),
    input = protocolFixture(),
    target = receiver()
  try {
    expect(target.messages).toEqual([{ type: 'raw-source-request', nonce }])
    target.client.accept({ type: 'raw-source-stream', nonce }, pair.reader)
    expect(target.messages[1]).toEqual({ type: 'raw-source-reader-ready', nonce })
    const ended = once(pair.reader, 'end')
    pair.writer.end(input.packet)
    await ended
    await turn()
    expect(target.status()).toBe('pending')
    target.client.accept(mainExit())
    const result = await target.result
    expect(result.ok).toBe(true)
    if (!result.ok || !result.value)
      throw new Error('The complete receiver did not publish its source.')
    const source = result.value.source
    expect(result.value).toMatchObject({
      make: 'Sony',
      model: 'ZV-1A',
      inputBytes: 2112,
      timings: { openMs: 1, unpackMs: 2 },
    })
    expect(source).toMatchObject({
      width: 48,
      height: 32,
      rawWidth: 64,
      left: 0,
      top: 0,
      flip: 5,
      cfa: [0, 1, 3, 2],
      black: [800, 800, 800, 800],
      normalization: {
        maximum: 15580,
        restoreGain: 2.26953125,
        referenceWhite: 1,
        gains: [2324, 1024, 2068, 1024],
        sourceSaturation: {
          thresholds: [15360, 15360, 15360, 15360],
          saturatedSites: 4,
          totalSites: 1536,
        },
      },
    })
    expect(source.matrix).toEqual(input.header.unpacked.matrix)
    // Independent fixed Float32 words for the captured gains and15580 sensor range.
    expect(Array.from(new Uint32Array(Float32Array.from(source.scale).buffer))).toEqual([
      0x40869a74, 0x3fed3c48, 0x406f8d5f, 0x3fed3c48,
    ])
    expect(source.pixels.byteOffset).toBe(0)
    expect(source.pixels.byteLength).toBe(4096)
    expect(source.pixels.buffer.byteLength).toBe(4096)
    expect(source.pixels.buffer).not.toBe(input.payload.buffer)
    expect(Buffer.from(source.pixels.buffer)).toEqual(input.payload)
    input.packet.fill(0)
    expect(source.pixels[2 * 64 + 2]).toBe(0x1234)
    expect(source.pixels[65]).toBe(65535)
  } finally {
    target.client.close()
    await pair.close()
  }
})

test('a successful main exit receipt without real EOF stays pending until the socket actually ends', async () => {
  const pair = await socketPair(),
    target = receiver()
  try {
    target.client.accept({ type: 'raw-source-stream', nonce }, pair.reader)
    await writeAndObserve(pair, protocolFixture().packet)
    target.client.accept(mainExit())
    await turn()
    expect(target.status()).toBe('pending')
    pair.writer.end()
    expect((await target.result).ok).toBe(true)
  } finally {
    target.client.close()
    await pair.close()
  }
})

for (const defect of ['negative-exit', 'truncated', 'excess'] as const)
  test(`a ${defect} real stream cannot publish a native source`, async () => {
    const pair = await socketPair(),
      target = receiver(),
      input = protocolFixture()
    try {
      target.client.accept({ type: 'raw-source-stream', nonce }, pair.reader)
      if (defect === 'negative-exit') {
        await writeAndObserve(pair, input.packet)
        target.client.accept(mainExit(7))
      } else {
        const bytes =
          defect === 'truncated'
            ? input.packet.subarray(0, -1)
            : Buffer.concat([input.packet, Buffer.from([0xff])])
        pair.writer.end(bytes)
        target.client.accept(mainExit())
      }
      const result = await target.result
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('A failed stream produced a source.')
      expect(result.error).toMatch(
        defect === 'negative-exit'
          ? /did not close successfully/
          : defect === 'truncated'
            ? /Truncated native RAW pipe/
            : /Excess native RAW stdout/,
      )
      expect(pair.reader.destroyed).toBe(true)
    } finally {
      target.client.close()
      await pair.close()
    }
  })

test('stale control identity destroys both its incoming socket and the active receiver', async () => {
  const active = await socketPair(),
    stale = await socketPair(),
    target = receiver()
  try {
    target.client.accept({ type: 'raw-source-stream', nonce }, active.reader)
    expect(() =>
      target.client.accept({ type: 'raw-source-stream', nonce: '2'.repeat(32) }, stale.reader),
    ).toThrow(/Unexpected native RAW control identity/)
    expect(await target.result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/control identity/),
    })
    expect(active.reader.destroyed).toBe(true)
    expect(stale.reader.destroyed).toBe(true)
  } finally {
    target.client.close()
    await Promise.all([active.close(), stale.close()])
  }
})

test('a duplicate stream handle fails closed instead of replacing its first receiver', async () => {
  const first = await socketPair(),
    duplicate = await socketPair(),
    target = receiver()
  try {
    target.client.accept({ type: 'raw-source-stream', nonce }, first.reader)
    target.client.accept({ type: 'raw-source-stream', nonce }, duplicate.reader)
    expect(await target.result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/duplicate native RAW stream/),
    })
    expect(first.reader.destroyed).toBe(true)
    expect(duplicate.reader.destroyed).toBe(true)
  } finally {
    target.client.close()
    await Promise.all([first.close(), duplicate.close()])
  }
})

test('duplicate close receipts reject a complete payload which has not reached EOF', async () => {
  const pair = await socketPair(),
    target = receiver()
  try {
    target.client.accept({ type: 'raw-source-stream', nonce }, pair.reader)
    await writeAndObserve(pair, protocolFixture().packet)
    target.client.accept(mainExit())
    target.client.accept(mainExit())
    expect(await target.result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/Duplicate native RAW completion/),
    })
    expect(pair.reader.destroyed).toBe(true)
  } finally {
    target.client.close()
    await pair.close()
  }
})

test('a wrong-library unsupported fallback is a protocol failure rather than permission for WASM fallback', async () => {
  const pair = await socketPair(),
    target = receiver()
  try {
    target.client.accept({ type: 'raw-source-stream', nonce }, pair.reader)
    pair.writer.end(protocolFixture(true, true).packet)
    target.client.accept(mainExit())
    expect(await target.result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/does not match the admitted decoder contract/),
    })
  } finally {
    target.client.close()
    await pair.close()
  }
})

test('a trusted unsupported-layout fallback returns null only after real EOF and main close notification', async () => {
  const pair = await socketPair(),
    target = receiver()
  try {
    target.client.accept({ type: 'raw-source-stream', nonce }, pair.reader)
    const ended = once(pair.reader, 'end')
    pair.writer.end(protocolFixture(true).packet)
    await ended
    await turn()
    expect(target.status()).toBe('pending')
    target.client.accept(mainExit())
    expect(await target.result).toEqual({ ok: true, value: null })
  } finally {
    target.client.close()
    await pair.close()
  }
})

test('explicit unavailable decline permits fallback while a resource-budget decline rejects', async () => {
  for (const reason of ['unavailable', 'memory-limit'] as const) {
    const target = receiver()
    try {
      target.client.accept({
        type: 'raw-source-declined',
        nonce,
        reason,
        message: `fixture ${reason}`,
      })
      const result = await target.result
      if (reason === 'unavailable') expect(result).toEqual({ ok: true, value: null })
      else expect(result).toEqual({ ok: false, error: 'Error: fixture memory-limit' })
      expect(target.messages).toEqual([{ type: 'raw-source-request', nonce }])
    } finally {
      target.client.close()
    }
  }
})

test('closing the client rejects its pending source and closes the real socket receiver', async () => {
  const pair = await socketPair(),
    target = receiver()
  try {
    target.client.accept({ type: 'raw-source-stream', nonce }, pair.reader)
    await writeAndObserve(pair, protocolFixture().packet.subarray(0, 24))
    const closed = once(pair.reader, 'close')
    target.client.close()
    expect(await target.result).toEqual({ ok: false, error: 'Error: Native RAW receiver closed.' })
    await closed
    expect(pair.reader.destroyed).toBe(true)
    expect(target.status()).toBe('rejected')
  } finally {
    target.client.close()
    await pair.close()
  }
})
