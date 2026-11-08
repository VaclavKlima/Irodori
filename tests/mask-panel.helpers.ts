import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'
import { activateButton } from './button.helpers'

export async function createMask(page: Page, tool: 'Brush' | 'Select object…' = 'Brush') {
  await activateButton(page.getByRole('button', { name: 'Create mask', exact: true }))
  await activateButton(
    page
      .getByRole('menu', { name: 'Create mask', exact: true })
      .getByRole('menuitem', { name: tool, exact: true }),
  )
}

export async function maskDetailTab(page: Page, name: 'Coverage' | 'Adjustments') {
  const tab = page.getByRole('tab', { name, exact: true })
  if ((await tab.getAttribute('aria-selected')) !== 'true') await activateButton(tab)
  await expect(tab).toHaveAttribute('aria-selected', 'true')
}

export async function maskAction(page: Page, name: string, action: string) {
  await activateButton(page.getByRole('button', { name: `Actions for ${name}`, exact: true }))
  await activateButton(page.getByRole('menu').getByRole('menuitem', { name: action, exact: true }))
}
