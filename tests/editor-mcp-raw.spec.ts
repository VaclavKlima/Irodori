import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { resolve } from 'node:path'
import { expect, test } from './electron.fixture'
import { importPhotos } from './import.helpers'

test('RAW editing MCP combines white balance, lens and light history, statistics and automatic scene rendering', async ({
  luma,
}) => {
  test.setTimeout(90000)
  await importPhotos(luma.app, luma.page, ['tests/fixtures/sony-zv1.ARW'])
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('scripts/editor-mcp.mjs')],
    env: { ...(process.env as Record<string, string>), LUMA_PROFILE: luma.userDataDir },
  })
  const client = new Client({ name: 'luma-editor-raw-test', version: '1' })
  try {
    await client.connect(transport)
    const call = async (name: string, args = {}) => {
      const result = await client.callTool({ name, arguments: args })
      expect(result.isError).not.toBe(true)
      return result.structuredContent as Record<string, unknown>
    }
    const photos = await call('luma_list_photos'),
      photoId = (photos.photos as { id: string }[])[0].id
    const patch = {
      shadows: 65,
      whites: -35,
      blacks: 20,
      exposureEv: 1.25,
      contrast: 37,
      highlights: -65,
      whiteBalance: { mode: 'custom', kelvin: 7000, tint: 15 },
      lens: { distortion: false },
    }
    expect(await call('luma_update_edits', { photoId, expectedRevision: 0, patch })).toMatchObject({
      revision: 1,
      settings: patch,
    })
    for (const [label, value] of [
      ['Temperature', '7000'],
      ['Tint', '15'],
      ['Highlights', '-65'],
    ])
      await expect(luma.page.getByRole('spinbutton', { name: `${label} value` })).toHaveValue(value)
    await expect(luma.page.getByTestId('lens-corrections')).toBeHidden()
    await expect(luma.page.getByTestId('lens-corrections')).toHaveAttribute('data-revision', '1')
    await luma.page.getByRole('button', { name: 'Lens corrections', exact: true }).click()
    await expect(
      luma.page.getByRole('checkbox', { name: 'Distortion', exact: true }),
    ).not.toBeChecked()
    const history = await call('luma_get_edit_history', { photoId })
    expect(history).toMatchObject({
      cursor: 1,
      snapshots: [{ settings: { exposureEv: 0 } }, { settings: patch }],
    })
    await expect
      .poll(
        async () => {
          const result = await client.callTool({
            name: 'luma_get_photo_statistics',
            arguments: { photoId, expectedRevision: 1 },
          })
          return result.isError ? null : result.structuredContent
        },
        { timeout: 60000 },
      )
      .toMatchObject({ photoId, revision: 1, colorSpace: 'srgb', dynamicRange: 'sdr' })
    await luma.page.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect(luma.page.getByRole('spinbutton', { name: 'Exposure value' })).toHaveValue('0.00')
    await expect(luma.page.getByRole('checkbox', { name: 'Distortion', exact: true })).toBeChecked()
    expect(await call('luma_redo_edit', { photoId, expectedRevision: 2 })).toMatchObject({
      revision: 3,
      settings: patch,
    })
    expect(await call('luma_undo_edit', { photoId, expectedRevision: 3 })).toMatchObject({
      revision: 4,
      settings: { processing: 'hdr-v1', exposureEv: 0 },
    })
    expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain(
      'luma_upgrade_photo_processing',
    )
  } finally {
    await client.close()
    await transport.close()
  }
})
