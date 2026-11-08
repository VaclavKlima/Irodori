import { expect, test } from '@playwright/test'
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generatedMask } from './helpers/generated-mask'
import {
  MaskContentStore,
  prepareMaskMutation,
  prepareMaskBaseReplacement,
  verifiedMaskBaseBytes,
} from '../src/main/mask-store'
import { maskBaseReference, resolveMasks } from '../src/shared/masks'
import { maskBaseAtlasPlan, localMaskPixelData, packLocalMasks } from '../src/shared/masks-gpu'
import { catalogTransaction } from '../src/main/catalog/transaction'

test('generated base replacement preserves ordered Paint/Erase and immutable content across restart and history branches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-generated-mask-')),
    path = join(root, 'masks.sqlite'),
    photo = 'a'.repeat(64),
    id = randomUUID()
  let db = new DatabaseSync(path),
    store = new MaskContentStore(db)
  try {
    store.initialize()
    const first = prepareMaskMutation([], {
        operations: [
          { kind: 'create', id, name: 'Subject' },
          {
            kind: 'stroke',
            id,
            stroke: { mode: 'add', radius: 0.1, feather: 0.5, points: [{ x: 0.2, y: 0.3 }] },
          },
          {
            kind: 'stroke',
            id,
            stroke: { mode: 'subtract', radius: 0.05, feather: 0, points: [{ x: 0.4, y: 0.5 }] },
          },
        ],
      }),
      a = generatedMask(8, 6, (x) => (x < 4 ? 255 : 0)),
      b = generatedMask(8, 6, (_, y) => (y < 3 ? 255 : 0))
    const accepted = prepareMaskBaseReplacement(first.stack, id, a)
    catalogTransaction(db, () => store.publish(photo, accepted, first.chunks, [a]))
    const refined = prepareMaskBaseReplacement(accepted, id, b)
    catalogTransaction(db, () => store.publish(photo, refined, [], [b]))
    expect(refined[0].head).toBe(accepted[0].head)
    expect(JSON.stringify(refined)).not.toMatch(/pngBase64|points/)
    const decoded = resolveMasks(
      refined,
      store.content(photo, refined),
      store.bases(photo, refined),
    )
    expect(decoded[0].strokes.map((s) => s.mode)).toEqual(['add', 'subtract'])
    expect(decoded[0].base?.hash).toBe(b.hash)
    expect(() => resolveMasks(refined, first.chunks)).toThrow('missing')
    catalogTransaction(db, () => store.publish(photo, []))
    db.close()
    db = new DatabaseSync(path)
    store = new MaskContentStore(db)
    store.validateExisting(true)
    expect(store.bases(photo, accepted)).toEqual([a])
    expect(store.bases(photo, refined)).toEqual([b])
    expect(store.content(photo, refined)).toEqual(store.content(photo, accepted))
    const corrupt = Buffer.from(a.pngBase64, 'base64')
    corrupt[corrupt.length - 5] ^= 1
    const bad = {
      ...a,
      pngBase64: corrupt.toString('base64'),
      hash: createHash('sha256').update(corrupt).digest('hex'),
    }
    expect(() => verifiedMaskBaseBytes(bad)).toThrow(/checksum|end/)
    const dimensions = { ...a, width: 7 }
    expect(() =>
      catalogTransaction(db, () => store.publish(photo, accepted, [], [dimensions])),
    ).toThrow('R8 PNG')
    expect(store.bases(photo, accepted)).toEqual([a])
  } finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('base hash changes rendering identity; duplicate masks share one native atlas layer and stale grids refuse', () => {
  const a = generatedMask(32, 24, (x, y) => ((x + y) % 2 ? 255 : 0)),
    id = randomUUID(),
    created = prepareMaskMutation([], {
      operations: [{ kind: 'create', id, name: 'Subject' }],
    }).stack,
    stack = prepareMaskBaseReplacement(created, id, a)
  stack[0].light.exposureEv = 1
  const masks = resolveMasks(stack, [], [a]),
    duplicate = { ...masks[0], id: randomUUID() }
  const plan = maskBaseAtlasPlan({ localMasks: [...masks, duplicate] })
  expect(plan.layers).toBe(1)
  expect(plan.bytes).toBe(32 * 24)
  expect(plan.uploadBytes).toBeLessThanOrEqual(4 * 1024 * 1024)
  expect(localMaskPixelData({ localMasks: masks })).toEqual([
    {
      inverted: false,
      light: masks[0].light,
      edge: masks[0].edge,
      strokes: [],
      base: maskBaseReference(a),
    },
  ])
  expect(() => packLocalMasks({ localMasks: masks }, { width: 31, height: 24 })).toThrow(
    'source grid',
  )
  expect(packLocalMasks({ localMasks: masks }, { width: 32, height: 24 })[27]).toBe(1)
})
