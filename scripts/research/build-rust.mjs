import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const cargo = process.env.LUMA_RESEARCH_CARGO || 'cargo'
const root = resolve(import.meta.dirname, '../..'),
  output = join(root, 'artifacts/research-rust')
mkdirSync(output, { recursive: true })
const args = [
  'build',
  '--locked',
  '--release',
  '--manifest-path',
  join(root, 'scripts/research/rust/Cargo.toml'),
  '--target-dir',
  output,
]
execFileSync(cargo, args, { cwd: root, stdio: 'inherit' })
const binary = join(
  output,
  'release',
  `luma-pipeline-research${process.platform === 'win32' ? '.exe' : ''}`,
)
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const rustc = cargo.includes('/') ? join(dirname(cargo), 'rustc') : 'rustc'
const manifest = {
  compiler: execFileSync(rustc, ['--version', '--verbose'], { encoding: 'utf8' }),
  command: [cargo, ...args],
  platform: process.platform,
  arch: process.arch,
  profile: 'release; one codegen unit; thin LTO; no fast-math',
  binaryHash: hash(binary),
  sources: Object.fromEntries(
    ['Cargo.toml', 'Cargo.lock', 'src/main.rs'].map((name) => [
      name,
      hash(join(root, 'scripts/research/rust', name)),
    ]),
  ),
}
writeFileSync(`${binary}.json`, JSON.stringify(manifest, null, 2))
console.log(`Research Rust service: ${binary}`)
