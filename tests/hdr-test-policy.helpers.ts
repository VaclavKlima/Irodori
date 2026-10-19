import { expect, type Page } from '@playwright/test'
import { ACES_INTERACTIVE_PREVIEW_VERSION } from '../src/shared/aces-preview-wgsl'
import { sustainedEditorInput } from './mac-workability.helpers'

// Keep the reference control explicit until production adopts a different default.
const precision = process.env.VITE_LUMA_HDR_INTERACTIVE_PRECISION ?? 'reference'
if (precision !== 'reference' && precision !== 'f32')
  throw new Error('VITE_LUMA_HDR_INTERACTIVE_PRECISION must be reference or f32.')
export const hdrTestPolicy = {
  precision,
  interactivePolicy: precision === 'f32' ? ACES_INTERACTIVE_PREVIEW_VERSION : 'reference',
} as const

export async function expectReferenceHdrPreview(page: Page) {
  const canvas = page.getByTestId('main-preview')
  await expect(canvas).toHaveAttribute('data-interactive-policy', hdrTestPolicy.interactivePolicy)
  await expect(canvas).toHaveAttribute('data-quality', 'normal')
  await expect(canvas).toHaveAttribute('data-presented-policy', 'reference')
  await expect(canvas).toHaveAttribute('data-gesturing', 'false')
  await expect
    .poll(() =>
      canvas.evaluate(
        (element) =>
          !!element.dataset.requestedSerial &&
          element.dataset.completedEditSerial === element.dataset.requestedSerial,
      ),
    )
    .toBe(true)
}

export async function expectActiveHdrPreview(page: Page) {
  const canvas = page.getByTestId('main-preview')
  await expect(canvas).toHaveAttribute('data-interactive-policy', hdrTestPolicy.interactivePolicy)
  await expect(canvas).toHaveAttribute('data-gesturing', 'true')
  await expect(canvas).toHaveAttribute('data-comparison', 'after')
  await expect(canvas).toHaveAttribute(
    'data-quality',
    precision === 'f32' ? 'interactive' : 'normal',
  )
  await expect(canvas).toHaveAttribute('data-presented-policy', hdrTestPolicy.interactivePolicy)
}

/** Preserve the original driver and its timing boundaries; inspect policy after the trial ends. */
export async function policyEditorInput(
  page: Page,
  options: Parameters<typeof sustainedEditorInput>[1],
) {
  const trial = await sustainedEditorInput(page, options)
  const final = await page.getByTestId('main-preview').evaluate((element) => ({
    quality: element.dataset.quality,
    presentedPolicy: element.dataset.presentedPolicy,
    previewPolicy: element.dataset.interactivePolicy,
    gesturing: element.dataset.gesturing,
    requestedSerial: element.dataset.requestedSerial,
    completedSerial: element.dataset.completedEditSerial,
  }))
  return {
    ...trial,
    policy: {
      expected: hdrTestPolicy,
      capabilityMismatches: trial.presentations.filter(
        (frame) => frame.previewPolicy !== hdrTestPolicy.interactivePolicy,
      ).length,
      invalidPresentations: trial.presentations.filter((frame) =>
        frame.quality === 'normal'
          ? frame.presentedPolicy !== 'reference'
          : frame.quality !== 'interactive' ||
            precision !== 'f32' ||
            frame.presentedPolicy !== ACES_INTERACTIVE_PREVIEW_VERSION,
      ).length,
      final,
    },
  }
}

export function expectHdrTrialPolicy(
  trial: Awaited<ReturnType<typeof policyEditorInput>> | undefined,
  context: string,
) {
  expect.soft(trial, context).toBeDefined()
  if (!trial) return
  expect.soft(trial.sharp + trial.interactive, context).toBe(trial.completed)
  expect.soft(trial.policy.capabilityMismatches, context).toBe(0)
  expect.soft(trial.policy.invalidPresentations, context).toBe(0)
  if (precision === 'f32') expect.soft(trial.interactive, context).toBeGreaterThan(0)
  else expect.soft(trial.interactive, context).toBe(0)
  expect.soft(trial.policy.final, context).toMatchObject({
    quality: 'normal',
    presentedPolicy: 'reference',
    previewPolicy: hdrTestPolicy.interactivePolicy,
    gesturing: 'false',
  })
  expect.soft(trial.policy.final.requestedSerial, context).toBeTruthy()
  expect.soft(trial.policy.final.completedSerial, context).toBe(trial.policy.final.requestedSerial)
}
