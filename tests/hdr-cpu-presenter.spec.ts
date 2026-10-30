import { expect, test } from '@playwright/test'
import { HdrCpuPresenter } from '../src/renderer/src/preview/hdr-cpu-presenter'
import {
  neutralAdjustments,
  srgbTransform,
  type AdjustmentParameters,
  type WorkingFrame,
} from '../src/shared/adjustments'
import { HDR_SOURCE_VERSION, type HdrWorkingAsset } from '../src/shared/hdr'

interface Request {
  asset: HdrWorkingAsset
  beforeAsset?: HdrWorkingAsset
  generation: number
  parameters: AdjustmentParameters
  hdrRanges: boolean
}

function source(identity: string, width = 64, height = 64): WorkingFrame {
  const byteLength = width * height * 16,
    sha256 = identity.repeat(64)
  return {
    identity,
    width,
    height,
    data: new Float32Array(),
    transform: srgbTransform,
    hdr: {
      kind: 'hdr-working-v1',
      url: `test:${identity}`,
      width,
      height,
      byteLength,
      sha256,
      strips: [{ byteLength, sha256 }],
      source: {
        version: HDR_SOURCE_VERSION,
        processing: 'hdr-v1',
        colorSpace: 'rec2020',
        whitePoint: 'D65',
        transfer: 'linear',
        alpha: 'straight',
        decoder: 'synthetic-lifecycle',
        cameraProfile: 'synthetic-lifecycle',
        orientation: 'applied-once',
        normalization: {
          black: [0, 0, 0, 0],
          maximum: 1,
          gains: [1, 1, 1, 1],
          restoreGain: 1,
          referenceWhite: 1,
          sourceSaturation: null,
        },
      },
    },
  }
}

function fixture(
  work: (value: {
    presenter: HdrCpuPresenter
    requests: Request[]
    reply: (request: Request, name: string, draft?: boolean) => void
    canvas: HTMLCanvasElement
    drawn: string[]
    closed: string[]
    state: { loaded: number; failed: number; activity: number; terminated: boolean }
  }) => void,
) {
  const workerDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Worker'),
    dprDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'devicePixelRatio'),
    requests: Request[] = [],
    drawn: string[] = [],
    closed: string[] = [],
    state = { loaded: 0, failed: 0, activity: 0, terminated: false }
  let receive: ((event: { data: unknown }) => void) | undefined
  class FakeWorker {
    set onmessage(value: (event: { data: unknown }) => void) {
      receive = value
    }
    onerror?: () => void
    postMessage(request: Request) {
      requests.push(request)
    }
    terminate() {
      state.terminated = true
    }
  }
  const context = {
    scale: () => undefined,
    clearRect: () => undefined,
    drawImage: (bitmap: { name: string }) => drawn.push(bitmap.name),
    imageSmoothingEnabled: false,
  }
  const canvas = {
    dataset: {
      editing: 'ready',
      quality: 'normal',
      exposure: '4',
      whiteBalance: 'old',
      comparison: 'before',
      hdrRanges: 'true',
    },
    style: { visibility: 'visible' },
    width: 64,
    height: 64,
    getContext: () => context,
  } as unknown as HTMLCanvasElement
  Object.defineProperty(globalThis, 'Worker', {
    configurable: true,
    writable: true,
    value: FakeWorker,
  })
  Object.defineProperty(globalThis, 'devicePixelRatio', { configurable: true, value: 2 })
  let presenter: HdrCpuPresenter | undefined
  try {
    presenter = new HdrCpuPresenter(
      canvas,
      () => state.loaded++,
      () => state.failed++,
      () => {
        state.activity++
        let released = false
        return () => {
          if (!released) {
            released = true
            state.activity--
          }
        }
      },
      Promise.resolve(),
      () => 'javascript',
    )
    work({
      presenter,
      requests,
      canvas,
      drawn,
      closed,
      state,
      reply: (request, name, draft = false) => {
        const bitmap = (suffix: string) => ({
          name: `${name}-${suffix}`,
          close: () => closed.push(`${name}-${suffix}`),
        })
        receive!({
          data: {
            generation: request.generation,
            parameters: request.parameters,
            hdrRanges: request.hdrRanges,
            draft,
            bitmap: bitmap('after'),
            neutral: bitmap('before'),
            beforeSha256: request.beforeAsset?.sha256,
            beforeSample: request.beforeAsset ? new Float32Array([0.1, 0.2, 0.3, 1]) : undefined,
            beforeDraftSample: request.beforeAsset
              ? new Float32Array([0.1, 0.2, 0.3, 1])
              : undefined,
          },
        })
      },
    })
  } finally {
    presenter?.dispose()
    if (workerDescriptor) Object.defineProperty(globalThis, 'Worker', workerDescriptor)
    else Reflect.deleteProperty(globalThis, 'Worker')
    if (dprDescriptor) Object.defineProperty(globalThis, 'devicePixelRatio', dprDescriptor)
    else Reflect.deleteProperty(globalThis, 'devicePixelRatio')
  }
  expect(state.failed).toBe(0)
  expect(state.activity).toBe(0)
  expect(state.terminated).toBe(true)
  expect(new Set(closed).size).toBe(closed.length)
}

const viewport = { width: 64, height: 64 },
  view = { fit: false, scale: 1, x: 0, y: 0 }

test('CPU comparison sources invalidate pixels and stale replies independently of point edits', () => {
  fixture(({ presenter, requests, reply, canvas, drawn, closed }) => {
    const after = source('a'),
      before = source('b'),
      replaced = { ...source('c'), identity: before.identity }
    presenter.setWorking(after)
    presenter.setComparison('before', 0.5)
    presenter.setComparisonSource(null, true)
    presenter.draw(after, viewport, view, neutralAdjustments)
    expect(requests).toHaveLength(0)
    presenter.setComparisonSource(before)
    expect(requests).toHaveLength(1)
    expect(requests[0].beforeAsset?.sha256).toBe(before.hdr!.sha256)
    reply(requests[0], 'first')
    expect(drawn).toEqual(['first-before'])
    expect(canvas.dataset.presentedBeforeSourceSha256).toBe(before.hdr!.sha256)
    presenter.setComparisonSource(replaced)
    expect(canvas.style.visibility).toBe('hidden')
    expect(canvas.dataset.presentedBeforeSourceSha256).toBeUndefined()
    expect(closed).toEqual(['first-after', 'first-before'])
    expect(requests[1].beforeAsset?.sha256).toBe(replaced.hdr!.sha256)
    reply(requests[0], 'stale')
    expect(drawn).toEqual(['first-before'])
    reply(requests[1], 'replacement')
    expect(drawn).toEqual(['first-before', 'replacement-before'])
    expect(canvas.dataset.presentedBeforeSourceSha256).toBe(replaced.hdr!.sha256)
    presenter.setComparisonSource({ ...after })
    expect(requests[2].beforeAsset).toBeUndefined()
    reply(requests[2], 'alias')
    expect(drawn.at(-1)).toBe('alias-before')
    expect(canvas.dataset.presentedBeforeSourceSha256).toBeUndefined()
  })
})

test('a required missing Before hides an ordinary completed neutral pair until its own source arrives', () => {
  fixture(({ presenter, requests, reply, canvas, drawn }) => {
    const after = source('a')
    presenter.setWorking(after)
    presenter.setComparisonSource(null, true)
    presenter.draw(after, viewport, view, neutralAdjustments)
    reply(requests[0], 'after-only')
    expect(drawn).toEqual(['after-only-after'])
    presenter.setComparison('before', 0.5)
    presenter.draw(after, viewport, view, neutralAdjustments)
    expect(canvas.style.visibility).toBe('hidden')
    expect(drawn).toEqual(['after-only-after'])
    expect(() => presenter.setComparisonSource(source('b', 65, 64))).toThrow('match')
    expect(requests).toHaveLength(1)
    presenter.setComparisonSource(source('b'))
    reply(requests[1], 'original')
    expect(drawn.at(-1)).toBe('original-before')
    expect(canvas.style.visibility).toBe('visible')
  })
})

test('CPU first pixels wait for confirmation, reject superseded replies and refine the same request to full quality', () => {
  fixture(({ presenter, requests, reply, canvas, drawn, closed, state }) => {
    expect(canvas.dataset.editing).toBeUndefined()
    expect(canvas.dataset.quality).toBeUndefined()
    expect(canvas.style.visibility).toBe('hidden')
    const first = source('a')
    presenter.setPresentationState(null)
    presenter.setWorking(first)
    presenter.draw(first, viewport, view, neutralAdjustments)
    expect(requests).toHaveLength(0)
    expect(drawn).toEqual([])
    expect(state.loaded).toBe(0)
    presenter.setPresentationState({ revision: 1, settings: neutralAdjustments })
    presenter.draw(first, viewport, view, neutralAdjustments)
    expect(requests).toHaveLength(1)
    presenter.setPresentationState(null)
    reply(requests[0], 'unconfirmed')
    expect(closed).toEqual(['unconfirmed-after', 'unconfirmed-before'])
    expect(drawn).toEqual([])
    expect(state.loaded).toBe(0)
    presenter.setPresentationState({ revision: 1, settings: neutralAdjustments })
    presenter.draw(first, viewport, view, neutralAdjustments)
    expect(requests).toHaveLength(2)
    reply(requests[1], 'draft', true)
    expect(drawn).toEqual(['draft-after'])
    expect(canvas.dataset.quality).toBe('draft')
    expect(canvas.dataset.editing).toBe('ready')
    expect(state.loaded).toBe(1)
    reply(requests[1], 'full')
    expect(drawn).toEqual(['draft-after', 'full-after'])
    expect(canvas.dataset.quality).toBe('normal')
    expect(state.loaded).toBe(2)
    expect(requests).toHaveLength(2)
    expect(closed).toContain('draft-after')
    expect(closed).toContain('draft-before')
  })
})

test('a changed corrected source retires old bitmaps and native authority before accepting fresh confirmed output', () => {
  fixture(({ presenter, requests, reply, canvas, drawn, closed, state }) => {
    const first = source('a'),
      second = source('b', 96, 48),
      changed = { ...neutralAdjustments, exposureEv: 2 }
    presenter.setPresentationState({ revision: 1, settings: neutralAdjustments })
    presenter.setWorking(first)
    presenter.draw(first, viewport, view, neutralAdjustments)
    reply(requests[0], 'first')
    expect(drawn).toEqual(['first-after'])
    expect(state.loaded).toBe(1)
    presenter.setPresentationState(null)
    presenter.setWorking(second)
    expect(closed).toEqual(['first-after', 'first-before'])
    expect(canvas.dataset.editing).toBeUndefined()
    expect(canvas.dataset.quality).toBeUndefined()
    expect(canvas.style.visibility).toBe('hidden')
    presenter.draw(second, viewport, view, neutralAdjustments)
    reply(requests[0], 'late-first')
    expect(requests).toHaveLength(1)
    expect(drawn).toEqual(['first-after'])
    expect(state.loaded).toBe(1)
    presenter.setPresentationState({ revision: 2, settings: changed })
    presenter.draw(second, viewport, view, neutralAdjustments)
    expect(requests).toHaveLength(1)
    presenter.draw(second, viewport, view, changed)
    expect(requests).toHaveLength(2)
    expect(requests[1].asset.sha256).toBe(second.hdr!.sha256)
    expect(requests[1].generation).toBeGreaterThan(requests[0].generation)
    reply(requests[0], 'late-again')
    expect(drawn).toEqual(['first-after'])
    reply(requests[1], 'second')
    expect(drawn).toEqual(['first-after', 'second-after'])
    expect(state.loaded).toBe(2)
    expect(canvas.dataset.exposure).toBe('2')
    expect(canvas.dataset.quality).toBe('normal')
    expect(canvas.style.visibility).toBe('visible')
    presenter.setWorking({ ...second })
    presenter.draw(second, viewport, view, changed)
    expect(requests).toHaveLength(2)
    expect(canvas.dataset.editing).toBe('ready')
  })
})
