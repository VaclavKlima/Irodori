import { createHash } from 'node:crypto'
import { lstat, readFile, rename, rm } from 'node:fs/promises'
import sharp from 'sharp'
import { INSPECTION_IMAGE_LIMIT, INSPECTION_PAIR_LIMIT } from '../../shared/inspection'
import type {
  DiagnosticOverlayImage,
  DiagnosticOverlayMask,
  DiagnosticOverlayRequest,
} from './types'

const aboveWhiteColor = [0, 255, 255] as const
const clippingColor = [255, 0, 0] as const
const shadowColor = [0, 0, 255] as const
const overlappingColor = [255, 0, 255] as const
const opacity = 180

function markPixels(
  base: Buffer | undefined,
  bits: Buffer,
  { label, targetMode }: DiagnosticOverlayMask,
) {
  const output = base ? Buffer.from(base) : Buffer.alloc(bits.length * 4)
  const hdr = targetMode === 'hdr' || label === 'above-white'
  for (let i = 0; i < bits.length; i++) {
    const flags = bits[i]
    if (flags > (hdr ? 15 : 3))
      throw new Error('Diagnostic overlay has invalid classification bits.')
    let color
    if (label === 'above-white') {
      if (flags & 4) color = aboveWhiteColor
    } else if (targetMode === 'hdr') {
      if (flags & 1) color = clippingColor
    } else if (flags === 3) color = overlappingColor
    else if (flags & 2) color = clippingColor
    else if (flags & 1) color = shadowColor
    if (!color) continue
    const at = i * 4
    for (let channel = 0; channel < 3; channel++) {
      output[at + channel] = base
        ? Math.round((output[at + channel] * (255 - opacity) + color[channel] * opacity) / 255)
        : color[channel]
    }
    // A classified native pixel remains visible even if the reduced base is transparent here.
    output[at + 3] = Math.max(output[at + 3], opacity)
  }
  return output
}

/** Encode already classified flags, with a registered SDR photograph for Console composites. */
export async function encodeDiagnosticOverlays({
  basePath,
  masks,
}: DiagnosticOverlayRequest): Promise<DiagnosticOverlayImage[]> {
  if (process.versions.electron)
    throw new Error('Diagnostic PNG encoding requires the isolated Node worker.')
  if (!Array.isArray(masks) || masks.length < 1 || masks.length > 2)
    throw new Error('Diagnostic overlay requires one or two classifications.')
  const { width, height } = masks[0]
  if (
    ![width, height].every((side) => Number.isSafeInteger(side) && side >= 1 && side <= 1024) ||
    new Set(masks.map(({ label }) => label)).size !== masks.length ||
    new Set([
      ...(basePath === undefined ? [] : [basePath]),
      ...masks.flatMap(({ outputPath }) => [outputPath, `${outputPath}.tmp`]),
    ]).size !==
      Number(basePath !== undefined) + 2 * masks.length ||
    masks.some(
      (mask) =>
        mask.width !== width ||
        mask.height !== height ||
        !['clipping', 'above-white'].includes(mask.label) ||
        !['hdr', 'sdr'].includes(mask.targetMode) ||
        typeof mask.dataBase64 !== 'string' ||
        mask.dataBase64.length !== 4 * Math.ceil((width * height) / 3),
    )
  )
    throw new Error('Invalid diagnostic overlay dimensions or classifications.')
  let base: Buffer | undefined
  if (basePath !== undefined) {
    const info = await lstat(basePath)
    if (!info.isFile() || info.size > INSPECTION_IMAGE_LIMIT)
      throw new Error('Diagnostic overlay requires a bounded SDR inspection image.')
    const source = sharp(basePath, { limitInputPixels: width * height })
    const metadata = await source.metadata()
    if (metadata.format !== 'png' || metadata.width !== width || metadata.height !== height)
      throw new Error('Diagnostic overlay photograph dimensions or encoding changed.')
    base = await source.toColourspace('srgb').ensureAlpha().raw().toBuffer()
  }
  const members: DiagnosticOverlayImage[] = []
  let total = 0
  for (const mask of masks) {
    const bits = Buffer.from(mask.dataBase64, 'base64')
    if (bits.byteLength !== width * height || bits.toString('base64') !== mask.dataBase64)
      throw new Error('Diagnostic overlay classification is incomplete.')
    const raw = markPixels(base, bits, mask)
    const path = mask.outputPath,
      temporary = `${path}.tmp`
    try {
      await sharp(raw, { raw: { width, height, channels: 4 } })
        .withIccProfile('srgb')
        .png()
        .toFile(temporary)
      const encoded = await readFile(temporary)
      const byteLength = encoded.byteLength
      total += byteLength
      if (byteLength > INSPECTION_IMAGE_LIMIT || total > INSPECTION_PAIR_LIMIT)
        throw new Error('Diagnostic overlays exceed delivery limits. Choose a smaller region.')
      await rename(temporary, path)
      members.push({
        label: mask.label,
        path,
        sha256: createHash('sha256').update(encoded).digest('hex'),
        byteLength,
        width,
        height,
      })
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }
  return members
}
