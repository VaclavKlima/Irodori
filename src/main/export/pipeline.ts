import { EXPORT_CODEC_VERSION, EXPORT_RENDERING_VERSION } from '../../shared/export'
import { DISPLAY_RENDERING_VERSION, HDR_CONTENT_VERSION } from '../../shared/display-rendering'
import { ADJUSTMENT_VERSION } from '../../shared/adjustments'
import { LENS_RENDER_VERSION } from '../processing/lens-correction'
import { exportCropPolicy } from './crop-policy'
import { exportDetailPolicy } from './detail-policy'
import { exportResizePolicy } from './resize-policy'
import type { OutputProofPipeline } from '../../shared/export-proof'

export function exportPipeline(): OutputProofPipeline {
  return {
    rendering: EXPORT_RENDERING_VERSION,
    codec: EXPORT_CODEC_VERSION,
    display: DISPLAY_RENDERING_VERSION,
    hdrContent: HDR_CONTENT_VERSION,
    adjustments: ADJUSTMENT_VERSION,
    lens: LENS_RENDER_VERSION,
    sdrEncoder: 'sharp-0.35.4-baseline-444-srgb',
    crop: { ...exportCropPolicy },
    detail: { ...exportDetailPolicy },
    resize: { ...exportResizePolicy },
  }
}
