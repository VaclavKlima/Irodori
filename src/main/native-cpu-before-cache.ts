import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, mkdtemp, open, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { CpuPreviewSamples } from '../shared/native-cpu-preview'

interface Stamp {
  readonly byteLength: number
  readonly sha256: string
}
export type CpuSampleStamp = Omit<CpuPreviewSamples, 'url'>
interface Entry {
  key: string
  planePath: string
  samplesPath: string
  plane: Stamp
  samples: CpuSampleStamp
}

/** Hash only private derived files, with one bounded read buffer and no symlink following. */
async function intact(path: string, stamp: Stamp, signal: AbortSignal) {
  signal.throwIfAborted()
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const first = await file.stat({ bigint: true })
      if (!first.isFile() || first.size !== BigInt(stamp.byteLength)) return false
      const storage = Buffer.alloc(Math.min(64 * 1024, stamp.byteLength)),
        digest = createHash('sha256')
      let offset = 0
      while (offset < stamp.byteLength) {
        signal.throwIfAborted()
        const { bytesRead } = await file.read(
          storage,
          0,
          Math.min(storage.byteLength, stamp.byteLength - offset),
          offset,
        )
        if (!bytesRead) return false
        digest.update(storage.subarray(0, bytesRead))
        offset += bytesRead
      }
      signal.throwIfAborted()
      const last = await file.stat({ bigint: true })
      return (
        last.size === first.size &&
        last.mtimeNs === first.mtimeNs &&
        last.ctimeNs === first.ctimeNs &&
        digest.digest('hex') === stamp.sha256
      )
    } finally {
      await file.close()
    }
  } catch (error) {
    signal.throwIfAborted()
    if (['ENOENT', 'ELOOP', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
      return false
    throw error
  }
}

/** One owner, at most the existing draft and normal layouts. No scheduler or persistent cache. */
export class NativeCpuBeforeCache {
  private directory?: string
  private entries = new Map<'draft' | 'normal', Entry>()
  constructor(private readonly root: string) {}

  async reuse(
    quality: 'draft' | 'normal',
    key: string,
    planePath: string,
    samplesPath: string,
    signal: AbortSignal,
  ): Promise<{ plane: Stamp; samples: CpuSampleStamp } | undefined> {
    const entry = this.entries.get(quality)
    if (!entry || entry.key !== key) return undefined
    if (
      !(await intact(entry.planePath, entry.plane, signal)) ||
      !(await intact(entry.samplesPath, entry.samples, signal))
    ) {
      this.entries.delete(quality)
      await this.remove(entry)
      return undefined
    }
    let planeLinked = false,
      samplesLinked = false
    try {
      signal.throwIfAborted()
      await link(entry.planePath, planePath)
      planeLinked = true
      await link(entry.samplesPath, samplesPath)
      samplesLinked = true
      signal.throwIfAborted()
      return { plane: { ...entry.plane }, samples: { ...entry.samples } }
    } catch (error) {
      if (planeLinked) await rm(planePath, { force: true })
      if (samplesLinked) await rm(samplesPath, { force: true })
      throw error
    }
  }

  async retain(
    quality: 'draft' | 'normal',
    key: string,
    planePath: string,
    plane: Stamp,
    samplesPath: string,
    samples: CpuSampleStamp,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted()
    this.directory ??= await mkdtemp(join(this.root, 'cpu-'))
    const id = randomUUID(),
      entry: Entry = {
        key,
        planePath: join(this.directory, `${id}.rgba`),
        samplesPath: join(this.directory, `${id}.f32`),
        plane: { ...plane },
        samples: { ...samples },
      }
    let retained = false
    try {
      await link(planePath, entry.planePath)
      await link(samplesPath, entry.samplesPath)
      signal.throwIfAborted()
      const previous = this.entries.get(quality)
      this.entries.set(quality, entry)
      retained = true
      if (previous) await this.remove(previous)
    } finally {
      if (!retained) await this.remove(entry)
    }
  }
  private async remove(entry: Entry) {
    const results = await Promise.allSettled([
        rm(entry.planePath, { force: true }),
        rm(entry.samplesPath, { force: true }),
      ]),
      errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
    if (errors.length) throw new AggregateError(errors, 'CPU Before cache cleanup failed.')
  }
  async close() {
    if (this.directory) await rm(this.directory, { recursive: true, force: true })
    this.directory = undefined
    this.entries.clear()
  }
}
