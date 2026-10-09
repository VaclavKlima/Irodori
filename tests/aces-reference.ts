import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import type { RGB } from '../src/shared/hdr'
/** Independent Float64 adapter of the unmodified CTL; never imports application math. */
export function buildAcesReference(directory: string): string {
  const cpp = join(directory, 'aces-reference.cpp')
  const binary = join(directory, 'aces-reference')
  for (const [command, args] of [
    ['python3', ['scripts/aces-reference.py', cpp]],
    [
      process.env.CXX ?? 'clang++',
      ['-std=c++17', '-Wno-c++11-narrowing', '-O2', cpp, '-o', binary],
    ],
  ] as const) {
    const result = spawnSync(command, args, { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`${command}: ${result.stderr || result.error}`)
  }
  return binary
}
export function referenceAces(
  binary: string,
  input: readonly number[][],
  peak: number,
  space: 'srgb' | 'display-p3' | 'rec2020',
): RGB[] {
  const result = spawnSync(binary, [], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 ** 2,
    input:
      input
        .map(
          (v) =>
            `${100 * peak} ${space === 'rec2020' ? 2 : Number(space === 'display-p3')} ${v.join(' ')}`,
        )
        .join('\n') + '\n',
  })
  if (result.status !== 0) throw new Error(`ACES reference: ${result.stderr || result.error}`)
  const output = result.stdout
    .trim()
    .split('\n')
    .map((line) => line.split(' ').map(Number) as RGB)
  if (output.length !== input.length || output.some((v) => v.some((x) => !Number.isFinite(x))))
    throw new Error('Invalid reference output.')
  return output.map((v) => v.map((x) => Math.max(0, Math.min(peak, x))) as RGB)
}
