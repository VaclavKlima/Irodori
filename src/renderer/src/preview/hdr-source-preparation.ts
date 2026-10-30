import type { HdrWorkingAsset } from '../../../shared/hdr'
import { uploadHdr, type HdrUploadedSource } from './hdr-upload'
import type { HdrSourceIdentity } from './hdr-source-cache'
import type { HdrPipelines } from './hdr-pipelines'

/** Shared verified strip upload; keep the existing three-strip submission boundary. */
export async function uploadHdrTexture(
  device: GPUDevice,
  texture: GPUTexture,
  asset: HdrWorkingAsset,
  signal: AbortSignal,
  timings: Record<string, number>,
): Promise<HdrUploadedSource> {
  let completed: HdrUploadedSource | undefined,
    submitted = 0
  const started = performance.now()
  for await (const strip of uploadHdr(asset, signal, (source) => {
    completed = source
  })) {
    for (const [key, value] of Object.entries(strip.timings))
      timings[key] = (timings[key] ?? 0) + value
    const writing = performance.now()
    device.queue.writeTexture(
      { texture, origin: [0, strip.row] },
      strip.data,
      { bytesPerRow: asset.width * 16 },
      [asset.width, strip.data.length / (asset.width * 4)],
    )
    timings.writeTextureMs = (timings.writeTextureMs ?? 0) + performance.now() - writing
    if (++submitted % 3 === 0) await device.queue.onSubmittedWorkDone()
  }
  timings.streamMs = performance.now() - started
  if (!completed) throw new Error('HDR source upload completed without verification.')
  return completed
}

/** The unchanged source mip program and geometry, with the real final queue fence. */
export function submitHdrSourceMips(
  device: GPUDevice,
  texture: GPUTexture,
  identity: HdrSourceIdentity,
  compiled: Pick<HdrPipelines, 'mipLayout' | 'mip'>,
): Promise<void> {
  const encoder = device.createCommandEncoder()
  for (let level = 1; level < identity.mipLevels; level++) {
    const group = device.createBindGroup({
      layout: compiled.mipLayout,
      entries: [
        {
          binding: 0,
          resource: texture.createView({ baseMipLevel: level - 1, mipLevelCount: 1 }),
        },
        { binding: 1, resource: texture.createView({ baseMipLevel: level, mipLevelCount: 1 }) },
      ],
    })
    const pass = encoder.beginComputePass()
    pass.setPipeline(compiled.mip)
    pass.setBindGroup(0, group)
    pass.dispatchWorkgroups(
      Math.ceil(Math.max(1, identity.width >> level) / 8),
      Math.ceil(Math.max(1, identity.height >> level) / 8),
    )
    pass.end()
  }
  device.queue.submit([encoder.finish()])
  return device.queue.onSubmittedWorkDone()
}
