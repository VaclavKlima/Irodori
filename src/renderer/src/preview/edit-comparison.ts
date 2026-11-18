import type { DisplayPreview } from '../../../shared/contracts'
import { maskBaseAtlasPlan, packLocalMasks } from '../../../shared/masks-gpu'
import { neutralAdjustments } from '../../../shared/adjustments'
import type { ManagedImageBytes, ResourcePolicySnapshot } from '../../../shared/resource-policy'
import { HDR_BITMAP_RESERVATION, hdrPresentationMemory, type HdrMemoryLimits } from './hdr-memory'
import { HDR_CACHE_MAX_TILES } from './hdr-render-cache'
import { rasterOverlayBytes } from './prepared-raster-overlay'
import type { Size } from './geometry'

/** Half-open physical-pixel clips never composite translucent A over B. */
export function comparisonClips(
  width: number,
  dpr: number,
  split: number,
  mode: 'a' | 'b' | 'split',
) {
  const boundary =
    mode === 'a'
      ? width
      : mode === 'b'
        ? 0
        : Math.max(0, Math.min(width, Math.ceil(width * dpr * split - 0.5) / dpr))
  return {
    boundary,
    a: `inset(0 ${Math.max(0, width - boundary)}px 0 0)`,
    b: `inset(0 0 0 ${boundary}px)`,
  }
}

/** A receipt is useful only for the complete currently requested pair/view generation. */
export class ComparisonPublication {
  private key = ''
  private members = new Set<'a' | 'b'>()
  request(key: string) {
    if (key !== this.key) {
      this.key = key
      this.members.clear()
    }
  }
  accept(key: string, member: 'a' | 'b') {
    if (key !== this.key) return false
    this.members.add(member)
    return this.members.size === 2
  }
}

/** Reserve both complete pipelines before either source transfer or GPU allocation. */
export function comparisonMemoryPlan(
  frames: readonly [DisplayPreview, DisplayPreview],
  viewport: Size,
  dpr: number,
  policy: ResourcePolicySnapshot,
  external: ManagedImageBytes,
) {
  const limits: HdrMemoryLimits = {
    revision: policy.revision,
    ramBytes: Math.max(0, Math.floor((policy.ram.effectiveBytes - external.ramBytes) / 2)),
    vramBytes: Math.max(0, Math.floor((policy.vram.effectiveBytes - external.vramBytes) / 2)),
  }
  const peaks = frames.map((frame) => {
    const p = frame.adjustments ?? neutralAdjustments,
      atlas = maskBaseAtlasPlan(p),
      masks = packLocalMasks(p, frame).byteLength,
      overlay =
        frame.linear?.preparedMasks || frame.linear?.hdr?.preparedMasks
          ? rasterOverlayBytes(frame.width, frame.height)
          : undefined,
      extras = {
        ramBytes:
          atlas.decodeBytes + atlas.uploadBytes + masks * 6 + (overlay?.ram ?? 0) + 64 * 1024,
        vramBytes: atlas.bytes + atlas.uploadBytes + masks + (overlay?.pending ?? 0) + 64 * 1024,
      }
    if (frame.linear?.hdr) {
      const plan = hdrPresentationMemory(
        {
          width: frame.width,
          height: frame.height,
          canvasWidth: Math.max(1, Math.round(viewport.width * dpr)),
          canvasHeight: Math.max(1, Math.round(viewport.height * dpr)),
          maximumLayers: Math.floor(HDR_CACHE_MAX_TILES / 2),
          bitmapReservation: HDR_BITMAP_RESERVATION,
          rawHalfSupported: false,
          otherReservations: extras,
        },
        limits,
      )
      return { ...plan.peak, accepted: plan.accepted }
    }
    const pixels = frame.width * frame.height,
      canvas =
        Math.max(1, Math.round(viewport.width * dpr)) *
        Math.max(1, Math.round(viewport.height * dpr)),
      ramBytes = pixels * 16 * 4 + canvas * 32 + extras.ramBytes,
      vramBytes = Math.ceil((pixels * 16 * 4) / 3) + canvas * 32 + extras.vramBytes
    return {
      ramBytes,
      vramBytes,
      accepted: ramBytes <= limits.ramBytes && vramBytes <= limits.vramBytes,
    }
  })
  return {
    limits,
    peaks,
    accepted: peaks.every((peak) => peak.accepted),
    reservation: {
      ramBytes: peaks.reduce((n, p) => n + p.ramBytes, 0),
      vramBytes: peaks.reduce((n, p) => n + p.vramBytes, 0),
    },
  }
}
