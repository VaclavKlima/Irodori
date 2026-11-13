import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'
import { activateButton } from './button.helpers'

export async function createMask(
  page: Page,
  tool: 'Brush' | 'Select object…' | 'Select Sky' | 'Select Background' = 'Brush',
) {
  await expect(page.getByTestId('masks-panel')).toHaveAttribute('data-ready', 'true')
  const rows = page.getByTestId('masks-list').locator('[data-mask-id]')
  const previousIds =
    tool === 'Brush'
      ? await rows.evaluateAll((elements) =>
          elements.map((element) => element.getAttribute('data-mask-id')),
        )
      : []
  await activateButton(page.getByRole('button', { name: 'Create mask', exact: true }))
  await activateButton(
    page
      .getByRole('menu', { name: 'Create mask', exact: true })
      .getByRole('menuitem', { name: tool, exact: true }),
  )
  if (tool === 'Brush') {
    await expect(rows).toHaveCount(previousIds.length + 1)
    const createdId = await rows.evaluateAll(
      (elements, previous) =>
        elements
          .map((element) => element.getAttribute('data-mask-id'))
          .find((id) => !previous.includes(id)),
      previousIds,
    )
    await expect(page.locator(`[data-mask-id="${createdId}"] [data-mask-select]`)).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(page.getByRole('button', { name: 'Create mask', exact: true })).toBeEnabled()
  }
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
