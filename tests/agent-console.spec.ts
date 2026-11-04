import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { test, expect } from './electron.fixture'
import { activateButton } from './button.helpers'
import { importPhotos } from './import.helpers'
import { agentCliFixture, runAgentHook } from './agent-cli.helpers'
import { agentTools } from '../src/main/agent/policy'
import type { ElectronApplication, Page } from '@playwright/test'
import { openPreviewOptions } from './preview-options.helpers'
import { foregroundTest } from './foreground'

async function configure(irodori: { app: ElectronApplication; page: Page; userDataDir: string }) {
  const executable = await agentCliFixture(irodori.userDataDir)
  await irodori.app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, executable)
  expect(await irodori.page.evaluate(() => window.irodori.chooseAgentExecutable())).toBe(true)
  await activateButton(irodori.page.getByTestId('console-toggle'))
  await activateButton(irodori.page.getByRole('button', { name: 'Connect Codex', exact: true }))
  await expect(irodori.page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
  const file = join(irodori.userDataDir, 'agent/workspace/fixture-connection.json')
  await expect
    .poll(async () => {
      try {
        return JSON.parse(await readFile(file, 'utf8')).session
      } catch {
        return null
      }
    })
    .toBeTruthy()
  const fixture = JSON.parse(await readFile(file, 'utf8'))
  const env = {
    IRODORI_AGENT_CONNECTION: JSON.stringify(fixture.connection),
    IRODORI_AGENT_REQUEST: join(irodori.userDataDir, 'agent/workspace/request.json'),
    IRODORI_AGENT_TOOLS: JSON.stringify(agentTools),
  }
  return { fixture, env }
}

test('one terminal survives close and workspace changes; restart waits for Resume or New conversation', async ({
  irodori,
}) => {
  const { page } = irodori
  const { fixture, env } = await configure(irodori)
  await expect(page.locator('.xterm-rows')).toContainText('IRODORI TEST CODEX')
  await page.locator('.xterm').evaluate((element) => {
    element.setAttribute('data-terminal-identity', 'retained')
  })
  const first = await page.evaluate(() => window.irodori.getAgentSession())
  await activateButton(page.getByRole('button', { name: 'Close agent console' }))
  await expect(page.getByTestId('console-panel')).toBeHidden()
  await activateButton(page.getByRole('button', { name: 'Library', exact: true }))
  await activateButton(page.getByTestId('console-toggle'))
  await expect(page.locator('.xterm')).toHaveAttribute('data-terminal-identity', 'retained')
  expect((await page.evaluate(() => window.irodori.getAgentSession())).sessionId).toBe(
    first.sessionId,
  )
  await activateButton(page.getByRole('button', { name: 'Editor', exact: true }))
  await expect(page.locator('.xterm')).toHaveAttribute('data-terminal-identity', 'retained')
  await runAgentHook(env, {
    hook_event_name: 'UserPromptSubmit',
    session_id: fixture.session,
    turn_id: 'first',
    prompt: 'Describe available photo tools.',
  })
  const reopened = await irodori.restart()
  await expect(
    reopened.page.getByRole('button', { name: 'Resume conversation', exact: true }),
  ).toBeVisible()
  expect(await reopened.page.evaluate(() => window.irodori.getAgentSession())).toMatchObject({
    status: 'choice',
    output: [],
  })
  await activateButton(reopened.page.getByRole('button', { name: 'New conversation', exact: true }))
  await expect(reopened.page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
  expect((await reopened.page.evaluate(() => window.irodori.getAgentSession())).resumable).toBe(
    false,
  )
})

test('managed MCP attaches to this instance, freezes targets, shares Undo/Redo and denies repeated conflicts and unrelated tools', async ({
  irodori,
}) => {
  test.setTimeout(90000)
  const { page } = irodori
  await importPhotos(irodori.app, page, undefined, true, 'keyboard')
  const photos = (await page.evaluate(() => window.irodori.listPhotos())).photos
  const [a, b] = photos
  await activateButton(page.getByRole('button', { name: `Select ${a.filename}`, exact: true }))
  const { fixture, env } = await configure(irodori)
  const hook = JSON.parse(
    await runAgentHook(env, {
      hook_event_name: 'UserPromptSubmit',
      session_id: fixture.session,
      turn_id: 'one',
      prompt: 'Brighten the current photo.',
    }),
  )
  const context = JSON.parse(hook.hookSpecificOutput.additionalContext.split('\n')[1])
  expect(context).toMatchObject({ active: { photoId: a.id, revision: 0 }, development: false })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('out/main/editor-mcp.js')],
    env: {
      ...(process.env as Record<string, string>),
      ...env,
      IRODORI_PROFILE: '/nonexistent/wrong-instance',
    },
  })
  const client = new Client({ name: 'managed-console-test', version: '1' })
  try {
    await client.connect(transport)
    const listed = (await client.listTools()).tools
    expect(listed.map((tool) => tool.name).sort()).toEqual([...agentTools].sort())
    expect(listed.every((tool) => tool.inputSchema.required?.includes('requestId'))).toBe(true)
    const call = (name: string, args: Record<string, unknown> = {}) =>
      client.callTool({ name, arguments: { ...args, requestId: context.requestId } })
    await activateButton(page.getByRole('button', { name: `Select ${b.filename}`, exact: true }))
    const frozen = await call('irodori_get_editor_context')
    expect(frozen.isError, JSON.stringify(frozen.content)).not.toBe(true)
    expect(frozen.structuredContent).toMatchObject({
      active: { photoId: a.id },
      requestId: context.requestId,
    })
    expect(
      (
        await call('irodori_update_edits', {
          photoId: b.id,
          expectedRevision: 0,
          patch: { exposureEv: 1 },
        })
      ).isError,
    ).toBe(true)
    expect(
      (
        await call('irodori_update_edits', {
          photoId: a.id,
          expectedRevision: 0,
          patch: { exposureEv: 0.5 },
        })
      ).isError,
    ).not.toBe(true)
    expect(await page.evaluate((id) => window.irodori.getEdits(id), b.id)).toMatchObject({
      revision: 0,
    })
    await activateButton(page.getByRole('button', { name: `Select ${a.filename}`, exact: true }))
    await expect(page.getByRole('spinbutton', { name: 'Exposure value', exact: true })).toHaveValue(
      '0.50',
    )
    await activateButton(page.getByRole('button', { name: 'Undo', exact: true }))
    await expect(page.getByRole('spinbutton', { name: 'Exposure value', exact: true })).toHaveValue(
      '0.00',
    )
    await activateButton(page.getByRole('button', { name: 'Redo', exact: true }))
    await expect(page.getByRole('spinbutton', { name: 'Exposure value', exact: true })).toHaveValue(
      '0.50',
    )
    expect(
      (
        await call('irodori_update_edits', {
          photoId: a.id,
          expectedRevision: 1,
          patch: { exposureEv: 0.75 },
        })
      ).isError,
    ).toBe(true)
    const refreshed = await call('irodori_get_edits', { photoId: a.id })
    expect(refreshed.structuredContent).toMatchObject({ revision: 3 })
    expect(
      (
        await call('irodori_update_edits', {
          photoId: a.id,
          expectedRevision: 3,
          patch: { exposureEv: 0.75 },
        })
      ).isError,
    ).not.toBe(true)
    await page.evaluate((id) => window.irodori.updateEdits(id, { exposureEv: 1 }, 4), a.id)
    expect(
      (
        await call('irodori_update_edits', {
          photoId: a.id,
          expectedRevision: 4,
          patch: { exposureEv: 0 },
        })
      ).isError,
    ).toBe(true)
    expect(await page.evaluate((id) => window.irodori.getEdits(id), a.id)).toMatchObject({
      revision: 5,
      settings: { exposureEv: 1 },
    })
    const denied = JSON.parse(
      await runAgentHook(env, {
        hook_event_name: 'PreToolUse',
        session_id: fixture.session,
        turn_id: 'one',
        tool_name: 'Bash',
        tool_input: { command: 'anything' },
      }),
    )
    expect(denied.hookSpecificOutput.permissionDecision).toBe('deny')
    const wrongToken = await fetch(`http://127.0.0.1:${fixture.connection.port}/editor`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${'f'.repeat(64)}` },
      body: JSON.stringify({ operation: 'irodori_get_edits', photoId: a.id }),
    })
    expect(wrongToken.status).toBe(403)
    await openPreviewOptions(page)
    await activateButton(page.getByRole('button', { name: 'Crop photo', exact: true }))
    await expect(
      runAgentHook(env, {
        hook_event_name: 'UserPromptSubmit',
        session_id: fixture.session,
        turn_id: 'crop',
        prompt: 'Edit this crop.',
      }),
    ).rejects.toThrow('crop')
    await activateButton(page.getByRole('button', { name: 'Cancel crop', exact: true }))
    await runAgentHook(env, {
      hook_event_name: 'Stop',
      session_id: fixture.session,
      turn_id: 'one',
    })
    expect((await call('irodori_get_edits', { photoId: a.id })).isError).toBe(true)
  } finally {
    const cancel = page.getByRole('button', { name: 'Cancel crop', exact: true })
    if (await cancel.isVisible()) await activateButton(cancel)
    await client.close()
    await transport.close()
  }
})

test(
  'native terminal focus, paste, resize and minimum Console-open layout',
  foregroundTest('Native terminal focus and compositor presentation require a foreground window.'),
  async ({ irodori }, info) => {
    const { page } = irodori
    const { fixture } = await configure(irodori)
    const clipboardBefore = await irodori.app.evaluate(({ clipboard }) => clipboard.readText())
    try {
      const native = await irodori.app.browserWindow(page)
      await native.evaluate((window) => {
        window.unmaximize()
        window.setContentSize(1100, 700)
        window.show()
        window.focus()
      })
      await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([1100, 700])
      await expect(page.locator('.xterm-rows')).toContainText('SIZE 123x8')
      const terminalLine = page.locator('.xterm-rows').getByText(/^IRODORI TEST CODEX /)
      await expect(terminalLine).toBeVisible()
      const lineText = (await terminalLine.textContent())!
      const lineBox = (await terminalLine.boundingBox())!
      const cell = lineBox.width / lineText.length
      await irodori.app.evaluate(({ clipboard }) => clipboard.writeText('before selection'))
      await page.mouse.move(lineBox.x + cell * 0.1, lineBox.y + lineBox.height / 2)
      await page.mouse.down()
      await page.mouse.move(lineBox.x + cell * 12.1, lineBox.y + lineBox.height / 2, { steps: 6 })
      expect(await irodori.app.evaluate(({ clipboard }) => clipboard.readText())).toBe(
        'before selection',
      )
      await page.mouse.up()
      await expect
        .poll(() => irodori.app.evaluate(({ clipboard }) => clipboard.readText()))
        .toBe(lineText.slice(0, 12))
      const input = page.getByRole('textbox', { name: 'Codex terminal' })
      await input.focus()
      await irodori.app.evaluate(({ clipboard }) => clipboard.writeText('before copy shortcut'))
      await page.keyboard.press('Control+C')
      await expect
        .poll(() => irodori.app.evaluate(({ clipboard }) => clipboard.readText()))
        .toBe(lineText.slice(0, 12))
      await expect(page.locator('.xterm-rows')).not.toContainText('INTERRUPTED')
      await page.locator('.xterm-screen').click({ position: { x: 10, y: 60 } })
      await page.keyboard.press('Control+C')
      await expect(page.locator('.xterm-rows')).toContainText('INTERRUPTED')
      await expect(
        page.evaluate(() => window.irodori.copyAgentSelection('older-session', 'unaccepted')),
      ).rejects.toThrow('older session')
      expect(await irodori.app.evaluate(({ clipboard }) => clipboard.readText())).toBe(
        lineText.slice(0, 12),
      )
      await irodori.app.evaluate(({ shell }) => {
        const opened: string[] = []
        ;(globalThis as unknown as { agentSignInTestUrls: string[] }).agentSignInTestUrls = opened
        shell.openExternal = async (url) => {
          opened.push(url)
        }
      })
      await activateButton(page.getByRole('button', { name: 'Copy sign-in link', exact: true }))
      expect(await irodori.app.evaluate(({ clipboard }) => clipboard.readText())).toBe(fixture.link)
      await activateButton(page.getByRole('button', { name: 'Open sign-in', exact: true }))
      await expect
        .poll(() =>
          irodori.app.evaluate(
            () =>
              (globalThis as unknown as { agentSignInTestUrls: string[] }).agentSignInTestUrls
                .length,
          ),
        )
        .toBe(1)
      // xterm receives pointer events on its screen above the rendered text spans.
      const signInText = await page
        .locator('.xterm-rows')
        .getByText('Sign in', { exact: true })
        .boundingBox()
      expect(signInText).not.toBeNull()
      await page.mouse.click(
        signInText!.x + signInText!.width / 2,
        signInText!.y + signInText!.height / 2,
      )
      await expect
        .poll(() =>
          irodori.app.evaluate(
            () => (globalThis as unknown as { agentSignInTestUrls: string[] }).agentSignInTestUrls,
          ),
        )
        .toEqual([fixture.link, fixture.link])
      await input.focus()
      await page.keyboard.type('brighten the photo')
      await page.keyboard.press('Enter')
      await expect(page.locator('.xterm-rows')).toContainText('INPUT')
      await irodori.app.evaluate(({ clipboard }) => clipboard.writeText('paste request'))
      await page.keyboard.press('Control+V')
      await page.keyboard.press('Enter')
      await expect(page.locator('.xterm-rows')).toContainText('paste request')
      const consoleBox = await page.getByTestId('console-panel').boundingBox()
      expect(consoleBox!.x).toBeGreaterThan(224)
      expect(consoleBox!.width).toBeGreaterThan(700)
      expect(consoleBox!.height).toBe(180)
      await page.screenshot({ path: info.outputPath('console-1100x700.png') })
      await page.keyboard.press('Shift+Tab')
      await expect(input).not.toBeFocused()
      const divider = page.getByRole('separator', { name: 'Resize agent console', exact: true })
      const edge = (await divider.boundingBox())!
      await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2)
      await page.mouse.down()
      await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2 - 80, { steps: 5 })
      await page.mouse.up()
      await expect(page.getByTestId('console-panel')).toHaveCSS('height', '260px')
      expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(
        true,
      )
      await page.screenshot({ path: info.outputPath('console-resized-1100x700.png') })
    } finally {
      await irodori.app.evaluate(
        ({ clipboard }, text) => clipboard.writeText(text),
        clipboardBefore,
      )
    }
  },
)

test('console divider drags, cancels, resizes by keyboard and restores height across workspace changes and restart', async ({
  irodori,
}) => {
  const { page } = irodori
  await importPhotos(irodori.app, page, ['tests/fixtures/photos/alpine-lake.jpg'], true, 'keyboard')
  const photoId = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id
  const historyBefore = await page.evaluate((id) => window.irodori.getEditHistory(id), photoId)
  await activateButton(page.getByTestId('console-toggle'))
  const divider = page.getByRole('separator', { name: 'Resize agent console', exact: true })
  const panel = page.getByTestId('console-panel')
  const initial = (await panel.boundingBox())!.height
  await divider.press('ArrowUp')
  await expect(panel).toHaveCSS('height', `${initial + 10}px`)
  const drag = async (delta: number, cancel = false) => {
    const box = (await divider.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - delta, { steps: 5 })
    if (cancel) await divider.press('Escape')
    await page.mouse.up()
  }
  await drag(80)
  const height = initial + 90
  await expect(panel).toHaveCSS('height', `${height}px`)
  await drag(50, true)
  await expect(panel).toHaveCSS('height', `${height}px`)
  expect(await page.evaluate((id) => window.irodori.getEditHistory(id), photoId)).toEqual(
    historyBefore,
  )
  await activateButton(page.getByRole('button', { name: 'Close agent console' }))
  await activateButton(page.getByRole('button', { name: 'Library', exact: true }))
  await activateButton(page.getByTestId('console-toggle'))
  await expect(panel).toHaveCSS('height', `${height}px`)
  const restarted = await irodori.restart()
  await expect(restarted.page.getByTestId('console-panel')).toHaveCSS('height', `${height}px`)
  const separator = restarted.page.getByRole('separator', {
    name: 'Resize agent console',
    exact: true,
  })
  await separator.press('Home')
  await expect(restarted.page.getByTestId('console-panel')).toHaveCSS('height', '120px')
  await separator.press('End')
  const maximum = await separator.getAttribute('aria-valuemax')
  await expect(restarted.page.getByTestId('console-panel')).toHaveCSS('height', `${maximum}px`)
  await separator.dispatchEvent('dblclick')
  await expect(restarted.page.getByTestId('console-panel')).toHaveCSS('height', `${initial}px`)
})
