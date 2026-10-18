import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  canonical,
  digest,
  whole,
  type Assets,
  type Frame,
  type ImageSpec,
  type RadialMask,
  type Recipe,
} from './contract.ts'

export function validateMask(mask: RadialMask) {
  if (
    mask.version !== 1 ||
    mask.coordinates !== 'normalized-source-v1' ||
    mask.center.length !== 2 ||
    !mask.center.every((v) => Number.isFinite(v) && v >= 0 && v <= 1) ||
    !Number.isFinite(mask.radius) ||
    mask.radius <= 0 ||
    mask.radius > 1 ||
    !Number.isFinite(mask.feather) ||
    mask.feather < 0 ||
    mask.feather > 1
  )
    throw new Error('Invalid durable mask geometry.')
}
export class ResearchAssets implements Assets {
  private images = new Map<string, Frame>()
  private masks = new Map<string, RadialMask>()
  addImage(spec: ImageSpec, data: Float32Array) {
    if (data.length !== spec.width * spec.height * spec.channels || !data.every(Number.isFinite))
      throw new Error('Invalid research source.')
    const owned = new Float32Array(data)
    const hash = createHash('sha256')
      .update(canonical(spec))
      .update(new Uint8Array(owned.buffer))
      .digest('hex')
    this.images.set(hash, { spec: structuredClone(spec), region: whole(spec), data: owned })
    return hash
  }
  addMask(mask: RadialMask) {
    validateMask(mask)
    const hash = digest(mask)
    this.masks.set(hash, structuredClone(mask))
    return hash
  }
  image(hash: string) {
    const frame = this.images.get(hash)
    if (!frame) throw new Error(`Missing immutable source: ${hash}`)
    return frame
  }
  mask(hash: string) {
    const mask = this.masks.get(hash)
    if (!mask) throw new Error(`Missing historical mask content: ${hash}`)
    return mask
  }
}
/** Caller supplies an owned research directory, never a managed photo library. */
export class DurableMasks {
  constructor(readonly directory: string) {}
  async put(mask: RadialMask) {
    validateMask(mask)
    const hash = digest(mask)
    await mkdir(this.directory, { recursive: true })
    try {
      await writeFile(join(this.directory, `${hash}.json`), canonical(mask), {
        flag: 'wx',
        mode: 0o600,
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    await this.read(hash)
    return hash
  }
  async read(hash: string): Promise<RadialMask> {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid asset hash.')
    const bytes = await readFile(join(this.directory, `${hash}.json`), 'utf8')
    const mask: RadialMask = JSON.parse(bytes)
    validateMask(mask)
    if (digest(mask) !== hash) throw new Error('Historical mask checksum mismatch.')
    return mask
  }
  retained(history: readonly Recipe[]) {
    return new Set(history.flatMap((recipe) => recipe.assets))
  }
}
