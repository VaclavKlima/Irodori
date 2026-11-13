import { findMaskComponent } from '../shared/masks'
import { objectSelectionTarget } from '../shared/object-selection'
import { selectionCanonicalBox } from '../shared/object-selection'
import { maskCanonicalPoint } from '../shared/mask-geometry'
import { maskBrushExample } from '../shared/mask-brush'
import { MergeError } from '../shared/merge'
import type { DisplayState } from './display-state'
import type { PreviewPreference } from '../shared/hdr-display'
import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, writeFile, rename, rm, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import type { PhotoLibrary } from './library'
import { AgentRequestGate } from './agent/request-gate'
import type { EditorContextSnapshot } from '../shared/agent'
import type { EditPatch } from '../shared/edits'

/** Private, authenticated transport for enumerated operations. The application owns SQLite. */
export async function startEditorEndpoint(
  profile: string,
  library: PhotoLibrary,
  display?: DisplayState,
  options: {
    capture?: () => Promise<EditorContextSnapshot>
    development?: boolean
    agentGate?: (token: string) => AgentRequestGate | undefined
  } = {},
) {
  const token = randomBytes(32).toString('hex')
  let closing = false
  const contextGate = new AgentRequestGate(
    async () => {
      if (!options.capture) throw new Error('Editor context is unavailable.')
      return options.capture()
    },
    async (id) => (await library.getEdits(id)).revision,
    options.development ?? false,
  )
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json')
    response.setHeader('Cache-Control', 'no-store')
    const supplied = request.headers.authorization ?? ''
    const expected = `Bearer ${token}`
    const gate = supplied.startsWith('Bearer ') ? options.agentGate?.(supplied.slice(7)) : undefined
    if (
      closing ||
      request.method !== 'POST' ||
      request.url !== '/editor' ||
      request.headers.origin ||
      request.headers.host !== `127.0.0.1:${port}` ||
      (!gate &&
        (Buffer.byteLength(supplied) !== Buffer.byteLength(expected) ||
          !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))))
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
      const args = JSON.parse(body)
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
        curveSample,
        exportRequest,
        preparationId,
        pasteRequest,
        presetId,
        expectedPresetRevision,
        presetRequest,
        presetApplication,
        presetQuery,
        maskMutation,
        rangeSample,
        points,
        allowOutsidePhoto,
      } = args as {
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
        curveSample: import('../shared/curve-tone').CurveToneRequest
        pasteRequest: import('../shared/edit-transfer').PasteEditsRequest
        exportRequest: import('../shared/export').ExportStart
        preparationId: string
        presetId: string
        expectedPresetRevision: number
        presetRequest:
          | import('../shared/presets').CreatePresetRequest
          | import('../shared/presets').UpdatePresetRequest
        presetApplication: import('../shared/presets').PresetApplicationRequest
        allowOutsidePhoto?: boolean
        points?: import('../shared/masks').MaskPoint[]
        maskMutation: import('../shared/masks').MaskMutation
        rangeSample: Omit<
          import('../shared/mask-range-sampling').MaskRangeSampleRequest,
          'photoId' | 'expectedRevision'
        >
        presetQuery?: import('../shared/presets').PresetQuery
      }
      if (
        body.length > 16384 &&
        ![
          'irodori_get_browse_summary',
          'irodori_get_gallery_summary',
          'irodori_get_photo_actions_context',
          'irodori_prepare_export',
          'irodori_prepare_paste_edits',
          'irodori_prepare_preset_application',
          'irodori_mutate_masks',
        ].includes(operation)
      )
        throw new Error('Editor request is too large.')
      if (
        operation === 'irodori_agent_begin_request' ||
        operation === 'irodori_agent_end_request'
      ) {
        if (!gate) throw new Error('This operation requires a managed console connection.')
        const result =
          operation === 'irodori_agent_begin_request'
            ? await gate.begin(args.sessionId, args.turnId)
            : (gate.end(args.sessionId, args.turnId), { ended: true })
        response.end(JSON.stringify({ result }))
        return
      }
      const execute = async () => {
        let result: unknown
        switch (operation) {
          case 'irodori_get_editing_guidance': {
            const { operation: transportOperation, requestId, ...request } = args
            void transportOperation
            void requestId
            result = library.getEditingGuidance(request)
            break
          }
          case 'irodori_get_photo_presentation_context': {
            const { operation: transportOperation, requestId, ...request } = args
            void transportOperation
            void requestId
            result = await library.getPhotoPresentationContext(request)
            break
          }
          case 'irodori_get_mask_preview': {
            const { operation: transportOperation, requestId, ...request } = args
            void transportOperation
            void requestId
            const lifetime = new AbortController()
            const gone = () => {
              if (!response.writableFinished)
                lifetime.abort(new Error('Mask inspection client disconnected.'))
            }
            response.once('close', gone)
            try {
              result = await library.getMaskPreview(
                request,
                gate ? AbortSignal.any([gate.signal, lifetime.signal]) : lifetime.signal,
              )
            } finally {
              response.removeListener('close', gone)
            }
            break
          }
          case 'irodori_get_editor_context':
            if (!gate && (offset === undefined || offset === 0))
              await contextGate.begin('00000000-0000-0000-0000-000000000000', 'external-context')
            result = (gate ?? contextGate).context(offset)
            break
          case 'irodori_get_photo_preview':
          case 'irodori_get_preview_context': {
            const lifetime = new AbortController()
            const gone = () => {
              if (!response.writableFinished)
                lifetime.abort(new Error('Inspection client disconnected.'))
            }
            response.once('close', gone)
            const signal = gate ? AbortSignal.any([gate.signal, lifetime.signal]) : lifetime.signal
            try {
              if (operation === 'irodori_get_preview_context') {
                const { geometry, ...context } = await library.agentPreviews.context(
                  photoId,
                  expectedRevision,
                  signal,
                )
                // Canonical lens tables are renderer geometry, not model prompt context.
                void geometry
                result = context
              } else
                result =
                  args.inspection === undefined
                    ? await library.agentPreviews.get(photoId, expectedRevision, signal)
                    : await library.agentPreviews.inspect(
                        photoId,
                        expectedRevision,
                        args.inspection,
                        signal,
                      )
            } finally {
              response.removeListener('close', gone)
            }
            break
          }
          case 'irodori_get_output_proof': {
            const lifetime = new AbortController()
            const gone = () => {
              if (!response.writableFinished)
                lifetime.abort(new Error('Output preview client disconnected.'))
            }
            response.once('close', gone)
            try {
              result = await library.getOutputProofOverview(
                {
                  preparationId,
                  photoId,
                  options: args.options,
                  token: args.proofToken,
                  ...(args.inspection === undefined ? {} : { inspection: args.inspection }),
                },
                gate ? AbortSignal.any([gate.signal, lifetime.signal]) : lifetime.signal,
              )
            } finally {
              response.removeListener('close', gone)
            }
            break
          }
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
            result = {
              ...(await library.getEdits(photoId)),
              maskContent: undefined,
              maskBases: undefined,
            }
            break
          case 'irodori_get_crop_context':
            result = await library.getCropContext(photoId, expectedRevision)
            break
          case 'irodori_propose_white_balance':
            result = await library.proposeWhiteBalance(photoId, expectedRevision, sample)
            break
          case 'irodori_sample_curve_tone':
            result = await library.sampleCurveTone(photoId, expectedRevision, curveSample)
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
          case 'irodori_list_presets':
            result = library.listPresets(presetQuery)
            break
          case 'irodori_get_preset':
            result = library.getPreset(presetId)
            break
          case 'irodori_create_preset':
            result = await library.createPreset(
              presetRequest as import('../shared/presets').CreatePresetRequest,
            )
            break
          case 'irodori_update_preset':
            result = await library.updatePreset(
              presetRequest as import('../shared/presets').UpdatePresetRequest,
            )
            break
          case 'irodori_delete_preset':
            await library.deletePreset({ presetId, expectedPresetRevision })
            result = { deleted: true }
            break
          case 'irodori_prepare_preset_application':
            result = await library.preparePresetApplication(presetApplication)
            break
          case 'irodori_start_preset_application':
            result = { taskId: await library.startPresetApplication(preparationId) }
            break
          case 'irodori_dispose_preset_preparation':
            library.editTransfers.dispose(preparationId)
            result = { disposed: true }
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
          case 'irodori_get_object_selection_context': {
            const context = await library.getObjectSelectionContext(photoId, expectedRevision)
            if (
              points !== undefined &&
              (!Array.isArray(points) ||
                points.length > 128 ||
                points.some(
                  (point) =>
                    !point ||
                    Object.keys(point).some((key) => !['x', 'y'].includes(key)) ||
                    ![point.x, point.y].every((n) => Number.isFinite(n) && n >= 0 && n <= 1),
                ))
            )
              throw new Error('Supply at most 128 normalized photograph points.')
            let box: [number, number, number, number] | undefined
            if (args.box !== undefined) {
              const input = args.box
              if (
                !Array.isArray(input) ||
                input.length !== 4 ||
                !input.every(
                  (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1,
                ) ||
                input[0] >= input[2] ||
                input[1] >= input[3]
              )
                throw new Error('Invalid normalized photograph box.')
              const mapped = selectionCanonicalBox(
                { x: input[0] * context.width, y: input[1] * context.height },
                { x: input[2] * context.width, y: input[3] * context.height },
                context.geometry,
              )
              if (!mapped) throw new Error('The indicated box is outside the canonical source.')
              box = mapped.box
            }
            const { geometry, ...metadata } = context
            result = {
              ...metadata,
              canonicalWidth: geometry.canonicalWidth,
              canonicalHeight: geometry.canonicalHeight,
              box,
              points: (points ?? []).map((point) =>
                maskCanonicalPoint(
                  { x: point.x * context.width, y: point.y * context.height },
                  geometry,
                ),
              ),
              coordinates:
                'Input box/points use normalized current cropped photograph coordinates. Returned box/points use normalized once-oriented uncorrected canonical source coordinates. The box is a segmentation guide, not an exact ROI; its perimeter is mapped through crop/lens geometry.',
            }
            break
          }
          case 'irodori_create_object_selection': {
            const lifetime = new AbortController()
            const gone = () => {
              if (!response.writableFinished)
                lifetime.abort(new Error('Selection client disconnected.'))
            }
            response.once('close', gone)
            try {
              const proposal = await library.createObjectSelection(
                {
                  photoId,
                  expectedRevision,
                  gridIdentity: args.gridIdentity as string,
                  prompts:
                    args.prompts as import('../shared/object-selection').ObjectSelectionPrompts,
                  ...(args.maskId === undefined ? {} : { maskId: args.maskId as string }),
                  ...(args.selectionTarget === undefined
                    ? {}
                    : {
                        target:
                          args.selectionTarget as import('../shared/object-selection').ObjectSelectionTarget,
                      }),
                },
                gate ? AbortSignal.any([gate.signal, lifetime.signal]) : lifetime.signal,
              )
              const destination = objectSelectionTarget({
                photoId,
                expectedRevision,
                gridIdentity: args.gridIdentity as string,
                prompts:
                  args.prompts as import('../shared/object-selection').ObjectSelectionPrompts,
                ...(args.maskId === undefined ? {} : { maskId: args.maskId as string }),
                ...(args.selectionTarget === undefined
                  ? {}
                  : {
                      target:
                        args.selectionTarget as import('../shared/object-selection').ObjectSelectionTarget,
                    }),
              })
              const componentId =
                destination.kind === 'new-mask' ? undefined : destination.componentId
              const selected = findMaskComponent(
                proposal.mask,
                componentId,
              ) as import('../shared/masks').ResolvedMaskCoverage
              const { strokes, base } = selected
              const describe = (node: import('../shared/masks').ResolvedMaskCoverage): unknown => {
                const { base, operands } = node
                const metadata = Object.fromEntries(
                  Object.entries(node).filter(
                    ([key]) =>
                      ![
                        'strokes',
                        'resultStrokes',
                        'base',
                        'preparedCoverage',
                        'operands',
                      ].includes(key),
                  ),
                )
                return {
                  ...metadata,
                  ...(base
                    ? {
                        base: {
                          version: base.version,
                          hash: base.hash,
                          width: base.width,
                          height: base.height,
                        },
                      }
                    : {}),
                  operands: (operands ?? []).map(describe),
                }
              }
              const mask = describe(proposal.mask) as Record<string, unknown>
              if (!base) throw new Error('The selection proposal has no generated coverage.')
              const { pngBase64, ...reference } = base
              result = {
                id: proposal.id,
                proposalId: proposal.id,
                target: proposal.target,
                photoId: proposal.photoId,
                revision: proposal.revision,
                gridIdentity: proposal.gridIdentity,
                modelIdentity: proposal.modelIdentity,
                mask: { ...mask },
                selectionBase: reference,
                manualStrokeCount: strokes.length + (selected.resultStrokes?.length ?? 0),
                data: pngBase64,
                mimeType: 'image/png',
                width: base.width,
                height: base.height,
                coordinates:
                  'Native canonical source R8 coverage: white selected, black excluded. This is a proposal; acceptance is explicit and preserves manual corrections. Fine-edge matting and physical alpha are unqualified.',
              }
            } finally {
              response.removeListener('close', gone)
            }
            break
          }
          case 'irodori_accept_object_selection':
            result = {
              ...(await library.acceptObjectSelection({
                proposalId: args.proposalId as string,
                photoId,
                expectedRevision,
              })),
              maskContent: undefined,
              maskBases: undefined,
            }
            break
          case 'irodori_cancel_object_selection':
            await library.cancelObjectSelection(photoId)
            result = { cancelled: true }
            break
          case 'irodori_get_mask_context': {
            if (allowOutsidePhoto !== undefined && typeof allowOutsidePhoto !== 'boolean')
              throw new Error('allowOutsidePhoto must be a boolean.')
            const minimum = allowOutsidePhoto ? -1 : 0,
              maximum = allowOutsidePhoto ? 2 : 1
            if (
              points !== undefined &&
              (!Array.isArray(points) ||
                points.length > 128 ||
                points.some(
                  (point) =>
                    !point ||
                    Object.keys(point).some((key) => !['x', 'y'].includes(key)) ||
                    !['x', 'y'].every(
                      (key) =>
                        typeof point[key as keyof typeof point] === 'number' &&
                        Number.isFinite(point[key as keyof typeof point]) &&
                        point[key as keyof typeof point] >= minimum &&
                        point[key as keyof typeof point] <= maximum,
                    ),
                ))
            )
              throw new Error('Supply at most 128 normalized output points.')
            const context = await library.getMaskContext(photoId, expectedRevision)
            const mapped = (points ?? []).map((point) =>
              maskCanonicalPoint(
                { x: point.x * context.width, y: point.y * context.height },
                context.geometry,
              ),
            )
            if (
              mapped.some((point) =>
                [point.x, point.y].some((n) => !Number.isFinite(n) || n < minimum || n > maximum),
              )
            )
              throw new Error(
                'Mapped points are outside the supported canonical source bounds. Choose another position.',
              )
            result = {
              photoId: context.photoId,
              revision: context.revision,
              width: context.width,
              height: context.height,
              canonicalWidth: context.geometry.canonicalWidth,
              canonicalHeight: context.geometry.canonicalHeight,
              points: mapped,
              ...(!allowOutsidePhoto && mapped.length
                ? {
                    brushExamples: {
                      paint: maskBrushExample('add', mapped[0]),
                      erase: maskBrushExample('subtract', mapped[0]),
                    },
                  }
                : {}),
              renderingIdentity: context.renderingIdentity,
              coordinates:
                'Input points are normalized cropped-output pixel-edge positions; returned points are normalized oriented uncorrected source coordinates for brush strokes (0–1), or gradient geometry (-1–2) when allowOutsidePhoto is true. Unsupported mapped coordinates are refused.',
            }
            break
          }
          case 'irodori_sample_mask_range': {
            if (
              !rangeSample ||
              typeof rangeSample !== 'object' ||
              Object.keys(rangeSample).some((key) => !['renderingIdentity', 'point'].includes(key))
            )
              throw new Error('Supply the confirmed rendering identity and range sample point.')
            const lifetime = new AbortController()
            const disconnected = () => {
              if (!response.writableFinished)
                lifetime.abort(new Error('Range sampling client disconnected.'))
            }
            response.once('close', disconnected)
            try {
              result = await library.sampleMaskRange(
                { ...rangeSample, photoId, expectedRevision },
                gate ? AbortSignal.any([gate.signal, lifetime.signal]) : lifetime.signal,
              )
            } finally {
              response.removeListener('close', disconnected)
            }
            break
          }
          case 'irodori_mutate_masks':
            result = {
              ...(await library.mutateMasks(photoId, expectedRevision, maskMutation)),
              maskContent: undefined,
              maskBases: undefined,
            }
            break
          case 'irodori_update_edits':
            result = {
              ...(await library.updateEdits(photoId, patch, expectedRevision)),
              maskContent: undefined,
              maskBases: undefined,
            }
            break
          case 'irodori_undo_edit':
            result = {
              ...(await library.undoEdit(photoId, expectedRevision)),
              maskContent: undefined,
              maskBases: undefined,
            }
            break
          case 'irodori_redo_edit':
            result = {
              ...(await library.redoEdit(photoId, expectedRevision)),
              maskContent: undefined,
              maskBases: undefined,
            }
            break
          default:
            throw new Error('Unknown editor operation.')
        }
        return result
      }
      const result = gate ? await gate.run(operation, args, execute) : await execute()
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
    agentConnection: (agentToken: string) => ({ version: 1 as const, port, token: agentToken }),
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
