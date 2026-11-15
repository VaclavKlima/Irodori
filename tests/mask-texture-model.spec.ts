import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { prepareMaskMutation } from '../src/main/mask-store'
import {
  migrateEditingHistory,
  supportsEditingSettings,
  CATALOG_VERSION,
} from '../src/main/catalog/editing-migration'
import { initialSettings, SETTINGS_VERSION } from '../src/shared/edits'
import { spatialControlsKey } from '../src/shared/detail-controls'
import {
  hasMaskedTexture,
  maskedTextureKey,
  maskedTextureSettingsKey,
} from '../src/shared/masked-texture'
import { hasLocalMasks, localMaskPixelData, packLocalMasks } from '../src/shared/masks-gpu'
import { maskEdgePixelIdentity } from '../src/shared/mask-edges'
import { neutralAdjustments } from '../src/shared/adjustments'
import { identityMaskGeometry } from '../src/shared/mask-geometry'
import {
  maskCapabilities,
  resolveMasks,
  validateMaskMutation,
  validateMaskStack,
  validateMaskTexture,
} from '../src/shared/masks'

const gradient = {
  kind: 'radial' as const,
  center: { x: 0.5, y: 0.5 },
  radiusX: 0.3,
  radiusY: 0.25,
  rotation: 0,
  feather: 40,
}
function made() {
  const id = randomUUID()
  return {
    id,
    ...prepareMaskMutation([], {
      operations: [{ kind: 'create', id, name: 'Feathers', gradient }],
    }),
  }
}

test('Texture validates signed integer root values and never becomes a coverage operand control', () => {
  expect(maskCapabilities.texture).toMatchObject({ min: -100, max: 100, step: 1, default: 0 })
  for (const amount of [-100, -25, 0, 25, 100]) validateMaskTexture(amount)
  for (const amount of [NaN, Infinity, -Infinity, -101, 101, 0.5, '25', null, undefined])
    expect(() => validateMaskTexture(amount)).toThrow('Texture')
  const f = made(),
    part = randomUUID()
  expect(f.stack[0].texture).toBe(0)
  validateMaskStack(f.stack)
  const missing = structuredClone(f.stack)
  Reflect.deleteProperty(missing[0], 'texture')
  expect(() => validateMaskStack(missing)).toThrow('descriptor')
  expect(() =>
    validateMaskMutation({
      operations: [{ kind: 'component-update', id: f.id, componentId: part, texture: 25 }],
    }),
  ).toThrow()
  const withPart = prepareMaskMutation(f.stack, {
    operations: [
      {
        kind: 'component-add',
        id: f.id,
        componentId: part,
        name: 'Part',
        operator: 'add',
        gradient,
      },
    ],
  })
  expect(() =>
    prepareMaskMutation(withPart.stack, {
      operations: [{ kind: 'update', id: f.id, componentId: part, texture: 25 }],
    }),
  ).toThrow('destination mask')
})

test('Texture-only roots activate the existing coverage program without changing coverage identity', () => {
  const f = made(),
    resolved = resolveMasks(f.stack, f.chunks)
  const parameters = {
    ...neutralAdjustments,
    localMasks: resolved,
    maskGeometry: identityMaskGeometry(17, 13),
  }
  expect(hasMaskedTexture(parameters)).toBe(false)
  expect(hasLocalMasks(parameters)).toBe(false)
  const coverage = maskEdgePixelIdentity(resolved[0])
  resolved[0].texture = 25
  expect(hasMaskedTexture(parameters)).toBe(true)
  expect(hasLocalMasks(parameters)).toBe(true)
  expect(maskEdgePixelIdentity(resolved[0])).toBe(coverage)
  expect(localMaskPixelData(parameters)[0]).toMatchObject({ texture: 25 })
  expect(packLocalMasks(parameters, { width: 17, height: 13 }).length).toBeGreaterThan(
    packLocalMasks({ ...parameters, localMasks: [] }, { width: 17, height: 13 }).length,
  )
  const identity = maskedTextureKey(parameters)
  resolved[0].texture = -25
  expect(maskedTextureKey(parameters)).not.toBe(identity)
  resolved[0].enabled = false
  expect(hasMaskedTexture(parameters)).toBe(false)
  expect(maskedTextureKey(parameters)).toBeUndefined()
  resolved[0].enabled = true
  resolved[0].texture = 0
  expect(localMaskPixelData(parameters)).toEqual([])
})

test('Texture duplicates independently, resolves with root state and resets without changing Light or Color', () => {
  const f = made(),
    copy = randomUUID()
  const changed = prepareMaskMutation(f.stack, {
    operations: [
      { kind: 'update', id: f.id, texture: 25, light: { shadows: 17 }, color: { saturation: 8 } },
      { kind: 'duplicate', id: f.id, newId: copy, name: 'Reflection' },
    ],
  })
  expect(changed.stack.map((mask) => mask.texture)).toEqual([25, 25])
  const reset = prepareMaskMutation(changed.stack, {
    operations: [{ kind: 'update', id: copy, texture: 0 }],
  })
  expect(reset.stack[0]).toMatchObject({
    texture: 0,
    light: changed.stack[0].light,
    color: changed.stack[0].color,
  })
  expect(reset.stack[1].texture).toBe(25)
  expect(resolveMasks(reset.stack, []).map((mask) => mask.texture)).toEqual([0, 25])
  const before = structuredClone(changed.stack)
  expect(() =>
    prepareMaskMutation(changed.stack, {
      operations: [
        { kind: 'update', id: copy, texture: -25 },
        { kind: 'update', id: f.id, texture: 100.5 },
      ],
    }),
  ).toThrow('Texture')
  expect(changed.stack).toEqual(before)
})

test('settings-19 migration fills Texture in every snapshot without changing history branches, revisions or timestamps', () => {
  expect(SETTINGS_VERSION).toBe(20)
  expect(CATALOG_VERSION).toBe(30)
  const f = made(),
    settings = structuredClone(initialSettings())
  settings.maskStack = f.stack
  const legacySettings = JSON.parse(JSON.stringify(settings))
  legacySettings.version = 19
  for (const mask of legacySettings.maskStack) delete mask.texture
  expect(supportsEditingSettings(legacySettings, 29)).toBe(true)
  expect(supportsEditingSettings({ ...legacySettings, maskStack: f.stack }, 29)).toBe(false)
  const history = {
    photoId: 'a'.repeat(64),
    revision: 17,
    cursor: 1,
    canUndo: true,
    canRedo: true,
    settings: legacySettings,
    snapshots: [0, 1, 2].map((i) => ({
      createdAt: `2026-11-0${i + 1}T12:00:00Z`,
      settings: { ...structuredClone(legacySettings), exposureEv: i },
    })),
  }
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('CREATE TABLE edits(id TEXT PRIMARY KEY,data TEXT NOT NULL)')
    db.prepare('INSERT INTO edits VALUES(?,?)').run(history.photoId, JSON.stringify(history))
    migrateEditingHistory(db)
    const actual = JSON.parse((db.prepare('SELECT data FROM edits').get() as { data: string }).data)
    const upgraded = (value: typeof legacySettings) => ({
      ...value,
      version: 20,
      maskStack: value.maskStack.map((mask: object) => ({ ...mask, texture: 0 })),
    })
    expect(actual).toEqual({
      ...history,
      settings: upgraded(history.settings),
      snapshots: history.snapshots.map((snapshot) => ({
        ...snapshot,
        settings: upgraded(snapshot.settings),
      })),
    })
    expect(supportsEditingSettings(actual.settings, 30)).toBe(true)
    const bytes = (db.prepare('SELECT data FROM edits').get() as { data: string }).data
    migrateEditingHistory(db)
    expect((db.prepare('SELECT data FROM edits').get() as { data: string }).data).toBe(bytes)
  } finally {
    db.close()
  }
})

test('ordered Texture invalidates spatial preparation for preceding edits while labels, disabled roots and neutral Texture retain the old path', () => {
  const f = made(),
    settings = initialSettings()
  settings.maskStack = f.stack
  const neutralKey = spatialControlsKey(settings)
  expect(maskedTextureSettingsKey(settings)).toBeUndefined()
  expect(spatialControlsKey({ ...settings, exposureEv: 1 })).toBe(neutralKey)
  settings.maskStack[0].texture = 25
  const key = spatialControlsKey(settings)
  expect(key).not.toBe(neutralKey)
  expect(spatialControlsKey({ ...settings, exposureEv: 1 })).not.toBe(key)
  const renamed = structuredClone(settings)
  renamed.maskStack[0].name = 'Renamed'
  expect(spatialControlsKey(renamed)).toBe(key)
  const previous = made()
  previous.stack[0].light.shadows = 10
  settings.maskStack.push(previous.stack[0])
  const ordered = spatialControlsKey(settings)
  settings.maskStack[1].light.shadows = 11
  expect(spatialControlsKey(settings)).not.toBe(ordered)
  settings.maskStack.reverse()
  expect(spatialControlsKey(settings)).not.toBe(ordered)
  settings.maskStack.find((mask) => mask.texture !== 0)!.enabled = false
  expect(maskedTextureSettingsKey(settings)).toBeUndefined()
  settings.maskStack = made().stack
  settings.maskStack[0].texture = 25
  delete settings.maskStack[0].gradient
  expect(maskedTextureSettingsKey(settings)).toBeUndefined()
})
