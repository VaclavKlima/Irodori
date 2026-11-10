import { randomUUID } from 'node:crypto'
import {
  neutralMaskLight,
  neutralMaskColor,
  type ResolvedMask,
  type ResolvedMaskCoverage,
  type ResolvedMaskOperand,
} from '../../src/shared/masks'
import { gradientMask } from './mask-gradients'
import { referenceCoverage } from './mask-reference'
export function compoundLeaf(x: number): ResolvedMask {
  return gradientMask({ kind: 'linear', start: { x, y: 0 }, end: { x: x + 0.6, y: 1 } })
}
export function compoundOperand(
  node: ResolvedMaskCoverage,
  operator: ResolvedMaskOperand['operator'],
): ResolvedMaskOperand {
  return { ...node, id: randomUUID(), operator }
}
export function compoundOracle(node: ResolvedMaskCoverage, x: number, y: number): number {
  // Independent reference: evaluate each analytic leaf, then explicit ordered scalar operations.
  const root = {
    ...node,
    light: neutralMaskLight,
    color: neutralMaskColor,
    inverted: false,
    operands: [],
    resultStrokes: [],
  }
  let a = referenceCoverage(root, x, y, 200, 100)
  for (const child of node.operands ?? []) {
    if (!child.enabled) continue
    const b = compoundOracle(child, x, y)
    a =
      child.operator === 'add'
        ? Math.max(a, b)
        : child.operator === 'subtract'
          ? a * (1 - b)
          : a * b
  }
  // The test corrections use hard brushes, keeping the independent correction oracle exact.
  for (const stroke of node.resultStrokes ?? []) {
    const b = referenceCoverage(
      { ...root, gradient: undefined, strokes: [{ ...stroke, mode: 'add' }] },
      x,
      y,
      200,
      100,
    )
    a = stroke.mode === 'add' ? Math.max(a, b) : a * (1 - b)
  }
  return node.inverted ? 1 - a : a
}
