import {
  neutralMaskColor,
  neutralMaskEdge,
  validateMaskStack,
  type MaskDescriptor,
  coverageNodes,
} from '../../shared/masks'
import type { DatabaseSync } from 'node:sqlite'
import { identityToneCurves, validateToneCurves } from '../../shared/tone-curves'
import { SETTINGS_VERSION, validatePatch } from '../../shared/edits'
import { identityCrop, isUncropped, validateCrop } from '../../shared/crop'
import { neutralColorMixer, validateColorMixer } from '../../shared/color-mixer'
import { neutralColorGrading, validateColorGrading } from '../../shared/color-grading'
import {
  neutralNoiseReduction,
  neutralDetailSharpening,
  validateNoiseReduction,
  validateDetailSharpening,
} from '../../shared/spatial-detail'

export const CATALOG_VERSION = 29

/** Validate the entire library before startup permits any migration or recovery write. */
export function supportsEditingSettings(
  settings: Record<string, unknown> | undefined,
  catalogVersion?: number,
): boolean {
  if (!settings || !['hdr-v1', 'display-referred-v1'].includes(String(settings.processing)))
    return false
  if (
    (settings.version as number) < 11 &&
    ('noiseReduction' in settings || 'detailSharpening' in settings)
  )
    return false
  if ((settings.version as number) < 12 && 'curves' in settings) return false
  if ((settings.version as number) < 13 && 'maskStack' in settings) return false
  if ((settings.version as number) < 10 && ('colorMixer' in settings || 'colorGrading' in settings))
    return false
  const legacy = settings.version === 7
  if (
    ![7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, SETTINGS_VERSION].includes(
      settings.version as number,
    )
  )
    return false
  if (
    catalogVersion !== undefined &&
    settings.version !==
      (
        {
          17: 7,
          18: 8,
          19: 9,
          20: 10,
          21: 11,
          22: 12,
          23: 13,
          24: 14,
          25: 15,
          26: 16,
          27: 17,
          28: 18,
          29: SETTINGS_VERSION,
        } as Record<number, number>
      )[catalogVersion]
  )
    return false
  if (
    legacy &&
    ((settings.saturation !== undefined && settings.saturation !== 0) ||
      (settings.vibrance !== undefined && settings.vibrance !== 0))
  )
    return false
  try {
    if ((settings.version as number) >= 12) validateToneCurves(settings.curves)
    if ((settings.version as number) >= 13) {
      if (!Array.isArray(settings.maskStack)) return false
      const version = settings.version as number
      if (
        version < 19 &&
        settings.maskStack.some((mask) =>
          coverageNodes(mask).some((node) => Object.hasOwn(node, 'range')),
        )
      )
        return false
      if (
        settings.maskStack.some(
          (mask) =>
            !mask ||
            typeof mask !== 'object' ||
            (version < 15 && Object.hasOwn(mask, 'edge')) ||
            (version < 16 && Object.hasOwn(mask, 'color')) ||
            (version < 17 && Object.hasOwn(mask, 'gradient')) ||
            (version < 18 &&
              (Object.hasOwn(mask, 'operands') || Object.hasOwn(mask, 'resultHead'))),
        )
      )
        return false
      validateMaskStack(
        settings.maskStack.map((mask) => ({
          ...mask,
          ...(version < 15 ? { edge: { ...neutralMaskEdge } } : {}),
          ...(version < 16 ? { color: { ...neutralMaskColor } } : {}),
        })),
      )
      if (
        (settings.version as number) < 14 &&
        (settings.maskStack as import('../../shared/masks').MaskDescriptor[]).some(
          (mask) => mask.base,
        )
      )
        return false
    }
    if ((settings.version as number) >= 11) {
      validateNoiseReduction(settings.noiseReduction)
      validateDetailSharpening(settings.detailSharpening)
    }
    if ((settings.version as number) >= 10) {
      validateColorMixer(settings.colorMixer)
      validateColorGrading(settings.colorGrading)
    }
    if ((settings.version as number) >= 9) validateCrop(settings.crop)
    else if (settings.crop !== undefined) {
      validateCrop(settings.crop)
      if (!isUncropped(settings.crop) || settings.crop.aspectRatio !== null) return false
    }
    validatePatch({
      exposureEv: settings.exposureEv,
      contrast: settings.contrast,
      highlights: settings.highlights,
      shadows: settings.shadows,
      whites: settings.whites,
      blacks: settings.blacks,
      whiteBalance: settings.whiteBalance,
      lens: settings.lens,
      saturation: legacy ? 0 : settings.saturation,
      vibrance: legacy ? 0 : settings.vibrance,
    })
    return true
  } catch {
    return false
  }
}

/** Caller owns the startup transaction; no revisions, cursors, branches or timestamps change. */
export function migrateEditingHistory(db: DatabaseSync): void {
  for (const row of db.prepare('SELECT id, data FROM edits').all() as {
    id: string
    data: string
  }[]) {
    const history = JSON.parse(row.data)
    let changed = false
    const upgrade = (settings: Record<string, unknown>) => {
      if (!supportsEditingSettings(settings))
        throw new Error('This edit history format is unsupported. Its files were preserved.')
      if (settings.version === SETTINGS_VERSION) return settings
      changed = true
      return {
        ...settings,
        version: SETTINGS_VERSION,
        ...(settings.version === 7 ? { saturation: 0, vibrance: 0 } : {}),
        crop: (settings.version as number) >= 9 ? settings.crop : { ...identityCrop },
        colorMixer:
          (settings.version as number) >= 10
            ? settings.colorMixer
            : structuredClone(neutralColorMixer),
        colorGrading:
          (settings.version as number) >= 10
            ? settings.colorGrading
            : structuredClone(neutralColorGrading),
        noiseReduction:
          (settings.version as number) >= 11
            ? settings.noiseReduction
            : { ...neutralNoiseReduction },
        detailSharpening:
          (settings.version as number) >= 11
            ? settings.detailSharpening
            : { ...neutralDetailSharpening },
        curves:
          (settings.version as number) >= 12
            ? settings.curves
            : structuredClone(identityToneCurves),
        maskStack:
          (settings.version as number) >= 13
            ? (settings.maskStack as MaskDescriptor[]).map((mask) => ({
                ...mask,
                ...((settings.version as number) < 18 ? { operands: [], resultHead: null } : {}),
                ...((settings.version as number) < 15 ? { edge: { ...neutralMaskEdge } } : {}),
                ...((settings.version as number) < 16 ? { color: { ...neutralMaskColor } } : {}),
              }))
            : [],
      }
    }
    history.settings = upgrade(history.settings)
    history.snapshots = history.snapshots.map(
      (snapshot: { settings: Record<string, unknown> }) => ({
        ...snapshot,
        settings: upgrade(snapshot.settings),
      }),
    )
    if (changed)
      db.prepare('UPDATE edits SET data = ? WHERE id = ?').run(JSON.stringify(history), row.id)
  }
}
