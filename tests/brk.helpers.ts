import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { CaptureMetadata } from '../src/shared/capture-sequence'
import { sequenceMetadata } from './capture.helpers'

export function bracketFrames(count = 3, start = 0, shutter = 0.01) {
  return Array.from({ length: count }, (_, index) => ({
    id: (start + index + 1).toString(16).padStart(64, '0'),
    metadata: {
      ...sequenceMetadata(index + 1),
      releaseMode: 5,
      releaseMode2: 2,
      releaseMode3: 2,
      sequenceLength: 3,
      shutterSeconds: shutter,
    } satisfies CaptureMetadata,
  }))
}
export interface BrkFixtureManifest {
  permission: string
  sequences: {
    name: string
    purpose: 'alignment' | 'aperture' | 'small-step' | 'partial' | 'continuous' | 'single-shot'
    files: string[]
    profile?: string
    complete?: boolean
  }[]
  files: { name: string; path: string; sha256: string; captureMetadata: CaptureMetadata }[]
}
export async function brkFixtures() {
  const path = resolve(
    process.env.IRODORI_BRK_FIXTURES ?? 'artifacts/fixtures/sony-brk/manifest.json',
  )
  try {
    const manifest = JSON.parse(await readFile(path, 'utf8')) as BrkFixtureManifest
    for (const file of manifest.files)
      file.path = isAbsolute(file.path) ? file.path : resolve(dirname(path), file.path)
    return manifest
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
