// Isolated photographic evidence for saved detail sharpening; no application library or UI.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, writeFile, stat, copyFile } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const args = process.argv.slice(2)
const option = (name) => {
  const at = args.indexOf(name)
  if (at < 0 || !args[at + 1]) throw new Error(`Provide ${name}.`)
  return resolve(args[at + 1])
}
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n')
const hash = async (path) => {
  const sha = createHash('sha256')
  for await (const bytes of createReadStream(path)) sha.update(bytes)
  return sha.digest('hex')
}
const pin = async (path) => ({
  path: resolve(path),
  sha256: await hash(path),
  bytes: (await stat(path)).size,
})

async function tracked(path, expected) {
  await promisify(execFile)('git', ['ls-files', '--error-unmatch', '--', path])
  await promisify(execFile)('git', ['diff', '--quiet', 'HEAD', '--', path])
  if ((await hash(path)) !== expected) throw new Error('Tracked input/notice changed: ' + path)
  return pin(path)
}

async function worker() {
  const { PreviewProcess } = await import('../../src/main/preview-process.ts')
  const { prepareNativeRawExecutable } = await import('../../src/main/native-raw-executable.ts')
  const { validateWorkingAsset, workingSourceIdentity } =
    await import('../../src/main/working-assets.ts')
  const { verifyMaster } = await import('../../src/main/merge/store.ts')
  const { MERGE_VERSION } = await import('../../src/shared/merge.ts')
  const { neutralAdjustments, srgbTransform } = await import('../../src/shared/adjustments.ts')
  const { noLensSettings } = await import('../../src/shared/lens.ts')
  const { observeResourceHardware } = await import('../../src/main/resource-settings.ts')
  const { DEFAULT_RESOURCE_SETTINGS, resolveResourcePolicy } =
    await import('../../src/shared/resource-policy.ts')
  const output = option('--output'),
    protocolPath = option('--protocol'),
    masterPath = option('--master')
  const protocolBytes = await readFile(protocolPath),
    protocol = JSON.parse(protocolBytes)
  if (
    protocol.id !== 'native-photographic-sharpening-20261114-v1' ||
    protocol.variants.length !== 5
  )
    throw new Error('Use the declared photographic matrix.')
  await writeFile(join(output, 'protocol.json'), protocolBytes, { flag: 'wx' })
  const processor = new PreviewProcess(resolve('out/main/preview-worker.js'), 240000, 30000, () =>
    prepareNativeRawExecutable(resolve('out/main')),
  )
  const controller = new AbortController(),
    signal = controller.signal
  const timer = setTimeout(
    () => controller.abort(new Error('Photographic matrix exceeded 15 minutes.')),
    900000,
  )
  const codePaths = [
    'package-lock.json',
    'out/main/preview-worker.js',
    'src/shared/spatial-detail.ts',
    'src/shared/spatial-detail-wgsl.ts',
    'src/main/processing/detail-bands.ts',
    'src/main/processing/detail-preview.ts',
    'src/main/processing/detail-preparation.ts',
    'src/main/gpu/spatial-detail.ts',
  ]
  const hardware = await observeResourceHardware()
  const observation = {
    ram: hardware.ram,
    gpu: { status: 'unknown', reason: 'adapter-unverified' },
  }
  const admission = {
    policy: resolveResourcePolicy(DEFAULT_RESOURCE_SETTINGS, observation, 0),
    reservation: { ramBytes: 0, vramBytes: 0 },
  }
  const report = {
    version: 1,
    status: 'running',
    startedAt: new Date().toISOString(),
    protocolSha256: digest(protocolBytes),
    code: await Promise.all(codePaths.map(pin)),
    hardware,
    admission,
    cases: [],
    scope: protocol.scope,
    foreground: false,
    productionAlgorithmChanged: false,
  }
  const reportPath = join(output, 'result.json')
  try {
    for (const entry of protocol.cases) {
      signal.throwIfAborted()
      const directory = join(output, entry.id)
      await mkdir(directory)
      const neutralDirectory = join(directory, 'neutral')
      await mkdir(neutralDirectory)
      const notice = await tracked(entry.notice, entry.noticeSha256)
      let source, metadata, asset, options, before, identity, master
      if (entry.kind === 'merge') {
        master = JSON.parse(await readFile(join(masterPath, 'manifest.json'), 'utf8'))
        if (
          (await hash(join(masterPath, 'manifest.json'))) !== entry.manifestSha256 ||
          master.version !== MERGE_VERSION ||
          master.recipe.version !== MERGE_VERSION ||
          master.asset.sha256 !== entry.assetSha256 ||
          master.recipe.maskSha256 !== entry.maskSha256
        )
          throw new Error('The retained master differs from the frozen v4 evidence.')
        await verifyMaster(masterPath, master)
        const manifest = JSON.parse(await readFile(entry.notice, 'utf8'))
        const originals = []
        for (const item of manifest.files)
          originals.push(await tracked(join(dirname(entry.notice), item.path), item.sha256))
        if (
          JSON.stringify(master.recipe.sources.map((x) => x.id).sort()) !==
          JSON.stringify(originals.map((x) => x.sha256).sort())
        )
          throw new Error('Master sources differ from tracked bracket.')
        source = {
          master: await pin(join(masterPath, 'manifest.json')),
          asset: await pin(join(masterPath, 'linear.f32')),
          mask: await pin(join(masterPath, 'motion.mask')),
          originals,
        }
        metadata = {
          ...master.metadata,
          mergeMaster: { asset: master.asset, recipe: master.recipe },
        }
        asset = {
          path: join(masterPath, 'linear.f32'),
          width: master.asset.width,
          height: master.asset.height,
          byteLength: master.asset.byteLength,
          sha256: master.asset.sha256,
          hdr: master.asset,
          transform: srgbTransform,
        }
        options = {
          metadata,
          settings: { ...noLensSettings },
          revision: 0,
          processing: 'hdr-v1',
          adjustments: structuredClone(neutralAdjustments),
          workingAsset: asset,
          prepareLinear: true,
        }
        before = await processor.renderPreparedFull(neutralDirectory, options, signal, 'gpu')
        identity = workingSourceIdentity(master.photo.id, options, true)
      } else {
        source = await tracked(entry.source, entry.sha256)
        metadata = await processor.inspect(resolve(entry.source), signal)
        options = {
          metadata,
          settings: { ...noLensSettings },
          revision: 0,
          processing: 'display-referred-v1',
          adjustments: structuredClone(neutralAdjustments),
          prepareLinear: true,
        }
        before = await processor.renderFull(
          resolve(entry.source),
          neutralDirectory,
          signal,
          options,
        )
        if (!before.linear) throw new Error('Native preparation did not return a linear source.')
        asset = {
          ...before.linear,
          width: before.width,
          height: before.height,
          path: join(neutralDirectory, 'linear.f32'),
        }
        identity = workingSourceIdentity(entry.sha256, options, false)
      }
      await validateWorkingAsset(asset, signal)
      const item = {
        id: entry.id,
        source,
        notice,
        asset,
        sourceIdentity: identity,
        regions: entry.regions,
        variants: [],
      }
      report.cases.push(item)
      if (master) {
        const mask = await readFile(join(masterPath, 'motion.mask')),
          crop = master.recipe.crop,
          dims = master.recipe.maskDimensions
        const region = entry.regions.find((x) => x.name === 'deghost-transition')
        let minimum = 255,
          maximum = 0
        for (let y = region.top; y < region.top + region.height; y++)
          for (let x = region.left; x < region.left + region.width; x++) {
            const value = mask[(y + crop.top) * dims.width + x + crop.left]
            minimum = Math.min(minimum, value)
            maximum = Math.max(maximum, value)
          }
        if (minimum !== 0 || maximum !== 255)
          throw new Error('Frozen crop lacks a full retained deghost transition.')
        item.transition = {
          minimum,
          maximum,
          maskDimensions: dims,
          crop,
          scope: 'Reference-fallback blend boundary, no known-truth motion claim.',
        }
      }
      for (const variant of protocol.variants) {
        signal.throwIfAborted()
        const destination = join(directory, variant.name)
        let frame = before
        if (variant.amount) {
          await mkdir(destination)
          frame = await processor.prepareDetailPreview(
            asset.path,
            destination,
            {
              ...admission,
              asset,
              sourceIdentity: identity,
              noiseReduction: protocol.noiseReduction,
              detailSharpening: {
                version: 1,
                amount: variant.amount,
                radius: variant.radius,
                threshold: variant.threshold,
              },
              options,
              workingOnly: false,
              backend: 'gpu',
            },
            signal,
          )
          const d = frame.detail
          if (
            d?.backend !== 'gpu' ||
            d.cpuTiles !== 0 ||
            d.precisionRecoveryTiles !== 0 ||
            !d.gpuTiles ||
            !d.adapter ||
            d.sourceSha256 !== asset.sha256 ||
            d.sourceIdentity !== identity
          )
            throw new Error(
              'Detail variant did not prove the requested production GPU source route.',
            )
        }
        if (
          frame.format !== 'rgba8-srgb' ||
          frame.width !== asset.width ||
          frame.height !== asset.height ||
          frame.byteLength !== asset.width * asset.height * 4
        )
          throw new Error('Native frame format/dimensions changed.')
        const pixels = await readFile(join(destination, 'full.rgba'))
        if (pixels.length !== frame.byteLength || digest(pixels) !== frame.sha256)
          throw new Error('Native proof frame hash mismatch.')
        const value = { name: variant.name, controls: variant, frame, crops: [] }
        item.variants.push(value)
        for (const region of entry.regions) {
          if (
            ![region.left, region.top, region.width, region.height].every(Number.isSafeInteger) ||
            region.left < 0 ||
            region.top < 0 ||
            region.width !== 512 ||
            region.height !== 512 ||
            region.left + 512 > frame.width ||
            region.top + 512 > frame.height
          )
            throw new Error('Frozen native crop is outside the actual decoded grid.')
          const path = join(destination, region.name + '.png')
          await sharp(pixels, { raw: { width: frame.width, height: frame.height, channels: 4 } })
            .extract({ left: region.left, top: region.top, width: 512, height: 512 })
            .png()
            .toFile(path)
          value.crops.push({ region, ...(await pin(path)), sourcePixelsPerPngPixel: 1 })
        }
        await save(join(destination, 'frame.json'), frame)
        await save(reportPath, report)
        console.log(
          JSON.stringify({
            id: entry.id,
            variant: variant.name,
            gpuTiles: frame.detail?.gpuTiles ?? 0,
            adapter: frame.detail?.adapter ?? frame.diagnostics?.adapter ?? null,
          }),
        )
      }
      await validateWorkingAsset(asset, signal)
      if ((await hash(join(neutralDirectory, 'full.rgba'))) !== before.sha256)
        throw new Error('Neutral proof was modified.')
      if (entry.kind === 'raster') await tracked(entry.source, entry.sha256)
      else await verifyMaster(masterPath, master)
      await tracked(entry.notice, entry.noticeSha256)
    }
    report.codeAfter = await Promise.all(codePaths.map(pin))
    if (JSON.stringify(report.codeAfter) !== JSON.stringify(report.code))
      throw new Error('Production processing changed during the review.')
    report.status = 'generated-awaiting-visual-review'
  } catch (error) {
    report.status = 'failed'
    report.error = String(error.stack ?? error)
    process.exitCode = 1
  } finally {
    clearTimeout(timer)
    try {
      await processor.close(true)
    } catch (error) {
      report.cleanupError = String(error)
      report.status = 'failed'
      process.exitCode = 1
    }
    report.finishedAt = new Date().toISOString()
    await save(reportPath, report)
    await writeFile(
      join(output, 'summary.md'),
      `# Native sharpening photographic review: ${report.status}\n\n${report.error ?? 'Production native frames generated; visual review remains separate.'}\n\n${report.cases.length} sources, fixed five variants, neutral NR. No foreground, algorithm change or physical HDR acceptance. Read result.json for exact source/protocol/code hashes and GPU diagnostics.\n`,
    )
  }
}

async function main() {
  if (args.includes('--worker')) return worker()
  const output = option('--output')
  await mkdir(output, { recursive: false })
  await copyFile(fileURLToPath(import.meta.url), join(output, 'generator.mjs'))
  const { build } = await import('esbuild')
  const bundled = join(output, 'worker.mjs')
  await build({
    entryPoints: [fileURLToPath(import.meta.url)],
    outfile: bundled,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
  })
  const require = createRequire(import.meta.url)
  const executable = join(
    dirname(require.resolve(`node-${process.platform}-${process.arch}/package.json`)),
    'bin/node',
  )
  const env = { ...process.env }
  delete env.NODE_OPTIONS
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(executable, [bundled, ...args, '--worker'], {
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
  const timer = setTimeout(stop, 960000)
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
  }
}
await main()
