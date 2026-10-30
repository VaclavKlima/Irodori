import type { DatabaseSync } from 'node:sqlite'
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

export const CATALOG_VERSION = 21

/** Validate the entire library before startup permits any migration or recovery write. */
export function supportsEditingSettings(
  settings: Record<string, unknown> | undefined,
  catalogVersion?: number,
): boolean {
  if (!settings || !['hdr-v1', 'display-referred-v1'].includes(String(settings.processing)))
    return false
  if (
    settings.version !== SETTINGS_VERSION &&
    ('noiseReduction' in settings || 'detailSharpening' in settings)
  )
    return false
  if ((settings.version as number) < 10 && ('colorMixer' in settings || 'colorGrading' in settings))
    return false
  const legacy = settings.version === 7
  if (![7, 8, 9, 10, SETTINGS_VERSION].includes(settings.version as number)) return false
  if (
    catalogVersion !== undefined &&
    settings.version !==
      ({ 17: 7, 18: 8, 19: 9, 20: 10, 21: SETTINGS_VERSION } as Record<number, number>)[
        catalogVersion
      ]
  )
    return false
  if (
    legacy &&
    ((settings.saturation !== undefined && settings.saturation !== 0) ||
      (settings.vibrance !== undefined && settings.vibrance !== 0))
  )
    return false
  try {
    if (settings.version === SETTINGS_VERSION) {
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
        noiseReduction: { ...neutralNoiseReduction },
        detailSharpening: { ...neutralDetailSharpening },
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
