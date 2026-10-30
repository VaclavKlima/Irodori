import { expect, test } from '@playwright/test'
import { NativeRawPipeReader, type NativeRawPipeHeader } from '../src/main/native-raw-pipe'

// Exact bounded header captured from the retained native rust8 DSC03243 control.
// Original SHA: 93880fc72a77553efd7a4f9b1f6d2462d0175cee94ae37f330903f70f78581ee.
// Sensor payload is not copied here; framing tests below use explicit synthetic bytes.
const realSonyHeader: NativeRawPipeHeader = {
  contract: 'irodori-parallel-sony-arw2-rows-v1',
  protocol: 'u16le-live-rows-v2',
  rowKernel: {
    status: 'rust-complete',
    requestedThreads: 8,
    participants: 8,
    observedThreads: 8,
    rows: 3672,
    blocks: 1263168,
    samples: 20210688,
    errorCode: 0,
    descriptor: {
      dataOffset: 1081344,
      mappedBytes: 21292032,
      compressedBytes: 20210688,
      rowBytes: 5504,
      rows: 3672,
      order: 18761,
      flags: 0,
      curveWords: 65536,
    },
    timings: {
      descriptorMs: 6e-5,
      rustDispatchMs: 9.174877,
    },
  },
  opened: {
    libraryVersion: '0.22.1-Release',
    make: 'Sony',
    model: 'ZV-1A',
    unpackFunction: 'sony_arw2_load_raw()',
    width: 5496,
    height: 3672,
    rawWidth: 5504,
    rawHeight: 3672,
    rawPitch: 0,
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
  },
  unpacked: {
    libraryVersion: '0.22.1-Release',
    make: 'Sony',
    model: 'ZV-1A',
    unpackFunction: 'sony_arw2_load_raw()',
    width: 5496,
    height: 3672,
    rawWidth: 5504,
    rawHeight: 3672,
    rawPitch: 11008,
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
  },
  packedBytes: 40421376,
  sourceLayout: {
    rowSamples: 5504,
    rowCount: 3672,
    strideSamples: 5504,
  },
}

function frame(magic: string, value: unknown) {
  const json = Buffer.from(JSON.stringify(value), 'utf8')
  const prefix = Buffer.alloc(12)
  prefix.write(magic, 0, 8, 'ascii')
  prefix.writeUInt32LE(json.length, 8)
  return Buffer.concat([prefix, json])
}

function fixture() {
  // Deliberate tiny transport fixture, not a photograph or decoder-math oracle.
  const header = structuredClone(realSonyHeader)
  for (const snapshot of [header.opened, header.unpacked])
    Object.assign(snapshot, {
      width: 30,
      height: 3,
      rawWidth: 32,
      rawHeight: 3,
      rawPitch: 0,
      left: 0,
      top: 0,
    })
  header.packedBytes = 192
  header.sourceLayout = { rowSamples: 32, rowCount: 3, strideSamples: 32 }
  header.rowKernel = {
    status: 'rust-complete',
    requestedThreads: 8,
    participants: 3,
    observedThreads: 3,
    rows: 3,
    blocks: 6,
    samples: 96,
    errorCode: 0,
    descriptor: {
      dataOffset: 16,
      mappedBytes: 112,
      compressedBytes: 96,
      rowBytes: 32,
      rows: 3,
      order: 0x4949,
      flags: 0,
      curveWords: 65536,
    },
    timings: { descriptorMs: 0.25, rustDispatchMs: 0.5 },
  }
  const payload = Buffer.alloc(192)
  const words = [0, 1, 255, 256, 32767, 32768, 65535, 0x1234]
  for (let at = 0; at < 96; at++) payload.writeUInt16LE(words[at % words.length], at * 2)
  const completion = {
    contract: 'irodori-parallel-sony-arw2-rows-v1',
    complete: true,
    packedBytes: 192,
    rowsWritten: 3,
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
  const headerBytes = frame('IRODRAW2', header),
    trailerBytes = frame('IRODEND2', completion)
  return {
    header,
    payload,
    completion,
    headerBytes,
    trailerBytes,
    packet: Buffer.concat([headerBytes, payload, trailerBytes]),
  }
}

function parse(packet: Buffer, widths: number[]) {
  const reader = new NativeRawPipeReader(performance.now())
  let offset = 0,
    index = 0
  while (offset < packet.length) {
    const count = widths[index++ % widths.length]
    reader.push(packet.subarray(offset, offset + count))
    offset += count
  }
  return reader
}

test('a retained real Sony metadata/header oracle is accepted while missing sensor bytes remain unpublished', () => {
  const reader = new NativeRawPipeReader(performance.now())
  reader.push(frame('IRODRAW2', realSonyHeader))
  expect(reader.diagnostics()).toMatchObject({ stage: 'payload', declaredPackedBytes: 40421376 })
  expect(() => reader.finish()).toThrow(/Truncated native RAW pipe/)
})

test('whole, bytewise and awkward fragments preserve exact payload and independent completion identity', () => {
  for (const widths of [[10000], [1], [7, 2, 13, 3, 64, 5]]) {
    const input = fixture(),
      reader = parse(input.packet, widths),
      result = reader.finish()
    expect(result.header).toEqual(input.header)
    expect(result.completion).toEqual(input.completion)
    expect(result.packed).toEqual(input.payload)
    expect(result.packed.readUInt16LE(12)).toBe(65535)
    // The receiver owns a copy; transferred source chunks may be reused after push.
    input.packet.fill(0)
    expect(result.packed).toEqual(input.payload)
  }
})

for (const boundary of [
  'prefix',
  'header',
  'payload-start',
  'payload-end',
  'trailer-prefix',
  'trailer-body',
] as const)
  test(`a stream truncated in its ${boundary} cannot produce a completed source`, () => {
    const input = fixture()
    const end = {
      prefix: 11,
      header: input.headerBytes.length - 1,
      'payload-start': input.headerBytes.length + 1,
      'payload-end': input.headerBytes.length + input.payload.length - 1,
      'trailer-prefix': input.headerBytes.length + input.payload.length + 11,
      'trailer-body': input.packet.length - 1,
    }[boundary]
    const reader = parse(input.packet.subarray(0, end), [3, 11, 19])
    expect(() => reader.finish()).toThrow(/Truncated native RAW pipe/)
  })

test('extra bytes and a concatenated second source are rejected rather than treated as part of the first source', () => {
  const input = fixture()
  for (const extra of [Buffer.from([0x00]), input.packet]) {
    const reader = parse(input.packet, [5, 31])
    expect(() => reader.push(extra)).toThrow(/Excess native RAW stdout/)
  }
})

test('bad magic, oversized header declarations and invalid UTF8 reject before a sensor buffer can be published', () => {
  const input = fixture(),
    badMagic = Buffer.from(input.headerBytes),
    oversized = Buffer.alloc(12),
    invalidUtf8 = Buffer.from(input.headerBytes)
  badMagic[0] ^= 1
  oversized.write('IRODRAW2', 0, 8, 'ascii')
  oversized.writeUInt32LE(65537, 8)
  invalidUtf8[12] = 0xff
  for (const bytes of [badMagic, oversized, invalidUtf8]) {
    const reader = new NativeRawPipeReader(performance.now())
    expect(() => reader.push(bytes)).toThrow()
    expect(() => reader.finish()).toThrow()
  }
})

for (const defect of [
  'active-crop',
  'row-stride',
  'packed-count',
  'layout',
  'row-proof',
  'mapped-range',
  'thread-count',
] as const)
  test(`contradictory ${defect} header evidence rejects before payload admission`, () => {
    const input = fixture(),
      header = input.header
    switch (defect) {
      case 'active-crop':
        header.unpacked.left = 3
        break
      case 'row-stride':
        header.unpacked.rawPitch = 62
        break
      case 'packed-count':
        header.packedBytes = 134217729
        break
      case 'layout':
        header.sourceLayout.rowCount = 4
        break
      case 'row-proof':
        header.rowKernel.rows = 2
        break
      case 'mapped-range':
        header.rowKernel.descriptor!.mappedBytes = 111
        break
      case 'thread-count':
        header.rowKernel.observedThreads = 9
        break
    }
    const reader = new NativeRawPipeReader(performance.now())
    expect(() => reader.push(frame('IRODRAW2', header))).toThrow()
    expect(() => reader.finish()).toThrow()
  })

for (const defect of [
  'identity',
  'rows',
  'bytes',
  'still-running-rows',
  'address-space',
  'storage-limit',
  'timing',
] as const)
  test(`a ${defect} completion cannot certify an otherwise complete payload`, () => {
    const input = fixture(),
      completion = input.completion
    switch (defect) {
      case 'identity':
        completion.contract = 'other-source'
        break
      case 'rows':
        completion.rowsWritten = 2
        break
      case 'bytes':
        completion.packedBytes = 190
        break
      case 'still-running-rows':
        completion.process.threads = 2
        break
      case 'address-space':
        completion.process.addressSpaceLimitBytes++
        break
      case 'storage-limit':
        completion.process.librawRawAllocationLimitBytes++
        break
      case 'timing':
        completion.timings.unpackMs = -1
        break
    }
    const reader = new NativeRawPipeReader(performance.now())
    reader.push(input.headerBytes)
    reader.push(input.payload)
    expect(() => reader.push(frame('IRODEND2', completion))).toThrow()
    expect(() => reader.finish()).toThrow()
  })
