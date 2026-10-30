import { MergeError } from '../shared/merge'
import type { DisplayState } from './display-state'
import type { PreviewPreference } from '../shared/hdr-display'
import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, writeFile, rename, rm, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import type { PhotoLibrary } from './library'
import type { EditPatch } from '../shared/edits'

/** Private, authenticated transport for enumerated operations. The application owns SQLite. */
export async function startEditorEndpoint(
  profile: string,
  library: PhotoLibrary,
  display?: DisplayState,
) {
  const token = randomBytes(32).toString('hex')
  let closing = false
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json')
    response.setHeader('Cache-Control', 'no-store')
    const supplied = request.headers.authorization ?? ''
    const expected = `Bearer ${token}`
    if (
      closing ||
      request.method !== 'POST' ||
      request.url !== '/editor' ||
      request.headers.origin ||
      request.headers.host !== `127.0.0.1:${port}` ||
      Buffer.byteLength(supplied) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
    ) {
      response.writeHead(403).end(JSON.stringify({ error: 'Unauthorized editor request.' }))
      request.resume()
      return
    }
    try {
      let body = ''
      for await (const chunk of request) {
        body += chunk.toString()
        if (body.length > 8 * 1024 * 1024) throw new Error('Editor request is too large.')
      }
      const {
        operation,
        ids,
        mode,
        reviewId,
        settings,
        taskId,
        photoId,
        patch,
        expectedRevision,
        offset,
        preference,
        domain,
        target,
        targetGeneration,
        stackId,
        coverId,
        expanded,
        fromId,
        toId,
        direction,
        query,
        sectionKey,
        selectedIds,
        galleryRevision,
        x,
        y,
        sample,
        exportRequest,
        preparationId,
        pasteRequest,
      } = JSON.parse(body) as {
        domain?: import('../shared/hdr-statistics').HdrAnalysisDomain
        target?: 'sdr' | 'current'
        targetGeneration?: number
        preference?: PreviewPreference
        ids: string[]
        mode: import('../shared/merge').MergeMode
        reviewId: string
        settings: import('../shared/merge').MergeSettings
        taskId: string
        operation: string
        photoId: string
        patch: EditPatch
        expectedRevision: number
        offset?: number
        stackId: string
        coverId: string
        expanded: boolean
        fromId: string
        toId: string
        direction?: -1 | 0 | 1
        query: import('../shared/browse').BrowseQuery
        sectionKey: string
        selectedIds?: string[]
        galleryRevision: import('../shared/stacks').GalleryRevision
        x: number
        y: number
        sample: import('../shared/white-balance-picker').WhiteBalanceSample
        pasteRequest: import('../shared/edit-transfer').PasteEditsRequest
        exportRequest: import('../shared/export').ExportStart
        preparationId: string
      }
      if (
        body.length > 16384 &&
        ![
          'irodori_get_browse_summary',
          'irodori_get_gallery_summary',
          'irodori_get_photo_actions_context',
          'irodori_prepare_export',
          'irodori_prepare_paste_edits',
        ].includes(operation)
      )
        throw new Error('Editor request is too large.')
      let result: unknown
      switch (operation) {
        case 'irodori_get_edit_capabilities':
          result = library.getEditCapabilities()
          break
        case 'irodori_get_export_capabilities':
          result = await library.getExportCapabilities()
          break
        case 'irodori_get_export_preferences':
          result = await library.getExportPreferences()
          break
        case 'irodori_prepare_export':
          result = await library.prepareExport(ids)
          break
        case 'irodori_dispose_export_preparation':
          library.exports.dispose(preparationId)
          result = { disposed: true }
          break
        case 'irodori_start_export':
          result = { taskId: await library.startExport(exportRequest) }
          break
        case 'irodori_get_export_results':
          result = library.exports.results(taskId, offset)
          break
        case 'irodori_get_photo_actions_context':
          result = library.getPhotoActionsContext(photoId, selectedIds!)
          break
        case 'irodori_get_browse_summary':
          result = library.getBrowseSummary(query, selectedIds)
          break
        case 'irodori_get_browse_chunk':
          result = library.getBrowseChunk(query, offset, expectedRevision)
          break
        case 'irodori_locate_browse_photo':
          result = { location: library.locateBrowsePhoto(query, photoId, expectedRevision) }
          break
        case 'irodori_get_browse_range':
          result = { photos: library.getBrowseRange(query, fromId, toId) }
          break
        case 'irodori_get_browse_section':
          result = { photos: library.getBrowseSection(query, sectionKey) }
          break
        case 'irodori_list_stacks':
          result = library.listStacks()
          break
        case 'irodori_get_photo_stack':
          result = { stack: library.getPhotoStack(photoId) }
          break
        case 'irodori_get_stack_members':
          result = library.getStackMembers(stackId, offset)
          break
        case 'irodori_get_stack_snapshot':
          result = library.getStackSnapshot(stackId, expectedRevision)
          break
        case 'irodori_group_photos':
          result = await library.groupPhotos(ids, coverId, expectedRevision)
          break
        case 'irodori_ungroup_stack':
          await library.ungroupStack(stackId, expectedRevision)
          result = { ungrouped: true }
          break
        case 'irodori_remove_from_stack':
          result = { stack: await library.removeFromStack(photoId, expectedRevision) }
          break
        case 'irodori_set_stack_cover':
          result = await library.setStackCover(stackId, photoId, expectedRevision)
          break
        case 'irodori_set_stack_expanded':
          result = await library.setStackExpanded(stackId, expanded, expectedRevision)
          break
        case 'irodori_get_gallery_summary':
          result = library.getGallerySummary(selectedIds)
          break
        case 'irodori_get_gallery_chunk':
          result = library.getGalleryChunk(offset ?? 0, galleryRevision)
          break
        case 'irodori_list_gallery':
          result = library.listGallery(offset)
          break
        case 'irodori_locate_gallery_photo':
          result = { location: library.locateGalleryPhoto(photoId, direction) }
          break
        case 'irodori_get_gallery_range':
          result = { photos: library.getGalleryRange(fromId, toId) }
          break
        case 'irodori_group_capture_sequences':
          result = { taskId: library.groupCaptureSequences() }
          break
        case 'irodori_get_active_merge_review':
          result = { review: library.getActiveMergeReview() }
          break
        case 'irodori_get_merge_diagnostics':
          result = library.getMergeDiagnostics(reviewId, expectedRevision)
          break
        case 'irodori_create_merge_review':
          result = await library.createMergeReview(ids, mode)
          break
        case 'irodori_update_merge_review':
          result = await library.updateMergeReview(reviewId, expectedRevision, settings)
          break
        case 'irodori_request_merge_preview':
          result = await library.requestMergePreview(reviewId, expectedRevision)
          break
        case 'irodori_start_merge':
          result = { taskId: library.startMerge(reviewId, expectedRevision) }
          break
        case 'irodori_dispose_merge_review':
          await library.disposeMergeReview(reviewId)
          result = { disposed: true }
          break
        case 'irodori_get_merge_provenance':
          result = await library.getMergeProvenance(photoId)
          break
        case 'irodori_list_tasks':
          result = { tasks: library.listTasks() }
          break
        case 'irodori_get_task_errors':
          result = library.taskErrors(taskId, offset)
          break
        case 'irodori_cancel_task':
          await library.cancelTask(taskId)
          result = { task: library.listTasks().find((task) => task.id === taskId) }
          break
        case 'irodori_dismiss_task':
          await library.dismissTask(taskId)
          result = { dismissed: true }
          break
        case 'irodori_get_preview_diagnostics':
          result = {
            ...library.fullPreviews.getDiagnostics(),
            presentation: display?.get().presentation,
          }
          break
        case 'irodori_get_display_state':
          if (!display) throw new Error('Display state unavailable.')
          result = display.get()
          break
        case 'irodori_set_preview_preference':
          if (!display || !preference) throw new Error('Display preference unavailable.')
          result = await display.set(preference)
          break
        case 'irodori_list_photos':
          result = library.list(offset)
          break
        case 'irodori_get_photo_statistics':
          result = await library.getPhotoStatistics(
            photoId,
            expectedRevision,
            domain === undefined ? undefined : { domain, target, targetGeneration },
          )
          break
        case 'irodori_get_edits':
          result = await library.getEdits(photoId)
          break
        case 'irodori_get_crop_context':
          result = await library.getCropContext(photoId, expectedRevision)
          break
        case 'irodori_propose_white_balance':
          result = await library.proposeWhiteBalance(photoId, expectedRevision, sample)
          break
        case 'irodori_get_photo_pixel':
          result = await library.getPhotoPixel(photoId, expectedRevision, x, y, {
            domain: domain!,
            target,
            targetGeneration,
          })
          break
        case 'irodori_get_edit_clipboard':
          result = { clipboard: library.getEditClipboard() }
          break
        case 'irodori_copy_edits':
          result = await library.copyEdits(photoId)
          break
        case 'irodori_prepare_paste_edits':
          result = await library.preparePasteEdits(pasteRequest)
          break
        case 'irodori_dispose_paste_preparation':
          library.editTransfers.dispose(preparationId)
          result = { disposed: true }
          break
        case 'irodori_start_paste_edits':
          result = { taskId: await library.startPasteEdits(preparationId) }
          break
        case 'irodori_get_edit_application_results':
          result = library.editTransfers.store.results(taskId, offset)
          break
        case 'irodori_get_edit_history':
          result = await library.getEditHistory(photoId)
          break
        case 'irodori_update_edits':
          result = await library.updateEdits(photoId, patch, expectedRevision)
          break
        case 'irodori_undo_edit':
          result = await library.undoEdit(photoId, expectedRevision)
          break
        case 'irodori_redo_edit':
          result = await library.redoEdit(photoId, expectedRevision)
          break
        default:
          throw new Error('Unknown editor operation.')
      }
      response.end(JSON.stringify({ result }))
    } catch (error) {
      response
        .writeHead(400)
        .end(
          JSON.stringify(
            error instanceof MergeError
              ? { error: error.message, failure: error.failure }
              : { error: error instanceof Error ? error.message : String(error) },
          ),
        )
    }
  })
  server.requestTimeout = 15000
  server.headersTimeout = 10000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Editor endpoint is unavailable.')
  const port = address.port
  const directory = join(profile, 'editor')
  const connection = join(directory, 'connection.json')
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
    await writeFile(`${connection}.tmp`, JSON.stringify({ version: 1, port, token }), {
      mode: 0o600,
    })
    await chmod(`${connection}.tmp`, 0o600)
    await rename(`${connection}.tmp`, connection)
  } catch (error) {
    server.close()
    throw error
  }
  return {
    async close() {
      closing = true
      await rm(connection, { force: true })
      server.closeIdleConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    },
  }
}
