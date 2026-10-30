import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const cargo = process.env.IRODORI_RESEARCH_CARGO || 'cargo'
const root = resolve(import.meta.dirname, '../..')
const output = join(root, 'artifacts/research-wgpu')
mkdirSync(output, { recursive: true })
const args = [
  'build',
  '--locked',
  '--release',
  '--manifest-path',
  join(root, 'scripts/research/wgpu/Cargo.toml'),
  '--target-dir',
  output,
]
execFileSync(cargo, args, { cwd: root, stdio: 'inherit' })
const binary = join(
  output,
  'release',
  `irodori-wgpu-research${process.platform === 'win32' ? '.exe' : ''}`,
)
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const rustc = cargo.includes('/') ? join(dirname(cargo), 'rustc') : 'rustc'
writeFileSync(
  `${binary}.json`,
  JSON.stringify(
    {
      compiler: execFileSync(rustc, ['--version', '--verbose'], { encoding: 'utf8' }),
      command: [cargo, ...args],
      platform: process.platform,
      arch: process.arch,
      profile: 'release; one codegen unit; thin LTO; safe WGSL validation; no fast-math',
      binaryHash: hash(binary),
      sources: Object.fromEntries(
        ['Cargo.toml', 'Cargo.lock', 'src/main.rs'].map((name) => [
          name,
          hash(join(root, 'scripts/research/wgpu', name)),
        ]),
      ),
    },
    null,
    2,
  ),
)
console.log(`Research wgpu component: ${binary}`)
