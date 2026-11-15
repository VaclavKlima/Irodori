import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { transferFixture } from './edit-transfer.helpers'

test('Texture commits one shared history step, invalidates dependent point edits and survives Undo, Redo and restart', async () => {
  const f = await transferFixture(1),
    photoId = f.ids[0],
    id = randomUUID()
  let refuseSource = false,
    validations = 0
  const installRevisionGate = () => {
    // This service case verifies catalog/history ownership; dedicated GPU targets own preparation.
    f.library.fullPreviews.validateMaskEdit = async (id, revision) => {
      validations++
      if ((await f.library.getEdits(id)).revision !== revision)
        throw new Error('Mask context revision conflict.')
      if (refuseSource) throw new Error('Simulated unavailable preview resource admission.')
    }
  }
  installRevisionGate()
  try {
    const created = await f.library.mutateMasks(photoId, 0, {
      operations: [
        {
          kind: 'create',
          id,
          name: 'Feathers',
          gradient: {
            kind: 'radial',
            center: { x: 0.5, y: 0.5 },
            radiusX: 0.4,
            radiusY: 0.4,
            rotation: 0,
            feather: 50,
          },
        },
        { kind: 'update', id, texture: 25, color: { saturation: 9 } },
      ],
    })
    expect(created.settings.maskStack[0]).toMatchObject({ texture: 25, color: { saturation: 9 } })
    const history = await f.library.getEditHistory(photoId)
    expect(history.snapshots).toHaveLength(2)
    expect(
      f.events.filter((event) => event.sourceChanged).map((event) => event.sourceChanged!.revision),
    ).toContain(created.revision)
    const undone = await f.library.undoEdit(photoId, created.revision)
    expect(undone.settings.maskStack).toEqual([])
    const redone = await f.library.redoEdit(photoId, undone.revision)
    expect(redone.settings.maskStack[0].texture).toBe(25)
    const persisted = await f.library.getEditHistory(photoId)
    await f.restart()
    installRevisionGate()
    const reopened = await f.library.getEditHistory(photoId)
    expect(reopened).toEqual(persisted)
    expect(reopened.settings.maskStack[0].texture).toBe(25)
    const before = structuredClone(reopened)
    await expect(
      Promise.resolve().then(() =>
        f.library.mutateMasks(photoId, reopened.revision, {
          operations: [
            { kind: 'update', id, texture: -25 },
            { kind: 'update', id, texture: 101 },
          ],
        }),
      ),
    ).rejects.toThrow('Texture')
    expect(await f.library.getEditHistory(photoId)).toEqual(before)
    const edited = await f.library.updateEdits(photoId, { exposureEv: 0.5 }, reopened.revision)
    expect(f.events.some((event) => event.sourceChanged?.revision === edited.revision)).toBe(true)
    refuseSource = true
    await expect(
      Promise.resolve().then(() =>
        f.library.mutateMasks(photoId, edited.revision, {
          operations: [{ kind: 'update', id, texture: 0, light: { contrast: 5 } }],
        }),
      ),
    ).rejects.toThrow('unavailable preview resource')
    expect((await f.library.getEdits(photoId)).revision).toBe(edited.revision)
    const previousValidations = validations
    const reset = await f.library.mutateMasks(photoId, edited.revision, {
      operations: [{ kind: 'update', id, texture: 0 }],
    })
    expect(reset.settings.maskStack[0]).toMatchObject({ texture: 0, color: { saturation: 9 } })
    expect(validations).toBe(previousValidations)
    expect(reset.settings.maskStack[0].light).toEqual(edited.settings.maskStack[0].light)
    await f.originalsUnchanged()
  } finally {
    await f.close()
  }
})
