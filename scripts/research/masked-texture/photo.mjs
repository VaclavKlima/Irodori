import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { PreviewProcess } from '../../../src/main/preview-process.ts'
import { prepareNativeRawExecutable } from '../../../src/main/native-raw-executable.ts'
import { validateWorkingAsset, workingSourceIdentity } from '../../../src/main/working-assets.ts'
import { neutralAdjustments } from '../../../src/shared/adjustments.ts'
import { noLensSettings } from '../../../src/shared/lens.ts'
import { neutralMaskColor, neutralMaskLight } from '../../../src/shared/masks.ts'
import { identityMaskGeometry } from '../../../src/shared/mask-geometry.ts'
import { observeResourceHardware } from '../../../src/main/resource-settings.ts'
import {
  DEFAULT_RESOURCE_SETTINGS,
  resolveResourcePolicy,
} from '../../../src/shared/resource-policy.ts'
import { createTextureGpu } from './gpu.mjs'
import {
  detailProofMemoryPlan,
  detailPreviewMemoryPlan,
} from '../../../src/shared/detail-resources.ts'

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const save = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
const check = (condition, message) => {
  if (!condition) throw new Error(message)
}
const bytesOf = (data) => new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
const wordsOf = (data) => new Uint32Array(data.buffer, data.byteOffset, data.length)
const hash = async (path) => {
  const result = createHash('sha256')
  for await (const bytes of createReadStream(path)) result.update(bytes)
  return result.digest('hex')
}
const pin = async (path) => ({
  path: resolve(path),
  sha256: await hash(path),
  bytes: (await stat(path)).size,
})

async function tracked(path, expected) {
  await promisify(execFile)('git', ['ls-files', '--error-unmatch', '--', path])
  await promisify(execFile)('git', ['diff', '--quiet', 'HEAD', '--', path])
  const value = await pin(path)
  check(!expected || value.sha256 === expected, `Tracked source/notice hash mismatch: ${path}`)
  return value
}

function masksFor(entry, asset) {
  const byId = new Map(entry.masks.map((item) => [item.id, item]))
  check(byId.size === 3 && entry.maskOrder.length === 3, 'Expected three frozen manual masks')
  return entry.maskOrder.map((id) => {
    const item = byId.get(id)
    check(item?.coverage.kind === 'radial', `Missing frozen radial mask: ${id}`)
    const shape = item.coverage
    return {
      id,
      name: item.label,
      enabled: true,
      inverted: false,
      head: null,
      gradient: {
        kind: 'radial',
        center: { x: shape.centerPx.x / asset.width, y: shape.centerPx.y / asset.height },
        radiusX: shape.radiusPx.x / asset.width,
        radiusY: shape.radiusPx.y / asset.height,
        rotation: shape.rotationDegrees,
        feather: shape.featherPercent,
      },
      edge: { featherPx: 0, shiftPx: 0 },
      strokes: [],
      operands: [],
      resultStrokes: [],
      light: { ...neutralMaskLight },
      color: { ...neutralMaskColor },
    }
  })
}

function inspectCandidate(source, candidate, coverage, signal) {
  check(
    candidate instanceof Float32Array && candidate.length === source.length,
    'Invalid native candidate frame',
  )
  check(
    coverage instanceof Float32Array && coverage.length * 4 === source.length,
    'Invalid native coverage frame',
  )
  const original = wordsOf(source),
    result = wordsOf(candidate)
  const counts = {
    pixels: coverage.length,
    zero: 0,
    full: 0,
    partial: 0,
    changed: 0,
    alphaWordsChanged: 0,
    hiddenRgbWordsChanged: 0,
    zeroCoverageWordsChanged: 0,
    nonFinite: 0,
  }
  let sum = 0
  for (let pixel = 0; pixel < coverage.length; pixel++) {
    if ((pixel & 65535) === 0) signal.throwIfAborted()
    const amount = coverage[pixel],
      start = pixel * 4
    check(Number.isFinite(amount) && amount >= 0 && amount <= 1, 'Coverage is outside [0,1]')
    sum += amount
    if (amount === 0) counts.zero++
    else if (amount === 1) counts.full++
    else counts.partial++
    let changed = false
    for (let channel = 0; channel < 4; channel++) {
      const index = start + channel,
        differs = original[index] !== result[index]
      if (!Number.isFinite(candidate[index])) counts.nonFinite++
      if (differs) changed = true
      if (differs && amount === 0) counts.zeroCoverageWordsChanged++
      if (differs && channel === 3) counts.alphaWordsChanged++
      if (differs && channel < 3 && source[start + 3] === 0) counts.hiddenRgbWordsChanged++
    }
    if (changed) counts.changed++
  }
  check(
    !counts.nonFinite &&
      !counts.alphaWordsChanged &&
      !counts.hiddenRgbWordsChanged &&
      !counts.zeroCoverageWordsChanged,
    `Native identity/finite gate failed: ${JSON.stringify(counts)}`,
  )
  return {
    ...counts,
    meanCoverage: sum / counts.pixels,
    zeroFraction: counts.zero / counts.pixels,
    partialFraction: counts.partial / counts.pixels,
    fullFraction: counts.full / counts.pixels,
    exactIdentityGates: 'passed',
  }
}

function compareProof(original, candidate, coverage, signal) {
  check(
    candidate.length === original.length && candidate.length === coverage.length * 4,
    'Proof size differs from the original production proof',
  )
  let zeroPixels = 0,
    changedPixels = 0,
    changedBytes = 0,
    allChangedPixels = 0
  for (let pixel = 0; pixel < coverage.length; pixel++) {
    if ((pixel & 65535) === 0) signal.throwIfAborted()
    let changed = false
    for (let channel = 0; channel < 4; channel++) {
      const index = pixel * 4 + channel
      if (original[index] !== candidate[index]) {
        changed = true
        if (coverage[pixel] === 0) changedBytes++
      }
    }
    if (changed) allChangedPixels++
    if (coverage[pixel] === 0) {
      zeroPixels++
      if (changed) changedPixels++
    }
  }
  return { zeroPixels, changedPixels, changedBytes, allChangedPixels, passed: changedBytes === 0 }
}

async function readProof(directory, frame, asset) {
  check(
    frame.format === 'rgba8-srgb' &&
      frame.width === asset.width &&
      frame.height === asset.height &&
      frame.byteLength === asset.width * asset.height * 4,
    'Production proof format/native dimensions changed',
  )
  check(
    (frame.diagnostics?.proofBackend ?? frame.diagnostics?.backend) === 'gpu',
    'Proof did not use the production GPU owner',
  )
  const pixels = await readFile(join(directory, 'full.rgba'))
  check(
    pixels.length === frame.byteLength && digest(pixels) === frame.sha256,
    'Production proof hash mismatch',
  )
  return pixels
}

async function imageEvidence(directory, pixels, asset, regions, fit = false) {
  const crops = []
  for (const region of regions) {
    check(
      [region.left, region.top, region.width, region.height].every(Number.isSafeInteger) &&
        region.left >= 0 &&
        region.top >= 0 &&
        region.width === 512 &&
        region.height === 512 &&
        region.left + 512 <= asset.width &&
        region.top + 512 <= asset.height,
      'Frozen native crop is outside decoded source',
    )
    const path = join(directory, `${region.name}.png`)
    await sharp(pixels, { raw: { width: asset.width, height: asset.height, channels: 4 } })
      .extract({ left: region.left, top: region.top, width: region.width, height: region.height })
      .png()
      .toFile(path)
    crops.push({ region, ...(await pin(path)), sourcePixelsPerPngPixel: 1 })
  }
  let fitImage
  if (fit) {
    const path = join(directory, 'fit.png')
    const info = await sharp(pixels, {
      raw: { width: asset.width, height: asset.height, channels: 4 },
    })
      .resize({ width: 1100, height: 800, fit: 'inside', withoutEnlargement: true })
      .png()
      .toFile(path)
    fitImage = {
      ...(await pin(path)),
      width: info.width,
      height: info.height,
      purpose: 'Fit-scale SDR appearance only; deliberately resized, never an exact-pixel gate',
    }
  }
  return { crops, fit: fitImage }
}

/** Research-only first photograph. The caller owns the frozen small-reference gate and timeout. */
export async function runPhotographs({ output, prototype, signal }) {
  signal ??= new AbortController().signal
  const directory = join(resolve(output), 'photographs')
  await mkdir(directory, { recursive: false })
  const protocolPath = resolve('assets/tests/references/masked-texture/protocol.json')
  const protocolBytes = await readFile(protocolPath),
    protocol = JSON.parse(protocolBytes)
  check(protocol.id === 'masked-texture-llf-residual-v1', 'Use the frozen LLF protocol')
  if (prototype)
    check(
      JSON.stringify(prototype) === JSON.stringify(protocol),
      'Parent and photograph protocols differ',
    )
  const casesPath = resolve(protocol.photoCases.file),
    casesBytes = await readFile(casesPath)
  check(digest(casesBytes) === protocol.photoCases.sha256, 'Frozen photographic case hash mismatch')
  const cases = JSON.parse(casesBytes)
  const selected = cases.cases.filter((entry) => entry.enabled)
  check(
    selected.length === 1 &&
      selected[0].id === 'flamingo-plumage-ripples-reflected-legs' &&
      selected[0].kind === 'raster',
    'Only the frozen first flamingo photograph is authorized',
  )
  const entry = selected[0]
  await writeFile(join(directory, 'protocol.json'), protocolBytes, { flag: 'wx' })
  await writeFile(join(directory, 'photo-cases.json'), casesBytes, { flag: 'wx' })
  await writeFile(
    join(directory, 'photo-helper.mjs'),
    await readFile(resolve('scripts/research/masked-texture/photo.mjs')),
    { flag: 'wx' },
  )
  const codePaths = [
    'scripts/research/masked-texture/photo.mjs',
    'scripts/research/masked-texture/gpu.mjs',
    'out/main/preview-worker.js',
    'package-lock.json',
    'src/main/preview-engine.ts',
    'src/main/gpu/point-renderer.ts',
    'src/shared/masks-gpu.ts',
    'src/main/processing/detail-preview.ts',
  ]
  const report = {
    version: 1,
    status: 'running',
    startedAt: new Date().toISOString(),
    scope:
      'First flamingo only; neutral point edits, native Float32 research Texture followed by unchanged production GPU SDR proof. No app/settings/history/export enablement, physical HDR or general stack acceptance.',
    protocol: await pin(protocolPath),
    photoCases: await pin(casesPath),
    case: entry,
    code: await Promise.all(codePaths.map(pin)),
    foreground: false,
    productionAlgorithmChanged: false,
    variants: [],
  }
  const reportPath = join(directory, 'result.json')
  const processor = new PreviewProcess(resolve('out/main/preview-worker.js'), 240000, 30000, () =>
    prepareNativeRawExecutable(resolve('out/main')),
  )
  let gpu
  try {
    report.source = await tracked(entry.source, entry.sha256)
    report.notice = await tracked(entry.notice)
    report.licenseNotice = await tracked(entry.licenseNotice)
    check(report.source.bytes === entry.bytes, 'Original photographic byte count changed')
    const notice = JSON.parse(await readFile(entry.notice))
    check(
      notice.files.some(
        (item) =>
          item.sha256 === entry.sha256 &&
          item.width === entry.width &&
          item.height === entry.height,
      ),
      'Fixture notice does not identify the frozen original',
    )
    const metadata = await processor.inspect(resolve(entry.source), signal)
    const options = {
      metadata,
      settings: { ...noLensSettings },
      revision: 0,
      processing: 'display-referred-v1',
      adjustments: structuredClone(neutralAdjustments),
      prepareLinear: true,
    }
    const originalDirectory = join(directory, 'original-source-proof')
    await mkdir(originalDirectory)
    const originalFrame = await processor.renderFull(
      resolve(entry.source),
      originalDirectory,
      signal,
      options,
    )
    check(
      originalFrame.linear &&
        originalFrame.width === entry.width &&
        originalFrame.height === entry.height,
      'Production preparation did not return the complete frozen native source',
    )
    const asset = {
      ...originalFrame.linear,
      width: originalFrame.width,
      height: originalFrame.height,
      path: join(originalDirectory, 'linear.f32'),
    }
    check(
      !asset.hdr && asset.width * asset.height <= protocol.runtime.maxNativePixels,
      'Unexpected domain or native source bound',
    )
    await validateWorkingAsset(asset, signal)
    const originalPixels = await readProof(originalDirectory, originalFrame, asset)
    const originalEvidence = await imageEvidence(
      originalDirectory,
      originalPixels,
      asset,
      entry.regions,
      true,
    )
    const sourceBytes = await readFile(asset.path)
    const sourceData = new Float32Array(
      sourceBytes.buffer,
      sourceBytes.byteOffset,
      sourceBytes.byteLength / 4,
    )
    check(digest(bytesOf(sourceData)) === asset.sha256, 'Prepared source bytes changed')
    const sourceIdentity = workingSourceIdentity(entry.sha256, options, false)
    const hardware = await observeResourceHardware()
    const policy = resolveResourcePolicy(
      DEFAULT_RESOURCE_SETTINGS,
      { ram: hardware.ram, gpu: { status: 'unknown', reason: 'adapter-unverified' } },
      0,
    )
    // Parent source/candidate/previous arrays, proof worker frames, QA coverage and codec ownership.
    const reservation = {
      ramBytes:
        asset.byteLength * 5 +
        originalPixels.byteLength * 4 +
        asset.width * asset.height * 4 * 3 +
        32 * 1024 ** 2,
      vramBytes: 0,
    }
    check(
      reservation.ramBytes < policy.ram.effectiveBytes,
      'Photographic parent ownership exceeds Automatic RAM',
    )
    const admission = { policy, reservation }
    report.hardware = hardware
    report.admission = admission
    report.asset = asset
    report.sourceIdentity = sourceIdentity
    report.preparation =
      'linear.f32 precedes point edits; all point edits frozen neutral/AsShot. The existing proof shader and transform run once unchanged.'
    report.original = { directory: originalDirectory, frame: originalFrame, ...originalEvidence }
    const proofOptions = {
      ...options,
      prepareLinear: false,
      workingOnly: false,
      crop: undefined,
      workingAsset: asset,
      adjustments: structuredClone(neutralAdjustments),
    }
    const baselineDirectory = join(directory, 'prepared-neutral-baseline')
    await mkdir(baselineDirectory)
    const baseline = await processor.renderPreparedFull(
      baselineDirectory,
      proofOptions,
      signal,
      'gpu',
    )
    const baselinePixels = await readProof(baselineDirectory, baseline, asset)
    let baselineDifferentBytes = 0
    for (let index = 0; index < originalPixels.length; index++)
      if (originalPixels[index] !== baselinePixels[index]) baselineDifferentBytes++
    report.baseline = {
      directory: baselineDirectory,
      frame: baseline,
      originalProofDifferentBytes: baselineDifferentBytes,
      exactOriginalProductionProof: baselineDifferentBytes === 0,
      ...(await imageEvidence(baselineDirectory, baselinePixels, asset, entry.regions, true)),
    }
    await save(reportPath, report)
    check(
      baselineDifferentBytes === 0,
      `Prepared/direct baseline differs in ${baselineDifferentBytes} RGBA bytes; original production proof gate retained`,
    )
    const masks = masksFor(entry, asset)
    const maskParameters = {
      localMasks: masks,
      maskGeometry: asset.maskGeometry ?? identityMaskGeometry(asset.width, asset.height),
    }
    report.maskParameters = maskParameters
    const coverageRecords = new Map()
    const coverageDirectory = join(directory, 'coverage')
    await mkdir(coverageDirectory)
    gpu = await createTextureGpu()
    report.sourcePreparation = await gpu.prepare(
      { data: sourceData, width: asset.width, height: asset.height, primaries: 'srgb', admission },
      signal,
    )
    // The LLF owner stays alive while the separate production proof owner runs.
    const concurrentAdmission = {
      policy,
      reservation: {
        ramBytes: reservation.ramBytes + report.sourcePreparation.estimatedRamBytes,
        vramBytes: report.sourcePreparation.estimatedGpuBytes,
      },
    }
    report.concurrentProofPlan = detailProofMemoryPlan(asset, concurrentAdmission, {
      hdr: false,
      authoredHdr: false,
      preferGpu: true,
    })
    report.concurrentComparatorPlan = detailPreviewMemoryPlan(asset, concurrentAdmission, {
      hdr: false,
      authoredHdr: false,
      preferGpu: true,
      workingOnly: false,
    })
    check(
      report.concurrentProofPlan.accepted &&
        report.concurrentComparatorPlan.filter.gpuAccepted &&
        report.concurrentComparatorPlan.peakGpuBytes <= policy.vram.effectiveBytes,
      'Simultaneous LLF/proof/comparator exceeds frozen Automatic admission',
    )
    await save(reportPath, report)

    async function retainCoverage(id, coverage) {
      const sha256 = digest(bytesOf(coverage))
      const previous = coverageRecords.get(id)
      if (previous) {
        check(previous.sha256 === sha256, `Frozen mask coverage changed: ${id}`)
        return previous
      }
      const path = join(coverageDirectory, `${id}.f32`)
      await writeFile(path, bytesOf(coverage), { flag: 'wx' })
      const record = {
        ...(await pin(path)),
        width: asset.width,
        height: asset.height,
        format: 'float32-coverage-native',
        quantization: 'none',
      }
      coverageRecords.set(id, record)
      return record
    }

    async function renderCandidate(
      name,
      result,
      original,
      regions,
      controls,
      fit = false,
      comparisonCoverage = result.coverage,
    ) {
      signal.throwIfAborted()
      const qa = inspectCandidate(original, result.data, result.coverage, signal)
      const destination = join(directory, name)
      await mkdir(destination)
      const path = join(destination, 'linear.f32'),
        sha256 = digest(bytesOf(result.data))
      await writeFile(path, bytesOf(result.data), { flag: 'wx' })
      const working = { ...asset, path, sha256 }
      await validateWorkingAsset(working, signal)
      const frame = await processor.renderPreparedFull(
        destination,
        { ...proofOptions, workingAsset: working },
        signal,
        'gpu',
      )
      const pixels = await readProof(destination, frame, asset)
      const unmaskedProof = compareProof(originalPixels, pixels, comparisonCoverage, signal)
      const record = {
        name,
        controls,
        directory: destination,
        asset: working,
        frame,
        adapter: result.adapter,
        qa,
        unmaskedProof,
        ...(await imageEvidence(destination, pixels, asset, regions, fit)),
      }
      report.variants.push(record)
      await save(reportPath, report)
      check(
        unmaskedProof.passed,
        `Unmasked production proof pixels changed: ${name}: ${JSON.stringify(unmaskedProof)}`,
      )
      return record
    }

    const amounts = [...protocol.variants.moderate, ...protocol.variants.stress].filter(
      (amount) => amount !== 0,
    )
    check(
      JSON.stringify(amounts) === JSON.stringify([-25, 25, -100, 100]),
      'Frozen amount matrix changed',
    )
    for (const [maskIndex, mask] of masks.entries()) {
      const region = entry.regions.find((item) => item.name === `${mask.id}-native`)
      check(region, `No fixed native crop for ${mask.id}`)
      for (const amount of amounts) {
        const result = await gpu.apply({ amount, maskParameters, maskIndex }, signal)
        const coverage = await retainCoverage(mask.id, result.coverage)
        const name = `texture-${mask.id}-${amount < 0 ? 'minus' : 'plus'}${Math.abs(amount)}`
        const record = await renderCandidate(name, result, sourceData, [region], {
          amount,
          maskId: mask.id,
          source: 'original-native-source',
          coverage,
        })
        console.log(
          JSON.stringify({
            photograph: entry.id,
            variant: name,
            status: 'generated-unreviewed',
            sha256: record.frame.sha256,
          }),
        )
      }
    }

    const comparatorDirectory = join(directory, 'global-sharpen-50-1-50')
    await mkdir(comparatorDirectory)
    const comparator = await processor.prepareDetailPreview(
      asset.path,
      comparatorDirectory,
      {
        ...concurrentAdmission,
        asset,
        sourceIdentity,
        noiseReduction: { version: 1, luminance: 0, chroma: 0 },
        detailSharpening: { version: 1, amount: 50, radius: 1, threshold: 50 },
        options: proofOptions,
        workingOnly: false,
        backend: 'gpu',
      },
      signal,
    )
    check(
      comparator.detail?.backend === 'gpu' &&
        comparator.detail.cpuTiles === 0 &&
        comparator.detail.precisionRecoveryTiles === 0 &&
        comparator.detail.gpuTiles > 0 &&
        comparator.detail.sourceSha256 === asset.sha256,
      'Global sharpening comparator did not use the existing GPU source owner',
    )
    const comparatorPixels = await readProof(comparatorDirectory, comparator, asset)
    report.comparator = {
      name: 'global-sharpen-50-1-50',
      scope:
        'Existing global saved-detail reference, not mask-local Texture or an unchanged-unmasked comparator',
      directory: comparatorDirectory,
      frame: comparator,
      ...(await imageEvidence(comparatorDirectory, comparatorPixels, asset, entry.regions, true)),
    }
    await save(reportPath, report)

    const union = new Float32Array(asset.width * asset.height)
    let preceding = sourceData
    const sequence = []
    for (const [step, mask] of [...masks].reverse().entries()) {
      const maskIndex = masks.findIndex((item) => item.id === mask.id),
        amount = protocol.variants.independentAmounts[mask.id]
      check(Number.isInteger(amount), `Missing independent frozen amount: ${mask.id}`)
      const preparation = await gpu.prepare(
        { data: preceding, width: asset.width, height: asset.height, primaries: 'srgb', admission },
        signal,
      )
      const result = await gpu.apply({ amount, maskParameters, maskIndex }, signal)
      const coverage = await retainCoverage(mask.id, result.coverage)
      const qa = inspectCandidate(preceding, result.data, result.coverage, signal)
      for (let pixel = 0; pixel < union.length; pixel++)
        union[pixel] = Math.max(union[pixel], result.coverage[pixel])
      const stepDirectory = join(directory, `combined-step-${step + 1}-${mask.id}`)
      await mkdir(stepDirectory)
      const path = join(stepDirectory, 'linear.f32')
      await writeFile(path, bytesOf(result.data), { flag: 'wx' })
      sequence.push({
        step: step + 1,
        maskId: mask.id,
        amount,
        preparation,
        coverage,
        qa,
        sourceSha256: digest(bytesOf(preceding)),
        output: await pin(path),
      })
      preceding = result.data
      report.combinedSequence = sequence
      await save(reportPath, report)
    }
    const unionPath = join(coverageDirectory, 'combined-union.f32')
    await writeFile(unionPath, bytesOf(union), { flag: 'wx' })
    const combined = await renderCandidate(
      'texture-independent-combined',
      { data: preceding, coverage: union, adapter: report.sourcePreparation.adapter },
      sourceData,
      entry.regions,
      {
        order: sequence.map(({ maskId, amount }) => ({ maskId, amount })),
        coverage: await pin(unionPath),
        source: 'True sequential preceding outputs; each field re-prepared before next mask',
      },
      true,
    )
    report.combined = combined
    await validateWorkingAsset(asset, signal)
    check(
      (await hash(join(originalDirectory, 'full.rgba'))) === originalFrame.sha256,
      'Original production proof was modified',
    )
    await tracked(entry.source, entry.sha256)
    check(
      (await tracked(entry.notice)).sha256 === report.notice.sha256 &&
        (await tracked(entry.licenseNotice)).sha256 === report.licenseNotice.sha256,
      'Source/permission notice changed during research',
    )
    report.codeAfter = await Promise.all(codePaths.map(pin))
    check(
      JSON.stringify(report.codeAfter) === JSON.stringify(report.code),
      'Source/proof code changed during photographic generation',
    )
    report.status = 'generated-unreviewed'
  } catch (error) {
    report.status = 'failed'
    report.error = String(error.stack ?? error)
    throw error
  } finally {
    const cleanup = await Promise.allSettled([gpu?.close(), processor.close(true)])
    const failures = cleanup
      .filter((result) => result.status === 'rejected')
      .map((result) => String(result.reason))
    if (failures.length) {
      report.cleanupErrors = failures
      report.status = 'failed'
    }
    report.finishedAt = new Date().toISOString()
    await save(reportPath, report)
    await writeFile(
      join(directory, 'summary.md'),
      `# Masked Texture first photograph: ${report.status}\n\n${report.error ?? 'Fixed primary flamingo evidence generated. Visual quality remains unreviewed; supplemental sources are inactive.'}\n\nNeutral point edits only; unchanged production GPU SDR proof, native Float32 zero-coverage/alpha gates and original-source proof comparison. No app/schema/UI/history, foreground, automatic CPU retry, full integration or physical HDR acceptance. Read result.json for frozen sources, masks, protocol and actual diagnostics.\n`,
    )
  }
  if (report.cleanupErrors?.length)
    throw new Error(`Photographic owner cleanup failed: ${report.cleanupErrors.join('; ')}`)
  return { ...report, reportPath }
}
