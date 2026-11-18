import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { neutralAdjustments } from '../../shared/adjustments'
import { CLIPPING_COVERAGE_ROWS, clippingCoverageMemory } from '../../shared/clipping-coverage'
import type { PreviewContext } from '../../shared/inspection'
import { ClippingCoverageProcess } from '../clipping-coverage/process'
import type { PreviewDiskReservation } from '../preview-types'
import { prepareSavedMaskCoverage, type MaskPreviewOwner } from './mask-previews'

type CoverageOwner = Pick<
  MaskPreviewOwner,
  'edits' | 'masks' | 'prepareCoverage' | 'admission' | 'reserve'
>

/** A single PhotoDiagnostics request owns each exact coverage file until its readers drain. */
export class MaskDiagnosticCoverage {
  private files = new Map<string, PreviewDiskReservation>()

  constructor(
    private root: string,
    private owner: CoverageOwner,
  ) {}

  async close(): Promise<void> {
    for (const directory of this.files.keys()) await this.release(directory)
  }

  private async release(directory: string): Promise<void> {
    const reservation = this.files.get(directory)
    if (!reservation) return
    await rm(directory, { force: true, recursive: true })
    this.files.delete(directory)
    reservation()
  }

  async prepare(
    id: string,
    revision: number,
    maskId: string,
    context: PreviewContext,
    signal: AbortSignal,
  ) {
    await this.close()
    const state = await this.owner.edits(id)
    signal.throwIfAborted()
    if (state.photoId !== id || state.revision !== revision || !context.geometry)
      throw new Error('Saved mask diagnostics require the current photo grid and edit revision.')
    const mask = this.owner.masks(state).find((candidate) => candidate.id === maskId)
    if (!mask)
      throw new Error('The selected saved mask is unavailable. Choose a current root mask.')
    const { width, height, geometry, gridIdentity } = context
    const authored = {
      ...neutralAdjustments,
      localMasks: [{ ...mask, enabled: true }],
      maskGeometry: geometry,
    }
    const memory = clippingCoverageMemory(width, height, authored, true)
    const selected = await prepareSavedMaskCoverage(
      authored.localMasks[0],
      id,
      revision,
      this.owner.prepareCoverage,
      signal,
    )
    const { policy, reservation: existing } = await this.owner.admission(signal)
    signal.throwIfAborted()
    if (
      existing.ramBytes + memory.ramBytes > policy.ram.effectiveBytes ||
      existing.vramBytes + memory.vramBytes > policy.vram.effectiveBytes
    )
      throw new Error('Saved mask diagnostics exceed the current image-memory budget.')

    const reservation = await this.owner.reserve(memory.byteLength)
    let directory: string | undefined
    try {
      await mkdir(this.root, { recursive: true })
      directory = await mkdtemp(join(this.root, 'coverage-'))
      this.files.set(directory, reservation)
      const path = join(directory, 'saved-mask.f32')
      const key = createHash('sha256')
        .update(JSON.stringify([id, revision, gridIdentity, maskId]))
        .digest('hex')
      const process = new ClippingCoverageProcess()
      const coverage = await process
        .prepare({ ...authored, localMasks: [selected] }, width, height, key, path, signal, true)
        .finally(() => process.close())
      signal.throwIfAborted()
      const file = await lstat(path)
      if (
        coverage.key !== key ||
        coverage.path !== path ||
        coverage.maskCount !== 1 ||
        coverage.width !== width ||
        coverage.height !== height ||
        !file.isFile() ||
        coverage.byteLength !== memory.byteLength ||
        file.size !== memory.byteLength ||
        !/^[a-f0-9]{64}$/.test(coverage.sha256) ||
        coverage.stripSha256.length !== Math.ceil(height / CLIPPING_COVERAGE_ROWS) ||
        coverage.stripSha256.some((hash) => !/^[a-f0-9]{64}$/.test(hash))
      )
        throw new Error('Saved mask coverage does not match the committed photo grid.')
      const owned = directory
      return { name: mask.name, coverage, release: () => this.release(owned) }
    } catch (error) {
      if (directory) await this.release(directory)
      else reservation()
      throw error
    }
  }
}
