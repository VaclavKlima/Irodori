import { expect, test } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { PhotoLibrary } from './photo-library.helpers'
import { processingMetadata } from '../src/main/processing/metadata'
import { initialSettings, type EditHistory, type EditPatch } from '../src/shared/edits'
import { neutralColorMixer } from '../src/shared/color-mixer'
import { neutralColorGrading } from '../src/shared/color-grading'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'irodori-color-history-')),
    id = 'a'.repeat(64),
    original = Buffer.from('retained original; history tests must never decode this file'),
    processor = {
      process: async () => {
        throw new Error('Metadata-only history checks must not decode sources')
      },
      close: async () => {},
    }
  const events: number[] = []
  const make = () =>
    new PhotoLibrary(root, processor, (event) => {
      if (event.editsChanged) events.push(event.editsChanged.revision)
    })
  let library = make()
  await library.open()
  await mkdir(join(root, 'originals', id))
  await writeFile(join(root, 'originals', id, 'original.png'), original)
  await library.catalogCommands.command({
    operation: 'original.publish',
    payload: {
      photo: {
        id,
        filename: 'color.png',
        width: 16,
        height: 12,
        bytes: original.length,
        format: 'PNG',
        importedAt: '2026-10-27T12:00:00.000Z',
        previewSource: 'image',
        thumbnailUrl: '',
        previewUrl: '',
      },
      processingIdentity: 'display-referred-v1',
      metadata: processingMetadata({}, []),
      createdAt: '2026-10-27T12:00:00.000Z',
    },
  })
  const db = new DatabaseSync(join(root, 'catalog.sqlite'))
  return {
    id,
    events,
    db,
    get library() {
      return library
    },
    assertOriginal: async () =>
      expect(await readFile(join(root, 'originals', id, 'original.png'))).toEqual(original),
    restart: async () => {
      await library.close()
      library = make()
      await library.open()
    },
    close: async () => {
      await library.close()
      db.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

test('partial mixer and grading calls share atomic photo history, retain redo on no-ops and survive restart', async () => {
  const t = await fixture()
  try {
    const patch: EditPatch = {
      exposureEv: -0.75,
      saturation: 15,
      colorMixer: { ranges: { blue: { hue: -30, saturation: 20 } } },
      colorGrading: {
        tones: {
          shadows: { hue: 234.5, saturation: 25 },
          highlights: { hue: 35.1, luminance: -10 },
        },
        balance: 10,
      },
    }
    const pending = t.library.updateEdits(t.id, patch, 0)
    Object.assign(patch.colorGrading!.tones!.shadows!, { hue: 110 })
    await pending
    const first = await t.library.getEditHistory(t.id)
    expect(first).toMatchObject({
      revision: 1,
      cursor: 1,
      settings: {
        exposureEv: -0.75,
        saturation: 15,
        colorMixer: { ranges: { blue: { hue: -30, saturation: 20, luminance: 0 } } },
        colorGrading: {
          tones: {
            shadows: { hue: 234.5, saturation: 25, luminance: 0 },
            highlights: { hue: 35.1, luminance: -10 },
          },
          blending: 50,
          balance: 10,
        },
      },
    })
    expect(first.snapshots).toHaveLength(2)
    await t.library.updateEdits(
      t.id,
      {
        colorMixer: { ranges: { blue: { luminance: 20 } } },
        colorGrading: { tones: { shadows: { hue: 220 } } },
      },
      1,
    )
    const second = await t.library.getEditHistory(t.id)
    expect(second.settings.colorMixer.ranges.blue).toEqual({
      hue: -30,
      saturation: 20,
      luminance: 20,
    })
    expect(second.settings.colorGrading.tones.shadows).toEqual({
      hue: 220,
      saturation: 25,
      luminance: 0,
    })
    await t.library.undoEdit(t.id, 2)
    const undone = await t.library.getEditHistory(t.id)
    expect(undone.settings).toEqual(first.settings)
    await t.library.updateEdits(
      t.id,
      {
        colorMixer: { ranges: { blue: { hue: -30 } } },
        colorGrading: { tones: { shadows: { hue: 234.5 } } },
      },
      3,
    )
    expect(await t.library.getEditHistory(t.id)).toEqual(undone)
    await t.restart()
    expect(await t.library.getEditHistory(t.id)).toEqual(undone)
    expect((await t.library.redoEdit(t.id, 3)).settings).toEqual(second.settings)
    await t.library.updateEdits(
      t.id,
      { colorMixer: neutralColorMixer, colorGrading: neutralColorGrading },
      4,
    )
    expect(await t.library.getEdits(t.id)).toMatchObject({
      revision: 5,
      settings: {
        exposureEv: -0.75,
        saturation: 15,
        colorMixer: neutralColorMixer,
        colorGrading: neutralColorGrading,
      },
    })
    expect((await t.library.getEditHistory(t.id)).snapshots).toHaveLength(4)
    await t.library.undoEdit(t.id, 5)
    await t.library.updateEdits(t.id, { colorGrading: { tones: { midtones: { hue: 120 } } } }, 6)
    const branch = await t.library.getEditHistory(t.id)
    expect(branch).toMatchObject({
      revision: 7,
      canRedo: false,
      settings: { colorGrading: { tones: { midtones: { hue: 120, saturation: 0 } } } },
    })
    expect(branch.snapshots).toHaveLength(4)
    await expect(t.library.updateEdits(t.id, { colorGrading: {} }, 6)).rejects.toThrow(
      'Edit conflict',
    )
    expect(await t.library.getEditHistory(t.id)).toEqual(branch)
    expect(t.events).toEqual([1, 2, 3, 4, 5, 6, 7])
    await t.assertOriginal()
  } finally {
    await t.close()
  }
})

test('color write failures and malformed worker commits leave complete confirmed history unchanged', async () => {
  const t = await fixture()
  try {
    const before = await t.library.getEditHistory(t.id),
      patch: EditPatch = {
        colorMixer: { ranges: { red: { saturation: -40 } } },
        colorGrading: { blending: 75 },
      }
    t.db.exec(
      "CREATE TRIGGER fail_color BEFORE UPDATE ON edits BEGIN SELECT RAISE(ABORT, 'Color disk failure'); END",
    )
    await expect(t.library.updateEdits(t.id, patch, 0)).rejects.toThrow('Color disk failure')
    expect(await t.library.getEditHistory(t.id)).toEqual(before)
    expect(t.events).toEqual([])
    t.db.exec('DROP TRIGGER fail_color')
    for (const group of ['colorMixer', 'colorGrading'] as const) {
      const history: EditHistory = structuredClone(before)
      Object.assign(history.settings, { [group]: {} })
      Object.assign(history.snapshots[0].settings, { [group]: {} })
      await expect(
        t.library.catalogCommands.command({
          operation: 'edits.commit',
          payload: { history, expectedRevision: 0 },
        }),
      ).rejects.toThrow('Invalid confirmed edit settings')
      expect(await t.library.getEditHistory(t.id)).toEqual(before)
    }
    const results = await Promise.allSettled([
      t.library.updateEdits(t.id, patch, 0),
      t.library.updateEdits(
        t.id,
        { colorGrading: { tones: { highlights: { hue: 30, saturation: 20 } } } },
        0,
      ),
    ])
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(t.events).toEqual([1])
    await t.assertOriginal()
  } finally {
    await t.close()
  }
})

test('typed color capabilities report authored units and cannot be mutated by callers', async () => {
  const t = await fixture()
  try {
    const capabilities = t.library.getEditCapabilities()
    expect(capabilities).toMatchObject({
      settingsVersion: 11,
      domains: ['linear-srgb', 'linear-rec2020'],
      stageOrder: ['colorMixer', 'saturationVibrance', 'colorGrading'],
      colorMixer: { parameters: { hue: { min: -100, max: 100, degreesPerUnit: 0.3 } } },
      colorGrading: {
        parameters: {
          hue: { min: 0, max: 359.9, step: 0.1, unit: 'degrees' },
          blending: { default: 50 },
          balance: { stopsPerUnit: 0.02 },
        },
      },
    })
    Object.assign(capabilities.colorMixer.parameters.hue, { max: 1 })
    expect(t.library.getEditCapabilities().colorMixer.parameters.hue.max).toBe(100)
    expect((await t.library.getEdits(t.id)).settings).toEqual(initialSettings())
  } finally {
    await t.close()
  }
})
