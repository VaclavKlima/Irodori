// Owned background ordered-mask proof. Failed gates never proceed to photographs.
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const i = args.indexOf(name)
  if (i < 0) return fallback
  if (!args[i + 1]) throw new Error(`Missing ${name}`)
  return args[i + 1]
}
const check = (value, message) => {
  if (!value) throw new Error(message)
}
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const save = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
const pin = async (path) => ({ path, sha256: digest(await readFile(path)) })
const output = resolve(option('--output', ''))
const stage = option('--stage', 'numeric')
check(
  args.includes('--output') && ['numeric', 'photo'].includes(stage),
  'Use --stage numeric|photo --output NEW_DIRECTORY',
)
const protocolPath = 'assets/tests/references/masked-texture/order-protocol-v2.json'
const protocolSha256 = 'fbdc719275c03cf307a71b5e3e80fde30b77af88ec5ce42f7a886fe3aba96601'
const codePaths = [
  'scripts/research/masked-texture/order-run.mjs',
  'scripts/research/masked-texture/ordered-core.mjs',
  'scripts/research/masked-texture/ordered-consumer.mjs',
  'scripts/research/masked-texture/ordered-point.mjs',
  'scripts/research/masked-texture/order-photo.mjs',
  'scripts/research/masked-texture/gpu.mjs',
  'src/main/gpu/point-renderer.ts',
  'src/shared/authored-output-wgsl.ts',
  'src/shared/masks-gpu.ts',
  'src/shared/crop.ts',
  'src/main/gpu/crop.ts',
  'src/main/processing/crop-preview.ts',
  'package-lock.json',
  'out/main/preview-worker.js',
]

async function numeric(protocol, signal, report) {
  const { runOrderedStack, renderCompatible, compareRgba } = await import('./ordered-core.mjs')
  const { renderActualPoint } = await import('./ordered-consumer.mjs')
  const { neutralAdjustments, srgbTransform } = await import('../../../src/shared/adjustments.ts')
  const { neutralMaskLight, neutralMaskColor } = await import('../../../src/shared/masks.ts')
  const { identityMaskGeometry, croppedMaskGeometry } =
    await import('../../../src/shared/mask-geometry.ts')
  const { cropGeometry } = await import('../../../src/shared/crop.ts')
  const { createCropGpu } = await import('../../../src/main/gpu/crop.ts')
  const { observeResourceHardware } = await import('../../../src/main/resource-settings.ts')
  const { DEFAULT_RESOURCE_SETTINGS, resolveResourcePolicy } =
    await import('../../../src/shared/resource-policy.ts')
  const referenceBytes = await readFile(protocol.reference.file)
  check(digest(referenceBytes) === protocol.reference.sha256, 'Frozen ordered vectors changed')
  check(
    (await pin(protocol.reference.generator)).sha256 === protocol.reference.generatorSha256,
    'Oracle generator changed',
  )
  const reference = JSON.parse(referenceBytes)
  for (const source of reference.provenance.sources)
    check(
      (await pin(source.file)).sha256 === source.sha256,
      `Independent reference dependency changed: ${source.file}`,
    )
  check(
    reference.policy === protocol.id && reference.cases.length === 14,
    'Unexpected frozen ordered case matrix',
  )
  const hardware = await observeResourceHardware()
  const policy = resolveResourcePolicy(
    DEFAULT_RESOURCE_SETTINGS,
    { ram: hardware.ram, gpu: { status: 'unknown', reason: 'adapter-unverified' } },
    0,
  )
  report.hardware = hardware
  report.cases = []
  report.legacyChecks = []
  report.cropChecks = []
  report.refusals = []
  report.negativeControls = {
    source: 'independent-small-array-oracle',
    witnesses: reference.negativeControls,
  }
  const selected = option('--case')
    ? reference.cases.filter((c) => c.id === option('--case'))
    : reference.cases
  check(selected.length > 0, 'Unknown exact numeric case')
  for (const entry of selected) {
    signal.throwIfAborted()
    const item = {
      id: entry.id,
      status: 'running',
      rgbFailures: 0,
      wordMismatches: 0,
      maxToleranceRatio: 0,
      textureJobs: 0,
    }
    report.cases.push(item)
    await save(join(output, 'result.json'), report)
    let data = Float32Array.from(entry.rgba),
      geometry
    if (entry.crop) {
      geometry = cropGeometry(
        { width: entry.crop.sourceWidth, height: entry.crop.sourceHeight },
        entry.crop.settings,
      )
      check(
        geometry.width === entry.width && geometry.height === entry.height,
        'Frozen crop dimensions changed',
      )
      for (let i = 0; i < 6; i++)
        check(
          Math.abs(geometry.outputToSource[i] - entry.crop.expectedGeometry.outputToSource[i]) <
            1e-12,
          'Frozen native crop phase changed',
        )
      const crop = await createCropGpu()
      try {
        data = await crop.render(
          geometry,
          { left: 0, top: 0, width: entry.width, height: entry.height },
          {
            left: 0,
            top: 0,
            width: entry.crop.sourceWidth,
            height: entry.crop.sourceHeight,
            data: Float32Array.from(entry.crop.sourceRgba),
          },
          signal,
        )
        const qa = compareRgba(data, entry.rgba, protocol.gates, `${entry.id}/independent-crop`)
        report.cropChecks.push({
          id: entry.id,
          status: 'passed',
          adapter: crop.adapter,
          precisionRecoveryTiles: crop.precisionRecoveryTiles,
          geometry,
          qa,
        })
      } finally {
        await crop.close()
      }
    }
    const maskGeometry = geometry
      ? croppedMaskGeometry(
          identityMaskGeometry(entry.crop.sourceWidth, entry.crop.sourceHeight),
          geometry,
        )
      : identityMaskGeometry(entry.width, entry.height)
    const localMasks = entry.roots.map((root) => ({
      id: root.id,
      name: root.id,
      enabled: root.enabled,
      inverted: false,
      head: null,
      gradient: root.gradient,
      edge: { featherPx: 0, shiftPx: 0 },
      strokes: [],
      operands: [],
      resultStrokes: [],
      light: { ...neutralMaskLight, ...root.light },
      color: { ...neutralMaskColor, ...root.color },
    }))
    const maskParameters = { localMasks, maskGeometry },
      adjustments = { ...structuredClone(neutralAdjustments), ...entry.globals, ...maskParameters }
    const admission = {
      policy,
      reservation: {
        ramBytes:
          data.byteLength * 8 +
          entry.width * entry.height * (localMasks.length + 3) * 4 +
          32 * 1024 ** 2,
        vramBytes: 0,
      },
    }
    const job = {
      data,
      width: entry.width,
      height: entry.height,
      domain: entry.primaries === 'srgb' ? 'raster' : 'scene-linear',
      adjustments,
      maskParameters,
      amounts: entry.roots.map((root) => root.amount),
      transform: srgbTransform,
      admission,
      expected: entry,
      gates: protocol.gates,
    }
    const stack = await runOrderedStack(job, signal)
    const qa = compareRgba(stack.data, entry.expected, protocol.gates, `${entry.id}/final`)
    Object.assign(item, qa, {
      textureJobs: stack.textureJobs,
      steps: stack.steps,
      globalQa: stack.globalQa,
      adapter: stack.adapter,
      mode: stack.mode,
      workingCompatibility: stack.workingCompatibility,
    })
    report.adapter = stack.adapter
    await writeFile(
      join(output, `${entry.id}.f32`),
      new Uint8Array(stack.data.buffer, stack.data.byteOffset, stack.data.byteLength),
    )
    await writeFile(
      join(output, `${entry.id}.texture-union.f32`),
      new Uint8Array(stack.coverage.buffer, stack.coverage.byteOffset, stack.coverage.byteLength),
    )
    if (stack.workingEvidence)
      for (const [kind, values] of Object.entries(stack.workingEvidence))
        await writeFile(
          join(output, `${entry.id}.working-${kind}.f32`),
          new Uint8Array(values.buffer, values.byteOffset, values.byteLength),
        )
    for (const packed of [false, true]) {
      const native = await renderCompatible({ ...job, id: entry.id, stack, packed }, signal)
      report.legacyChecks.push(...native.legacyChecks)
      const format = packed ? 'rgba8' : 'float32-sdr'
      for (const [kind, values] of [
        ['legacy', native.legacyData],
        ['consumed', native.candidateData],
        ['selected', native.data],
      ])
        await writeFile(
          join(output, `${entry.id}.${format}.${kind}.bin`),
          new Uint8Array(values.buffer, values.byteOffset, values.byteLength),
        )
      item[format] = {
        adapter: native.adapter,
        selectedPixels: native.selectedPixels,
        receipt: native.receipt,
        legacySha256: digest(new Uint8Array(native.legacyData.buffer)),
        selectedSha256: digest(new Uint8Array(native.data.buffer)),
      }
    }
    if (!option('--case') && entry.id === reference.cases[0].id) {
      const wrongParent = data.slice()
      wrongParent[0] = Math.fround(wrongParent[0] + 0.03125)
      let reason
      try {
        await renderCompatible({ ...job, data: wrongParent, stack, packed: true }, signal)
      } catch (error) {
        reason = String(error)
      }
      check(
        reason?.includes('parent/grid/point context mismatch'),
        'Prepared stack accepted a different original parent',
      )
      report.refusals.push({
        id: 'prepared-parent-mismatch',
        status: 'passed',
        reason,
        cpuFeatureFallback: false,
      })
    }
    item.status = 'passed'
    await save(join(output, 'result.json'), report)
    console.log(`${entry.id}: passed`)
  }
  if (option('--case')) return
  for (const entry of reference.refusals) {
    const localMasks = entry.roots.map((root) => ({
      id: root.id,
      name: root.id,
      enabled: root.enabled,
      inverted: false,
      head: null,
      gradient: root.gradient,
      edge: { featherPx: 0, shiftPx: 0 },
      strokes: [],
      operands: [],
      resultStrokes: [],
      light: { ...neutralMaskLight, ...root.light },
      color: { ...neutralMaskColor, ...root.color },
    }))
    const maskParameters = {
      localMasks,
      maskGeometry: identityMaskGeometry(entry.width, entry.height),
    }
    let reason
    try {
      await runOrderedStack(
        {
          data: Float32Array.from(entry.rgba),
          width: entry.width,
          height: entry.height,
          domain: entry.primaries === 'srgb' ? 'raster' : 'scene-linear',
          adjustments: {
            ...structuredClone(neutralAdjustments),
            ...entry.globals,
            ...maskParameters,
          },
          maskParameters,
          amounts: entry.roots.map((r) => r.amount),
          transform: srgbTransform,
          admission: { policy, reservation: { ramBytes: 0, vramBytes: 0 } },
        },
        signal,
      )
    } catch (error) {
      reason = String(error)
    }
    check(reason, `${entry.id}: required refusal did not happen`)
    report.refusals.push({ id: entry.id, status: 'passed', reason, cpuFeatureFallback: false })
  }
  const entry = reference.cases[0],
    tiny = Float32Array.from(entry.rgba),
    bare = {
      data: tiny,
      width: entry.width,
      height: entry.height,
      domain: 'raster',
      adjustments: structuredClone(neutralAdjustments),
      transform: srgbTransform,
      admission: { policy, reservation: { ramBytes: 0, vramBytes: 0 } },
      packed: true,
    }
  let contextReason
  try {
    await renderActualPoint(
      { ...bare, consumed: { policy: 'wrong-context', context: 'wrong', sha256: 'wrong' } },
      signal,
    )
  } catch (error) {
    contextReason = String(error)
  }
  check(
    contextReason?.includes('consumed point context'),
    'Consumed-context mismatch was not refused',
  )
  report.refusals.push({
    id: 'consumed-context-mismatch',
    status: 'passed',
    reason: contextReason,
    cpuFeatureFallback: false,
  })
  const { createOrderedPointGpu } = await import('./ordered-point.mjs')
  const point = await createOrderedPointGpu()
  try {
    let resourceReason
    try {
      await point.global(
        {
          ...bare,
          admission: {
            policy,
            reservation: {
              ramBytes: policy.ram.effectiveBytes,
              vramBytes: policy.vram.effectiveBytes,
            },
          },
        },
        signal,
      )
    } catch (error) {
      resourceReason = String(error)
    }
    check(resourceReason, 'Over-budget native work was not refused')
    report.refusals.push({
      id: 'resource-budget',
      status: 'passed',
      reason: resourceReason,
      cpuFeatureFallback: false,
    })
  } finally {
    await point.close()
  }
}

async function worker() {
  const protocolBytes = await readFile(protocolPath),
    protocol = JSON.parse(protocolBytes)
  check(
    digest(protocolBytes) === protocolSha256,
    'Ordered protocol changed after prospective freeze',
  )
  check(
    (await pin(protocol.algorithmReference.file)).sha256 === protocol.algorithmReference.sha256,
    'Original LLF protocol changed',
  )
  const report = {
    version: 1,
    status: 'running',
    stage,
    protocolSha256,
    startedAt: new Date().toISOString(),
    foreground: false,
    cpuFeatureFallback: false,
    productionEnabled: false,
    bundleSha256: digest(await readFile(process.argv[1])),
    code: await Promise.all(codePaths.map(pin)),
  }
  const controller = new AbortController(),
    started = performance.now(),
    timer = setTimeout(
      () => controller.abort(new Error('Owned ordered proof exceeded ten minutes')),
      600000,
    )
  try {
    await writeFile(join(output, 'protocol.json'), protocolBytes, { flag: 'wx' })
    await save(join(output, 'result.json'), report)
    if (stage === 'numeric') {
      await numeric(protocol, controller.signal, report)
      report.status = option('--case') ? 'passed-case' : 'passed'
    } else {
      check(args.includes('--numeric'), 'Photo requires --numeric passed full ordered proof')
      const priorPath = resolve(option('--numeric')),
        previous = JSON.parse(await readFile(join(priorPath, 'result.json')))
      check(
        previous.stage === 'numeric' &&
          previous.status === 'passed' &&
          previous.cases.length === 14 &&
          previous.cropChecks.length === 3,
        'Full numeric/actual-consumer/crop gates are incomplete',
      )
      check(
        previous.protocolSha256 === protocolSha256 && previous.bundleSha256 === report.bundleSha256,
        'Processing bundle changed since ordered proof',
      )
      check(
        previous.code.find((x) => x.path === 'package-lock.json').sha256 ===
          report.code.find((x) => x.path === 'package-lock.json').sha256,
        'Dependencies changed since ordered proof',
      )
      report.numericPrerequisite = await pin(join(priorPath, 'result.json'))
      const { runOrderedPhotograph } = await import('./order-photo.mjs')
      const { runOrderedStack, renderCompatible } = await import('./ordered-core.mjs')
      report.photograph = await runOrderedPhotograph({
        output,
        protocol,
        signal: controller.signal,
        runStack: runOrderedStack,
        renderCompatible,
      })
      report.status = 'generated-awaiting-visual-review'
    }
    report.codeAfter = await Promise.all(codePaths.map(pin))
    check(
      JSON.stringify(report.code) === JSON.stringify(report.codeAfter),
      'Processing sources changed during proof',
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
      `# Ordered Texture ${stage}: ${report.status}\n\n${report.error ?? 'Bounded proof finished; production integration is not enabled.'}\n\nCases ${report.cases?.length ?? 0}; ${(report.durationMs / 1000).toFixed(2)} s. Background isolated GPU, no CPU feature fallback. See result.json for unchanged references, actual native consumer, crop and refusal gates.\n`,
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
