import type { Locator, Page } from '@playwright/test'
import { expect } from '@playwright/test'
import { activateButton } from './button.helpers'

export type InspectorTool =
  | 'Light'
  | 'Color'
  | 'Color intensity'
  | 'Color Mixer'
  | 'Color Grading'
  | 'Tone blending'
  | 'Detail'
  | 'Sharpening'
  | 'Crop'
  | 'Lens corrections'
  | 'Metadata'
  | 'Histogram · After'
export async function navigateInspector(
  page: Page,
  tool: InspectorTool,
  activate: (button: Locator) => Promise<void> = activateButton,
) {
  if (tool === 'Histogram · After') return
  const group = [
    'Color',
    'Color intensity',
    'Color Mixer',
    'Color Grading',
    'Tone blending',
  ].includes(tool)
    ? 'Color'
    : ['Crop', 'Lens corrections'].includes(tool)
      ? 'Geometry'
      : tool === 'Sharpening'
        ? 'Detail'
        : tool === 'Metadata'
          ? 'Info'
          : tool
  const tab = page.getByRole('tab', { name: group, exact: true })
  if ((await tab.getAttribute('aria-selected')) !== 'true') await activate(tab)
  await expect(tab).toHaveAttribute('aria-selected', 'true')
  if (group === 'Color') {
    const color = page.getByRole('tab', {
      name:
        tool === 'Color Mixer'
          ? 'Mixer'
          : ['Color Grading', 'Tone blending'].includes(tool)
            ? 'Grading'
            : 'Basic',
      exact: true,
    })
    if ((await color.getAttribute('aria-selected')) !== 'true') await activate(color)
    await expect(color).toHaveAttribute('aria-selected', 'true')
  }
}
export async function openInspectorTool(page: Page, tool: InspectorTool) {
  await navigateInspector(page, tool)
  const disclosure = page.getByRole('button', { name: tool, exact: true })
  if ((await disclosure.getAttribute('aria-expanded')) !== 'true') await activateButton(disclosure)
}
