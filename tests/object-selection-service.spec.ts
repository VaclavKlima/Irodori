import { objectSelectionMemoryPlan } from '../src/shared/object-selection-resources'
import { expect, test } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ObjectSelectionService, selectedMaskStack } from '../src/main/object-selection/service'
import { initialSettings, SETTINGS_VERSION, type EditState } from '../src/shared/edits'
import { identityMaskGeometry, type MaskGeometry } from '../src/shared/mask-geometry'
import { neutralMaskColor, neutralMaskLight, type ResolvedMask } from '../src/shared/masks'
import type { ObjectSelectionRequest } from '../src/shared/object-selection'
import { cropAdmission } from './crop-frame.helpers'
import { syntheticExportSource } from './export.helpers'
import { generatedMask } from './helpers/generated-mask'
import { DatabaseSync } from 'node:sqlite'
import {
  migrateEditingHistory,
  supportsEditingSettings,
  CATALOG_VERSION,
} from '../src/main/catalog/editing-migration'
import { catalogTransaction } from '../src/main/catalog/transaction'
import { MaskContentStore, prepareMaskMutation } from '../src/main/mask-store'

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'irodori-selection-service-'))
  const source = await syntheticExportSource(root, 16, 16, (x, y) => [x / 16, y / 16, 0.3])
  let state: EditState = {
    photoId: source.photo.id,
    revision: 4,
    settings: initialSettings(),
    canUndo: false,
    canRedo: false,
  }
  let geometry: MaskGeometry = identityMaskGeometry(16, 16)
  const calls = { decode: 0, run: 0, commits: 0, coverage: 0, runtimeClose: 0, decoderClose: 0 }
  const outputs: string[] = []
  const options: {
    badFrameHash?: boolean
    beforeDecode?: (signal: AbortSignal) => Promise<void>
    beforeRun?: (signal: AbortSignal) => Promise<void>
    beforeRuntimeClose?: () => Promise<void>
    beforeDecoderClose?: () => Promise<void>
    beforeCoverage?: (signal: AbortSignal) => Promise<void>
  } = {}
  const service = new ObjectSelectionService(
    root,
    {
      source: async () => source,
      context: async (photoId) => ({
        photoId,
        revision: state.revision,
        geometry,
        width: 16,
        height: 16,
        renderingIdentity: 'a'.repeat(64),
      }),
      edits: async () => structuredClone(state),
      admission: async () => cropAdmission(),
      prepareCoverage: async (mask, context, signal) => {
        calls.coverage++
        expect(context.geometry.canonicalWidth).toBe(16)
        expect(mask.preparedCoverage).toBeUndefined()
        await options.beforeCoverage?.(signal)
        signal.throwIfAborted()
        return { ...generatedMask(16, 16, () => 128), key: 'a'.repeat(64) }
      },
      commit: async (request, base, id) => {
        if (request.expectedRevision !== state.revision)
          throw new Error('Expected revision changed.')
        calls.commits++
        state = {
          ...state,
          revision: state.revision + 1,
          settings: {
            ...state.settings,
            maskStack: selectedMaskStack(state.settings.maskStack, request, base, id),
          },
          maskBases: [base],
          canUndo: true,
        }
        source.processing.revision = state.revision
        return structuredClone(state)
      },
    },
    {
      decoder: {
        renderFull: async (_path, directory, signal, processing) => {
          calls.decode++
          expect(processing?.crop).toBeUndefined()
          expect(processing?.noiseReduction).toBeUndefined()
          expect(processing?.detailSharpening).toBeUndefined()
          expect(processing?.settings).toEqual({
            distortion: false,
            vignetting: false,
            chromaticAberration: false,
          })
          expect(processing?.adjustments?.localMasks ?? []).toEqual([])
          await options.beforeDecode?.(signal)
          signal.throwIfAborted()
          const bytes = Buffer.alloc(16 * 16 * 4, 127)
          await mkdir(directory, { recursive: true })
          await writeFile(join(directory, 'full.rgba'), bytes)
          return {
            width: 16,
            height: 16,
            byteLength: bytes.length,
            sha256: options.badFrameHash ? '0'.repeat(64) : sha(bytes),
            format: 'rgba8-srgb',
            renderId: 'synthetic-service-frame',
            placeholderBytes: 0,
          }
        },
        close: async () => {
          calls.decoderClose++
          await options.beforeDecoderClose?.()
        },
      },
      runtime: {
        run: async (input, prompts, output, signal) => {
          calls.run++
          outputs.push(output)
          expect(input).toEqual({
            key: input.key,
            path: input.path,
            width: 16,
            height: 16,
            format: 'rgba8',
          })
          expect((await readFile(input.path)).byteLength).toBe(16 * 16 * 4)
          expect(prompts.key).toBe(input.key)
          await options.beforeRun?.(signal)
          signal.throwIfAborted()
          const base = generatedMask(16, 16, (x) => (x < 8 ? 255 : 0))
          const png = Buffer.from(base.pngBase64, 'base64')
          await writeFile(output, png)
          return {
            key: input.key,
            width: 16,
            height: 16,
            path: output,
            sha256: base.hash,
            encodedBytes: png.length,
            modelIdentity: 'sam2.1-hiera-tiny-f32-labels-v1',
            selectedCandidate: 0,
            predictedIou: 0.9,
          }
        },
        close: async () => {
          calls.runtimeClose++
          await options.beforeRuntimeClose?.()
        },
      },
    },
  )
  return {
    root,
    source,
    calls,
    options,
    outputs,
    service,
    state: () => state,
    geometry: (next: MaskGeometry) => {
      geometry = next
    },
    revision: () => {
      state.revision++
      source.processing.revision = state.revision
    },
    setMask: (mask: ResolvedMask) => {
      const { base } = mask
      state.settings.maskStack = [
        {
          id: mask.id,
          name: mask.name,
          enabled: mask.enabled,
          inverted: mask.inverted,
          head: mask.head,
          light: { ...mask.light },
          color: { ...mask.color },
          edge: { ...mask.edge },
          ...(base
            ? { base: { version: 1, hash: base.hash, width: base.width, height: base.height } }
            : {}),
        },
      ]
      source.processing.adjustments = {
        ...source.processing.adjustments!,
        localMasks: [structuredClone(mask)],
      }
    },
    request: async (
      extra: Partial<ObjectSelectionRequest> = {},
    ): Promise<ObjectSelectionRequest> => {
      const context = await service.context(source.photo.id, state.revision)
      return {
        photoId: source.photo.id,
        expectedRevision: state.revision,
        gridIdentity: context.gridIdentity,
        prompts: { box: [0.2, 0.2, 0.8, 0.8], positivePoints: [], negativePoints: [] },
        ...extra,
      }
    },
    close: async () => {
      await service.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

test('a proposal changes no history; explicit acceptance commits once and consumes its immutable target', async () => {
  const f = await fixture()
  try {
    const request = await f.request()
    const proposal = await f.service.create(request)
    expect(f.calls.commits).toBe(0)
    expect(f.state().revision).toBe(4)
    expect(f.state().settings.maskStack).toEqual([])
    expect(proposal.mask.base?.hash).toHaveLength(64)
    expect(proposal.mask.edge).toEqual({ featherPx: 0, shiftPx: 0 })
    await expect(readFile(f.outputs[0])).rejects.toThrow(/ENOENT/)
    const accepted = await f.service.accept({
      photoId: request.photoId,
      expectedRevision: 4,
      proposalId: proposal.id,
    })
    expect(accepted.revision).toBe(5)
    expect(accepted.settings.version).toBe(SETTINGS_VERSION)
    expect(accepted.settings.maskStack[0].base?.hash).toBe(proposal.mask.base?.hash)
    await expect(
      f.service.accept({ photoId: request.photoId, expectedRevision: 4, proposalId: proposal.id }),
    ).rejects.toThrow(/unavailable/)
    expect(f.calls.commits).toBe(1)
  } finally {
    await f.close()
  }
})

test('same-grid base replacement preserves the existing name, controls, history head and manual strokes', async () => {
  const f = await fixture()
  try {
    const mask: ResolvedMask = {
      id: randomUUID(),
      name: 'Manually repaired object',
      enabled: false,
      inverted: true,
      head: 'c'.repeat(64),
      color: { temperature: 12, tint: -3, saturation: -15 },
      light: { ...neutralMaskLight, exposureEv: 1.2, shadows: 12 },
      edge: { featherPx: 12.5, shiftPx: -3 },
      base: generatedMask(16, 16, () => 0),
      strokes: [
        { mode: 'add', radius: 0.1, feather: 0.5, points: [{ x: 0.2, y: 0.3 }] },
        { mode: 'subtract', radius: 0.05, feather: 0, points: [{ x: 0.6, y: 0.4 }] },
      ],
    }
    f.setMask(mask)
    const request = await f.request({ maskId: mask.id })
    const proposal = await f.service.create(request)
    expect(proposal.mask).toMatchObject({
      id: mask.id,
      name: mask.name,
      enabled: false,
      inverted: true,
      head: mask.head,
      light: mask.light,
      color: mask.color,
      edge: mask.edge,
      strokes: mask.strokes,
    })
    expect(proposal.mask.base?.hash).not.toBe(mask.base?.hash)
    expect(proposal.mask.preparedCoverage?.key).toBe('a'.repeat(64))
    expect(f.calls.coverage).toBe(1)
    expect(f.calls.commits).toBe(0)
    const result = await f.service.accept({
      photoId: request.photoId,
      expectedRevision: 4,
      proposalId: proposal.id,
    })
    expect(result.settings.maskStack[0]).toMatchObject({
      head: mask.head,
      light: mask.light,
      color: mask.color,
      edge: mask.edge,
      enabled: false,
      inverted: true,
      base: { hash: proposal.mask.base!.hash },
    })
  } finally {
    await f.close()
  }
})

test('equal-sized rotation, source identity and revision changes reject stale requests before preparation', async () => {
  for (const change of ['rotation', 'source', 'revision'] as const) {
    const f = await fixture()
    try {
      const request = await f.request()
      if (change === 'rotation') f.geometry({ ...identityMaskGeometry(16, 16), flip: 4 })
      if (change === 'source') f.source.identity.mtimeMs++
      if (change === 'revision') f.revision()
      await expect(f.service.create(request)).rejects.toThrow(/changed/)
      expect(f.calls).toMatchObject({ decode: 0, run: 0, commits: 0 })
    } finally {
      await f.close()
    }
  }
})

test('an elongated source below the pixel budget still refuses the declared per-side limit before preparation', async () => {
  const f = await fixture()
  try {
    f.geometry(identityMaskGeometry(16_384, 1000))
    await expect(f.service.context(f.source.photo.id, 4)).rejects.toThrow(/8192 pixels per side/)
    expect(f.calls).toMatchObject({ decode: 0, run: 0, commits: 0 })
  } finally {
    await f.close()
  }
})

test('a source/grid change during inference rejects publication and accepting a stale proposal never commits', async () => {
  const f = await fixture()
  try {
    const request = await f.request()
    f.options.beforeRun = async () => {
      f.geometry({ ...identityMaskGeometry(16, 16), flip: 4 })
    }
    await expect(f.service.create(request)).rejects.toThrow(/geometry changed/)
    await expect(readFile(f.outputs[0])).rejects.toThrow(/ENOENT/)
    expect(f.calls.commits).toBe(0)
    f.geometry(identityMaskGeometry(16, 16))
    f.options.beforeRun = undefined
    const proposal = await f.service.create(await f.request())
    f.source.identity.ctimeMs++
    await expect(
      f.service.accept({ photoId: request.photoId, expectedRevision: 4, proposalId: proposal.id }),
    ).rejects.toThrow(/geometry changed/)
    expect(f.calls.commits).toBe(0)
  } finally {
    await f.close()
  }
})

test('a same-size RGBA hash mismatch refuses inference and leaves no prepared source', async () => {
  const f = await fixture()
  try {
    f.options.badFrameHash = true
    await expect(f.service.create(await f.request())).rejects.toThrow(/source hash changed/)
    expect(f.calls).toMatchObject({ decode: 1, run: 0, commits: 0 })
    expect(await readdir(join(f.root, 'cache', 'object-selection'))).toEqual([])
  } finally {
    await f.close()
  }
})

for (const phase of ['beforeDecode', 'beforeRun'] as const) {
  test(`cancellation during ${phase} drains temporary ownership and a fresh request can retry`, async () => {
    const f = await fixture()
    let started!: () => void
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    f.options[phase] = async (signal) => {
      started()
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('Selection cancelled.')), {
          once: true,
        }),
      )
    }
    try {
      const pending = f.service.create(await f.request())
      await ready
      const rejected = expect(pending).rejects.toThrow(/cancelled/)
      await f.service.cancel(f.source.photo.id)
      await rejected
      expect(f.calls.commits).toBe(0)
      expect(await readdir(join(f.root, 'cache', 'object-selection'))).toEqual([])
      f.options[phase] = undefined
      const proposal = await f.service.create(await f.request())
      expect(proposal.photoId).toBe(f.source.photo.id)
      expect(f.calls.commits).toBe(0)
    } finally {
      await f.close()
    }
  })
}

test('invalid or overflowing prompts are refused before any source preparation or inference', async () => {
  const f = await fixture()
  try {
    const request = await f.request()
    expect(() =>
      f.service.create({ ...request, prompts: { positivePoints: [], negativePoints: [] } }),
    ).toThrow(/box or a positive point/)
    expect(() =>
      f.service.create({
        ...request,
        prompts: {
          positivePoints: Array.from({ length: 7 }, () => [0.5, 0.5]),
          negativePoints: [],
        },
      }),
    ).toThrow(/six prompt slots/)
    expect(f.calls).toMatchObject({ decode: 0, run: 0, commits: 0 })
  } finally {
    await f.close()
  }
})

test('rapid same-photo cancellation serializes cleanup before the next proposal and preserves that new proposal', async () => {
  const f = await fixture()
  let releaseCleanup!: () => void
  let cleanupStarted!: () => void
  const cleanup = new Promise<void>((resolve) => {
    releaseCleanup = resolve
  })
  const started = new Promise<void>((resolve) => {
    cleanupStarted = resolve
  })
  try {
    const previous = await f.service.create(await f.request())
    let held = false
    f.options.beforeRuntimeClose = async () => {
      if (held) return
      held = true
      cleanupStarted()
      await cleanup
    }
    const cancelled = f.service.cancel(f.source.photo.id)
    await started
    const latest = f.service.create(await f.request())
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(f.calls.run).toBe(1)
    releaseCleanup()
    await cancelled
    const proposal = await latest
    expect(proposal.id).not.toBe(previous.id)
    expect(f.calls).toMatchObject({ decode: 2, run: 2, commits: 0 })
    const accepted = await f.service.accept({
      photoId: f.source.photo.id,
      expectedRevision: 4,
      proposalId: proposal.id,
    })
    expect(accepted.revision).toBe(5)
    expect(f.calls.commits).toBe(1)
  } finally {
    releaseCleanup()
    await f.close()
  }
})

test('removing a decoding photograph waits for its drained decoder even after another photo queues', async () => {
  const f = await fixture()
  let decodeStarted!: () => void
  let closeStarted!: () => void
  let releaseClose!: () => void
  const decoding = new Promise<void>((resolve) => {
    decodeStarted = resolve
  })
  const closing = new Promise<void>((resolve) => {
    closeStarted = resolve
  })
  const closeGate = new Promise<void>((resolve) => {
    releaseClose = resolve
  })
  f.options.beforeDecode = async (signal) => {
    if (f.calls.decode !== 1) return
    decodeStarted()
    await new Promise<void>((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(new Error('Selection cancelled.')), {
        once: true,
      }),
    )
  }
  let held = false
  f.options.beforeDecoderClose = async () => {
    if (held) return
    held = true
    closeStarted()
    await closeGate
  }
  try {
    const first = f.service.create(await f.request())
    const firstRejected = expect(first).rejects.toThrow(/cancelled/)
    await decoding
    const otherPhotoId = 'b'.repeat(64)
    const otherContext = await f.service.context(otherPhotoId, 4)
    const queued = f.service.create({
      ...(await f.request()),
      photoId: otherPhotoId,
      gridIdentity: otherContext.gridIdentity,
    })
    await closing
    let trashBarrierReleased = false
    const removal = f.service.beginRemoval(f.source.photo.id).then(() => {
      trashBarrierReleased = true
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(trashBarrierReleased).toBe(false)
    expect(f.calls.run).toBe(0)
    await expect(f.service.context(f.source.photo.id, 4)).rejects.toThrow(/being removed/)
    releaseClose()
    await firstRejected
    await removal
    expect(trashBarrierReleased).toBe(true)
    expect((await queued).photoId).toBe(otherPhotoId)
    expect(f.calls).toMatchObject({ decode: 2, run: 1, commits: 0 })
    f.service.endRemoval(f.source.photo.id)
  } finally {
    releaseClose()
    await f.close()
  }
})

test('acceptance finishes worker cleanup before a new request at the committed revision can infer', async () => {
  const f = await fixture()
  let releaseCleanup!: () => void
  let cleanupStarted!: () => void
  const cleanup = new Promise<void>((resolve) => {
    releaseCleanup = resolve
  })
  const started = new Promise<void>((resolve) => {
    cleanupStarted = resolve
  })
  try {
    const previous = await f.service.create(await f.request())
    let held = false
    f.options.beforeRuntimeClose = async () => {
      if (held) return
      held = true
      cleanupStarted()
      await cleanup
    }
    const acceptance = f.service.accept({
      photoId: f.source.photo.id,
      expectedRevision: 4,
      proposalId: previous.id,
    })
    await started
    expect(f.state().revision).toBe(5)
    expect(f.source.processing.revision).toBe(5)
    const latest = f.service.create(await f.request())
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(f.calls.run).toBe(1)
    releaseCleanup()
    await acceptance
    const proposal = await latest
    expect(proposal.revision).toBe(5)
    expect(proposal.id).not.toBe(previous.id)
    expect(f.calls).toMatchObject({ run: 2, commits: 1 })
  } finally {
    releaseCleanup()
    await f.close()
  }
})

test('catalog 23 / settings 13 migration preserves every brush-history branch, head, timestamp and immutable stroke', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('CREATE TABLE edits (id TEXT PRIMARY KEY, data TEXT NOT NULL); PRAGMA user_version=23')
    const store = new MaskContentStore(db),
      photoId = 'a'.repeat(64),
      maskId = randomUUID()
    store.initialize()
    const first = prepareMaskMutation([], {
      operations: [
        { kind: 'create', id: maskId, name: 'Existing manual object' },
        {
          kind: 'stroke',
          id: maskId,
          stroke: { mode: 'add', radius: 0.1, feather: 0.6, points: [{ x: 0.2, y: 0.3 }] },
        },
      ],
    })
    const second = prepareMaskMutation(first.stack, {
      operations: [
        {
          kind: 'stroke',
          id: maskId,
          stroke: { mode: 'subtract', radius: 0.03, feather: 0.4, points: [{ x: 0.4, y: 0.5 }] },
        },
        { kind: 'update', id: maskId, light: { exposureEv: 0.7, blacks: -3 } },
      ],
    })
    catalogTransaction(db, () =>
      store.publish(photoId, second.stack, [...first.chunks, ...second.chunks]),
    )
    const settings = [
      initialSettings(),
      { ...initialSettings(), maskStack: first.stack },
      { ...initialSettings(), maskStack: second.stack },
    ]
    const expected = {
      photoId,
      revision: 9,
      cursor: 1,
      canUndo: true,
      canRedo: true,
      settings: settings[1],
      snapshots: settings.map((value, index) => ({
        settings: value,
        createdAt: `2026-11-0${index + 1}T12:00:00Z`,
      })),
    }
    const legacy = JSON.parse(JSON.stringify(expected))
    for (const value of [
      legacy.settings,
      ...legacy.snapshots.map((snapshot: { settings: unknown }) => snapshot.settings),
    ]) {
      value.version = 13
      for (const mask of value.maskStack) {
        delete mask.edge
        delete mask.color
      }
    }
    expect(supportsEditingSettings(legacy.settings, 23)).toBe(true)
    db.prepare('INSERT INTO edits VALUES (?, ?)').run(photoId, JSON.stringify(legacy))
    const immutableBefore = db.prepare('SELECT * FROM mask_content ORDER BY hash').all()
    catalogTransaction(db, () => migrateEditingHistory(db))
    const actual = JSON.parse((db.prepare('SELECT data FROM edits').get() as { data: string }).data)
    expect(actual).toEqual(expected)
    expect(supportsEditingSettings(actual.settings, CATALOG_VERSION)).toBe(true)
    expect(db.prepare('SELECT * FROM mask_content ORDER BY hash').all()).toEqual(immutableBefore)
    expect(store.content(photoId, first.stack)).toEqual(first.chunks)
    expect(store.content(photoId, second.stack)).toHaveLength(2)
  } finally {
    db.close()
  }
})

test('a generated base disguised as settings 13 is refused and rolls back all earlier migration writes', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('CREATE TABLE edits (id TEXT PRIMARY KEY, data TEXT NOT NULL); PRAGMA user_version=23')
    const good = { ...initialSettings(), version: 13 }
    const bad = {
      ...good,
      maskStack: [
        {
          id: randomUUID(),
          name: 'Unsupported future base',
          enabled: true,
          inverted: false,
          head: null,
          light: { ...neutralMaskLight },
          base: { version: 1, hash: 'c'.repeat(64), width: 16, height: 16 },
        },
      ],
    }
    expect(supportsEditingSettings(bad, 23)).toBe(false)
    for (const [id, settings] of [
      ['a', good],
      ['b', bad],
    ] as const)
      db.prepare('INSERT INTO edits VALUES (?, ?)').run(
        id.repeat(64),
        JSON.stringify({
          photoId: id.repeat(64),
          settings,
          snapshots: [{ settings, createdAt: '2026-11-01T00:00:00Z' }],
          revision: 3,
          cursor: 0,
        }),
      )
    const before = db.prepare('SELECT * FROM edits ORDER BY id').all()
    expect(() => catalogTransaction(db, () => migrateEditingHistory(db))).toThrow(/unsupported/)
    expect(db.prepare('SELECT * FROM edits ORDER BY id').all()).toEqual(before)
    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 23 })
  } finally {
    db.close()
  }
})

test('selection admission charges exact sequential GPU buffers without lowering the model allowance', () => {
  const width = 5496,
    height = 3672,
    pixels = width * height,
    mib = 1024 ** 2
  const admission = cropAdmission()
  const plan = objectSelectionMemoryPlan(width, height, admission)
  expect(plan.phases.preprocessing).toBe(
    pixels * 4 + 1024 * 3672 * 16 + 2 * 3 * 1024 * 1024 * 4 + 16,
  )
  expect(plan.phases.reconstruction).toBe(Math.ceil(pixels / 4) * 8 + 256 * 256 * 4 + 16)
  expect(plan.phases.modelAllowance).toBe(512 * mib)
  expect(plan.additionalVram).toBe(512 * mib + plan.phases.preprocessing)
  expect(plan.additionalRam).toBe(pixels * 24 + 1024 ** 3)
  expect(plan.vramBytes).toBe(admission.reservation.vramBytes + plan.additionalVram)
})

test('selection admission refuses exact image budget overflow and unsupported dimensions', () => {
  const initial = cropAdmission(),
    plan = objectSelectionMemoryPlan(256, 256, initial)
  const exact = {
    ...initial,
    policy: {
      ...initial.policy,
      ram: { ...initial.policy.ram, effectiveBytes: plan.ramBytes },
      vram: { ...initial.policy.vram, effectiveBytes: plan.vramBytes },
    },
  }
  expect(objectSelectionMemoryPlan(256, 256, exact).accepted).toBe(true)
  expect(
    objectSelectionMemoryPlan(256, 256, {
      ...exact,
      policy: {
        ...exact.policy,
        vram: { ...exact.policy.vram, effectiveBytes: plan.vramBytes - 1 },
      },
    }).accepted,
  ).toBe(false)
  expect(() => objectSelectionMemoryPlan(16384, 1000, initial)).toThrow()
})

test('edge-aware AI refinement retires its model heap and revalidates revision after coverage preparation', async () => {
  const f = await fixture()
  try {
    const mask: ResolvedMask = {
      id: randomUUID(),
      name: 'Refined edge',
      enabled: true,
      inverted: false,
      head: null,
      color: { ...neutralMaskColor },
      light: { ...neutralMaskLight },
      edge: { featherPx: 4, shiftPx: -1 },
      base: generatedMask(16, 16, () => 0),
      strokes: [],
    }
    f.setMask(mask)
    f.options.beforeCoverage = async () => {
      expect(f.calls.runtimeClose).toBeGreaterThan(0)
      f.revision()
    }
    await expect(f.service.create(await f.request({ maskId: mask.id }))).rejects.toThrow(/changed/)
    expect(f.calls).toMatchObject({ coverage: 1, commits: 0 })
    expect(f.state().settings.maskStack[0]).toMatchObject({
      edge: mask.edge,
      base: { hash: mask.base!.hash },
    })
  } finally {
    await f.close()
  }
})
