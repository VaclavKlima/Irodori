import type { ElectronApplication } from '@playwright/test'
import type {
  ImportCandidate,
  ImportReview,
  ImportVerificationMode,
  ReviewThumbnailRequest,
} from '../src/shared/contracts'
import type { ImportDevice } from '../src/shared/import-devices'

export async function expectMissingOptionErrors(app: ElectronApplication) {
  return app.evaluateHandle(() => {
    const expectedErrors: string[] = []
    const originalError = console.error
    console.error = (...args) => {
      if (
        args[0] === "Error occurred in handler for 'library:only-missing':" &&
        args[1] instanceof Error &&
        args[1].message === 'Fixture import option unavailable'
      ) {
        expectedErrors.push(args[1].message)
        return
      }
      originalError(...args)
    }
    return {
      expectedErrors,
      restore: () => {
        console.error = originalError
      },
    }
  })
}

/** UI-only review fixtures run in the main process of a harness-isolated application. */
export async function mockImportReview(
  app: ElectronApplication,
  count = 61,
  alreadyImported: number[] = [],
) {
  return app.evaluateHandle(
    ({ ipcMain, BrowserWindow }, { count, alreadyImported }) => {
      const candidate = (index: number, selected: boolean): ImportCandidate => ({
        id: `candidate-${index}`,
        filename: `${String(index).padStart(2, '0')}.jpg`,
        relativePath: `${String(index).padStart(2, '0')}.jpg`,
        bytes: 1024,
        status: 'unchecked',
        selected,
        thumbnailState: 'idle',
        alreadyImported: alreadyImported.includes(index),
      })
      let candidates = Array.from({ length: count }, (_, index) => candidate(index, true))
      let phase: ImportReview['phase'] = 'scanning'
      let sessionId = ''
      let sessionCounter = 0
      let selectionRevision = 0
      let contentRevision = 0
      let thumbnailGeneration = 0
      let defaultSelected = true
      let sourceError: string | undefined
      let checkingPrevious: string | undefined
      let onlyMissing: boolean | undefined
      let verificationMode: ImportVerificationMode | undefined
      let verificationPending = false
      let holdModes = false
      let modeFailure = false
      let holdSelections = false
      let holdSnapshots = false
      let holdThumbnails = true
      let holdDevices = false
      let holdDisposals = false
      let deviceFailure = false
      let selectionActive = 0
      let selectionMaximum = 0
      let deviceActive = 0
      let deviceMaximum = 0
      let deviceCalls = 0
      const pendingSelections: (() => void)[] = []
      const pendingSnapshots: (() => void)[] = []
      const pendingThumbnails: (() => void)[] = []
      const pendingDevices: (() => void)[] = []
      const pendingDisposals: (() => void)[] = []
      const pendingModes: (() => void)[] = []
      const selections: { ids: string[] | null; selected: boolean }[] = []
      const thumbnails: { ids: string[]; requestedAt: number; sessionId: string }[] = []
      const accepted: string[][] = []
      const cancelled: string[] = []
      const disposed: string[] = []
      const deviceChoices: { id: string; entire: boolean }[] = []
      const deviceModes: boolean[] = []
      const modes: { sessionId: string; enabled: boolean }[] = []
      const verificationChoices: ImportVerificationMode[] = []
      const verifications: { sessionId: string; mode: ImportVerificationMode }[] = []
      const devices: ImportDevice[] = [
        {
          id: 'card-1',
          name: 'Camera card',
          capacityBytes: 64 * 1024 ** 3,
          available: true,
          volumeCount: 1,
        },
        {
          id: 'usb-1',
          name: 'External photos',
          capacityBytes: 256 * 1024 ** 3,
          available: false,
          volumeCount: 0,
        },
      ]
      const emit = () => {
        contentRevision++
        return BrowserWindow.getAllWindows().forEach((window) =>
          window.webContents.send('library:event', { sessionId }),
        )
      }
      const review = (offset: number): ImportReview => ({
        sessionId,
        source: 'Review fixture',
        sourceError,
        checkingPrevious,
        verificationMode,
        verificationPending,
        phase,
        candidates: candidates.slice(offset, offset + 60).map((item) => ({
          ...item,
          selected: item.selected && !(onlyMissing && item.alreadyImported),
        })),
        total: candidates.length,
        totalBytes: candidates.length * 1024,
        selected: candidates.filter(
          (item) => item.selected && !(onlyMissing && item.alreadyImported),
        ).length,
        selectedBytes:
          candidates.filter((item) => item.selected && !(onlyMissing && item.alreadyImported))
            .length * 1024,
        onlyMissing,
        alreadyImported: candidates.filter((item) => item.alreadyImported).length,
        alreadyImportedBytes: candidates.filter((item) => item.alreadyImported).length * 1024,
        orderingRevision: candidates.length,
        contentRevision,
        selectionRevision,
        unchecked: candidates.length,
        ready: 0,
        duplicates: 0,
        errors: 0,
        imported: 0,
        skipped: 0,
      })
      const replace = (channel: string, handler: Parameters<typeof ipcMain.handle>[1]) => {
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, handler)
      }
      const choose = (missing?: boolean, verification?: ImportVerificationMode) => {
        if (sessionId) {
          cancelled.push(sessionId)
          disposed.push(sessionId)
        }
        sessionId = `review-${++sessionCounter}`
        selectionRevision = 0
        thumbnailGeneration = 0
        sourceError = undefined
        checkingPrevious = undefined
        defaultSelected = true
        onlyMissing = missing
        verificationMode = verification
        verificationPending = false
        candidates = candidates.map((item) => ({ ...item, selected: true, thumbnailState: 'idle' }))
        return sessionId
      }
      replace('library:choose', () => choose())
      replace(
        'library:device',
        (
          _event,
          id: string,
          entire: boolean,
          missing = true,
          verification: ImportVerificationMode = 'camera-fast',
        ) => {
          deviceChoices.push({ id, entire })
          deviceModes.push(missing)
          verificationChoices.push(verification)
          return choose(missing, verification)
        },
      )
      replace('library:verification-mode', (_event, id: string, mode: ImportVerificationMode) => {
        verifications.push({ sessionId: id, mode })
        verificationMode = mode
        verificationPending = mode === 'full'
        checkingPrevious = verificationPending ? '00.jpg' : undefined
        candidates = candidates.map((item) => ({
          ...item,
          alreadyImported:
            mode === 'camera-fast' && alreadyImported.includes(Number(item.id.slice(10))),
        }))
        selectionRevision++
        emit()
      })
      replace('library:only-missing', async (_event, id: string, enabled: boolean) => {
        modes.push({ sessionId: id, enabled })
        if (holdModes) await new Promise<void>((resolve) => pendingModes.push(resolve))
        if (modeFailure) throw new Error('Fixture import option unavailable')
        onlyMissing = enabled
        selectionRevision++
        emit()
      })
      replace('review:summary', async () => {
        const { candidates: rows, ...snapshot } = review(0)
        void rows
        if (holdSnapshots) await new Promise<void>((resolve) => pendingSnapshots.push(resolve))
        return snapshot
      })
      replace('review:chunk', async (_event, _id: string, offset: number, revision: number) => {
        if (revision !== candidates.length) return { stale: true }
        const snapshot = review(offset)
        return {
          result: {
            sessionId,
            offset,
            orderingRevision: snapshot.orderingRevision,
            contentRevision: snapshot.contentRevision,
            selectionRevision: snapshot.selectionRevision,
            candidates: snapshot.candidates,
          },
        }
      })
      replace('review:locate', (_event, _id: string, id: string, revision: number) => {
        if (revision !== candidates.length) return { stale: true }
        const index = candidates.findIndex((c) => c.id === id)
        return {
          result:
            index < 0
              ? null
              : {
                  index,
                  orderingRevision: revision,
                  candidate: review(Math.floor(index / 60) * 60).candidates[index % 60],
                },
        }
      })
      replace('library:review', async (_event, _id: string, offset: number) => {
        const snapshot = review(offset)
        if (holdSnapshots) await new Promise<void>((resolve) => pendingSnapshots.push(resolve))
        return snapshot
      })
      replace(
        'library:select',
        async (_event, _id: string, ids: string[] | null, selected: boolean) => {
          selections.push({ ids, selected })
          selectionMaximum = Math.max(selectionMaximum, ++selectionActive)
          if (holdSelections) await new Promise<void>((resolve) => pendingSelections.push(resolve))
          if (ids === null) defaultSelected = selected
          candidates = candidates.map((item) =>
            (ids === null || ids.includes(item.id)) && !(onlyMissing && item.alreadyImported)
              ? { ...item, selected }
              : item,
          )
          selectionRevision++
          selectionActive--
          emit()
        },
      )
      replace(
        'library:thumbnails',
        async (_event, id: string, request: string[] | ReviewThumbnailRequest) => {
          const generation = Array.isArray(request) ? thumbnailGeneration + 1 : request.generation
          if (generation <= thumbnailGeneration) return
          thumbnailGeneration = generation
          const ids = Array.isArray(request) ? request : [...request.visible, ...request.lookahead]
          thumbnails.push({ ids: [...ids], requestedAt: Date.now(), sessionId: id })
          if (holdThumbnails) await new Promise<void>((resolve) => pendingThumbnails.push(resolve))
          if (id !== sessionId || generation !== thumbnailGeneration) return
          let changed = false
          candidates = candidates.map((item) => {
            if (!ids.includes(item.id) || item.thumbnailState === 'ready') return item
            changed = true
            return {
              ...item,
              thumbnailState: 'ready',
              thumbnailUrl:
                'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
            }
          })
          if (changed) emit()
        },
      )
      replace('library:import', () => {
        accepted.push(
          candidates
            .filter((item) => item.selected && !(onlyMissing && item.alreadyImported))
            .map((item) => item.id),
        )
      })
      replace('library:cancel', (_event, id: string) => {
        cancelled.push(id)
      })
      replace('library:dispose', async (_event, id: string) => {
        disposed.push(id)
        if (holdDisposals) await new Promise<void>((resolve) => pendingDisposals.push(resolve))
      })
      replace('library:devices', async () => {
        deviceCalls++
        deviceMaximum = Math.max(deviceMaximum, ++deviceActive)
        if (holdDevices) await new Promise<void>((resolve) => pendingDevices.push(resolve))
        deviceActive--
        return deviceFailure ? { error: 'Fixture discovery unavailable' } : { devices }
      })
      return {
        finishVerification: () => {
          verificationPending = false
          checkingPrevious = undefined
          candidates = candidates.map((item) => ({
            ...item,
            alreadyImported: alreadyImported.includes(Number(item.id.slice(10))),
          }))
          emit()
        },
        finish: () => {
          phase = 'review'
          checkingPrevious = undefined
          emit()
        },
        checkingPrevious: (filename?: string) => {
          checkingPrevious = filename
          emit()
        },
        append: (count: number) => {
          const offset = candidates.length
          candidates.push(
            ...Array.from({ length: count }, (_, index) =>
              candidate(offset + index, defaultSelected),
            ),
          )
          emit()
        },
        prepend: (count: number) => {
          const offset = candidates.length
          candidates = [
            ...Array.from({ length: count }, (_, index) =>
              candidate(offset + index, defaultSelected),
            ),
            ...candidates,
          ]
          emit()
        },
        holdSelections: () => {
          holdSelections = true
        },
        holdModes: () => {
          holdModes = true
        },
        releaseModes: () => {
          holdModes = false
          pendingModes.splice(0).forEach((release) => release())
        },
        failModes: (failure: boolean) => {
          modeFailure = failure
        },
        releaseSelections: () => {
          holdSelections = false
          pendingSelections.splice(0).forEach((release) => release())
        },
        holdSnapshots: () => {
          holdSnapshots = true
        },
        releaseSnapshots: () => {
          holdSnapshots = false
          pendingSnapshots.splice(0).forEach((release) => release())
        },
        releaseThumbnails: () => {
          holdThumbnails = false
          pendingThumbnails.splice(0).forEach((release) => release())
        },
        failThumbnail: (id: string) => {
          candidates = candidates.map((item) =>
            item.id === id
              ? {
                  ...item,
                  thumbnailState: 'error',
                  thumbnailMessage: 'No usable embedded thumbnail',
                }
              : item,
          )
          emit()
        },
        holdDevices: () => {
          holdDevices = true
        },
        releaseDevices: () => {
          holdDevices = false
          pendingDevices.splice(0).forEach((release) => release())
        },
        holdDisposals: () => {
          holdDisposals = true
        },
        releaseDisposals: () => {
          holdDisposals = false
          pendingDisposals.splice(0).forEach((release) => release())
        },
        failDevices: (fail: boolean) => {
          deviceFailure = fail
        },
        disconnect: () => {
          sourceError = 'Device disconnected. Restart the review to continue.'
          emit()
        },
        reconnect: () => {
          emit()
        },
        refresh: emit,
        state: () => ({
          selections,
          thumbnails,
          accepted,
          cancelled,
          disposed,
          deviceChoices,
          deviceModes,
          modes,
          verificationChoices,
          verifications,
          verificationMode,
          verificationPending,
          onlyMissing,
          selectionMaximum,
          deviceCalls,
          deviceMaximum,
          sessionId,
          pendingSnapshots: pendingSnapshots.length,
          pendingDisposals: pendingDisposals.length,
          pendingModes: pendingModes.length,
          selectedIds: candidates
            .filter((item) => item.selected && !(onlyMissing && item.alreadyImported))
            .map((item) => item.id),
        }),
        releaseAll: () => {
          holdSelections =
            holdSnapshots =
            holdThumbnails =
            holdDevices =
            holdDisposals =
            holdModes =
              false
          for (const pending of [
            pendingSelections,
            pendingSnapshots,
            pendingThumbnails,
            pendingDevices,
            pendingDisposals,
            pendingModes,
          ])
            pending.splice(0).forEach((release) => release())
        },
      }
    },
    { count, alreadyImported },
  )
}
