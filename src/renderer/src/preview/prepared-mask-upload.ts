import type { HdrWorkingAsset, PreparedMaskPresentation } from '../../../shared/hdr'
import { HDR_TRANSPORT_CHUNK_BYTES } from './hdr-memory'

export function validatePreparedMaskPresentation(
  asset: Pick<HdrWorkingAsset, 'width' | 'height' | 'sha256' | 'preparedMasks'> & { url?: string },
): PreparedMaskPresentation | undefined {
  const prepared = asset.preparedMasks
  if (!prepared) return
  const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
  if (
    !hash(prepared.key) ||
    !hash(prepared.context) ||
    prepared.parentSha256 !== asset.sha256 ||
    prepared.consumed !== 'global-and-local-point-v1' ||
    typeof prepared.pointKey !== 'string'
  )
    throw new Error('Invalid prepared mask presentation identity.')
  for (const [file, bytesPerPixel] of [
    [prepared.candidate, 16],
    [prepared.union, 4],
  ] as const) {
    if (
      !file ||
      !file.url ||
      !hash(file.sha256) ||
      file.byteLength !== asset.width * asset.height * bytesPerPixel ||
      file.strips.length !== Math.ceil(asset.height / 64) ||
      file.strips.some(
        (s, i) =>
          s.byteLength !== asset.width * Math.min(64, asset.height - i * 64) * bytesPerPixel ||
          !hash(s.sha256),
      )
    )
      throw new Error('Invalid prepared mask presentation file.')
  }
  const urls = [prepared.candidate.url, prepared.union.url, ...(asset.url ? [asset.url] : [])]
  if (new Set(urls).size !== urls.length)
    throw new Error('Prepared mask presentation files overlap.')
  return prepared
}

/** One verified native strip at a time; original-source leases and sample caches remain separate. */
export async function* readPreparedMaskStrips(
  file: PreparedMaskPresentation['candidate'],
  width: number,
  height: number,
  channels: 1 | 4,
  signal: AbortSignal,
): AsyncGenerator<{ row: number; rows: number; bytes: Uint8Array<ArrayBuffer> }> {
  const response = await fetch(file.url, { signal, cache: 'no-store' })
  if (
    response.status !== 200 ||
    Number(response.headers.get('content-length')) !== file.byteLength ||
    !response.body
  ) {
    await response.body?.cancel()
    throw new Error('Incomplete prepared mask source.')
  }
  const reader = response.body.getReader()
  let pending = new Uint8Array(0),
    offset = 0
  try {
    for (let row = 0; row < height; row += 64) {
      signal.throwIfAborted()
      const rows = Math.min(64, height - row),
        expected = width * rows * channels * 4,
        bytes = new Uint8Array(expected)
      let filled = 0
      while (filled < expected) {
        if (offset === pending.length) {
          const next = await reader.read()
          if (next.done || next.value.byteLength > HDR_TRANSPORT_CHUNK_BYTES)
            throw new Error('Incomplete or oversized prepared mask transport.')
          pending = next.value
          offset = 0
        }
        const count = Math.min(expected - filled, pending.length - offset)
        bytes.set(pending.subarray(offset, offset + count), filled)
        filled += count
        offset += count
      }
      const digest = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.buffer)),
        (n) => n.toString(16).padStart(2, '0'),
      ).join('')
      if (digest !== file.strips[row / 64].sha256) throw new Error('Damaged prepared mask strip.')
      const data = new Float32Array(bytes.buffer),
        bits = new Uint32Array(bytes.buffer)
      for (let i = 0; i < data.length; i++) {
        if (
          !Number.isFinite(data[i]) ||
          (channels === 1 && (data[i] < 0 || data[i] > 1)) ||
          (channels === 4 && i % 4 === 3 && (data[i] < 0 || data[i] > 1))
        )
          throw new Error('Invalid prepared mask sample.')
        if (channels === 1 && (bits[i] & 0x7fffffff) > 0x3f800000)
          throw new Error('Invalid prepared mask union.')
      }
      signal.throwIfAborted()
      yield { row, rows, bytes }
    }
    if (offset !== pending.length || !(await reader.read()).done)
      throw new Error('Unexpected prepared mask source bytes.')
  } finally {
    try {
      await reader.cancel()
    } finally {
      reader.releaseLock()
    }
  }
}

/** Shared strip checks feed the existing Dawn path and the raster WebGL presenter. */
export async function uploadPreparedMaskTexture(
  device: GPUDevice,
  texture: GPUTexture,
  file: PreparedMaskPresentation['candidate'],
  width: number,
  height: number,
  channels: 1 | 4,
  signal: AbortSignal,
) {
  for await (const { row, rows, bytes } of readPreparedMaskStrips(
    file,
    width,
    height,
    channels,
    signal,
  )) {
    device.queue.writeTexture(
      { texture, origin: [0, row] },
      bytes,
      { bytesPerRow: width * channels * 4 },
      [width, rows],
    )
    await device.queue.onSubmittedWorkDone()
  }
}

/** Positive Float32 coverage is reduced by its ordered bits, including subnormal values. */
export const preparedMaskUnionMipShader = `
@group(0) @binding(0) var source:texture_2d<f32>;
@group(0) @binding(1) var destination:texture_storage_2d<r32float,write>;
@compute @workgroup_size(8,8) fn down(@builtin(global_invocation_id) p:vec3u){
 if(any(p.xy>=textureDimensions(destination))){return;}
 let size=vec2i(textureDimensions(source));var maximum=0u;
 for(var y=0;y<2;y++){for(var x=0;x<2;x++){
  maximum=max(maximum,bitcast<u32>(textureLoad(source,min(vec2i(p.xy)*2+vec2i(x,y),size-1),0).r)&0x7fffffffu);
 }}
 textureStore(destination,p.xy,vec4f(bitcast<f32>(maximum),0.,0.,1.));
}`
