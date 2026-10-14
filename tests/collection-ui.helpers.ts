import type { Locator, Page } from '@playwright/test'
import { expect } from '@playwright/test'

export async function scrollCollection(viewport: Locator, index: number) {
  await viewport.evaluate((element, index) => {
    const rowHeight = Number((element as HTMLElement).dataset.rowHeight),
      columns = Number((element as HTMLElement).dataset.columns ?? 1)
    element.scrollTop = Math.floor(index / columns) * rowHeight
    element.dispatchEvent(new Event('scroll', { bubbles: true }))
  }, index)
}
export async function revealEditorPhoto(page: Page, id: string) {
  const location = await page.evaluate((id) => window.luma.locateGalleryPhoto(id), id)
  expect(location).not.toBeNull()
  await scrollCollection(page.getByTestId('editor-photo-scroll'), location!.index)
  await expect(page.getByTestId(`photo-card-${id}`)).toBeVisible()
  return page.getByTestId(`photo-card-${id}`)
}
export async function revealImportCandidate(page: Page, index: number, filename?: string) {
  await scrollCollection(page.getByTestId('import-scroll'), index)
  if (filename)
    await expect(
      page.getByRole('checkbox', { name: `Import ${filename}`, exact: true }),
    ).toBeVisible()
}
