import {
  neutralMaskColor,
  neutralMaskEdge,
  neutralMaskLight,
  type MaskGradient,
  type ResolvedMask,
} from '../../src/shared/masks'
import { brush } from './mask-reference'

export function gradientMask(gradient: MaskGradient): ResolvedMask {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    name: 'Gradient',
    enabled: true,
    inverted: false,
    head: null,
    gradient,
    light: { ...neutralMaskLight, exposureEv: 0.7 },
    color: { ...neutralMaskColor },
    edge: { ...neutralMaskEdge },
    strokes: [],
  }
}
export function gradientCases() {
  const gradients: MaskGradient[] = [
    { kind: 'linear', start: { x: 0.2, y: 0.1 }, end: { x: 0.75, y: 0.8 } },
    { kind: 'linear', start: { x: -1, y: 1.2 }, end: { x: 2, y: -0.5 } },
    ...[0, 50, 100].flatMap((feather) =>
      [0, 37, -90, 180].map((rotation) => ({
        kind: 'radial' as const,
        center: { x: 0.42, y: 0.57 },
        radiusX: 0.3,
        radiusY: 0.2,
        rotation,
        feather,
      })),
    ),
    {
      kind: 'radial',
      center: { x: -0.2, y: 0.6 },
      radiusX: 0.7,
      radiusY: 0.8,
      rotation: -31,
      feather: 100,
    },
  ]
  return gradients.flatMap((gradient) =>
    [false, true].map((inverted) => ({
      ...gradientMask(gradient),
      inverted,
      strokes: [
        brush('subtract', 0.12, 0.4, [
          [0.42, 0.5],
          [0.6, 0.6],
        ]),
        brush('add', 0.09, 0.6, [
          [0.5, 0.6],
          [0.7, 0.5],
        ]),
        brush('subtract', 0.035, 0, [[0.55, 0.6]]),
      ],
    })),
  )
}
