import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test } from './electron.fixture'
import { importPhotos } from './import.helpers'

test('stdio editing tools share persisted history with UI without a development debug endpoint', async ({
  irodori,
}) => {
  test.setTimeout(90000)
  expect(await irodori.app.evaluate(({ app }) => app.getName())).toBe('Irodori')
  await expect(irodori.page).toHaveTitle('Irodori — Personal photo editing')
  await importPhotos(irodori.app, irodori.page, ['tests/fixtures/photos/alpine-lake.jpg'])
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('scripts/editor-mcp.mjs')],
    env: { ...(process.env as Record<string, string>), IRODORI_PROFILE: irodori.userDataDir },
  })
  const client = new Client({ name: 'irodori-editor-test', version: '1' })
  try {
    await client.connect(transport)
    const previewTool = (await client.listTools()).tools.find(
      (tool) => tool.name === 'irodori_request_merge_preview',
    )!
    expect(Object.keys(previewTool.inputSchema.properties!)).toEqual([
      'reviewId',
      'expectedRevision',
    ])
    expect(previewTool.inputSchema.required).toEqual(['reviewId', 'expectedRevision'])
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      'irodori_get_edit_clipboard',
      'irodori_copy_edits',
      'irodori_prepare_paste_edits',
      'irodori_dispose_paste_preparation',
      'irodori_start_paste_edits',
      'irodori_get_edit_application_results',
      'irodori_get_export_capabilities',
      'irodori_get_export_preferences',
      'irodori_prepare_export',
      'irodori_dispose_export_preparation',
      'irodori_start_export',
      'irodori_get_export_results',
      'irodori_get_photo_actions_context',
      'irodori_get_browse_summary',
      'irodori_get_browse_chunk',
      'irodori_locate_browse_photo',
      'irodori_get_browse_range',
      'irodori_get_browse_section',
      'irodori_list_stacks',
      'irodori_get_photo_stack',
      'irodori_get_stack_members',
      'irodori_get_stack_snapshot',
      'irodori_group_photos',
      'irodori_ungroup_stack',
      'irodori_remove_from_stack',
      'irodori_set_stack_cover',
      'irodori_set_stack_expanded',
      'irodori_get_gallery_summary',
      'irodori_get_gallery_chunk',
      'irodori_list_gallery',
      'irodori_locate_gallery_photo',
      'irodori_get_gallery_range',
      'irodori_group_capture_sequences',
      'irodori_get_active_merge_review',
      'irodori_get_merge_diagnostics',
      'irodori_create_merge_review',
      'irodori_update_merge_review',
      'irodori_request_merge_preview',
      'irodori_start_merge',
      'irodori_dispose_merge_review',
      'irodori_get_merge_provenance',
      'irodori_list_tasks',
      'irodori_get_task_errors',
      'irodori_cancel_task',
      'irodori_dismiss_task',
      'irodori_get_preview_diagnostics',
      'irodori_get_display_state',
      'irodori_set_preview_preference',
      'irodori_get_photo_statistics',
      'irodori_get_photo_pixel',
      'irodori_list_photos',
      'irodori_get_edit_capabilities',
      'irodori_get_edits',
      'irodori_get_crop_context',
      'irodori_propose_white_balance',
      'irodori_get_edit_history',
      'irodori_update_edits',
      'irodori_undo_edit',
      'irodori_redo_edit',
    ])
    const call = async (name: string, args = {}) => {
      const result = await client.callTool({ name, arguments: args })
      expect(result.isError).not.toBe(true)
      return result.structuredContent as Record<string, unknown>
    }
    expect(await call('irodori_get_active_merge_review')).toEqual({ review: null })
    const missingDiagnostics = await client.callTool({
      name: 'irodori_get_merge_diagnostics',
      arguments: { reviewId: 'missing', expectedRevision: 0 },
    })
    expect(missingDiagnostics.isError).toBe(true)
    const page = await call('irodori_list_photos')
    const photoId = (page.photos as { id: string }[])[0].id
    const gallery = await irodori.page.evaluate(() => window.irodori.getGallerySummary())
    expect(await call('irodori_get_gallery_summary')).toEqual(gallery)
    expect(
      await call('irodori_get_gallery_chunk', {
        offset: 0,
        galleryRevision: { catalogRevision: gallery.catalogRevision, revision: gallery.revision },
      }),
    ).toEqual(
      await irodori.page.evaluate(
        (revision) => window.irodori.getGalleryChunk(0, revision),
        gallery,
      ),
    )
    const staleGallery = await client.callTool({
      name: 'irodori_get_gallery_chunk',
      arguments: { offset: 0, galleryRevision: { catalogRevision: -1, revision: 0 } },
    })
    expect(staleGallery.isError).toBe(true)
    const context = await irodori.page.evaluate(
      (id) => window.irodori.getPhotoActionsContext(id, [id]),
      photoId,
    )
    expect(
      await call('irodori_get_photo_actions_context', { photoId, selectedIds: [photoId] }),
    ).toEqual(context)
    const large = await call('irodori_get_photo_actions_context', {
      photoId: null,
      selectedIds: [
        photoId,
        ...Array.from({ length: 600 }, (_, i) => (i + 1).toString(16).padStart(64, '0')),
      ],
    })
    expect(large).toMatchObject({
      photo: null,
      selection: [{ id: photoId }],
      targetsCurrent: false,
    })
    const query = { search: 'ALPINE JPG', grouping: 'date' }
    const summary = await call('irodori_get_browse_summary', { query, selectedIds: [photoId] })
    expect(summary).toMatchObject({ total: 1, selected: 1, outsideSelected: 0 })
    const chunk = await call('irodori_get_browse_chunk', {
      query,
      expectedRevision: summary.revision,
    })
    expect(chunk).toMatchObject({ offset: 0, photos: [{ id: photoId }] })
    expect(await call('irodori_locate_browse_photo', { query, photoId })).toMatchObject({
      location: { index: 0, photo: { id: photoId } },
    })
    expect(
      await call('irodori_get_browse_range', { query, fromId: photoId, toId: photoId }),
    ).toMatchObject({ photos: [{ id: photoId }] })
    const section = (summary.sections as { key: string }[])[0]
    expect(
      await call('irodori_get_browse_section', { query, sectionKey: section.key }),
    ).toMatchObject({ photos: [{ id: photoId }] })
    const unsupportedPixel = await client.callTool({
      name: 'irodori_get_photo_pixel',
      arguments: {
        photoId,
        expectedRevision: 0,
        x: 0,
        y: 0,
        domain: 'working-hdr',
      },
    })
    expect(unsupportedPixel.isError).toBe(true)
    expect(JSON.stringify(unsupportedPixel.content)).toContain('processing unavailable')
    expect(await call('irodori_get_edits', { photoId })).toMatchObject({ revision: 0 })
    const unsupportedPicker = await client.callTool({
      name: 'irodori_propose_white_balance',
      arguments: { photoId, expectedRevision: 0, sample: { x: 0.5, y: 0.5, diameter: 15 } },
    })
    expect(unsupportedPicker.isError).toBe(true)
    expect(JSON.stringify(unsupportedPicker.content)).toContain('supported single RAW capture')
    expect(await call('irodori_get_edit_history', { photoId })).toMatchObject({
      revision: 0,
      cursor: 0,
    })
    expect(await call('irodori_list_tasks')).toMatchObject({ tasks: expect.any(Array) })
    const invalidMerge = await client.callTool({
      name: 'irodori_create_merge_review',
      arguments: { ids: [photoId, photoId], mode: 'hdr' },
    })
    expect(invalidMerge.isError).toBe(true)
    expect(JSON.stringify(invalidMerge.content)).toContain('Duplicate merge sources')
    const highlightsDraft = irodori.page.getByRole('spinbutton', { name: 'Highlights value' })
    await expect(highlightsDraft).toBeEnabled({ timeout: 30000 })
    await highlightsDraft.fill('20')
    expect(
      await call('irodori_update_edits', {
        photoId,
        expectedRevision: 0,
        patch: {
          shadows: 65,
          whites: -35,
          blacks: 20,
          exposureEv: 1.25,
          contrast: 37,
          highlights: -65,
          saturation: 35,
          vibrance: -45,
        },
      }),
    ).toMatchObject({
      revision: 1,
      settings: {
        shadows: 65,
        whites: -35,
        blacks: 20,
        exposureEv: 1.25,
        contrast: 37,
        highlights: -65,
        saturation: 35,
        vibrance: -45,
      },
    })
    await expect(irodori.page.getByRole('spinbutton', { name: 'Exposure value' })).toHaveValue(
      '1.25',
    )
    await expect(irodori.page.getByRole('spinbutton', { name: 'Contrast value' })).toHaveValue('37')
    await expect(irodori.page.getByRole('spinbutton', { name: 'Highlights value' })).toHaveValue(
      '-65',
    )
    for (const [label, value] of [
      ['Shadows', '65'],
      ['Whites', '-35'],
      ['Blacks', '20'],
      ['Saturation', '35'],
      ['Vibrance', '-45'],
    ])
      await expect(irodori.page.getByRole('spinbutton', { name: `${label} value` })).toHaveValue(
        value,
      )
    await highlightsDraft.press('Enter')
    await expect
      .poll(
        async () => {
          const result = await client.callTool({
            name: 'irodori_get_photo_statistics',
            arguments: { photoId, expectedRevision: 1 },
          })
          return result.isError ? null : result.structuredContent
        },
        { timeout: 60000 },
      )
      .toMatchObject({ photoId, revision: 1, colorSpace: 'srgb', dynamicRange: 'sdr' })
    expect(
      (
        await client.callTool({
          name: 'irodori_get_photo_statistics',
          arguments: { photoId, expectedRevision: 0 },
        })
      ).isError,
    ).toBe(true)

    for (const key of [
      'contrast',
      'highlights',
      'shadows',
      'whites',
      'blacks',
      'saturation',
      'vibrance',
    ])
      for (const value of [-101, 101, 0.25, '20', null]) {
        const invalid = await client.callTool({
          name: 'irodori_update_edits',
          arguments: { photoId, expectedRevision: 1, patch: { [key]: value } },
        })
        expect(invalid.isError).toBe(true)
      }
    const conflict = await client.callTool({
      name: 'irodori_update_edits',
      arguments: { photoId, expectedRevision: 0, patch: { exposureEv: 2 } },
    })
    expect(conflict.isError).toBe(true)
    expect(await call('irodori_get_edit_history', { photoId })).toMatchObject({
      cursor: 1,
      snapshots: [
        {
          settings: { shadows: 0, whites: 0, blacks: 0, exposureEv: 0, contrast: 0, highlights: 0 },
        },
        {
          settings: {
            shadows: 65,
            whites: -35,
            blacks: 20,
            exposureEv: 1.25,
            contrast: 37,
            highlights: -65,
            saturation: 35,
            vibrance: -45,
          },
        },
      ],
    })
    await irodori.page.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect(irodori.page.getByRole('spinbutton', { name: 'Exposure value' })).toHaveValue(
      '0.00',
    )
    expect(await call('irodori_redo_edit', { photoId, expectedRevision: 2 })).toMatchObject({
      revision: 3,
      settings: {
        shadows: 65,
        whites: -35,
        blacks: 20,
        exposureEv: 1.25,
        contrast: 37,
        highlights: -65,
        saturation: 35,
        vibrance: -45,
      },
    })
    await call('irodori_undo_edit', { photoId, expectedRevision: 3 })
    const connectionPath = join(irodori.userDataDir, 'editor', 'connection.json')
    const connection = JSON.parse(await readFile(connectionPath, 'utf8'))
    if (process.platform !== 'win32') expect((await stat(connectionPath)).mode & 0o777).toBe(0o600)
    const response = await fetch(`http://127.0.0.1:${connection.port}/editor`, {
      method: 'POST',
      body: '{}',
    })
    expect(response.status).toBe(403)
    const browser = await fetch(`http://127.0.0.1:${connection.port}/editor`, {
      method: 'POST',
      headers: { Origin: 'https://example.com', Authorization: `Bearer ${connection.token}` },
      body: '{}',
    })
    expect(browser.status).toBe(403)
    await irodori.restart()
    expect(await call('irodori_get_edits', { photoId })).toMatchObject({
      revision: 4,
      settings: { shadows: 0, whites: 0, blacks: 0, exposureEv: 0, contrast: 0, highlights: 0 },
      canRedo: true,
    })
  } finally {
    await client.close()
    await transport.close()
  }
})
