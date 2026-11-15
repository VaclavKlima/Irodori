// Research-only explicit consumed-point adapter around the actual native rendition owner.
import { createHash } from 'node:crypto'
import { createPointGpu } from '../../../src/main/gpu/point-renderer.ts'
import { RawGpuRenderer } from '../../../src/main/gpu/raw-renderer.ts'

export const consumedPolicy = 'masked-texture-consumed-point-proof-v1'
const digest = (value) => createHash('sha256').update(value).digest('hex')
export function pointContextIdentity({
  domain,
  width,
  height,
  adjustments,
  transform,
  whiteBalance,
  parentSha256,
  gridPolicy,
  amounts,
}) {
  return digest(
    JSON.stringify({
      policy: consumedPolicy,
      domain,
      width,
      height,
      adjustments,
      transform,
      whiteBalance,
      parentSha256,
      gridPolicy,
      amounts,
    }),
  )
}

function consumedRenderer(domain, mode, receipt) {
  const raw = new RawGpuRenderer()
  return {
    get failure() {
      return raw.failure
    },
    close: () => raw.close(),
    async mergeDevice() {
      const { device, adapter } = await raw.mergeDevice()
      let uniform
      const queue = new Proxy(device.queue, {
        get(target, property) {
          if (property === 'writeBuffer')
            return (buffer, offset, data, dataOffset, size) => {
              if (buffer !== uniform)
                return target.writeBuffer(buffer, offset, data, dataOffset, size)
              if (
                offset !== 0 ||
                dataOffset !== undefined ||
                size !== undefined ||
                !(data instanceof Float32Array) ||
                data.length !== 48
              )
                throw new Error(
                  'Production point uniform contract changed; no implicit consumed replay.',
                )
              const values = data.slice()
              if (values[47] !== 0)
                throw new Error('Research consumed flag collides with production uniform.')
              values[47] = mode
              return target.writeBuffer(buffer, offset, values)
            }
          const value = target[property]
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      const facade = new Proxy(device, {
        get(target, property) {
          if (property === 'queue') return queue
          if (property === 'createBuffer')
            return (descriptor) => {
              const value = target.createBuffer(descriptor)
              if (
                !uniform &&
                descriptor.size === 192 &&
                descriptor.usage & globalThis.GPUBufferUsage.UNIFORM
              )
                uniform = value
              return value
            }
          if (property === 'createShaderModule')
            return (descriptor) => {
              const global =
                domain === 'scene-linear'
                  ? 'adjusted(pixel.rgb)'
                  : 'rasterAdjusted(pixel.rgb,u.values[2],u.values[3].xy,u.values[11].xy,u.values[8].x)'
              const masked =
                domain === 'scene-linear'
                  ? `applyLocalMasks(${global},maskPoint,1.,true)`
                  : `applyLocalMasks(${global},maskPoint,u.values[8].x,false)`
              const expression = descriptor.code.includes(masked) ? masked : global
              if (descriptor.code.split(expression).length !== 2)
                throw new Error('Production point expression changed; no guessed consumption seam.')
              const replacement = `select(${expression},pixel.rgb,u.values[11].w>.5)`
              const code = descriptor.code.replace(expression, replacement)
              receipt.shaderSourceSha256 = digest(descriptor.code)
              receipt.consumedShaderSha256 = digest(code)
              receipt.expression = expression
              receipt.modeUniformIndex = 47
              return target.createShaderModule({ ...descriptor, code })
            }
          const value = target[property]
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      return { device: facade, adapter }
    },
  }
}

/** The original point branch remains runtime-live for the actual owner's bind layout.
 * The consumed branch selects pre-rendition RGB explicitly, rather than relying on neutral edits.
 * This adapter is not installed in PreviewProcess or application rendering.
 */
export async function renderActualPoint(job, signal) {
  const { width, height, domain, adjustments, data, admission } = job
  signal.throwIfAborted()
  if (
    !['raster', 'scene-linear'].includes(domain) ||
    !(data instanceof Float32Array) ||
    data.length !== width * height * 4
  )
    throw new Error('Invalid bounded ordered consumer input.')
  if (width * height > 24000000 || !Number.isSafeInteger(width) || !Number.isSafeInteger(height))
    throw new Error('Invalid native ordered consumer dimensions.')
  const context = pointContextIdentity(job)
  if (
    job.consumed &&
    (job.consumed.policy !== consumedPolicy ||
      job.consumed.context !== context ||
      job.consumed.sha256 !== digest(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)))
  )
    throw new Error('Prepared ordered stack does not match consumed point context/source.')
  const receipt = {
    policy: job.consumed ? consumedPolicy : 'unchanged-production-point',
    context,
    consumed: Boolean(job.consumed),
    domain,
    packed: job.packed,
  }
  // Existing production output is streamed in native 64-row bands.
  const capacity = width * Math.min(64, height),
    wordsPerPixel = job.packed ? 1 : 3
  const outputBytes = width * height * wordsPerPixel * 4
  const estimatedHostBytes =
    data.buffer.byteLength + outputBytes * 2 + capacity * 40 + 16 * 1024 ** 2
  if (admission.reservation.ramBytes + estimatedHostBytes > admission.policy.ram.effectiveBytes)
    throw new Error('Ordered native consumer exceeds unchanged Automatic RAM policy.')
  const limit = Math.min(
    1024 ** 3,
    admission.policy.vram.effectiveBytes - admission.reservation.vramBytes,
  )
  if (limit <= 0) throw new Error('No admitted GPU budget for ordered native consumer.')
  const factory = job.consumed ? () => consumedRenderer(domain, 1, receipt) : undefined
  const owner = await createPointGpu(
    capacity,
    adjustments,
    job.whiteBalance,
    false,
    Boolean(job.packed),
    64,
    0,
    limit,
    { domain, preserveAlpha: true, transform: job.transform, maskSize: { width, height }, signal },
    factory,
  )
  try {
    if (owner.peakBytes + admission.reservation.vramBytes > admission.policy.vram.effectiveBytes)
      throw new Error('Ordered point owner exceeds admitted GPU policy.')
    const output = new Uint32Array(width * height * wordsPerPixel)
    let maximumHeadroom = 0
    for (let y = 0; y < height; y += 64) {
      signal.throwIfAborted()
      const count = width * Math.min(64, height - y)
      const rendered = await owner.render(
        data.subarray(y * width * 4, (y * width + count) * 4),
        y * width,
      )
      output.set(
        new Uint32Array(
          rendered.data.buffer,
          rendered.data.byteOffset,
          rendered.data.byteLength / 4,
        ),
        y * width * wordsPerPixel,
      )
      maximumHeadroom = Math.max(maximumHeadroom, rendered.headroom)
    }
    return {
      data: output,
      adapter: owner.adapter,
      wordsPerPixel,
      receipt,
      peakBytes: owner.peakBytes,
      estimatedHostBytes,
      maximumHeadroom,
    }
  } finally {
    await owner.close()
  }
}
