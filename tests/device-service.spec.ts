import { expect, test } from '@playwright/test'
import { copyFile, mkdir, readFile, readdir, stat, symlink, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { DeviceUnavailableError, type DeviceSource } from '../src/main/import-devices'
import { commit, scan, setup } from './library.helpers'

async function mounted(path: string): Promise<DeviceSource> {
  const info = await stat(path, { bigint: true })
  return {
    deviceId: 'opaque-device',
    displayName: 'Test card',
    roots: [
      {
        path,
        identity: 'volume-1',
        filesystemDevice: String(info.dev),
        filesystemIdentity: `${info.dev}:${info.ino}`,
        nestedMounts: [],
      },
    ],
  }
}

test('device review sorts vendor folders by filesystem modification time newest first', async () => {
  const t = await setup()
  try {
    const root = join(t.root, 'card')
    for (const [folder, filename, year] of [
      ['DCIM/100SONY', 'a-oldest.jpg', 2022],
      ['DCIM/101SONY', 'b-newest.jpg', 2024],
      ['DCIM/102SONY', 'c-middle.jpg', 2023],
    ] as const) {
      const directory = join(root, folder)
      await mkdir(directory, { recursive: true })
      const path = join(directory, filename)
      await copyFile('tests/fixtures/photos/alpine-lake.jpg', path)
      const modified = new Date(Date.UTC(year, 0, 1))
      await utimes(path, modified, modified)
    }
    const source = await mounted(root)
    const id = await t.service.scan([join(root, 'DCIM')], true, {
      source,
      validate: async () => {},
    })
    await expect.poll(() => t.service.review(id).phase).toBe('review')
    expect(t.service.review(id).candidates.map((candidate) => candidate.relativePath)).toEqual([
      '101SONY/b-newest.jpg',
      '102SONY/c-middle.jpg',
      '100SONY/a-oldest.jpg',
    ])
    expect(t.service.review(id)).toMatchObject({ unchecked: 3, selected: 3 })
  } finally {
    await t.close()
  }
})

test('device scan recurses photo folders while skipping hidden, system, symlink and nested mount directories', async () => {
  const inspected: string[] = []
  const t = await setup(undefined, {
    hiddenEntries: async (directory) => {
      inspected.push(directory)
      return new Set(['attribute-hidden', 'attribute-hidden.jpg'])
    },
    close: async () => {},
  })
  try {
    const root = join(t.root, 'card')
    for (const directory of [
      'DCIM/100SONY/vendor',
      '.hidden',
      'attribute-hidden',
      '$RECYCLE.BIN',
      'System Volume Information',
      'nested-mount',
    ]) {
      await mkdir(join(root, directory), { recursive: true })
      await copyFile('tests/fixtures/photos/alpine-lake.jpg', join(root, directory, 'photo.jpg'))
    }
    await copyFile('tests/fixtures/photos/alpine-lake.jpg', join(root, '.hidden-photo.jpg'))
    await copyFile('tests/fixtures/photos/alpine-lake.jpg', join(root, 'attribute-hidden.jpg'))
    await symlink(join(root, 'DCIM'), join(root, 'link'))
    const source = await mounted(root)
    source.roots[0].nestedMounts = [join(root, 'nested-mount')]
    const id = await t.service.scan([root], true, { source, validate: async () => {} })
    await expect.poll(() => t.service.review(id).phase).toBe('review')
    expect(t.service.review(id)).toMatchObject({
      source: 'Test card',
      total: 1,
      unchecked: 1,
      selected: 1,
    })
    expect(t.service.review(id).candidates[0].relativePath).toBe('DCIM/100SONY/vendor/photo.jpg')
    expect(inspected).toContain(root)
    expect(inspected).not.toContain(join(root, 'attribute-hidden'))
    await commit(t.service, id)
    expect(t.service.list().total).toBe(1)
    expect(
      await readFile(
        join(t.root, 'library', 'originals', t.service.list().photos[0].id, 'original.jpg'),
      ),
    ).toEqual(await readFile('tests/fixtures/photos/alpine-lake.jpg'))
  } finally {
    await t.close()
  }
})

test('confirmed disconnection latches review invalidation, while discovery failures preserve the review', async () => {
  const t = await setup()
  try {
    const root = join(t.root, 'card')
    await mkdir(root)
    await copyFile('tests/fixtures/photos/alpine-lake.jpg', join(root, 'photo.jpg'))
    const source = await mounted(root)
    let failure: Error | undefined
    const device = {
      source,
      validate: async () => {
        if (failure) throw failure
      },
    }
    const id = await t.service.scan([root], true, device)
    await expect.poll(() => t.service.review(id).phase).toBe('review')
    failure = new Error('Discovery timed out')
    await expect(t.service.validateDeviceReview()).rejects.toThrow('timed out')
    expect(t.service.review(id).sourceError).toBeUndefined()
    failure = new DeviceUnavailableError()
    await t.service.validateDeviceReview()
    expect(t.service.review(id).sourceError).toContain('disconnected or changed')
    failure = undefined
    await t.service.validateDeviceReview()
    expect(() => t.service.importSelected(id)).toThrow('Select at least one')
    expect(() => t.service.select(id, null, true)).toThrow('no longer selectable')
    const next = await t.service.scan([root], true, device)
    await expect.poll(() => t.service.review(next).phase).toBe('review')
    expect(t.service.review(next).sourceError).toBeUndefined()
    expect(() => t.service.review(id)).toThrow('expired')
    await commit(t.service, next)
    expect(t.service.list().total).toBe(1)
  } finally {
    await t.close()
  }
})

test('device replacement after acceptance retains committed photos and reports remaining selected files', async () => {
  const t = await setup()
  try {
    const root = join(t.root, 'card')
    await mkdir(root)
    await copyFile('tests/fixtures/photos/alpine-lake.jpg', join(root, 'first.jpg'))
    await copyFile('tests/fixtures/photos/mountain-ridge.jpg', join(root, 'second.jpg'))
    const source = await mounted(root)
    const device = {
      source,
      validate: async () => {
        // Disconnect after one complete validated transfer, independently of boundary checks.
        if (t.service.listTasks().some((task) => task.transfer?.copied === 1))
          throw new DeviceUnavailableError()
      },
    }
    const id = await t.service.scan(
      [join(root, 'first.jpg'), join(root, 'second.jpg')],
      true,
      device,
    )
    await expect.poll(() => t.service.review(id).phase).toBe('review')
    const bytes = t.service.review(id).selectedBytes
    await commit(t.service, id)
    expect(t.service.list().total).toBe(1)
    expect(t.service.listTasks()[0]).toMatchObject({
      status: 'failed',
      items: { total: 2 },
      progress: { total: 2 },
      transfer: { totalBytes: bytes },
      outcomes: { processed: 2, imported: 1, duplicates: 0, failed: 1 },
    })
    expect(t.service.taskErrors(id).errors[0].message).toContain('disconnected or changed')
    expect(await readdir(join(t.root, 'library', 'staging'))).toEqual([])
    await t.service.dispose(id)
    const next = await scan(t.service, [])
    expect(t.service.review(next).sourceError).toBeUndefined()
    expect(t.service.listTasks()[0].outcomes?.imported).toBe(1)
  } finally {
    await t.close()
  }
})
