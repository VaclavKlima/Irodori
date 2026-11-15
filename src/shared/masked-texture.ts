import { adjustmentPixelKey, type AdjustmentParameters } from './adjustments'
import type { EditSettings } from './edits'
import { hasMaskAdjustments, type MaskCoverageNode, type MaskDescriptor } from './masks'
import { maskHasCoverage } from './masks-gpu'

export const MASKED_TEXTURE_POLICY = 'masked-texture-cropped-stack-v1'

/** Rendering the compatibility parent must not activate a previously neutral point root. */
export function pointOnlyMaskAdjustments<T extends Pick<AdjustmentParameters, 'localMasks'>>(
  parameters: T,
): T {
  if (!parameters.localMasks?.some((mask) => (mask.texture ?? 0) !== 0)) return parameters
  return {
    ...parameters,
    localMasks: parameters.localMasks.map((mask) =>
      (mask.texture ?? 0) === 0 ? mask : { ...mask, texture: 0 },
    ),
  }
}

/** Only enabled, potentially nonempty spatial roots require preparation. */
export function hasMaskedTexture(parameters: Pick<AdjustmentParameters, 'localMasks'>): boolean {
  return Boolean(
    parameters.localMasks?.some(
      (mask) => mask.enabled && (mask.texture ?? 0) !== 0 && maskHasCoverage(mask),
    ),
  )
}

/** Complete preceding point/coverage context invalidates an ordered spatial prefix. */
export function maskedTextureKey(parameters: AdjustmentParameters): string | undefined {
  return hasMaskedTexture(parameters)
    ? JSON.stringify([MASKED_TEXTURE_POLICY, adjustmentPixelKey(parameters)])
    : undefined
}

function authoredCoverage(node: MaskCoverageNode): unknown {
  return {
    inverted: node.inverted,
    head: node.head,
    resultHead: node.resultHead ?? null,
    edge: node.edge,
    base: node.base ?? null,
    gradient: node.gradient ?? null,
    range: node.range ?? null,
    operands: (node.operands ?? [])
      .filter((part) => part.enabled)
      .map((part) => ({ operator: part.operator, coverage: authoredCoverage(part) })),
  }
}

/** Catalog invalidation uses immutable authored stroke/base references, never derived coverage.
 * Names, selected IDs and disabled trees do not affect pixels. Existing global Detail keeps its
 * own source key; this additional key exists only while a Texture amount is active.
 */
export function maskedTextureSettingsKey(settings: Partial<EditSettings>): string | undefined {
  if (
    !(settings.maskStack ?? []).some(
      (mask) => mask.enabled && (mask.texture ?? 0) !== 0 && authoredHasCoverage(mask),
    )
  )
    return
  const { version: _version, maskStack, ...global } = settings
  void _version
  const roots = maskStack!
    .filter((mask) => mask.enabled && hasMaskAdjustments(mask))
    .map((mask: MaskDescriptor) => ({
      coverage: authoredCoverage(mask),
      light: mask.light,
      color: mask.color,
      texture: mask.texture,
    }))
  return JSON.stringify([MASKED_TEXTURE_POLICY, global, roots])
}

function authoredHasCoverage(node: MaskCoverageNode): boolean {
  return Boolean(
    node.base ||
    node.gradient ||
    node.range ||
    node.inverted ||
    node.head ||
    node.resultHead ||
    node.operands?.some(
      (part) => part.enabled && part.operator === 'add' && authoredHasCoverage(part),
    ),
  )
}
