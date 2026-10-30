import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdtemp, open, readFile, rm, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeNativeCpuMask } from '../src/main/native-cpu-mask-sink'
import { nativeHdrMaskMemory } from '../src/shared/native-hdr-mask-memory'
import { resourcePolicy, deferred, observed, valueOf } from './native-cpu-controller.helpers'

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const turn = () => new Promise<void>((resolve) => setImmediate(resolve))
function protocol() {
  const width = 3,
    height = 129,
    request = Buffer.alloc(848),
    header = Buffer.alloc(864),
    body = Buffer.from(Array.from({ length: width * height }, (_, index) => index % 16)),
    parts: Buffer[] = []
  request.write('MASKCPU3')
  request.writeUInt32LE(3, 8)
  request.writeUInt32LE(width, 16)
  request.writeUInt32LE(height, 20)
  header.write('MASKOUT1')
  header.writeUInt32LE(848, 8)
  request.copy(header, 12)
  header.writeUInt32LE(4, 860)
  parts.push(header)
  for (let row = 0; row < height; row += 64) {
    const rows = Math.min(64, height - row),
      record = Buffer.alloc(16)
    record.write('STRP')
    record.writeUInt32LE(row, 4)
    record.writeUInt32LE(rows, 8)
    record.writeUInt32LE(width * rows, 12)
    parts.push(record, body.subarray(row * width, (row + rows) * width))
  }
  const terminal = Buffer.alloc(72)
  terminal.write('MASKDONE')
  terminal.writeBigUInt64LE(BigInt(body.length), 8)
  terminal.writeUInt32LE(3, 16)
  terminal.writeDoubleLE(1.25, 24)
  terminal.writeDoubleLE(2.5, 32)
  terminal.writeDoubleLE(3.75, 40)
  terminal.writeDoubleLE(4, 48)
  terminal.writeBigUInt64LE(8192n, 56)
  terminal.writeBigUInt64LE(1572864n, 64)
  parts.push(terminal)
  return { request, parts, body, width, height }
}
async function scratch(work: (file: FileHandle, path: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'irodori-native-mask-pure-')),
    path = join(directory, 'mask.r8'),
    file = await open(path, 'wx+', 0o600)
  try {
    await work(file, path)
  } finally {
    await file.close()
    await rm(directory, { recursive: true, force: true })
  }
}
async function* fragments(bytes: Buffer) {
  const sizes = [1, 7, 31, 2, 127, 11]
  for (let offset = 0, index = 0; offset < bytes.length; index++) {
    const end = Math.min(bytes.length, offset + sizes[index % sizes.length])
    yield bytes.subarray(offset, end)
    offset = end
  }
}
test('fragmented full mask output is unpublished until successful child close, then matches every scratch byte and digest', async () => {
  await scratch(async (file, path) => {
    const p = protocol(),
      closed = deferred()
    let eofObserved = false
    const stdout = (async function* () {
        yield* fragments(Buffer.concat(p.parts))
        eofObserved = true
      })(),
      completion = observed(
        writeNativeCpuMask({
          stdout,
          expectedRequest: p.request,
          threads: 4,
          closedSuccessfully: closed.promise,
          file,
          signal: new AbortController().signal,
        }),
      )
    let settled = false
    void completion.then(() => {
      settled = true
    })
    await expect.poll(() => eofObserved).toBe(true)
    expect((await file.stat()).size).toBe(p.body.length)
    await turn()
    expect(settled).toBe(false)
    closed.resolve()
    const result = await valueOf(completion)
    expect(result).toMatchObject({
      width: 3,
      height: 129,
      strips: 3,
      byteLength: 387,
      sha256: sha(p.body),
    })
    expect(await readFile(path)).toEqual(p.body)
    expect(result.metrics).toEqual({
      preparationMs: 1.25,
      readMs: 2.5,
      computeMs: 3.75,
      writeMs: 4,
      peakOwnedBytes: 8192,
      stackBytes: 1572864,
    })
  })
})

test('complete EOF followed by unsuccessful child close cannot produce a mask result', async () => {
  await scratch(async (file) => {
    const p = protocol(),
      closed = deferred(),
      completion = observed(
        writeNativeCpuMask({
          stdout: fragments(Buffer.concat(p.parts)),
          expectedRequest: p.request,
          threads: 4,
          closedSuccessfully: closed.promise,
          file,
          signal: new AbortController().signal,
        }),
      )
    await expect.poll(async () => (await file.stat()).size).toBe(p.body.length)
    closed.reject(new Error('actual close fixture failed'))
    const result = await completion
    expect(result.ok).toBe(false)
    if (!result.ok) expect(String(result.error)).toContain('actual close fixture failed')
  })
})

const corruptions: Array<[string, (parts: Buffer[]) => void]> = [
  [
    'response echo',
    (p) => {
      p[0][84] ^= 1
    },
  ],
  [
    'thread receipt',
    (p) => {
      p[0].writeUInt32LE(8, 860)
    },
  ],
  [
    'strip row',
    (p) => {
      p[1].writeUInt32LE(1, 4)
    },
  ],
  [
    'strip height',
    (p) => {
      p[1].writeUInt32LE(63, 8)
    },
  ],
  [
    'strip byte length',
    (p) => {
      p[1].writeUInt32LE(191, 12)
    },
  ],
  [
    'unsupported bit',
    (p) => {
      p[2][0] = 16
    },
  ],
  [
    'terminal byte count',
    (p) => {
      p.at(-1)!.writeBigUInt64LE(386n, 8)
    },
  ],
  [
    'terminal strip count',
    (p) => {
      p.at(-1)!.writeUInt32LE(2, 16)
    },
  ],
  [
    'terminal reserved field',
    (p) => {
      p.at(-1)!.writeUInt32LE(1, 20)
    },
  ],
  [
    'nonfinite timing',
    (p) => {
      p.at(-1)!.writeDoubleLE(NaN, 40)
    },
  ],
  [
    'negative timing',
    (p) => {
      p.at(-1)!.writeDoubleLE(-1, 32)
    },
  ],
  [
    'unsafe memory receipt',
    (p) => {
      p.at(-1)!.writeBigUInt64LE(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 56)
    },
  ],
  [
    'excess worker stack',
    (p) => {
      p.at(-1)!.writeBigUInt64LE(1572865n, 64)
    },
  ],
  [
    'truncated terminal',
    (p) => {
      p[p.length - 1] = p.at(-1)!.subarray(0, 71)
    },
  ],
  [
    'trailing output',
    (p) => {
      p.push(Buffer.from([0]))
    },
  ],
]
for (const [name, corrupt] of corruptions)
  test(`mask framing rejects ${name} without returning a descriptor`, async () => {
    await scratch(async (file) => {
      const p = protocol()
      corrupt(p.parts)
      await expect(
        writeNativeCpuMask({
          stdout: fragments(Buffer.concat(p.parts)),
          expectedRequest: p.request,
          threads: 4,
          closedSuccessfully: Promise.resolve(),
          file,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow()
    })
  })

test('managed reservations preserve every declared existing owner, enforce exact boundaries and credit only drained JS strips', () => {
  const policy = resourcePolicy(),
    existing = { ramBytes: 1234567, vramBytes: 7654321 },
    plan = nativeHdrMaskMemory(7, 129, existing, policy),
    credited = nativeHdrMaskMemory(7, 129, existing, policy, true)
  expect(plan.peak.ramBytes - plan.additional.ramBytes).toBe(existing.ramBytes)
  expect(plan.peak.vramBytes).toBe(existing.vramBytes)
  expect(plan.additional.vramBytes).toBe(0)
  expect(credited.creditedJsSourceStripBytes).toBe(7 * 64 * 16 * 2)
  expect(plan.additional.ramBytes - credited.additional.ramBytes).toBe(
    credited.creditedJsSourceStripBytes,
  )
  const boundary = {
    ...policy,
    ram: { ...policy.ram, effectiveBytes: plan.peak.ramBytes },
    vram: { ...policy.vram, effectiveBytes: existing.vramBytes },
  }
  expect(nativeHdrMaskMemory(7, 129, existing, boundary).accepted).toBe(true)
  expect(
    nativeHdrMaskMemory(7, 129, existing, {
      ...boundary,
      ram: { ...boundary.ram, effectiveBytes: plan.peak.ramBytes - 1 },
    }).accepted,
  ).toBe(false)
  expect(
    nativeHdrMaskMemory(7, 129, existing, {
      ...boundary,
      vram: { ...boundary.vram, effectiveBytes: existing.vramBytes - 1 },
    }).accepted,
  ).toBe(false)
  for (const [width, height] of [
    [0, 1],
    [1, 0],
    [1.5, 1],
    [32769, 1],
    [8192, 8192],
    [NaN, 1],
  ])
    expect(() => nativeHdrMaskMemory(width, height, existing, policy)).toThrow()
  for (const ramBytes of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    expect(() => nativeHdrMaskMemory(7, 129, { ramBytes, vramBytes: 0 }, policy)).toThrow()
})
