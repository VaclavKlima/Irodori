import type { Locator, Page } from '@playwright/test'
import { expect } from '@playwright/test'
import { galleryLayout } from '../src/renderer/src/collections/gallery-layout'

export async function scrollCollection(viewport: Locator, index: number) {
  await viewport.evaluate((element, index) => {
    const rowHeight = Number((element as HTMLElement).dataset.rowHeight),
      columns = Number((element as HTMLElement).dataset.columns ?? 1)
    element.scrollTop = Math.floor(index / columns) * rowHeight
    element.dispatchEvent(new Event('scroll', { bubbles: true }))
  }, index)
}
export async function revealEditorPhoto(page: Page, id: string) {
  const location = await page.evaluate((id) => window.irodori.locateGalleryPhoto(id), id)
  expect(location).not.toBeNull()
  const viewport = page.getByTestId('editor-photo-scroll')
  await expect(viewport).toHaveAttribute(
    'data-gallery-revision',
    `${location!.catalogRevision}:${location!.revision}`,
  )
  const width = await viewport.evaluate((element) => element.clientWidth - 14)
  const top = galleryLayout(location!.total, location!.groups, width).top(location!.index)
  await viewport.evaluate((element, top) => {
    element.scrollTop = top
    element.dispatchEvent(new Event('scroll', { bubbles: true }))
  }, top)
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
