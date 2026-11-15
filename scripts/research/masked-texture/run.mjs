// Owned, background-only research runner. A numerical failure prevents photographs.
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(name)
  if (index < 0) return fallback
  if (!args[index + 1]) throw new Error(`Missing ${name} value`)
  return args[index + 1]
}
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const pin = async (path) => ({ path, sha256: digest(await readFile(path)) })
const save = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
const assert = (value, message) => {
  if (!value) throw new Error(message)
}
const codePaths = [
  'scripts/research/masked-texture/run.mjs',
  'scripts/research/masked-texture/gpu.mjs',
  'scripts/research/masked-texture/photo.mjs',
  'src/main/gpu/raw-renderer.ts',
  'src/shared/spatial-detail.ts',
  'src/shared/masks-gpu.ts',
  'package-lock.json',
]
const output = resolve(option('--output', ''))
const stage = option('--stage', 'numeric')
assert(
  args.includes('--output') && ['numeric', 'photo'].includes(stage),
  'Use --output NEW_DIRECTORY --stage numeric|photo',
)

async function numeric(prototype, signal, report) {
  const { createTextureGpu } = await import('./gpu.mjs')
  const { detailLuminance } = await import('../../../src/shared/spatial-detail.ts')
  const { observeResourceHardware } = await import('../../../src/main/resource-settings.ts')
  const { resolveResourcePolicy, DEFAULT_RESOURCE_SETTINGS } =
    await import('../../../src/shared/resource-policy.ts')
  const hardware = await observeResourceHardware()
  const admission = {
    policy: resolveResourcePolicy(
      DEFAULT_RESOURCE_SETTINGS,
      { ram: hardware.ram, gpu: { status: 'unknown', reason: 'adapter-unverified' } },
      0,
    ),
    reservation: { ramBytes: 0, vramBytes: 0 },
  }
  const fixtureBytes = await readFile(prototype.reference.file)
  assert(digest(fixtureBytes) === prototype.reference.sha256, 'Frozen numeric fixture changed')
  const fixtures = JSON.parse(fixtureBytes)
  assert(
    fixtures.policy === prototype.id && fixtures.cases.length === 19,
    'Wrong numerical contract',
  )
  const gpu = await createTextureGpu()
  report.hardware = hardware
  report.admission = admission
  report.adapter = gpu.adapter
  report.cases = []
  const rms = (values) => {
    const mean = values.reduce((a, b) => a + b, 0) / values.length
    return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length)
  }
  try {
    for (const entry of fixtures.cases) {
      signal.throwIfAborted()
      const source = new Float32Array(entry.rgba),
        expected = new Float32Array(entry.expected)
      const sourceWords = new Uint32Array(source.buffer)
      let data = source
      const item = {
        id: entry.id,
        status: 'running',
        passes: entry.passes,
        maxAbsoluteError: 0,
        maxToleranceRatio: 0,
        wordMismatches: 0,
        rgbFailures: 0,
      }
      report.cases.push(item)
      for (const amount of entry.passes) {
        await gpu.prepare(
          { data, width: entry.width, height: entry.height, primaries: entry.primaries, admission },
          signal,
        )
        data = (await gpu.apply({ amount, coverage: new Float32Array(entry.mask) }, signal)).data
      }
      const words = new Uint32Array(data.buffer)
      for (let i = 0; i < data.length; i++) {
        assert(Number.isFinite(data[i]), `${entry.id}: nonfinite result`)
        if (i % 4 === 3) continue
        const error = Math.abs(data[i] - expected[i]),
          tolerance =
            prototype.gates.absoluteRgb + prototype.gates.relativeRgb * Math.abs(expected[i])
        item.maxAbsoluteError = Math.max(item.maxAbsoluteError, error)
        item.maxToleranceRatio = Math.max(item.maxToleranceRatio, error / tolerance)
        if (error > tolerance) item.rgbFailures++
      }
      for (const i of entry.descriptive.exactSourceWordIndices)
        if (words[i] !== sourceWords[i]) item.wordMismatches++
      await writeFile(join(output, `${entry.id}.f32`), new Uint8Array(data.buffer))
      if (entry.id.startsWith('band-') || entry.id === 'flat-noise-positive') {
        const coefficients = detailLuminance(entry.primaries)
        const feature = (image) =>
          Array.from({ length: image.length / 4 }, (_, p) =>
            Math.asinh(coefficients.reduce((sum, c, i) => sum + c * image[p * 4 + i], 0) / 0.18),
          )
        item.featureRmsGain = rms(feature(data)) / rms(feature(source))
      }
      if (entry.id === 'strong-step-boundary') {
        const rgbSource = entry.rgba.filter((_, i) => i % 4 === 0),
          rgbResult = Array.from(data).filter((_, i) => i % 4 === 0)
        const low = Math.min(...rgbSource),
          high = Math.max(...rgbSource)
        item.overshootFraction =
          Math.max(0, Math.max(...rgbResult) - high, low - Math.min(...rgbResult)) / (high - low)
      }
      assert(
        item.rgbFailures === 0 && item.wordMismatches === 0,
        `${entry.id}: ${item.rgbFailures} RGB gates, ${item.wordMismatches} exact word gates failed`,
      )
      item.status = 'passed'
      console.log(`numeric ${entry.id}: passed`)
      await save(join(output, 'result.json'), report)
    }
    const quality = prototype.gates.firstProceduralQuality
    const byId = new Map(report.cases.map((x) => [x.id, x]))
    const gates = []
    for (const name of ['band-mid', 'band-texture']) {
      gates.push({
        id: `${name}-positive`,
        value: byId.get(name).featureRmsGain,
        pass: byId.get(name).featureRmsGain >= quality.period4And8Positive25MinFeatureRmsGain,
      })
      gates.push({
        id: `${name}-negative`,
        value: byId.get(`${name}-negative`).featureRmsGain,
        pass:
          byId.get(`${name}-negative`).featureRmsGain <=
          quality.period4And8Negative25MaxFeatureRmsGain,
      })
    }
    const high = byId.get('band-high').featureRmsGain
    gates.push({
      id: 'fine-frequency-preservation',
      value: high,
      pass:
        high >= quality.period2Positive25FeatureRmsGainRange[0] &&
        high <= quality.period2Positive25FeatureRmsGainRange[1],
    })
    const noise = byId.get('flat-noise-positive').featureRmsGain
    gates.push({
      id: 'flat-noise',
      value: noise,
      pass: noise <= quality.flatNoisePositive25MaxFeatureRmsGain,
    })
    const step = byId.get('strong-step-boundary').overshootFraction
    gates.push({
      id: 'step-overshoot',
      value: step,
      pass: step <= quality.stepMaxOvershootFraction,
    })
    report.qualityGates = gates
    assert(
      gates.every((x) => x.pass),
      'Frozen procedural quality gate failed; no photograph execution',
    )
    // Bounded synthetic impulse checks the declared native support, without a CPU image implementation.
    const width = 97,
      height = 97,
      source = new Float32Array(width * height * 4),
      mask = new Float32Array(width * height).fill(1)
    for (let i = 0; i < mask.length; i++) source.set([0.375, 0.375, 0.375, 1], i * 4)
    source.set([0.5, 0.5, 0.5, 1], (48 * width + 48) * 4)
    await gpu.prepare({ data: source, width, height, primaries: 'srgb', admission }, signal)
    const result = await gpu.apply({ amount: 25, coverage: mask }, signal),
      words = new Uint32Array(result.data.buffer),
      original = new Uint32Array(source.buffer)
    let outsideChanged = 0,
      maxSupport = 0
    for (let i = 0; i < mask.length; i++)
      if (words[i * 4] !== original[i * 4]) {
        const distance = Math.max(Math.abs((i % width) - 48), Math.abs(Math.floor(i / width) - 48))
        maxSupport = Math.max(maxSupport, distance)
        if (distance > quality.maximumSupportPx) outsideChanged++
      }
    report.supportProbe = {
      width,
      height,
      maxSupport,
      outsideChanged,
      bound: quality.maximumSupportPx,
    }
    assert(outsideChanged === 0, 'Native support exceeds frozen bound')
  } finally {
    await gpu.close()
  }
}

async function worker() {
  const protocolPath = 'assets/tests/references/masked-texture/protocol.json',
    bytes = await readFile(protocolPath),
    prototype = JSON.parse(bytes)
  const controller = new AbortController(),
    signal = controller.signal
  const timer = setTimeout(
    () => controller.abort(new Error('Owned research budget exceeded')),
    prototype.runtime.maxSecondsPerOwnedRun * 1000,
  )
  const report = {
    version: 1,
    stage,
    status: 'running',
    startedAt: new Date().toISOString(),
    protocolSha256: digest(bytes),
    code: await Promise.all(codePaths.map(pin)),
    bundleSha256: digest(await readFile(process.argv[1])),
    foreground: false,
    cpuFeatureFallback: false,
    productionEnabled: false,
  }
  const started = performance.now()
  try {
    await writeFile(join(output, 'protocol.json'), bytes, { flag: 'wx' })
    if (stage === 'numeric') {
      await numeric(prototype, signal, report)
      report.status = 'passed'
    } else {
      const prerequisitePath = resolve(option('--numeric', '')),
        prerequisite = JSON.parse(await readFile(join(prerequisitePath, 'result.json')))
      assert(
        args.includes('--numeric') &&
          prerequisite.status === 'passed' &&
          prerequisite.stage === 'numeric' &&
          prerequisite.protocolSha256 === report.protocolSha256,
        'Photographs require successful matching numeric receipt',
      )
      assert(
        prerequisite.bundleSha256 === report.bundleSha256 &&
          prerequisite.code.find((x) => x.path === 'package-lock.json').sha256 ===
            report.code.find((x) => x.path === 'package-lock.json').sha256,
        'Bundled implementation or dependencies changed since numerical gates',
      )
      report.numericPrerequisite = await pin(join(prerequisitePath, 'result.json'))
      const { runPhotographs } = await import('./photo.mjs')
      report.photographs = await runPhotographs({ output, prototype, signal })
      report.status = 'generated-awaiting-visual-review'
    }
    report.codeAfter = await Promise.all(codePaths.map(pin))
    assert(
      JSON.stringify(report.code) === JSON.stringify(report.codeAfter),
      'Processing code changed during owned run',
    )
  } catch (error) {
    report.status = 'failed'
    report.error = String(error.stack ?? error)
    process.exitCode = 1
  } finally {
    clearTimeout(timer)
    report.durationMs = performance.now() - started
    report.finishedAt = new Date().toISOString()
    await save(join(output, 'result.json'), report)
    await writeFile(
      join(output, 'summary.md'),
      `# Masked Texture ${stage}: ${report.status}\n\n${report.error ?? `${report.cases?.length ?? 0} numerical cases; photograph review remains separate.`}\n\nDuration ${(report.durationMs / 1000).toFixed(2)}s. Background isolated GPU; no CPU feature fallback or application enablement. See result.json for pins, gates and adapter evidence.\n`,
    )
    console.log(`${stage}: ${report.status}`)
  }
}

async function main() {
  if (args.includes('--worker')) return worker()
  await mkdir(output, { recursive: false })
  await copyFile(fileURLToPath(import.meta.url), join(output, 'generator.mjs'))
  const { build } = await import('esbuild'),
    bundle = join(output, 'worker.mjs')
  await build({
    entryPoints: [fileURLToPath(import.meta.url)],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
  })
  const require = createRequire(import.meta.url),
    executable = join(
      dirname(require.resolve(`node-${process.platform}-${process.arch}/package.json`)),
      'bin/node',
    )
  const env = { ...process.env }
  delete env.NODE_OPTIONS
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(executable, [bundle, ...args, '--worker'], {
    env,
    detached: true,
    stdio: 'inherit',
  })
  const stop = () => {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }
  const timer = setTimeout(stop, 610000)
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    const outcome = await new Promise((accept, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => accept({ code, signal }))
    })
    await save(join(output, 'worker-exit.json'), outcome)
    if (outcome.code !== 0) process.exitCode = 1
  } finally {
    clearTimeout(timer)
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    stop()
  }
}
await main()
