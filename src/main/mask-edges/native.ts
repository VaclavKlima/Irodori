import { createHash } from 'node:crypto'
import type { AdjustmentParameters } from '../../shared/adjustments'
import type { CropAdmission } from '../../shared/crop-resources'
import { EXPORT_ENCODER_LIMIT_BYTES, ExportResourceError } from '../../shared/export-resources'
import {
  maskEdgeMemoryPlan,
  maskEdgeOwnBytes,
  maskEdgePixelIdentity,
} from '../../shared/mask-edges'
import {
  maskBaseReference,
  maskCapabilities,
  maskHasEdges,
  hasMaskAdjustments,
  validateMaskEdge,
  validatePreparedMaskCoverage,
  type PreparedMaskCoverage,
  type ResolvedMask,
  neutralMaskLight,
  neutralMaskColor,
} from '../../shared/masks'
import { maskCoverageNodes, mapMaskCoverage } from '../../shared/masks-gpu'
import { verifiedMaskBaseBytes } from '../mask-store'
import { prepareMaskEdgeCoverage } from './gpu'

export interface NativeMaskEdgeOptions {
  readonly signal?: AbortSignal
  readonly edgeAdmission?: CropAdmission
}

/** Enabled local adjustments share prepared coverage in the native photograph point pass. */
export function activeNativeMaskEdges(adjustments: Pick<AdjustmentParameters, 'localMasks'>) {
  for (const mask of adjustments.localMasks ?? [])
    for (const node of maskCoverageNodes(mask, true)) validateMaskEdge(node.edge)
  const active: ResolvedMask[] = []
  const visit = (node: ResolvedMask) => {
    if (!node.preparedCoverage)
      for (const child of node.operands ?? [])
        if (child.enabled) visit({ ...child, light: neutralMaskLight, color: neutralMaskColor })
    if (maskHasEdges(node)) active.push(node)
  }
  for (const mask of adjustments.localMasks ?? [])
    if (mask.enabled && hasMaskAdjustments(mask)) visit(mask)
  return active
}

function validateCoverage(coverage: PreparedMaskCoverage, width: number, height: number) {
  validatePreparedMaskCoverage(coverage)
  if (coverage.width !== width || coverage.height !== height)
    throw new Error('Prepared mask coverage differs from the canonical source grid.')
  verifiedMaskBaseBytes({ ...maskBaseReference(coverage), pngBase64: coverage.pngBase64 })
}

/** The accepted isolated native codec encodes R8 GPU results; it performs no mask filtering. */
async function encodedCoverage(
  device: GPUDevice,
  mask: ResolvedMask,
  width: number,
  height: number,
  signal: AbortSignal,
) {
  for (const node of maskCoverageNodes(mask)) if (node.base) verifiedMaskBaseBytes(node.base)
  const pixels = await prepareMaskEdgeCoverage(device, mask, width, height, signal)
  signal.throwIfAborted()
  if (pixels.byteLength !== width * height)
    throw new Error('Native mask edge coverage is incomplete.')
  const sharp = (await import('sharp')).default
  const png = await sharp(Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength), {
    raw: { width, height, channels: 1 },
    limitInputPixels: width * height,
  })
    .toColourspace('b-w')
    .png({ compressionLevel: 6, palette: false })
    .toBuffer()
  signal.throwIfAborted()
  if (png.byteLength > maskCapabilities.maxBaseEncodedBytes)
    throw new Error(
      'Prepared mask edges exceed the 16 MiB transfer limit. Reset Mask edges or use fewer corrected boundaries.',
    )
  const key = createHash('sha256')
    .update(JSON.stringify([width, height, maskEdgePixelIdentity(mask)]))
    .digest('hex')
  const coverage: PreparedMaskCoverage = {
    version: 1,
    key,
    width,
    height,
    hash: createHash('sha256').update(png).digest('hex'),
    pngBase64: png.toString('base64'),
  }
  validateCoverage(coverage, width, height)
  return coverage
}

/** Prepare sequentially on the same selected Dawn device, before point-render buffers exist. */
export async function prepareNativeMaskEdges(
  device: GPUDevice,
  adjustments: AdjustmentParameters,
  width: number,
  height: number,
  vramLimitBytes: number,
  options: NativeMaskEdgeOptions = {},
): Promise<{ adjustments: AdjustmentParameters; peakBytes: number }> {
  if (process.versions.electron)
    throw new Error('Native mask edge preparation requires the isolated Node worker.')
  const signal = options.signal ?? new AbortController().signal
  signal.throwIfAborted()
  const active = activeNativeMaskEdges(adjustments)
  if (!active.length) return { adjustments, peakBytes: 0 }
  const missing = active.filter((mask) => !mask.preparedCoverage)
  const own = maskEdgeOwnBytes(width, height, missing)
  const plan = options.edgeAdmission
    ? maskEdgeMemoryPlan(width, height, missing, options.edgeAdmission)
    : undefined
  if (
    !Number.isSafeInteger(vramLimitBytes) ||
    vramLimitBytes < 0 ||
    own.ownGpu > vramLimitBytes ||
    own.ownRam > EXPORT_ENCODER_LIMIT_BYTES ||
    (plan && !plan.accepted)
  )
    throw new ExportResourceError(
      'Mask edge preparation exceeds the frozen native image budgets. Reset Mask edges or close other processing before retrying GPU.',
    )
  const prepared = new Map<string, PreparedMaskCoverage>()
  let encodedBytes = 0
  for (const mask of active) {
    signal.throwIfAborted()
    const input = mapMaskCoverage(mask, (node) =>
      node.id !== mask.id && prepared.has(node.id)
        ? { ...node, preparedCoverage: prepared.get(node.id)! }
        : node,
    )
    const coverage =
      mask.preparedCoverage ?? (await encodedCoverage(device, input, width, height, signal))
    validateCoverage(coverage, width, height)
    encodedBytes += Buffer.byteLength(coverage.pngBase64, 'base64')
    if (encodedBytes > maskCapabilities.maxLiveBaseEncodedBytes)
      throw new ExportResourceError(
        'Prepared mask edges exceed the 32 MiB live transfer limit. Reset Mask edges on an unused mask before retrying GPU.',
      )
    prepared.set(mask.id, coverage)
  }
  signal.throwIfAborted()
  return {
    adjustments: {
      ...adjustments,
      localMasks: adjustments.localMasks?.map((mask) =>
        mapMaskCoverage(mask, (node) =>
          prepared.has(node.id) ? { ...node, preparedCoverage: prepared.get(node.id)! } : node,
        ),
      ),
    },
    peakBytes: own.ownGpu,
  }
}
