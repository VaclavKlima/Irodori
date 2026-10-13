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
        x,
        y,
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
        x: number
        y: number
      }
      if (body.length > 16384 && operation !== 'luma_get_browse_summary')
        throw new Error('Editor request is too large.')
      let result: unknown
      switch (operation) {
        case 'luma_get_browse_summary':
          result = library.getBrowseSummary(query, selectedIds)
          break
        case 'luma_get_browse_chunk':
          result = library.getBrowseChunk(query, offset, expectedRevision)
          break
        case 'luma_locate_browse_photo':
          result = { location: library.locateBrowsePhoto(query, photoId, expectedRevision) }
          break
        case 'luma_get_browse_range':
          result = { photos: library.getBrowseRange(query, fromId, toId) }
          break
        case 'luma_get_browse_section':
          result = { photos: library.getBrowseSection(query, sectionKey) }
          break
        case 'luma_list_stacks':
          result = library.listStacks()
          break
        case 'luma_get_photo_stack':
          result = { stack: library.getPhotoStack(photoId) }
          break
        case 'luma_get_stack_members':
          result = library.getStackMembers(stackId, offset)
          break
        case 'luma_get_stack_snapshot':
          result = library.getStackSnapshot(stackId, expectedRevision)
          break
        case 'luma_group_photos':
          result = library.groupPhotos(ids, coverId, expectedRevision)
          break
        case 'luma_ungroup_stack':
          library.ungroupStack(stackId, expectedRevision)
          result = { ungrouped: true }
          break
        case 'luma_remove_from_stack':
          result = { stack: library.removeFromStack(photoId, expectedRevision) }
          break
        case 'luma_set_stack_cover':
          result = library.setStackCover(stackId, photoId, expectedRevision)
          break
        case 'luma_set_stack_expanded':
          result = library.setStackExpanded(stackId, expanded, expectedRevision)
          break
        case 'luma_list_gallery':
          result = library.listGallery(offset)
          break
        case 'luma_locate_gallery_photo':
          result = { location: library.locateGalleryPhoto(photoId, direction) }
          break
        case 'luma_get_gallery_range':
          result = { photos: library.getGalleryRange(fromId, toId) }
          break
        case 'luma_group_capture_sequences':
          result = { taskId: library.groupCaptureSequences() }
          break
        case 'luma_get_active_merge_review':
          result = { review: library.getActiveMergeReview() }
          break
        case 'luma_get_merge_diagnostics':
          result = library.getMergeDiagnostics(reviewId, expectedRevision)
          break
        case 'luma_create_merge_review':
          result = await library.createMergeReview(ids, mode)
          break
        case 'luma_update_merge_review':
          result = await library.updateMergeReview(reviewId, expectedRevision, settings)
          break
        case 'luma_request_merge_preview':
          result = await library.requestMergePreview(reviewId, expectedRevision)
          break
        case 'luma_start_merge':
          result = { taskId: library.startMerge(reviewId, expectedRevision) }
          break
        case 'luma_dispose_merge_review':
          await library.disposeMergeReview(reviewId)
          result = { disposed: true }
          break
        case 'luma_get_merge_provenance':
          result = await library.getMergeProvenance(photoId)
          break
        case 'luma_list_tasks':
          result = { tasks: library.listTasks() }
          break
        case 'luma_get_task_errors':
          result = library.taskErrors(taskId, offset)
          break
        case 'luma_cancel_task':
          await library.cancelTask(taskId)
          result = { task: library.listTasks().find((task) => task.id === taskId) }
          break
        case 'luma_dismiss_task':
          library.dismissTask(taskId)
          result = { dismissed: true }
          break
        case 'luma_get_preview_diagnostics':
          result = {
            ...library.fullPreviews.getDiagnostics(),
            presentation: display?.get().presentation,
          }
          break
        case 'luma_get_display_state':
          if (!display) throw new Error('Display state unavailable.')
          result = display.get()
          break
        case 'luma_set_preview_preference':
          if (!display || !preference) throw new Error('Display preference unavailable.')
          result = await display.set(preference)
          break
        case 'luma_list_photos':
          result = library.list(offset)
          break
        case 'luma_get_photo_statistics':
          result = await library.getPhotoStatistics(
            photoId,
            expectedRevision,
            domain === undefined ? undefined : { domain, target, targetGeneration },
          )
          break
        case 'luma_get_edits':
          result = await library.getEdits(photoId)
          break
        case 'luma_get_photo_pixel':
          result = await library.getPhotoPixel(photoId, expectedRevision, x, y, {
            domain: domain!,
            target,
            targetGeneration,
          })
          break
        case 'luma_get_edit_history':
          result = await library.getEditHistory(photoId)
          break
        case 'luma_update_edits':
          result = await library.updateEdits(photoId, patch, expectedRevision)
          break
        case 'luma_undo_edit':
          result = await library.undoEdit(photoId, expectedRevision)
          break
        case 'luma_redo_edit':
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
