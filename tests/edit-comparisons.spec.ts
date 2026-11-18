import { expect, test } from '@playwright/test'
import { mkdtemp, rm, lstat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EditComparisons } from '../src/main/edit-comparisons'
import { syntheticExportSource } from './export.helpers'
import { identity } from '../src/main/export/files'
import { inspectionContext } from '../src/main/agent/inspection-source'
import { initialSettings } from '../src/shared/edits'
import type { FrozenEditComparisonSource } from '../src/shared/edit-checkpoints'
import type { DisplayPreview } from '../src/shared/contracts'
import type { InspectionImage } from '../src/shared/inspection'

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'irodori-version-pair-')),
    source = await syntheticExportSource(root, 32, 24, (x, y) => [x / 32, y / 24, 0.3])
  source.identity = identity(await lstat(source.path))
  source.processing.adjustments = structuredClone(source.processing.adjustments)
  const settings = initialSettings(),
    captured = [4, 8],
    snapshots = captured.map((revision, index): FrozenEditComparisonSource => ({
      photoId: source.photo.id,
      source: {
        kind: 'checkpoint',
        checkpointId: crypto.randomUUID(),
        expectedCheckpointRevision: 1,
      },
      identity: `${index}`.repeat(64),
      sourceIdentity: 'c'.repeat(64),
      settings: { ...settings, exposureEv: index ? 0.7 : 0.2 },
      capturedFromRevision: revision,
      label: index ? 'Stronger' : 'Natural',
    })) as [FrozenEditComparisonSource, FrozenEditComparisonSource],
    context = inspectionContext(source, { width: 32, height: 24 })
  let valid = true,
    hold: ReturnType<typeof gate> | null = null,
    mismatch = false,
    inspectionCount = 0
  const frameOptions: { revision: number; exposure?: number }[] = [],
    released: string[] = []
  const manager = new EditComparisons({
    resolve: async () => structuredClone(snapshots),
    assert: async () => {
      if (!valid) throw new Error('Checkpoint revision changed.')
    },
    source: async (snapshot) => ({
      ...structuredClone(source),
      processing: {
        ...structuredClone(source.processing),
        revision: snapshot.capturedFromRevision,
        adjustments: {
          ...source.processing.adjustments!,
          exposureEv: snapshot.settings.exposureEv,
        },
      },
    }),
    previews: {
      requestFrozen: async (photoId, requestId, options) => {
        frameOptions.push({ revision: options.revision, exposure: options.adjustments?.exposureEv })
        await hold?.promise
        return {
          photoId,
          requestId,
          width: 32,
          height: 24,
          settingsRevision: options.revision,
          format: 'hdr-working',
          byteLength: 32 * 24 * 16,
          sha256: 'd'.repeat(64),
          renderId: 'frozen',
          url: 'irodori-photo://frozen',
        } as DisplayPreview
      },
      release: async (token) => {
        released.push(token!)
        hold?.resolve()
      },
    },
    inspection: {
      contextFrozen: async (s, _signal, validate) => {
        await validate()
        return {
          ...context,
          revision: s.processing.revision,
          gridIdentity:
            mismatch && s.processing.revision === 8 ? 'different-grid' : context.gridIdentity,
        }
      },
      inspectFrozen: async (s, _options, _signal, validate) => {
        inspectionCount++
        await validate()
        const image = {
          label: 'after',
          photoId: s.photo.id,
          revision: s.processing.revision,
          gridIdentity: context.gridIdentity,
          width: 4,
          height: 3,
          byteLength: 12,
          data: 'encoded',
          renderingIdentity: String(s.processing.adjustments?.exposureEv),
        } as InspectionImage
        return {
          photoId: s.photo.id,
          revision: s.processing.revision,
          gridIdentity: context.gridIdentity,
          members: [image],
        }
      },
    },
  })
  const request = () => ({
    photoId: source.photo.id,
    requestId: crypto.randomUUID(),
    baseline: snapshots[0].source,
    target: snapshots[1].source,
  })
  return {
    manager,
    source,
    snapshots,
    frameOptions,
    released,
    request,
    change: () => {
      valid = false
    },
    mismatch: () => {
      mismatch = true
    },
    hold: () => {
      hold = gate()
    },
    release: () => hold?.resolve(),
    inspections: () => inspectionCount,
    close: async () => {
      await manager.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

test('frozen members render their exact snapshot settings and keep explicit labels after live settings differ', async () => {
  const f = await fixture()
  try {
    const session = await f.manager.prepare(f.request())
    f.source.processing.revision = 99
    f.source.processing.adjustments!.exposureEv = 2
    await f.manager.frame(session.photoId, session.id, 'a', crypto.randomUUID(), 'sdr')
    await f.manager.frame(session.photoId, session.id, 'b', crypto.randomUUID(), 'sdr')
    expect(f.frameOptions).toEqual([
      { revision: 4, exposure: 0.2 },
      { revision: 8, exposure: 0.7 },
    ])
    const result = await f.manager.inspect(session.photoId, session.id, {
      resolutionPercent: 100,
      encoding: { format: 'png' },
    })
    expect(
      result.members.map((member) => [
        member.label,
        member.revision,
        member.version.label,
        member.renderingIdentity,
      ]),
    ).toEqual([
      ['a', 4, 'Natural', '0.2'],
      ['b', 8, 'Stronger', '0.7'],
    ])
  } finally {
    await f.close()
  }
})

test('geometry mismatch and stale checkpoint revisions refuse comparison instead of using current edits', async () => {
  const f = await fixture()
  try {
    f.mismatch()
    await expect(f.manager.prepare(f.request())).rejects.toThrow('different crop')
  } finally {
    await f.close()
  }
  const g = await fixture()
  try {
    const session = await g.manager.prepare(g.request())
    g.change()
    await expect(g.manager.inspect(session.photoId, session.id, {})).rejects.toThrow(
      'Checkpoint revision changed',
    )
    expect(g.inspections()).toBe(0)
  } finally {
    await g.close()
  }
})

test('renderer and MCP have separate bounded ownership, and foreign-photo handles cannot read or dispose a pair', async () => {
  const f = await fixture()
  try {
    const renderer = await f.manager.prepare(f.request()),
      mcp = await f.manager.prepare(f.request(), undefined, 'mcp')
    await expect(f.manager.prepare(f.request())).rejects.toThrow('already open')
    await expect(f.manager.inspect('f'.repeat(64), renderer.id, {})).rejects.toThrow('unavailable')
    await expect(f.manager.dispose('f'.repeat(64), renderer.id)).rejects.toThrow(
      'another photograph',
    )
    await f.manager.dispose(mcp.photoId, mcp.id)
    await expect(f.manager.inspect(renderer.photoId, renderer.id, {})).resolves.toMatchObject({
      sessionId: renderer.id,
    })
  } finally {
    await f.close()
  }
})

test('session cancellation drains an in-flight frozen frame and cannot publish it afterwards', async () => {
  const f = await fixture()
  try {
    const session = await f.manager.prepare(f.request()),
      token = crypto.randomUUID()
    f.hold()
    const pending = f.manager.frame(session.photoId, session.id, 'a', token, 'sdr')
    await expect.poll(() => f.frameOptions.length).toBe(1)
    const rejected = expect(pending).rejects.toThrow('Version comparison closed')
    await f.manager.dispose(session.photoId, session.id)
    await rejected
    expect(f.released).toContain(token)
  } finally {
    await f.close()
  }
})

test('source changes invalidate both members before another asset can be rendered', async () => {
  const f = await fixture()
  try {
    const session = await f.manager.prepare(f.request())
    await writeFile(f.source.path, 'changed source bytes')
    await expect(
      f.manager.frame(session.photoId, session.id, 'b', crypto.randomUUID(), 'sdr'),
    ).rejects.toThrow('source changed')
    expect(f.frameOptions).toEqual([])
  } finally {
    await f.close()
  }
})
