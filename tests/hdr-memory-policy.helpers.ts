import { expect } from '@playwright/test'

export interface HdrMemoryObservation {
  allocatedRamBytes: number
  allocatedGpuBytes: number
  ramBudgetBytes: number
  vramBudgetBytes: number
  resourcePolicyRevision: number
  /** Conservative debug sum; this is not an independent memory limit. */
  allocatedBytes?: number
}

/** Serializable browser reader. Missing/empty metadata must never become a zero-byte pass. */
export function readHdrMemory(element: HTMLElement): HdrMemoryObservation {
  const value = (key: string) => {
    const raw = element.dataset[key]
    return raw === undefined || raw.trim() === '' ? Number.NaN : Number(raw)
  }
  return {
    allocatedRamBytes: value('allocatedRamBytes'),
    allocatedGpuBytes: value('allocatedGpuBytes'),
    ramBudgetBytes: value('ramBudgetBytes'),
    vramBudgetBytes: value('vramBudgetBytes'),
    resourcePolicyRevision: value('resourcePolicyRevision'),
    allocatedBytes: value('allocatedBytes'),
  }
}

export function assertHdrMemory(
  memory: Partial<HdrMemoryObservation> | null | undefined,
  context?: string,
  soft = false,
) {
  const check = soft ? expect.soft : expect
  for (const field of [
    'allocatedRamBytes',
    'allocatedGpuBytes',
    'ramBudgetBytes',
    'vramBudgetBytes',
  ] as const) {
    const value = memory?.[field]
    check(Number.isSafeInteger(value), `${context ?? 'HDR memory'}: ${field} is required`).toBe(
      true,
    )
    check(value, context).toBeGreaterThan(0)
  }
  check(
    Number.isSafeInteger(memory?.resourcePolicyRevision),
    `${context ?? 'HDR memory'}: resource policy revision is required`,
  ).toBe(true)
  check(memory?.resourcePolicyRevision, context).toBeGreaterThanOrEqual(0)
  check(memory?.allocatedRamBytes, context).toBeLessThanOrEqual(memory?.ramBudgetBytes as number)
  check(memory?.allocatedGpuBytes, context).toBeLessThanOrEqual(memory?.vramBudgetBytes as number)
}

export function hdrMemoryGates(memory: Partial<HdrMemoryObservation>, prefix = '') {
  return [
    {
      metric: `${prefix}allocatedRamBytes`,
      operator: '<=' as const,
      limit: memory.ramBudgetBytes!,
    },
    {
      metric: `${prefix}allocatedGpuBytes`,
      operator: '<=' as const,
      limit: memory.vramBudgetBytes!,
    },
  ]
}
