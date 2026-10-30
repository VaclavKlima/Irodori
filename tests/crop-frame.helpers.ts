import { srgbTransform, type WorkingFrame } from '../src/shared/adjustments'
import { DEFAULT_RESOURCE_SETTINGS, resolveResourcePolicy } from '../src/shared/resource-policy'
import type { CropAdmission } from '../src/shared/crop-resources'

export function cropAdmission(): CropAdmission {
  return structuredClone({
    policy: resolveResourcePolicy(
      DEFAULT_RESOURCE_SETTINGS,
      {
        ram: { totalBytes: 32 * 1024 ** 3, availableBytes: 24 * 1024 ** 3 },
        gpu: { status: 'unknown', reason: 'unavailable' },
      },
      1,
    ),
    reservation: { ramBytes: 12345, vramBytes: 67890 },
  })
}
export function cropFrame(width = 293, height = 193): WorkingFrame {
  const data = new Float32Array(width * height * 4)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      data.set(
        [x % 5 ? x / 23 - 1 : -0, y / 47 - 1, 16 + ((x + y) % 11), x < width / 2 ? 0.5 : 1],
        (y * width + x) * 4,
      )
  return { data, width, height, transform: { ...srgbTransform, white: 0.83 } }
}
