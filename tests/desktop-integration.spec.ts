import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { desktopEntry } from '../scripts/desktop-launcher.mjs'
import { DESKTOP_ID } from '../src/shared/desktop-identity'

test('Little Jizo originals and every platform derivative match their provenance and dimensions', async () => {
  const directory = 'assets/app/icons/'
  const manifest = JSON.parse(await readFile(directory + 'generated/manifest.json', 'utf8')) as {
    sourceSha256: string
    files: { file: string; sha256: string; bytes: number }[]
  }
  expect(
    createHash('sha256')
      .update(await readFile(directory + 'little-jizo.png'))
      .digest('hex'),
  ).toBe(manifest.sourceSha256)
  for (const file of manifest.files) {
    const bytes = await readFile(directory + 'generated/' + file.file)
    expect(bytes.length).toBe(file.bytes)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256)
    if (file.file.endsWith('.png')) {
      const size = Number(file.file.match(/\d+/)![0]),
        metadata = await sharp(bytes).metadata()
      expect([metadata.width, metadata.height]).toEqual([size, size])
      expect(metadata.hasAlpha).toBe(true)
    }
    if (file.file.endsWith('.icns')) {
      expect(bytes.subarray(0, 4).toString()).toBe('icns')
      expect(bytes.readUInt32BE(4)).toBe(bytes.length)
    }
    if (file.file.endsWith('.ico')) {
      expect(bytes.readUInt16LE(2)).toBe(1)
      expect(bytes.readUInt16LE(4)).toBe(7)
    }
  }
})
test('desktop launchers quote paths, preserve field-code literals and reject multiline injection', () => {
  const launcher = desktopEntry(
    '/var/home/User/My Photos $`%/irodori',
    '/var/home/User/icons/jizo.png',
  )
  const command = launcher
    .split('\n')
    .find((line) => line.startsWith('Exec='))!
    .slice(5)
  const desktopDecoded = command.replace(/\\\\/g, '\\')
  expect(desktopDecoded).toBe('"/var/home/User/My Photos \\$\\`%%/irodori"')
  expect(launcher).toContain(`StartupWMClass=${DESKTOP_ID}`)
  expect(launcher).toContain('Terminal=false')
  expect(() => desktopEntry('relative', '/icon.png')).toThrow('absolute')
  expect(() => desktopEntry('/app\nExec=bad', '/icon.png')).toThrow('control')
  expect(() => desktopEntry('/app\tbad', '/icon.png')).toThrow('control')
  expect(() => desktopEntry('/app=bad', '/icon.png')).toThrow('equal')
})
