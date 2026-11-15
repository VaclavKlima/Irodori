import { createHash } from 'node:crypto'
import { open, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { AdjustmentParameters, DisplayTransform } from '../../shared/adjustments'
import type { DetailAdmission } from '../../shared/detail-resources'
import { validateExportAdmission } from '../../shared/export-resources'
import { hasMaskedTexture, maskedTextureKey } from '../../shared/masked-texture'
import { createTextureGpu } from '../gpu/masked-texture.mjs'
import { createOrderedPointGpu, type TexturePointJob } from '../gpu/masked-texture-point.mjs'
import { validateWorkingAsset } from '../working-assets'
import {
  PREPARED_MASK_STACK_CONSUMED,
  PREPARED_MASK_STACK_GRID_POLICY,
  PREPARED_MASK_STACK_POLICY,
  preparedMaskStackContext,
  preparedMaskStackKey,
  validatePreparedMaskStack,
  type PreparedMaskStack,
  type PreparedMaskStackParent,
  type PreparedMaskStackRequest,
} from './prepared-mask-stack'

export interface MaskStackPreparationJob {
  readonly parent: PreparedMaskStackParent
  readonly adjustments: AdjustmentParameters
  readonly domain: 'raster' | 'scene-linear' | 'authored-hdr'
  readonly transform?: DisplayTransform
  readonly whiteBalance?: readonly number[]
  readonly admission: DetailAdmission
}
export interface MaskStackPreparationResult {
  readonly request?: PreparedMaskStackRequest
  readonly skipped: boolean
  readonly adapter?: string
  readonly textureJobs: number
  readonly memory?: { readonly ramBytes: number; readonly gpuBytes: number }
}
const digest = (data: ArrayBufferView) =>
  createHash('sha256')
    .update(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
    .digest('hex')
const words = (data: Float32Array<ArrayBuffer>) =>
  new Uint32Array(data.buffer, data.byteOffset, data.length)

/** Complete native crop preparation. Every root sees its complete preceding spatial/point prefix.
 * No output is published until the immutable source and the final receipt validate.
 */
export async function prepareMaskStack(
  outputDirectory: string,
  input: MaskStackPreparationJob,
  signal: AbortSignal,
): Promise<MaskStackPreparationResult> {
  if (process.versions.electron)
    throw new Error('Texture preparation requires the isolated Node worker.')
  const job = structuredClone(input)
  signal.throwIfAborted()
  if (!hasMaskedTexture(job.adjustments)) return { skipped: true, textureJobs: 0 }
  validateExportAdmission(job.admission)
  const asset = job.parent.asset,
    count = asset.width * asset.height,
    metadataBytes = Buffer.byteLength(JSON.stringify(job.adjustments)) * 4,
    candidatePath = resolve(join(outputDirectory, 'mask-stack.f32')),
    unionPath = resolve(join(outputDirectory, 'mask-union.f32'))
  if ([candidatePath, unionPath].includes(resolve(asset.path)))
    throw new Error('Texture output must not overlap its immutable parent.')
  if (
    count > 24_000_000 ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    asset.byteLength * 8 + count * 12 + metadataBytes + job.admission.reservation.ramBytes >
      job.admission.policy.ram.effectiveBytes
  )
    throw new Error(
      'Automatic resource policy refuses complete ordered Texture preparation; no reduced-resolution retry.',
    )
  const pointContext = preparedMaskStackContext(job)
  await validateWorkingAsset(asset, signal)
  const bytes = await readFile(asset.path)
  signal.throwIfAborted()
  if (bytes.byteLength !== asset.byteLength || digest(bytes) !== asset.sha256)
    throw new Error('Texture parent changed during acquisition.')
  const backing = bytes.byteOffset % 4 === 0 ? bytes : Buffer.from(Uint8Array.from(bytes).buffer)
  const data = new Float32Array(
    backing.buffer as ArrayBuffer,
    backing.byteOffset,
    backing.byteLength / 4,
  )
  const reserve = (ramBytes: number): DetailAdmission => ({
    policy: job.admission.policy,
    reservation: {
      ramBytes: job.admission.reservation.ramBytes + ramBytes,
      vramBytes: job.admission.reservation.vramBytes,
    },
  })
  // Source, rolling prefix/candidate and union are additional live owners during each bounded GPU pass.
  const admission = reserve(asset.byteLength * 3 + count * 12 + metadataBytes)
  const pointJob: TexturePointJob = {
    width: asset.width,
    height: asset.height,
    domain: job.domain,
    data,
    adjustments: job.adjustments,
    maskParameters: job.adjustments,
    transform: job.transform ?? asset.transform,
    whiteBalance: job.whiteBalance,
    admission,
  }
  const point = await createOrderedPointGpu()
  let candidateFile: Awaited<ReturnType<typeof open>> | undefined,
    unionFile: Awaited<ReturnType<typeof open>> | undefined,
    ownedCandidate = false,
    ownedUnion = false,
    complete = false
  let textureJobs = 0,
    peakRam = 0,
    peakGpu = 0
  const remember = (memory: { ramBytes: number; gpuBytes: number }) => {
    peakRam = Math.max(peakRam, memory.ramBytes + admission.reservation.ramBytes)
    peakGpu = Math.max(peakGpu, memory.gpuBytes + admission.reservation.vramBytes)
  }
  try {
    candidateFile = await open(candidatePath, 'wx')
    ownedCandidate = true
    unionFile = await open(unionPath, 'wx')
    ownedUnion = true
    const global = await point.global(pointJob, signal)
    remember(global.memory)
    let current = global.data
    let union = new Float32Array(count)
    const fullCoverage = new Float32Array(count).fill(1)
    const masks = job.adjustments.localMasks ?? []
    for (let index = masks.length - 1; index >= 0; index--) {
      signal.throwIfAborted()
      const root = masks[index],
        amount = root.texture ?? 0
      if (
        !root.enabled ||
        (amount === 0 &&
          !Object.values(root.light).some(Boolean) &&
          !Object.values(root.color).some(Boolean))
      )
        continue
      const previous = current
      const probe = await point.root(
        { ...pointJob, previous, candidate: previous, maskIndex: index },
        signal,
      )
      remember(probe.memory)
      let result = probe
      if (amount !== 0 && probe.coverage.some((value) => value > 0)) {
        const texture = await createTextureGpu()
        let candidate: Float32Array<ArrayBuffer>
        try {
          const preparation = await texture.prepare(
            {
              data: previous,
              width: asset.width,
              height: asset.height,
              primaries: job.domain === 'raster' ? 'srgb' : 'rec2020',
              admission,
            },
            signal,
          )
          peakRam = Math.max(
            peakRam,
            preparation.estimatedRamBytes + admission.reservation.ramBytes,
          )
          peakGpu = Math.max(
            peakGpu,
            preparation.estimatedGpuBytes + admission.reservation.vramBytes,
          )
          candidate = (await texture.apply({ amount, coverage: fullCoverage }, signal)).data
          textureJobs++
        } finally {
          await texture.close()
        }
        result = await point.root({ ...pointJob, previous, candidate, maskIndex: index }, signal)
        remember(result.memory)
        const combined = await point.union(
          { ...pointJob, coverages: [union, result.coverage] },
          signal,
        )
        remember(combined.memory)
        union = combined.coverage
      }
      current = result.data
    }
    if (!textureJobs)
      return {
        skipped: true,
        textureJobs: 0,
        adapter: point.adapter,
        memory: { ramBytes: peakRam, gpuBytes: peakGpu },
      }
    const legacy = await point.legacy(pointJob, signal)
    remember(legacy.memory)
    const selected = await point.select(
      {
        ...pointJob,
        legacy: words(legacy.data),
        candidate: words(current),
        coverage: union,
        alpha: data,
        wordsPerPixel: 4,
      },
      signal,
    )
    remember(selected.memory)
    const candidate = new Float32Array(
      selected.data.buffer,
      selected.data.byteOffset,
      selected.data.length,
    )
    signal.throwIfAborted()
    const candidateBytes = Buffer.from(
        candidate.buffer,
        candidate.byteOffset,
        candidate.byteLength,
      ),
      unionBytes = Buffer.from(union.buffer, union.byteOffset, union.byteLength)
    await candidateFile.writeFile(candidateBytes)
    await unionFile.writeFile(unionBytes)
    await candidateFile.close()
    candidateFile = undefined
    await unionFile.close()
    unionFile = undefined
    signal.throwIfAborted()
    const unkeyed: Omit<PreparedMaskStack, 'key'> = {
      policy: PREPARED_MASK_STACK_POLICY,
      state: 'complete',
      consumed: PREPARED_MASK_STACK_CONSUMED,
      gridPolicy: PREPARED_MASK_STACK_GRID_POLICY,
      domain: job.domain,
      parent: job.parent,
      context: pointContext,
      textureIdentity: createHash('sha256')
        .update(maskedTextureKey(job.adjustments)!)
        .digest('hex'),
      candidate: {
        path: candidatePath,
        width: asset.width,
        height: asset.height,
        byteLength: candidate.byteLength,
        sha256: digest(candidate),
      },
      union: { path: unionPath, byteLength: union.byteLength, sha256: digest(union) },
    }
    const stack: PreparedMaskStack = { ...unkeyed, key: preparedMaskStackKey(unkeyed) }
    validatePreparedMaskStack(stack, job)
    complete = true
    return {
      request: { stack, admission: job.admission },
      skipped: false,
      adapter: point.adapter,
      textureJobs,
      memory: { ramBytes: peakRam, gpuBytes: peakGpu },
    }
  } finally {
    try {
      await point.close()
    } finally {
      try {
        await candidateFile?.close()
      } finally {
        try {
          await unionFile?.close()
        } finally {
          if (ownedCandidate && !complete) await rm(candidatePath, { force: true })
          if (ownedUnion && !complete) await rm(unionPath, { force: true })
        }
      }
    }
  }
}
