import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'
import { activateButton } from './button.helpers'

/** Reach preview options through the native disclosure without toggling an already open menu. */
export async function openPreviewOptions(page: Page) {
  const summary = page.getByLabel('Display details', { exact: true })
  const details = summary.locator('..')
  if (!(await details.evaluate((element) => element.hasAttribute('open'))))
    await activateButton(summary)
  await expect(details).toHaveJSProperty('open', true)
}
