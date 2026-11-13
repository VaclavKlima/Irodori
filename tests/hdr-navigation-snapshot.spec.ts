import { expect, test } from '@playwright/test'
import { HdrPresenter } from '../src/renderer/src/preview/hdr-presenter'
import { HdrEditQueue } from '../src/renderer/src/preview/hdr-edit-queue'
import { neutralAdjustments, type AdjustmentParameters } from '../src/shared/adjustments'
import { SDR_TARGET } from '../src/shared/hdr'

test('navigation reuses one detached parameter snapshot and actual input changes replace it', () => {
  const queue = new HdrEditQueue<{ parameters: AdjustmentParameters }>()
  // Control only request capture here; actual GPU/source/history ownership is
  // exercised by masked-navigation-ui and masked-preview-confirmation-ui.
  const owner = Object.assign(Object.create(HdrPresenter.prototype), {
    queue,
    canvas: { dataset: {} },
    target: SDR_TARGET,
    frame: { identity: 'source' },
    device: {},
    context: {},
    ready: true,
    renderingGeneration: 0,
    previewPolicy: { presentationCache: false },
    mode: 'after',
    inputSerial: 0,
    epoch: 1,
    checkFirstSurfaceIdentity: () => {},
    checkCachedIdentity: () => {},
    invalidate: () => queue.invalidate(),
    run: () => Promise.resolve(),
  }) as { draw: HdrPresenter['draw'] }
  const parameters: AdjustmentParameters = { ...neutralAdjustments, exposureEv: 0.5 }
  const submit = (input: AdjustmentParameters, x: number) => {
    owner.draw(
      { width: 8, height: 6 },
      { width: 4, height: 3 },
      { fit: false, scale: 1, x, y: 0 },
      input,
    )
    const request = queue.take()!
    expect(queue.finish(request)).toBe(true)
    return request.value.parameters
  }
  const first = submit(parameters, 0)
  expect(first).not.toBe(parameters)
  for (let x = 1; x < 8; x++) expect(submit(parameters, x)).toBe(first)
  parameters.exposureEv = 0.75
  const changed = submit(parameters, 9)
  expect(changed).not.toBe(first)
  expect(first.exposureEv).toBe(0.5)
  expect(changed.exposureEv).toBe(0.75)
  // New immutable objects can carry freshly prepared planes at unchanged edit
  // values. They must receive a new detached snapshot, even with the same key.
  const replacement = { ...parameters }
  const refreshed = submit(replacement, 10)
  expect(refreshed).not.toBe(changed)
  expect(refreshed).not.toBe(replacement)
  replacement.exposureEv = 1
  expect(refreshed.exposureEv).toBe(0.75)
})
