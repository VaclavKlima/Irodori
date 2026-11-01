import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { expect, test } from '@playwright/test'
import {
  createPilotPatchGpu,
  PILOT_PATCH_GPU_BYTES,
  PILOT_PATCH_WORKING_BYTES,
} from '../scripts/research/strong-noise/pilot-patch-gpu'

const fixtures = resolve('assets/tests/references/detail/strong-noise/pilot-patch-quality')
const python = process.env.IRODORI_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
interface QualityCase {
  row: number
  width: number
  height: number
  recipe: { primaries: 'srgb' | 'rec2020'; strength: number; name: string }
  estimate: { version: 'frozen-global-directional-mad-v1'; variance: [number, number, number] }
  inputs: { kind: string; file: string; sha256: string; bytes: number }[]
}
interface Manifest {
  provenance: { metricSources: { path: string; sha256: string }[] }
  cases: QualityCase[]
}

// Reuse the frozen metric functions, without running an estimator or CPU filter.
const evaluate = String.raw`
import importlib.util, json, pathlib, struct, sys
sys.dont_write_bytecode = True
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
root = pathlib.Path.cwd()
directory, output, primary = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3]
manifest = json.loads((directory/'manifest.json').read_text())
record = next(item for item in manifest['cases'] if item['recipe']['primaries'] == primary)
inputs = {item['kind']: directory/item['file'] for item in record['inputs']}
def pixels(path): return list(struct.iter_unpack('<4f', path.read_bytes()))
model = load('existing_detail_metrics', root/'scripts/research/detail-candidates.py')
cases = load('existing_detail_cases', root/'scripts/research/strong-noise/cases.py')
case = {**record['recipe'], 'width':record['width'], 'height':record['height'],
        'clean':pixels(inputs['clean']), 'entering':pixels(inputs['entering']),
        'cohort':'high-required'}
metrics = cases.evaluate(model, case, pixels(output))
print(json.dumps(metrics, allow_nan=False))
`

for (const primary of ['srgb', 'rec2020'] as const) {
  // eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures; no Electron app is needed.
  test(`GPU pilot patch preserves the retained ${primary} context edge quality limits`, async ({}, info) => {
    test.setTimeout(180_000)
    await mkdir(info.outputDir, { recursive: true })
    const manifest = JSON.parse(await readFile(join(fixtures, 'manifest.json'), 'utf8')) as Manifest
    expect(manifest.cases).toHaveLength(2)
    for (const source of manifest.provenance.metricSources)
      expect(sha(await readFile(resolve(source.path)))).toBe(source.sha256)
    const record = manifest.cases.find((item) => item.recipe.primaries === primary)!
    expect(record).toBeDefined()
    expect(record.recipe.name).toBe('isoluminant')
    expect(record.recipe.strength).toBe(75)
    const inputs = new Map<string, Buffer>()
    for (const input of record.inputs) {
      const bytes = await readFile(join(fixtures, input.file))
      expect(bytes.length).toBe(input.bytes)
      expect(bytes.length).toBe(record.width * record.height * 16)
      expect(sha(bytes)).toBe(input.sha256)
      inputs.set(input.kind, bytes)
    }
    const entering = inputs.get('entering')!
    const data = new Float32Array(entering.length / 4)
    for (let i = 0; i < data.length; i++) data[i] = entering.readFloatLE(i * 4)
    const gpu = createPilotPatchGpu()
    const controller = new AbortController()
    try {
      const start = performance.now()
      const output = await gpu.render(
        {
          image: { width: record.width, height: record.height },
          tile: { left: 0, top: 0, width: record.width, height: record.height },
          source: { left: 0, top: 0, width: record.width, height: record.height, data },
          estimate: {
            version: record.estimate.version,
            variance: record.estimate.variance,
            source: {
              width: record.width,
              height: record.height,
              primaries: primary,
              identity: sha(entering),
              sha256: sha(entering),
            },
          },
          luminance: 75,
          chroma: 75,
          admission: {
            maxGpuBytes: PILOT_PATCH_GPU_BYTES,
            maxWorkingBytes: PILOT_PATCH_WORKING_BYTES,
          },
        },
        controller.signal,
      )
      const elapsedMs = performance.now() - start
      expect(output.length).toBe(data.length)
      const bytes = Buffer.alloc(output.byteLength)
      for (let i = 0; i < output.length; i++) bytes.writeFloatLE(output[i], i * 4)
      const outputPath = info.outputPath(`context-${primary}.f32`)
      await writeFile(outputPath, bytes, { flag: 'wx' })
      const metrics = JSON.parse(
        execFileSync(python, ['-B', '-c', evaluate, fixtures, outputPath, primary], {
          timeout: 15_000,
          maxBuffer: 1024 * 1024,
          encoding: 'utf8',
        }),
      ) as {
        required: boolean
        edgeLeakage: number
        edgeWidthGrowth: number
        gates: Record<string, boolean>
      }
      const receipt = {
        row: record.row,
        recipe: record.recipe,
        adapter: gpu.adapter,
        allocatedBytes: gpu.allocatedBytes,
        outputSha256: sha(bytes),
        elapsedMs,
        timingAcceptance: false,
        scope:
          'Two retained context edges only; later quality stages and photographic acceptance remain open.',
        metrics,
      }
      await writeFile(info.outputPath('quality.json'), JSON.stringify(receipt, null, 2), {
        flag: 'wx',
      })
      await info.attach('GPU context quality', {
        body: JSON.stringify(receipt),
        contentType: 'application/json',
      })
      expect(gpu.adapter).toBeTruthy()
      expect(metrics.required).toBe(true)
      expect(metrics.edgeLeakage).toBeLessThanOrEqual(0.03)
      expect(metrics.edgeWidthGrowth).toBeLessThanOrEqual(0.5)
      expect(Object.keys(metrics.gates).length).toBeGreaterThan(0)
      expect(Object.entries(metrics.gates).filter(([, passed]) => !passed)).toEqual([])
    } finally {
      controller.abort()
      await gpu.close()
      expect(gpu.allocatedBytes).toBe(0)
    }
  })
}
