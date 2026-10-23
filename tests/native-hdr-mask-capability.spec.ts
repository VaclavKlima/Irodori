import { expect, test } from '@playwright/test'
import { access, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nativeCpuMaskCapability } from '../src/main/native-cpu-executable'
import { observed, processExists, sha, valueOf } from './native-cpu-controller.helpers'

test.skip(
  process.platform !== 'linux' || process.arch !== 'x64',
  'Bundled native mask capabilities currently support Linux x64 only.',
)
test.setTimeout(20000)
const reference = {
  electron: '44.3.0',
  v8: '15.2.124.19-electron.0',
  chromium: '152.0.7977.78',
  llvmLibcRevision: '3ea89f4304312567e31a8eb45e0737577e65b676',
}
const sourceNames = [
  'provenance/electron-DEPS',
  'provenance/chromium-DEPS',
  'provenance/chromium-llvm-BUILD.gn',
  'provenance/chromium-llvm-README.chromium',
  'provenance/v8-ieee754.cc',
  'llvm-libc/LICENSE.TXT',
  'llvm-libc/shared/math/atan2.h',
  'llvm-libc/shared/libc_common.h',
  'llvm-libc/src/__support/math/atan2.h',
  'llvm-libc/src/__support/math/atan_utils.h',
  'llvm-libc/src/__support/FPUtil/double_double.h',
  'llvm-libc/src/__support/FPUtil/FPBits.h',
  'llvm-libc/src/__support/FPUtil/multiply_add.h',
  'llvm-libc/src/__support/FPUtil/nearest_integer.h',
]
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('Unrepresentable capability fixture value.')
  return encoded
}
function syntheticCapability() {
  // These deliberate hashes describe this CONTRACT fixture, not compiled math.
  // Actual Electron/full-photo parity and the real bundled helper are other gates.
  const arithmetic = {
    version: 'native-hdr-mask-arithmetic-v2-electron-llvm',
    reference: { ...reference },
    substitution: {
      count: 1,
      before: 'double h_rad = atan2(Aab[2], Aab[1]);',
      after: 'double h_rad = luma_electron_atan2::atan2(Aab[2], Aab[1]);',
    },
    isolation: 'namespace and C symbol renames only',
    maskCompilerFlags: ['-mno-fma', '-mno-avx', '-mno-sse4.2'],
    upstreamSourcePins: Object.fromEntries(
      sourceNames.map((name) => [name, sha(`contract-fixture:${name}`)]),
    ),
    ...Object.fromEntries(
      [
        'ordinaryGeneratedSha256',
        'candidateGeneratedSha256',
        'maskGeneratedSha256',
        'normalBridgeSha256',
        'maskContextSha256',
        'llvmShimSha256',
        'upstreamManifestSha256',
        'maskBridgeSha256',
        'maskHostSha256',
        'prepareSourceSha256',
      ].map((name) => [name, sha(`contract-fixture:${name}`)]),
    ),
  }
  return {
    version: 'native-cpu-capabilities-v1',
    presentation: 'LUMACPU1',
    mask: {
      request: 'MASKCPU1',
      output: 'MASKOUT1',
      terminal: 'MASKDONE',
      mode: '--mask-v1',
      arithmeticSha256: sha(canonical(arithmetic)),
      arithmetic,
    },
  }
}
type Capability = ReturnType<typeof syntheticCapability>
function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`
}

/** Same trusted runtime/SHA256SUMS fixture contract as native-cpu-executable.
 * It executes a clearly synthetic real child and never touches a user library. */
async function withCapability(
  capability: Capability,
  mode: 'ordinary' | 'held-after-eof' | 'oversized-ignore-term',
  work: (control: {
    completion: ReturnType<typeof observed<{ arithmeticSha256: string }>>
    event(name: string): Promise<{ event: string; pid: number }>
    allowExit(): Promise<void>
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'luma-mask-capability-')),
    directory = join(root, 'native-cpu-render/linux-x64'),
    config = join(root, 'fixture.json'),
    script = fileURLToPath(new URL('./native-hdr-mask-capability-child.mjs', import.meta.url))
  await mkdir(directory, { recursive: true })
  const wrapper = `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(script)} ${shellQuote(config)} "$@"\n`,
    encoded = JSON.stringify(capability),
    payload = mode === 'oversized-ignore-term' ? `${encoded}${' '.repeat(65537)}` : encoded
  await writeFile(join(directory, 'luma-cpu-render'), wrapper, { mode: 0o700, flag: 'wx' })
  await writeFile(join(directory, 'SHA256SUMS'), `${sha(wrapper)}  luma-cpu-render\n`, {
    mode: 0o600,
    flag: 'wx',
  })
  await writeFile(
    config,
    JSON.stringify({ directory: root, mode, payload: Buffer.from(payload).toString('base64') }),
    { mode: 0o600, flag: 'wx' },
  )
  const completion = observed(nativeCpuMaskCapability(root)),
    events = async () => {
      try {
        return (await readFile(join(root, 'events.jsonl'), 'utf8'))
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { event: string; pid: number })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      }
    }
  const allowExit = () => writeFile(join(root, 'allow-exit'), '')
  try {
    await work({
      completion,
      allowExit,
      event: async (name) => {
        await expect
          .poll(async () => (await events()).some((event) => event.event === name), {
            timeout: 5000,
            intervals: [1, 5, 10, 25],
          })
          .toBe(true)
        return (await events()).find((event) => event.event === name)!
      },
    })
  } finally {
    await allowExit()
    // The production discovery owner settles only after actual child close,
    // including output-bound escalation. Never remove evidence before that join.
    await completion
    for (const event of await events()) expect(processExists(event.pid)).toBe(false)
    await rm(root, { recursive: true, force: true })
    await expect(access(root)).rejects.toThrow()
  }
}

test('an E receipt and real pipe EOF cannot escape capability discovery before successful actual child close', async () => {
  const capability = syntheticCapability()
  await withCapability(capability, 'held-after-eof', async (control) => {
    let settled = false
    void control.completion.then(() => {
      settled = true
    })
    const child = await control.event('eof-complete')
    expect(processExists(child.pid)).toBe(true)
    // The child explicitly closed these OS descriptors. The process remains
    // alive behind a file gate, independently of both complete parent pipes.
    for (const fd of [1, 2])
      await expect
        .poll(async () => {
          try {
            await readlink(`/proc/${child.pid}/fd/${fd}`)
            return false
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
            throw error
          }
        })
        .toBe(true)
    expect(settled).toBe(false)
    await control.allowExit()
    expect(await valueOf(control.completion)).toEqual({
      arithmeticSha256: capability.mask.arithmeticSha256,
    })
    expect(processExists(child.pid)).toBe(false)
  })
})

test('correctly hashed retired or mismatched arithmetic receipts cannot authorize native mask computation', async () => {
  const changes: Array<[string, (value: Capability) => void]> = [
    [
      'retired Node D',
      (value) => {
        const arithmetic = value.mask.arithmetic as unknown as Record<string, unknown>
        arithmetic.version = 'native-hdr-mask-arithmetic-v1'
        delete arithmetic.reference
        arithmetic.nodeReference = '24.20.0'
        arithmetic.v8Reference = '13.6.233.17-node.53'
        value.mask.arithmetic.substitution.after =
          'double h_rad = luma_v8_atan2::atan2(Aab[2], Aab[1]);'
      },
    ],
    ...(['electron', 'v8', 'chromium', 'llvmLibcRevision'] as const).map(
      (key) =>
        [
          `wrong ${key}`,
          (value: Capability) => {
            value.mask.arithmetic.reference[key] += '-different'
          },
        ] as [string, (value: Capability) => void],
    ),
    [
      'unverified FMA branch',
      (value) => {
        value.mask.arithmetic.maskCompilerFlags = ['-mfma', '-mno-avx', '-mno-sse4.2']
      },
    ],
    [
      'missing upstream source',
      (value) => {
        delete value.mask.arithmetic.upstreamSourcePins['llvm-libc/src/__support/math/atan2.h']
      },
    ],
    [
      'upstream traversal path',
      (value) => {
        value.mask.arithmetic.upstreamSourcePins['../outside.h'] = 'f'.repeat(64)
      },
    ],
  ]
  for (const [name, change] of changes)
    await test.step(name, async () => {
      const capability = syntheticCapability()
      change(capability)
      // Re-sign the deliberately invalid semantic record. Failure must concern
      // its identity/provenance, rather than accidentally exercising only SHA.
      capability.mask.arithmeticSha256 = sha(canonical(capability.mask.arithmetic))
      await withCapability(capability, 'ordinary', async ({ completion }) => {
        const result = await completion
        expect(result.ok).toBe(false)
        if (!result.ok)
          expect(String(result.error)).toMatch(/supported.*mask arithmetic|provenance|source hash/i)
      })
    })
})

test('a valid E identity with a forged canonical receipt hash fails after actual successful child close', async () => {
  const capability = syntheticCapability()
  capability.mask.arithmeticSha256 = `${capability.mask.arithmeticSha256[0] === '0' ? '1' : '0'}${capability.mask.arithmeticSha256.slice(1)}`
  await withCapability(capability, 'ordinary', async ({ completion, event }) => {
    const result = await completion,
      child = await event('exiting')
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(String(result.error)).toMatch(/receipt does not match its capability hash/i)
    expect(processExists(child.pid)).toBe(false)
  })
})

test('capability output overflow retains a TERM-ignoring child until real KILL and pipe close', async () => {
  await withCapability(
    syntheticCapability(),
    'oversized-ignore-term',
    async ({ completion, event }) => {
      let settled = false
      void completion.then(() => {
        settled = true
      })
      const child = await event('sigterm')
      expect(processExists(child.pid)).toBe(true)
      expect(settled).toBe(false)
      const result = await completion
      expect(result.ok).toBe(false)
      if (!result.ok) expect(String(result.error)).toMatch(/capabilities exceed the output bound/i)
      expect(processExists(child.pid)).toBe(false)
    },
  )
})
