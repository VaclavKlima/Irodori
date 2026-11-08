import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { crc32 } from 'node:zlib'
import {
  neutralMaskEdge,
  maskCapabilities,
  maskChunkBytes,
  maskHash,
  maskBaseReference,
  neutralMaskLight,
  resolveMasks,
  validateMaskMutation,
  validateMaskStack,
  validateMaskBaseContent,
  type MaskBaseContent,
  type MaskDescriptor,
  type MaskMutation,
  type MaskStrokeChunk,
} from '../shared/masks'

/** This internal publication helper preserves every ordered manual correction. */
export function prepareMaskBaseReplacement(
  current: readonly MaskDescriptor[],
  id: string,
  base: MaskBaseContent,
) {
  verifiedMaskBaseBytes(base)
  const stack = structuredClone(current) as MaskDescriptor[],
    mask = stack.find((entry) => entry.id === id)
  if (!mask) throw new Error('This mask is unavailable. Refresh the confirmed masks.')
  mask.base = maskBaseReference(base)
  validateMaskStack(stack)
  return stack
}

/** Native codecs produce these bytes; main checks the immutable envelope and every PNG CRC. */
export function verifiedMaskBaseBytes(base: MaskBaseContent): Buffer {
  validateMaskBaseContent(base)
  const png = Buffer.from(base.pngBase64, 'base64')
  if (
    png.byteLength > maskCapabilities.maxBaseEncodedBytes ||
    png.toString('base64') !== base.pngBase64 ||
    createHash('sha256').update(png).digest('hex') !== base.hash
  )
    throw new Error('Generated mask PNG hash or encoding mismatch.')
  let offset = 8,
    imageData = false,
    ended = false
  while (offset < png.length) {
    if (offset + 12 > png.length) throw new Error('Truncated generated mask PNG.')
    const length = png.readUInt32BE(offset),
      end = offset + length + 12
    if (end > png.length) throw new Error('Truncated generated mask PNG chunk.')
    const kind = png.toString('ascii', offset + 4, offset + 8)
    if (crc32(png.subarray(offset + 4, end - 4)) !== png.readUInt32BE(end - 4))
      throw new Error('Generated mask PNG checksum mismatch.')
    if (kind === 'IDAT') imageData = true
    if (kind === 'IEND') {
      if (length !== 0 || end !== png.length) throw new Error('Invalid generated mask PNG end.')
      ended = true
    }
    offset = end
  }
  if (!imageData || !ended) throw new Error('Incomplete generated mask PNG.')
  return png
}

export function prepareMaskMutation(current: readonly MaskDescriptor[], mutation: MaskMutation) {
  validateMaskMutation(mutation)
  const stack = structuredClone(current) as MaskDescriptor[],
    chunks: MaskStrokeChunk[] = []
  const find = (id: string) => {
    const mask = stack.find((mask) => mask.id === id)
    if (!mask) throw new Error('This mask is unavailable. Refresh the confirmed masks.')
    return mask
  }
  for (const op of mutation.operations) {
    switch (op.kind) {
      case 'create':
        if (stack.some((mask) => mask.id === op.id)) throw new Error('This mask ID already exists.')
        stack.unshift({
          id: op.id,
          name: op.name,
          enabled: true,
          inverted: false,
          head: null,
          light: { ...neutralMaskLight },
          edge: { ...neutralMaskEdge },
        })
        break
      case 'update': {
        const mask = find(op.id)
        if (op.name !== undefined) mask.name = op.name
        if (op.enabled !== undefined) mask.enabled = op.enabled
        if (op.inverted !== undefined) mask.inverted = op.inverted
        if (op.light) mask.light = { ...mask.light, ...op.light }
        if (op.edge) mask.edge = { ...mask.edge, ...op.edge }
        break
      }
      case 'duplicate': {
        const source = find(op.id)
        if (stack.some((mask) => mask.id === op.newId))
          throw new Error('This mask ID already exists.')
        stack.splice(stack.indexOf(source), 0, {
          ...structuredClone(source),
          id: op.newId,
          name: op.name,
        })
        break
      }
      case 'delete':
        stack.splice(stack.indexOf(find(op.id)), 1)
        break
      case 'reorder': {
        if (
          op.ids.length !== stack.length ||
          op.ids.some((id) => !stack.some((mask) => mask.id === id))
        )
          throw new Error('Reordering requires every current mask exactly once.')
        const ordered = op.ids.map(find)
        stack.splice(0, stack.length, ...ordered)
        break
      }
      case 'stroke': {
        const mask = find(op.id),
          parent = mask.head,
          hash = createHash('sha256').update(maskChunkBytes(parent, op.stroke)).digest('hex')
        chunks.push({ hash, parent, stroke: structuredClone(op.stroke) })
        mask.head = hash
        break
      }
    }
  }
  validateMaskStack(stack)
  return { stack, chunks }
}

/** Append-only immutable content; accepted history and frozen jobs never race a collector. */
export class MaskContentStore {
  constructor(private db: DatabaseSync) {}
  validateExisting(required: boolean, requireBases = required) {
    const table = this.db
      .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'mask_content'")
      .get()
    if (!table) {
      if (required)
        throw new Error(
          'This library is missing its immutable mask store. Its files were preserved.',
        )
      return
    }
    this.db.prepare('SELECT photo_id, hash, data, bytes FROM mask_content LIMIT 0').all()
    const bases = this.db
      .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'mask_base_content'")
      .get()
    if (!bases) {
      if (requireBases)
        throw new Error(
          'This library is missing its immutable generated mask store. Its files were preserved.',
        )
      return
    }
    this.db
      .prepare('SELECT photo_id, hash, width, height, png, bytes FROM mask_base_content LIMIT 0')
      .all()
  }
  initialize() {
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS mask_content (photo_id TEXT NOT NULL, hash TEXT NOT NULL, data TEXT NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY(photo_id, hash))',
    )
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS mask_base_content (photo_id TEXT NOT NULL, hash TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, png BLOB NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY(photo_id, hash))',
    )
  }
  bases(photoId: string, stack: readonly MaskDescriptor[]): MaskBaseContent[] {
    validateMaskStack(stack)
    const bases = new Map<string, MaskBaseContent>(),
      read = this.db.prepare(
        'SELECT width, height, png FROM mask_base_content WHERE photo_id = ? AND hash = ?',
      )
    let bytes = 0
    for (const mask of stack) {
      if (!mask.base || bases.has(mask.base.hash)) continue
      const row = read.get(photoId, mask.base.hash) as
        { width: number; height: number; png: Uint8Array } | undefined
      if (!row) throw new Error('Historical generated mask content is missing.')
      const content: MaskBaseContent = {
        version: 1,
        hash: mask.base.hash,
        width: row.width,
        height: row.height,
        pngBase64: Buffer.from(row.png).toString('base64'),
      }
      const png = verifiedMaskBaseBytes(content)
      if (JSON.stringify(maskBaseReference(content)) !== JSON.stringify(mask.base))
        throw new Error('Historical generated mask dimensions do not match its reference.')
      bytes += png.byteLength
      if (bytes > maskCapabilities.maxLiveBaseEncodedBytes)
        throw new Error('The live generated mask content limit was exceeded.')
      bases.set(content.hash, content)
    }
    return [...bases.values()]
  }
  content(photoId: string, stack: readonly MaskDescriptor[]): MaskStrokeChunk[] {
    validateMaskStack(stack)
    if (!stack.some((mask) => mask.head)) {
      resolveMasks(stack, [], this.bases(photoId, stack))
      return []
    }
    const content = new Map<string, MaskStrokeChunk>(),
      pending = stack.flatMap((mask) => (mask.head ? [mask.head] : []))
    let points = 0
    const read = this.db.prepare('SELECT data FROM mask_content WHERE photo_id = ? AND hash = ?')
    while (pending.length) {
      const hash = pending.pop()!
      if (content.has(hash)) continue
      const row = read.get(photoId, hash) as { data: string } | undefined
      if (!row) throw new Error('Historical mask content is missing.')
      const value = JSON.parse(row.data) as {
        version: number
        parent: string | null
        stroke: MaskStrokeChunk['stroke']
      }
      if (
        value.version !== 1 ||
        (value.parent !== null &&
          (typeof value.parent !== 'string' || !maskHash.test(value.parent)))
      )
        throw new Error('Invalid historical mask content.')
      const encoded = maskChunkBytes(value.parent, value.stroke)
      if (createHash('sha256').update(encoded).digest('hex') !== hash)
        throw new Error('Historical mask content hash mismatch.')
      points += value.stroke.points.length
      if (points > maskCapabilities.maxLivePoints)
        throw new Error('The live brush geometry limit was exceeded.')
      content.set(hash, { hash, parent: value.parent, stroke: value.stroke })
      if (value.parent) pending.push(value.parent)
    }
    const chunks = [...content.values()]
    resolveMasks(stack, chunks, this.bases(photoId, stack))
    return chunks
  }
  /** Called only inside the same catalog transaction that publishes history. */
  publish(
    photoId: string,
    stack: readonly MaskDescriptor[],
    chunks: readonly MaskStrokeChunk[] = [],
    bases: readonly MaskBaseContent[] = [],
  ) {
    if (!chunks.length && !bases.length) {
      this.content(photoId, stack)
      return
    }
    let bytes = Number(
      (
        this.db
          .prepare(
            'SELECT (SELECT COALESCE(SUM(bytes), 0) FROM mask_content WHERE photo_id = ?) + (SELECT COALESCE(SUM(bytes), 0) FROM mask_base_content WHERE photo_id = ?) AS bytes',
          )
          .get(photoId, photoId) as { bytes: number }
      ).bytes,
    )
    const insertBase = this.db.prepare(
      'INSERT OR IGNORE INTO mask_base_content VALUES (?, ?, ?, ?, ?, ?)',
    )
    for (const base of bases) {
      const png = verifiedMaskBaseBytes(base)
      if (insertBase.run(photoId, base.hash, base.width, base.height, png, png.byteLength).changes)
        bytes += png.byteLength
      if (bytes > maskCapabilities.maxRetainedBytes)
        throw new Error(
          'The retained mask data limit was exceeded. Keep the existing selection or use another photograph.',
        )
    }
    const insert = this.db.prepare('INSERT OR IGNORE INTO mask_content VALUES (?, ?, ?, ?)')
    for (const chunk of chunks) {
      const encoded = maskChunkBytes(chunk.parent, chunk.stroke)
      if (
        !maskHash.test(chunk.hash) ||
        createHash('sha256').update(encoded).digest('hex') !== chunk.hash
      )
        throw new Error('Invalid immutable mask hash.')
      if (
        chunk.parent &&
        !this.db
          .prepare('SELECT 1 FROM mask_content WHERE photo_id = ? AND hash = ?')
          .get(photoId, chunk.parent)
      )
        throw new Error('Mask parent content is unavailable.')
      const size = Buffer.byteLength(encoded)
      if (insert.run(photoId, chunk.hash, encoded, size).changes) bytes += size
      if (bytes > maskCapabilities.maxRetainedBytes)
        throw new Error('The retained mask data limit was exceeded.')
    }
    this.content(photoId, stack)
  }
}
