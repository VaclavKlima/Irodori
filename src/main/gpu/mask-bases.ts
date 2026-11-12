import type { AdjustmentParameters } from '../../shared/adjustments'
import { maskBaseAtlasPlan } from '../../shared/masks-gpu'

/** Isolated bundled Node decodes immutable PNGs with the accepted native sharp codec. */
export async function createMaskBaseAtlas(
  device: GPUDevice,
  parameters: Pick<AdjustmentParameters, 'localMasks'>,
  coverageOnly = false,
): Promise<GPUTexture> {
  if (process.versions.electron)
    throw new Error('Generated mask decoding requires the isolated Node worker.')
  const plan = maskBaseAtlasPlan(parameters, coverageOnly)
  if (
    plan.width > device.limits.maxTextureDimension2D ||
    plan.height > device.limits.maxTextureDimension2D ||
    plan.layers > device.limits.maxTextureArrayLayers
  )
    throw new Error('Generated masks exceed this GPU texture size or layer limit.')
  const texture = device.createTexture({
    size: [plan.width, plan.height, plan.layers],
    format: 'r8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  })
  try {
    if (plan.bases.length) {
      const sharp = (await import('sharp')).default
      for (let layer = 0; layer < plan.bases.length; layer++) {
        const base = plan.bases[layer],
          decoded = await sharp(Buffer.from(base.pngBase64, 'base64'), {
            limitInputPixels: plan.width * plan.height,
          })
            .toColourspace('b-w')
            .raw()
            .toBuffer({ resolveWithObject: true })
        if (
          decoded.info.width !== plan.width ||
          decoded.info.height !== plan.height ||
          decoded.info.channels !== 1 ||
          decoded.data.byteLength !== plan.width * plan.height
        )
          throw new Error('Decoded generated mask dimensions or channels changed.')
        device.queue.writeTexture(
          { texture, origin: [0, 0, layer] },
          decoded.data,
          { bytesPerRow: plan.width, rowsPerImage: plan.height },
          [plan.width, plan.height],
        )
      }
    }
    return texture
  } catch (error) {
    texture.destroy()
    throw error
  }
}
