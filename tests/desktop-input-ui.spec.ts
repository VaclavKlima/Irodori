import type { Page } from '@playwright/test'
import { expect, test } from './electron.fixture'
import { activateButton } from './button.helpers'
import { foregroundTest } from './foreground'

const selectedText = (page: Page) => page.evaluate(() => getSelection()?.toString() ?? '')
const words = (text: string) => text.replace(/\s+/g, ' ').trim()

test('Select All never selects app chrome, including the native Edit command', async ({
  irodori: { app, page },
}) => {
  const editor = page.getByRole('button', { name: 'Editor', exact: true })
  await expect(editor).toHaveCSS('user-select', 'none')
  for (const shortcut of ['Control+a', 'Meta+a']) {
    await editor.press(shortcut)
    expect(await selectedText(page)).toBe('')
  }
  await editor.focus()
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.selectAll(),
  )
  await expect.poll(() => selectedText(page)).toBe('')
  await activateButton(page.getByRole('button', { name: 'Settings', exact: true }))
  const cancel = page.getByRole('button', { name: 'Cancel', exact: true })
  await cancel.press('ControlOrMeta+a')
  expect(await selectedText(page)).toBe('')
  await cancel.press('Escape')
  await expect(cancel).toBeHidden()
})

test('text entry keeps native Select All, replacement and Undo while copyable details stay local', async ({
  irodori: { app, page },
}) => {
  await activateButton(page.getByRole('button', { name: 'Library', exact: true }))
  const search = page.getByRole('searchbox', { name: 'Search photos' })
  await search.fill('first draft')
  await search.press('ControlOrMeta+a')
  expect(
    await search.evaluate((element) => {
      const input = element as HTMLInputElement
      return [input.selectionStart, input.selectionEnd]
    }),
  ).toEqual([0, 11])
  await page.keyboard.insertText('replacement')
  await expect(search).toHaveValue('replacement')
  await search.press('ControlOrMeta+z')
  await expect(search).toHaveValue('first draft')
  await search.press('ControlOrMeta+a')
  await page.keyboard.press('Backspace')
  await expect(search).toHaveValue('')
  await activateButton(page.getByRole('button', { name: 'Editor', exact: true }))
  await activateButton(page.getByLabel('Display details', { exact: true }))
  const details = page.getByLabel('Display diagnostics', { exact: true })
  await expect(details).toHaveCSS('user-select', 'text')
  await details.press('ControlOrMeta+a')
  const text = await selectedText(page)
  expect(words(text)).toBe(words(await details.innerText()))
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.selectAll(),
  )
  await expect.poll(() => selectedText(page)).toBe(text)
  await page.getByRole('button', { name: 'Editor', exact: true }).press('ControlOrMeta+a')
  expect(await selectedText(page)).toBe('')
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.selectAll(),
  )
  await expect.poll(() => selectedText(page)).toBe('')
})

test('native text owners and composition retain their key events, including Console', async ({
  irodori: { page },
}) => {
  await page.evaluate(() => {
    const host = document.createElement('div')
    host.id = 'input-policy-fixture'
    host.style.cssText = 'position:fixed;top:100px;left:400px;z-index:1000'
    host.innerHTML =
      '<input aria-label="Read-only details" readonly value="copy this value"><textarea aria-label="Notes">editable notes</textarea><div contenteditable="true" aria-label="Editable notes"><span>nested text</span></div>'
    document.body.append(host)
  })
  try {
    const readonly = page.getByRole('textbox', { name: 'Read-only details', exact: true })
    await readonly.press('ControlOrMeta+a')
    expect(
      await readonly.evaluate((element) => {
        const input = element as HTMLInputElement
        return [input.selectionStart, input.selectionEnd]
      }),
    ).toEqual([0, 15])
    await page.keyboard.insertText('ignored')
    await expect(readonly).toHaveValue('copy this value')
    const notes = page.getByRole('textbox', { name: 'Notes', exact: true })
    await notes.press('ControlOrMeta+a')
    await page.keyboard.insertText('new notes')
    await expect(notes).toHaveValue('new notes')
    const editable = page.getByLabel('Editable notes', { exact: true })
    await editable.press('ControlOrMeta+a')
    expect(await selectedText(page)).toBe('nested text')
    await page.keyboard.insertText('new nested text')
    await expect(editable).toHaveText('new nested text')
    const chrome = page.getByRole('button', { name: 'Editor', exact: true })
    expect(
      await chrome.evaluate((element) => {
        const event = new KeyboardEvent('keydown', {
          key: 'a',
          ctrlKey: true,
          isComposing: true,
          bubbles: true,
          cancelable: true,
        })
        element.dispatchEvent(event)
        return event.defaultPrevented
      }),
    ).toBe(false)
    await activateButton(page.getByTestId('console-toggle'))
    const terminal = page.getByRole('textbox', { name: 'Codex terminal' })
    expect(
      await terminal.evaluate((element) => {
        let cancelled = true
        element.addEventListener(
          'keydown',
          (event) => {
            cancelled = event.defaultPrevented
          },
          { once: true, capture: true },
        )
        element.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'a',
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }),
        )
        return cancelled
      }),
    ).toBe(false)
  } finally {
    await page.evaluate(() => document.getElementById('input-policy-fixture')?.remove())
  }
})

test(
  'native drag selection and clipboard copy stay within diagnostics at minimum size with Console open',
  foregroundTest(
    'Requires actual pointer selection, system clipboard and native minimum-size focus.',
  ),
  async ({ irodori: { app, page } }, info) => {
    const clipboardBefore = await app.evaluate(({ clipboard }) => clipboard.readText())
    try {
      await app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]
        window.setContentSize(1100, 700)
        window.focus()
      })
      await activateButton(page.getByTestId('console-toggle'))
      await activateButton(page.getByLabel('Display details', { exact: true }))
      const details = page.getByLabel('Display diagnostics', { exact: true })
      const line = details.locator('p').filter({ hasText: 'Physical luminance is unverified.' })
      const bounds = (await line.boundingBox())!
      await page.mouse.move(bounds.x, bounds.y + bounds.height / 2)
      await page.mouse.down()
      await page.mouse.move(bounds.x + bounds.width - 1, bounds.y + bounds.height / 2, {
        steps: 12,
      })
      await page.mouse.up()
      await expect.poll(() => selectedText(page)).toBe('Physical luminance is unverified.')
      await page.keyboard.press('ControlOrMeta+c')
      await expect
        .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
        .toBe('Physical luminance is unverified.')
      await details.press('ControlOrMeta+a')
      const allDetails = await selectedText(page)
      expect(words(allDetails)).toBe(words(await details.innerText()))
      await page.keyboard.press('ControlOrMeta+c')
      await expect
        .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
        .toBe(allDetails)
      await page.getByRole('button', { name: 'Editor', exact: true }).press('ControlOrMeta+a')
      expect(await selectedText(page)).toBe('')
      const editor = page.getByRole('button', { name: 'Editor', exact: true })
      const chrome = (await editor.boundingBox())!
      await page.mouse.move(chrome.x + 2, chrome.y + chrome.height / 2)
      await page.mouse.down()
      await page.mouse.move(chrome.x + chrome.width - 2, chrome.y + chrome.height / 2, { steps: 8 })
      await page.mouse.up()
      expect(await selectedText(page)).toBe('')
      await expect(page.getByTestId('console-panel')).toBeVisible()
      await page.evaluate(() => {
        const alert = document.createElement('div')
        alert.id = 'input-policy-alert'
        alert.setAttribute('role', 'alert')
        alert.style.cssText = 'position:fixed;left:400px;bottom:60px;z-index:1000'
        const message = document.createElement('span')
        message.textContent = 'Copy this error message.'
        const retry = document.createElement('button')
        retry.textContent = 'Retry test error'
        alert.append(message, retry)
        document.body.append(alert)
      })
      const alert = page.locator('#input-policy-alert')
      const message = (await alert.locator('span').boundingBox())!
      await page.mouse.move(message.x, message.y + message.height / 2)
      await page.mouse.down()
      await page.mouse.move(message.x + message.width, message.y + message.height / 2, { steps: 8 })
      await page.mouse.up()
      await expect.poll(() => selectedText(page)).toBe('Copy this error message.')
      await page.keyboard.press('ControlOrMeta+c')
      await expect
        .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
        .toBe('Copy this error message.')
      const alertBounds = (await alert.boundingBox())!
      await page.mouse.move(message.x, message.y + message.height / 2)
      await page.mouse.down()
      await page.mouse.move(
        alertBounds.x + alertBounds.width + 20,
        message.y + message.height / 2,
        { steps: 10 },
      )
      await page.mouse.up()
      expect(await selectedText(page)).not.toContain('Retry test error')
      await alert.getByRole('button', { name: 'Retry test error' }).press('ControlOrMeta+a')
      expect(await selectedText(page)).toBe('')
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].webContents.selectAll(),
      )
      await expect.poll(() => selectedText(page)).toBe('')
      await alert.evaluate((element) => element.remove())
      await page.screenshot({ path: info.outputPath('desktop-input-1100x700-console.png') })
    } finally {
      await page.evaluate(() => document.getElementById('input-policy-alert')?.remove())
      await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), clipboardBefore)
    }
  },
)
