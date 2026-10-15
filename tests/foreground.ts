import type { TestDetails } from '@playwright/test'
import { testUiMode } from '../scripts/test-ui-mode.mjs'

export function foregroundTest(reason: string): TestDetails {
  return {
    tag: '@foreground',
    annotation: { type: 'requires-foreground', description: reason },
  }
}

export function requiresForeground(
  test: { skip(condition: boolean, description?: string): void },
  reason: string,
) {
  test.skip(testUiMode() !== 'foreground', `Foreground required: ${reason}`)
}
