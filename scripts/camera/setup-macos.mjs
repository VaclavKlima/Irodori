import { mkdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') throw new Error('ImageCaptureCore requires macOS.')
const output = fileURLToPath(new URL('../../artifacts/camera/bin/', import.meta.url))
await mkdir(output, { recursive: true })
const result = spawnSync(
  'xcrun',
  [
    'swiftc',
    '-swift-version',
    '5',
    '-module-cache-path',
    `${output}/module-cache`,
    fileURLToPath(new URL('image-capture.swift', import.meta.url)),
    '-o',
    `${output}/image-capture`,
  ],
  { stdio: 'inherit' },
)
process.exitCode = result.status ?? 1
