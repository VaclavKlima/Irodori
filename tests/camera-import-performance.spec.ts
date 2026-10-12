import { expect, test } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cameraCommit, cameraReview, cameraSetup, cameraSource } from './camera-import.helpers'

// The service measurement deliberately does not launch a browser.
// eslint-disable-next-line no-empty-pattern
test('1,000 recognized originals do zero content work during repeat review and acceptance', async ({}, testInfo) => {
  test.setTimeout(90_000)
  const t = await cameraSetup()
  try {
    const paths = Array.from({ length: 1000 }, (_, index) => join(t.card, `photo-${index}.jpg`))
    await Promise.all(paths.map((path, index) => writeFile(path, `camera original ${index}`)))
    // Bootstrap is measured separately from durable repeat recognition.
    await cameraCommit(t.library, await cameraReview(t.library, paths))
    const source = await cameraSource(t.card)
    let started = performance.now()
    const bootstrap = await cameraReview(t.library, paths, source)
    const bootstrapMs = performance.now() - started
    expect(t.library.review(bootstrap)).toMatchObject({ alreadyImported: 1000, selected: 0 })
    const bootstrapReads = { ...t.reads, copies: t.reads.copies.length }
    await t.restart()
    const newPaths = [join(t.card, 'new-1.jpg'), join(t.card, 'new-2.jpg')]
    await Promise.all(newPaths.map((path, index) => writeFile(path, `new original ${index}`)))
    const before = { ...t.reads, copies: t.reads.copies.length }
    started = performance.now()
    const repeat = await cameraReview(t.library, [t.card], source)
    const repeatMs = performance.now() - started
    expect(t.library.review(repeat)).toMatchObject({
      total: 1002,
      alreadyImported: 1000,
      selected: 2,
    })
    for (let offset = 0; offset < 1002; offset += 60) {
      const known = t.library.review(repeat, offset).candidates.filter((c) => c.alreadyImported)
      t.library.requestReviewThumbnails(
        repeat,
        known.map((c) => c.id),
      )
    }
    const unselected = t.library.review(repeat).candidates.find((c) => c.filename === 'new-2.jpg')!
    t.library.select(repeat, [unselected.id], false)
    const acceptanceStarted = performance.now()
    const task = await cameraCommit(t.library, repeat)
    const acceptanceMs = performance.now() - acceptanceStarted
    expect(task).toMatchObject({
      items: { total: 1 },
      transfer: { copied: 1 },
      outcomes: { imported: 1 },
    })
    expect(t.reads.copies.slice(before.copies)).toEqual([newPaths[0]])
    expect(t.reads.cardSampleBytes).toBe(before.cardSampleBytes)
    expect(t.reads.managedSampleBytes).toBe(before.managedSampleBytes)
    expect(t.reads.hashes).toBe(before.hashes)
    expect(t.reads.thumbnails).toEqual([])
    const measurements = {
      originals: 1000,
      bootstrapMs,
      repeatMs,
      acceptanceMs,
      bootstrapReads,
      repeat: {
        knownContentBytes: 0,
        knownThumbnailReads: 0,
        knownHashes: 0,
        knownCopies: 0,
        selectedNewCopies: 1,
      },
      source: 'isolated local fixtures; physical exFAT reader throughput is unverified',
    }
    const path = testInfo.outputPath('camera-repeat-measurements.json')
    await writeFile(path, JSON.stringify(measurements, null, 2))
    await testInfo.attach('camera-repeat-measurements', { path, contentType: 'application/json' })
  } finally {
    await t.close()
  }
})
