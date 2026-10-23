import { expect, test, type Page } from '@playwright/test'
import { selectEditorPreviewPolicy } from '../src/shared/editor-preview-policy'
import {
  ACES_INTERACTIVE_PREVIEW_VERSION,
  selectInteractivePreviewPolicy,
} from '../src/shared/interactive-preview-policy'
import { sustainedEditorInput } from './mac-workability.helpers'

export const editorTestPreviewPolicy = selectEditorPreviewPolicy(process.platform)
const precision = editorTestPreviewPolicy.interactivePrecision
export const hdrTestPolicy = {
  precision,
  interactivePolicy: precision === 'f32' ? ACES_INTERACTIVE_PREVIEW_VERSION : 'reference',
  arithmeticPolicies: {
    sdr: selectInteractivePreviewPolicy(precision, 'sdr'),
    hdr: selectInteractivePreviewPolicy(precision, 'hdr'),
  },
} as const

/** Feature-only UI suites use the actual app platform; no build selector can enable them. */
export async function requireEditorPreviewFeature(
  page: Page,
  feature: 'interactive' | 'presentation-cache',
) {
  const info = await page.evaluate(() => window.luma.getAppInfo())
  expect(info.platform, 'The app and test process must use the same platform policy.').toBe(
    process.platform,
  )
  const policy = selectEditorPreviewPolicy(info.platform)
  test.skip(
    feature === 'interactive' ? policy.interactivePrecision !== 'f32' : !policy.presentationCache,
    `The ordinary ${info.platform} policy does not yet enable ${feature}; separate platform verification is incomplete.`,
  )
  return policy
}

async function expectArithmeticPolicy(page: Page, interactive: boolean) {
  const canvas = page.getByTestId('main-preview')
  const target = await page.evaluate(() => window.luma.getDisplayState())
  await expect(canvas).toHaveAttribute('data-target-generation', String(target.generation))
  await expect(canvas).toHaveAttribute(
    'data-presented-arithmetic-policy',
    interactive ? selectInteractivePreviewPolicy(precision, target.mode) : 'reference',
  )
  const ranges = (await canvas.getAttribute('data-hdr-ranges')) === 'true'
  await expect(canvas).toHaveAttribute(
    'data-range-arithmetic-policy',
    target.mode === 'sdr' && ranges
      ? interactive
        ? selectInteractivePreviewPolicy(precision, 'hdr')
        : 'reference'
      : '',
  )
}

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
  await expectArithmeticPolicy(page, false)
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
  await expectArithmeticPolicy(page, precision === 'f32')
}

/** Preserve the original driver and its timing boundaries; inspect policy after the trial ends. */
export async function policyEditorInput(
  page: Page,
  options: Parameters<typeof sustainedEditorInput>[1],
) {
  const trial = await sustainedEditorInput(page, options)
  const final = await page.getByTestId('main-preview').evaluate(async (element) => ({
    target: await window.luma.getDisplayState(),
    quality: element.dataset.quality,
    presentedPolicy: element.dataset.presentedPolicy,
    presentedArithmeticPolicy: element.dataset.presentedArithmeticPolicy,
    rangeArithmeticPolicy: element.dataset.rangeArithmeticPolicy,
    hdrRanges: element.dataset.hdrRanges === 'true',
    targetGeneration: Number(element.dataset.targetGeneration),
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
    presentedArithmeticPolicy: 'reference',
    previewPolicy: hdrTestPolicy.interactivePolicy,
    gesturing: 'false',
  })
  expect
    .soft(trial.policy.final.targetGeneration, context)
    .toBe(trial.policy.final.target.generation)
  expect
    .soft(trial.policy.final.rangeArithmeticPolicy, context)
    .toBe(
      trial.policy.final.target.mode === 'sdr' && trial.policy.final.hdrRanges ? 'reference' : '',
    )
  expect.soft(trial.policy.final.requestedSerial, context).toBeTruthy()
  expect.soft(trial.policy.final.completedSerial, context).toBe(trial.policy.final.requestedSerial)
}
