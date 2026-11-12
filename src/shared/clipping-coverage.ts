import type { AdjustmentParameters } from './adjustments'
import { maskEdgeOwnBytes } from './mask-edges'
import { maskOutputSize, validateMaskGeometry } from './mask-geometry'
import { hasMaskAdjustments, maskCapabilities, type ResolvedMask } from './masks'
import {
  localMaskAllocationBytes,
  mapMaskCoverage,
  maskCoverageNodes,
  maskHasCoverage,
} from './masks-gpu'

export const CLIPPING_COVERAGE_ROWS = 64

/** The native exact classifier and GPU sampler must consume the same root order. */
export function clippingCoverageMasks(
  parameters: Pick<AdjustmentParameters, 'localMasks'>,
): ResolvedMask[] {
  return (parameters.localMasks ?? []).filter(
    (mask) => mask.enabled && maskHasCoverage(mask) && hasMaskAdjustments(mask),
  )
}

/** Conservative additional ownership for GPU coverage preparation and its native feed.
 * The file is streamed; no full Float32 coverage plane is retained in memory. */
export function clippingCoverageMemory(
  width: number,
  height: number,
  parameters: Pick<AdjustmentParameters, 'localMasks' | 'maskGeometry'>,
) {
  if (
    ![width, height].every((value) => Number.isSafeInteger(value) && value > 0 && value <= 32768) ||
    width * height * 16 > 512 * 1024 ** 2
  )
    throw new Error('Unsupported clipping coverage source geometry.')
  // Prepared pixels belong to their renderer/source owner and cannot change
  // the request's admission. Main independently prepares the authored coverage.
  const masks = clippingCoverageMasks(parameters).map((root) =>
    mapMaskCoverage(root, (node) => ({ ...node, preparedCoverage: undefined })),
  )
  const maskCount = masks.length
  if (!maskCount) return { ramBytes: 0, vramBytes: 0, maskCount, stripBytes: 0, byteLength: 0 }
  if (parameters.maskGeometry) {
    validateMaskGeometry(parameters.maskGeometry)
    const output = maskOutputSize(parameters.maskGeometry)
    if (output.width !== width || output.height !== height)
      throw new Error('Clipping coverage differs from the authoritative working source grid.')
  }
  const selected = { ...parameters, localMasks: masks }
  const canonicalWidth = parameters.maskGeometry?.canonicalWidth ?? width
  const canonicalHeight = parameters.maskGeometry?.canonicalHeight ?? height
  const edges = maskEdgeOwnBytes(canonicalWidth, canonicalHeight, masks)
  const geometryAndAtlas = localMaskAllocationBytes(selected, { width, height })
  const stripBytes = width * Math.min(CLIPPING_COVERAGE_ROWS, height) * maskCount * 4
  const encoded = new Map<string, number>()
  for (const root of masks)
    for (const node of maskCoverageNodes(root)) {
      if (node.base) encoded.set(node.base.hash, node.base.pngBase64.length * 2)
    }
  const strings = [...encoded.values()].reduce((sum, bytes) => sum + bytes, 0)
  const bytes = {
    // Two parameter clones, retained encoded edges, codec/atlas decode and the
    // main/native coverage strips are charged even across sequential phases.
    ramBytes:
      edges.ownRam +
      geometryAndAtlas * 2 +
      strings * 3 +
      maskCapabilities.maxLiveBaseEncodedBytes * 4 +
      canonicalWidth * canonicalHeight * 4 +
      stripBytes * 3 +
      4096,
    vramBytes: edges.ownGpu + geometryAndAtlas + stripBytes * 2 + 4096,
    maskCount,
    stripBytes,
    byteLength: width * height * maskCount * 4,
  }
  if (Object.values(bytes).some((value) => !Number.isSafeInteger(value) || value < 0))
    throw new Error('Invalid clipping coverage managed reservation.')
  return bytes
}
