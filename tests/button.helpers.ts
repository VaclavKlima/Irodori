import type { Locator } from '@playwright/test'
import { expect } from '@playwright/test'

export type ButtonActivation = 'pointer' | 'keyboard'

/** DOM keyboard activation works without taking native desktop focus. */
export async function activateButton(button: Locator, activation: ButtonActivation = 'keyboard') {
  if (activation === 'pointer') return button.click()
  await expect(button).toBeVisible()
  await expect(button).toBeEnabled()
  await button.focus()
  await button.press('Enter')
}
