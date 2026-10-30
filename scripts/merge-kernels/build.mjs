import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'

const root = resolve(import.meta.dirname, '../..'),
  source = 'src/main/merge/kernels/prepare.c',
  directory = join(root, 'vendor/merge-kernels'),
  compiler = process.env.IRODORI_EMCC || 'emcc',
  compilerVersion = execFileSync(compiler, ['--version'], { encoding: 'utf8' }).split('\n')[0]
if (!/^emcc .* 4\.0\.20\b/.test(compilerVersion))
  throw new Error(`Emscripten 4.0.20 is required; found ${compilerVersion}.`)

const flags = [
  '-O3',
  '-std=c11',
  '-msimd128',
  '-fno-fast-math',
  '-ffp-contract=off',
  '-nostdlib',
  '-sSTANDALONE_WASM=1',
  '-sSUPPORT_LONGJMP=0',
  '-sERROR_ON_UNDEFINED_SYMBOLS=1',
  '-sALLOW_MEMORY_GROWTH=1',
  '-sINITIAL_MEMORY=2097152',
  '-sMAXIMUM_MEMORY=134217728',
  '-sSTACK_SIZE=65536',
  '--no-entry',
  '-Wl,--export-memory',
  '-Wl,--export=__heap_base',
  '-Wl,--export=irodori_kernel_version',
  '-Wl,--export=irodori_camera_strip',
  '-Wl,--export=irodori_camera_validity_strip',
  '-Wl,--export=irodori_fallback_geometry_strip',
  '-Wl,--export=irodori_prepare_strip',
  '-Wl,--export=irodori_reduce_strip',
  '-Wl,--export=irodori_sensor_mask',
  '-Wl,--export=irodori_repair_mask',
]
await mkdir(directory, { recursive: true })
const output = join(directory, 'irodori-merge-kernels.wasm')
execFileSync(compiler, [...flags, source, '-o', output], { cwd: root, stdio: 'inherit' })
const bytes = await readFile(output),
  module = await WebAssembly.compile(bytes),
  imports = WebAssembly.Module.imports(module)
if (imports.some((entry) => entry.module !== 'env' || entry.name !== 'hypot'))
  throw new Error(`Unexpected kernel imports: ${JSON.stringify(imports)}`)
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
await writeFile(
  join(directory, 'manifest.json'),
  JSON.stringify(
    {
      version: 5,
      sha256: sha256(bytes),
      sourceSha256: sha256(await readFile(join(root, source))),
      compiler: compilerVersion,
      flags,
    },
    null,
    2,
  ) + '\n',
)
console.log(`Built ${bytes.length} bytes; SHA-256 ${sha256(bytes)}.`)
