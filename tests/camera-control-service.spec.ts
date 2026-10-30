import { expect, test } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cameraFixture, finished, latch } from './camera-control.helpers'

test('exact same-model routing, independent sessions and settings readback', async () => {
  const f = await cameraFixture()
  try {
    const opened = await f.service.openSession('camera-2', { iso: '200' })
    expect(opened.settings.settings.find((s) => s.id === 'iso')?.verification.writeReadback).toBe(
      true,
    )
    expect(f.provider.writes).toEqual([{ camera: 'camera-2', id: 'iso', value: '200' }])
    expect(f.provider.values.get('camera-1')!.iso).toBe('100')
    await expect(f.service.openSession('camera-2')).rejects.toThrow('already has a session')
    const other = await f.service.openSession('camera-1')
    await f.service.closeSession(other.sessionId)
    const closed = await f.service.closeSession(opened.sessionId)
    expect(closed.restoration[0].outcome).toBe('restored')
    expect(f.provider.values.get('camera-2')!.iso).toBe('100')
  } finally {
    await f.cleanup()
  }
})

test('another service cannot claim the host broker, even using another artifacts directory', async () => {
  const f = await cameraFixture(),
    other = f.create()
  try {
    const first = await f.service.openSession('camera-1')
    await expect(other.openSession('camera-2')).rejects.toThrow()
    await f.service.closeSession(first.sessionId)
    const second = await other.openSession('camera-2')
    await other.closeSession(second.sessionId)
  } finally {
    await other.shutdown()
    await f.cleanup()
  }
})

test('pending write recovery revalidates old restored flags and confirms rollback after delayed acknowledgements', async () => {
  for (const delayedWriteArrived of [false, true]) {
    const f = await cameraFixture()
    try {
      const session = await f.service.openSession('camera-1')
      await f.service.closeSession(session.sessionId)
      const path = join(f.root, 'data/sessions', session.sessionId + '.json'),
        record = JSON.parse(await readFile(path, 'utf8'))
      // Reproduce a journal from the former early-readback failure: the original
      // was observed before the acknowledged setting reached the camera.
      record.touched.iso = {
        original: '100',
        lastApplied: '100',
        intended: '200',
        pending: true,
        restored: true,
      }
      await writeFile(path, JSON.stringify(record))
      f.provider.values.get('camera-1')!.iso = delayedWriteArrived ? '200' : '100'
      expect((await f.service.list()).recoveries.map((entry) => entry.sessionId)).toContain(
        session.sessionId,
      )
      const recovered = await f.service.openSession('camera-1', {}, session.sessionId)
      expect(f.provider.values.get('camera-1')!.iso).toBe('100')
      expect(f.provider.writes).toEqual([{ camera: 'camera-1', id: 'iso', value: '100' }])
      expect(recovered.restoration).toEqual([
        expect.objectContaining({ setting: 'iso', outcome: 'restored' }),
      ])
      const closed = await f.service.closeSession(recovered.sessionId)
      expect(closed.restoration[0].outcome).toBe('already-restored')
      expect(JSON.parse(await readFile(path, 'utf8')).touched.iso.pending).toBe(false)
    } finally {
      await f.cleanup()
    }
  }
})

test('verified return to original survives automatic readout changes without hiding inspection values', async () => {
  const f = await cameraFixture()
  const current = f.provider.values.get('camera-1')!
  current.exposureProgram = 'P'
  current.aperture = '4'
  const inspect = f.provider.inspect.bind(f.provider)
  f.provider.inspect = async (camera) => {
    const inspection = await inspect(camera)
    for (const setting of inspection.settings) {
      if (setting.id === 'exposureProgram') setting.choices = ['P', 'M']
      if (setting.id === 'aperture') {
        setting.writable = f.provider.values.get(camera.id)!.exposureProgram === 'M'
        setting.choices = setting.writable ? ['3.5', '4'] : []
        if (!setting.writable) setting.value = 'null'
      }
    }
    return inspection
  }
  try {
    const session = await f.service.openSession('camera-1', { exposureProgram: 'M' })
    for (const [index, aperture] of ['3.5', '4'].entries()) {
      const accepted = await f.service.executeAction(
        session.sessionId,
        'apply-settings',
        { settings: { aperture } },
        `aperture-roundtrip-${index}`,
      )
      const operation = await finished(f.service, accepted.operationId)
      expect(operation.state).toBe('completed')
      expect(
        operation.settings?.settings.find((setting) => setting.id === 'aperture'),
      ).toMatchObject({
        value: aperture,
        verification: { writeReadback: true },
      })
    }
    const restoredProgram = await f.service.executeAction(
      session.sessionId,
      'apply-settings',
      { settings: { exposureProgram: 'P' } },
      'program-roundtrip',
    )
    const operation = await finished(f.service, restoredProgram.operationId)
    expect(operation.state).toBe('completed')
    expect(operation.settings?.settings.find((setting) => setting.id === 'aperture')).toMatchObject(
      {
        value: 'null',
        writable: false,
        verification: { writeReadback: false },
      },
    )
    const journal = JSON.parse(
      await readFile(join(f.root, 'data/sessions', session.sessionId + '.json'), 'utf8'),
    )
    expect(journal.touched.aperture).toMatchObject({
      original: '4',
      lastApplied: '4',
      restored: true,
      pending: false,
    })
    const writes = f.provider.writes.length
    const closed = await f.service.closeSession(session.sessionId)
    expect(closed.restoration).toEqual([
      expect.objectContaining({ setting: 'aperture', outcome: 'already-restored' }),
      expect.objectContaining({ setting: 'exposureProgram', outcome: 'already-restored' }),
    ])
    expect(f.provider.writes).toHaveLength(writes)
    expect((await f.service.list()).recoveries).toEqual([])
  } finally {
    await f.cleanup()
  }
})

test('a later write after verified restoration rebases from the actual external value and still detects new conflicts', async () => {
  for (const conflict of [false, true]) {
    const f = await cameraFixture()
    try {
      const session = await f.service.openSession('camera-1', { iso: '200' })
      const returned = await f.service.executeAction(
        session.sessionId,
        'apply-settings',
        { settings: { iso: '100' } },
        'return-original',
      )
      expect((await finished(f.service, returned.operationId)).state).toBe('completed')
      f.provider.values.get('camera-1')!.iso = '400'
      const reapplied = await f.service.executeAction(
        session.sessionId,
        'apply-settings',
        { settings: { iso: '200' } },
        'write-after-restoration',
      )
      expect((await finished(f.service, reapplied.operationId)).state).toBe('completed')
      if (conflict) f.provider.values.get('camera-1')!.iso = '125'
      const closed = await f.service.closeSession(session.sessionId)
      expect(closed.restoration[0]).toMatchObject({
        original: '400',
        outcome: conflict ? 'conflict' : 'restored',
        observed: conflict ? '125' : '400',
      })
      expect(f.provider.values.get('camera-1')!.iso).toBe(conflict ? '125' : '400')
      expect(f.provider.writes).toEqual([
        { camera: 'camera-1', id: 'iso', value: '200' },
        { camera: 'camera-1', id: 'iso', value: '100' },
        { camera: 'camera-1', id: 'iso', value: '200' },
        ...(!conflict ? [{ camera: 'camera-1', id: 'iso', value: '400' }] : []),
      ])
    } finally {
      await f.cleanup()
    }
  }
})

test('an original-value write with mismatching readback remains pending and recoverable', async () => {
  const f = await cameraFixture()
  try {
    const session = await f.service.openSession('camera-1', { iso: '200' })
    f.provider.mismatch = true
    const accepted = await f.service.executeAction(
      session.sessionId,
      'apply-settings',
      { settings: { iso: '100' } },
      'unverified-return-original',
    )
    const operation = await finished(f.service, accepted.operationId)
    expect(operation.state).toBe('failed')
    expect(operation.failure?.code).toBe('readback-mismatch')
    expect(operation.restoration[0].outcome).toBe('failed')
    const journal = JSON.parse(
      await readFile(join(f.root, 'data/sessions', session.sessionId + '.json'), 'utf8'),
    )
    expect(journal.touched.iso).toMatchObject({
      original: '100',
      lastApplied: '200',
      restored: false,
      pending: true,
      intended: '100',
    })
    expect((await f.service.list()).recoveries.map((entry) => entry.sessionId)).toContain(
      session.sessionId,
    )
    f.provider.values.get('camera-1')!.iso = '400'
    const writes = f.provider.writes.length
    const closed = await f.service.closeSession(session.sessionId)
    expect(closed.restoration[0]).toMatchObject({ outcome: 'conflict', observed: '400' })
    expect(f.provider.writes).toHaveLength(writes)
    expect(f.provider.values.get('camera-1')!.iso).toBe('400')
    expect(f.provider.captures).toEqual([])
  } finally {
    await f.cleanup()
  }
})

test('rollback retains uncertain earlier targets while preserving unrelated external changes', async () => {
  for (const externalChange of [false, true]) {
    const f = await cameraFixture()
    try {
      let writes = 0
      const write = f.provider.write.bind(f.provider)
      f.provider.write = async (camera, setting, value) => {
        writes++
        if (writes <= 2) {
          f.provider.writes.push({ camera: camera.id, id: setting.id, value })
          if (writes === 2) f.provider.values.get(camera.id)![setting.id] = '200'
          throw new Error('Acknowledged command has not settled yet.')
        }
        await write(camera, setting, value)
      }
      const session = await f.service.openSession('camera-1'),
        accepted = await f.service.executeAction(
          session.sessionId,
          'apply-settings',
          { settings: { iso: '200' } },
          'delayed-setting',
        ),
        failed = await finished(f.service, accepted.operationId)
      expect(failed.state).toBe('failed')
      expect(failed.restoration[0].outcome).toBe('failed')
      expect(f.provider.values.get('camera-1')!.iso).toBe('200')
      if (externalChange) f.provider.values.get('camera-1')!.iso = '400'
      const closed = await f.service.closeSession(session.sessionId)
      expect(closed.restoration[0].outcome).toBe(externalChange ? 'conflict' : 'restored')
      expect(f.provider.values.get('camera-1')!.iso).toBe(externalChange ? '400' : '100')
      expect(writes).toBe(externalChange ? 2 : 3)
      expect(f.provider.captures).toEqual([])
    } finally {
      await f.cleanup()
    }
  }
})

test('invalid and changed read-only settings cannot release a shutter', async () => {
  const f = await cameraFixture()
  try {
    const session = await f.service.openSession('camera-1')
    await expect(f.service.executeAction(session.sessionId, 'delete', {}, 'bad')).rejects.toThrow(
      'not advertised',
    )
    const invalid = await f.service.executeAction(
      session.sessionId,
      'capture',
      { settings: { iso: '64000' } },
      'invalid',
    )
    expect((await finished(f.service, invalid.operationId)).state).toBe('failed')
    f.provider.unavailable = true
    const readonly = await f.service.executeAction(
      session.sessionId,
      'capture',
      { settings: { iso: '200' } },
      'readonly',
    )
    expect((await finished(f.service, readonly.operationId)).failure?.message).toContain(
      'Read-only',
    )
    expect(f.provider.captures).toEqual([])
  } finally {
    await f.cleanup()
  }
})

test('RAW/JPEG companions, unique exposure directories, requested/readback settings and hashes survive restart', async () => {
  const f = await cameraFixture()
  try {
    const session = await f.service.openSession('camera-1')
    const accepted = await f.service.executeAction(
      session.sessionId,
      'exposure-sequence',
      { steps: [{ iso: '100' }, { iso: '200' }, { iso: '400' }] },
      'sequence',
    )
    const operation = await finished(f.service, accepted.operationId)
    expect(operation.state).toBe('completed')
    expect(operation.steps).toHaveLength(3)
    expect(operation.steps.map((s) => s.readback.iso)).toEqual(['100', '200', '400'])
    for (const step of operation.steps) {
      expect(step.files).toHaveLength(2)
      for (const file of step.files) {
        expect(file.sha256).toMatch(/^[a-f0-9]{64}$/)
        expect(file.complete).toBe(true)
        expect(await readFile(file.path, 'utf8')).toBe(
          `unchanged-original-${file.filename.split('.').at(-1)}`,
        )
      }
    }
    expect(new Set(operation.steps.map((s) => s.files[0].path)).size).toBe(3)
    expect(
      JSON.parse(await readFile(join(operation.directory, 'manifest.json'), 'utf8')).steps,
    ).toHaveLength(3)
    await f.service.closeSession(session.sessionId)
    const restarted = f.create()
    try {
      expect((await restarted.getOperation(operation.id)).steps).toEqual(operation.steps)
      const duplicate = await restarted.executeAction(
        session.sessionId,
        'exposure-sequence',
        { steps: [{ iso: '100' }, { iso: '200' }, { iso: '400' }] },
        'sequence',
      )
      expect(duplicate).toEqual({ operationId: operation.id, deduplicated: true })
      expect(f.provider.captures).toHaveLength(3)
    } finally {
      await restarted.shutdown()
    }
  } finally {
    await f.cleanup()
  }
})

test('concurrent duplicate requests share one operation and operations serialize on one camera', async () => {
  const f = await cameraFixture(),
    entered = latch(),
    release = latch()
  try {
    const session = await f.service.openSession('camera-1')
    f.provider.beforeCapture = async () => {
      entered.release()
      await release.promise
    }
    const request = () =>
      f.service.executeAction(session.sessionId, 'capture', { settings: { iso: '200' } }, 'dedup')
    const [first, duplicate] = await Promise.all([request(), request()])
    expect(first.operationId).toBe(duplicate.operationId)
    await entered.promise
    const second = await f.service.executeAction(
      session.sessionId,
      'capture',
      { settings: { iso: '400' } },
      'second',
    )
    expect(f.provider.captures).toHaveLength(1)
    await expect(
      f.service.executeAction(session.sessionId, 'capture', { settings: { iso: '100' } }, 'dedup'),
    ).rejects.toThrow('different parameters')
    release.release()
    expect((await finished(f.service, second.operationId)).state).toBe('completed')
    expect(f.provider.captures).toHaveLength(2)
  } finally {
    release.release()
    await f.cleanup()
  }
})

test('cancellation drains an active RAW/JPEG pair, retains it, stops subsequent releases and restores settings', async () => {
  const f = await cameraFixture(),
    entered = latch(),
    release = latch()
  try {
    const session = await f.service.openSession('camera-1', { iso: '125' })
    f.provider.beforeCapture = async () => {
      entered.release()
      await release.promise
    }
    const accepted = await f.service.executeAction(
      session.sessionId,
      'exposure-sequence',
      { steps: [{ iso: '200' }, { iso: '400' }] },
      'cancel',
    )
    await entered.promise
    const cancelled = f.service.cancelOperation(accepted.operationId)
    expect(f.provider.values.get('camera-1')!.iso).toBe('200')
    release.release()
    const operation = await cancelled
    expect(operation.state).toBe('cancelled')
    expect(operation.steps).toHaveLength(1)
    expect(operation.steps[0].files).toHaveLength(2)
    expect(operation.steps[0].complete).toBe(true)
    expect(f.provider.values.get('camera-1')!.iso).toBe('100')
    expect(operation.restoration[0].outcome).toBe('restored')
  } finally {
    release.release()
    await f.cleanup()
  }
})

for (const partial of [false, true])
  test(`uncertain ${partial ? 'partial-download' : 'timeout'} retains results and never retries`, async () => {
    const f = await cameraFixture()
    try {
      const session = await f.service.openSession('camera-1', { iso: '200' })
      f.provider.partial = partial
      f.provider.failCapture = !partial
      const accepted = await f.service.executeAction(
        session.sessionId,
        'capture',
        { settings: {} },
        'uncertain',
      )
      const operation = await finished(f.service, accepted.operationId)
      expect(operation.state).toBe('uncertain')
      expect(operation.failure?.uncertain).toBe(true)
      expect(operation.steps[0].files.length).toBe(partial ? 1 : 0)
      if (partial) expect(operation.steps[0].files[0].complete).toBe(false)
      expect(
        (await f.service.executeAction(session.sessionId, 'capture', { settings: {} }, 'uncertain'))
          .deduplicated,
      ).toBe(true)
      expect(f.provider.captures).toHaveLength(1)
      expect(f.provider.values.get('camera-1')!.iso).toBe('100')
    } finally {
      await f.cleanup()
    }
  })

test('restoration conflicts preserve external changes and recovery information', async () => {
  const f = await cameraFixture()
  try {
    const session = await f.service.openSession('camera-1', { iso: '200' })
    f.provider.values.get('camera-1')!.iso = '400'
    const closed = await f.service.closeSession(session.sessionId)
    expect(closed.restoration[0]).toMatchObject({
      outcome: 'conflict',
      original: '100',
      observed: '400',
    })
    expect(f.provider.values.get('camera-1')!.iso).toBe('400')
    expect((await f.service.list()).recoveries[0].sessionId).toBe(session.sessionId)
    await expect(f.service.openSession('camera-1', {}, session.sessionId)).rejects.toThrow(
      'unresolved',
    )
    expect(f.provider.values.get('camera-1')!.iso).toBe('400')
  } finally {
    await f.cleanup()
  }
})

test('disconnect invalidates a session; reconnection requires new identification and explicit recovery', async () => {
  const f = await cameraFixture()
  try {
    const session = await f.service.openSession('camera-1', { iso: '200' })
    const camera = f.provider.cameras.shift()!
    await f.service.list()
    await expect(
      f.service.executeAction(session.sessionId, 'read-settings', {}, 'old'),
    ).rejects.toThrow('disconnected')
    expect((await f.service.closeSession(session.sessionId)).restoration[0].outcome).toBe('failed')
    camera.connection = 'reconnected'
    camera.id = 'new-camera'
    f.provider.cameras.push(camera)
    f.provider.values.set(camera.id, {
      iso: '200',
      format: 'RAW+JPEG',
      driveMode: 'Single',
      shutterSpeed: '1/100',
    })
    const opened = await f.service.openSession(camera.id, {}, session.sessionId)
    expect(f.provider.values.get(camera.id)!.iso).toBe('100')
    expect(opened.restoration[0].outcome).toBe('restored')
  } finally {
    await f.cleanup()
  }
})

test('restart classifies journalled shutter attempts as uncertain and shutdown restores pending writes', async () => {
  const f = await cameraFixture()
  try {
    const session = await f.service.openSession('camera-1', { iso: '200' })
    const accepted = await f.service.executeAction(session.sessionId, 'read-settings', {}, 'read')
    const operation = await finished(f.service, accepted.operationId)
    operation.state = 'running'
    operation.steps = [
      { index: 0, requested: {}, readback: {}, releaseAttempted: true, complete: false, files: [] },
    ]
    await writeFile(f.service.store.path('operations', operation.id), JSON.stringify(operation))
    const restarted = f.create()
    try {
      expect((await restarted.getOperation(operation.id)).state).toBe('uncertain')
    } finally {
      await restarted.shutdown()
    }
    await f.service.shutdown()
    expect(f.provider.values.get('camera-1')!.iso).toBe('100')
  } finally {
    await f.cleanup()
  }
})

test('deduplication IDs cannot be redirected to a second physical camera', async () => {
  const f = await cameraFixture()
  try {
    const first = await f.service.openSession('camera-1'),
      second = await f.service.openSession('camera-2')
    const accepted = await f.service.executeAction(
      first.sessionId,
      'capture',
      { settings: {} },
      'physical-request',
    )
    await finished(f.service, accepted.operationId)
    await expect(
      f.service.executeAction(second.sessionId, 'capture', { settings: {} }, 'physical-request'),
    ).rejects.toThrow('different physical camera')
    expect(f.provider.captures).toEqual(['camera-1'])
    const inventory = await f.service.executeAction(
      first.sessionId,
      'read-card-inventory',
      {},
      'inventory',
    )
    expect((await finished(f.service, inventory.operationId)).inventory).toMatchObject({
      available: false,
      files: [],
    })
  } finally {
    await f.cleanup()
  }
})

test('close after cancellation does not re-restore automatic readouts or overwrite later external changes', async () => {
  const f = await cameraFixture(),
    entered = latch(),
    release = latch()
  try {
    const session = await f.service.openSession('camera-1', { shutterSpeed: '1/200' })
    f.provider.beforeCapture = async () => {
      entered.release()
      await release.promise
    }
    const accepted = await f.service.executeAction(
      session.sessionId,
      'capture',
      { settings: {} },
      'cancel-auto',
    )
    await entered.promise
    const cancelled = f.service.cancelOperation(accepted.operationId)
    release.release()
    await cancelled
    const writeCount = f.provider.writes.length
    f.provider.values.get('camera-1')!.shutterSpeed = '1/50'
    const closed = await f.service.closeSession(session.sessionId)
    expect(closed.restoration[0].outcome).toBe('already-restored')
    expect(f.provider.values.get('camera-1')!.shutterSpeed).toBe('1/50')
    expect(f.provider.writes).toHaveLength(writeCount)
  } finally {
    release.release()
    await f.cleanup()
  }
})

test('inspection waits for initial session settings rather than racing an in-flight write', async () => {
  const f = await cameraFixture(),
    entered = latch(),
    release = latch()
  const write = f.provider.write.bind(f.provider)
  f.provider.write = async (camera, setting, value) => {
    entered.release()
    await release.promise
    await write(camera, setting, value)
  }
  try {
    const opening = f.service.openSession('camera-1', { iso: '200' })
    await entered.promise
    const inspection = f.service.listActions('camera-1')
    await new Promise((resolve) => setTimeout(resolve, 5))
    release.release()
    await opening
    expect((await inspection).settings.find((setting) => setting.id === 'iso')?.value).toBe('200')
  } finally {
    release.release()
    await f.cleanup()
  }
})
