import { expect, test } from '@playwright/test'
import { runAgentQualityEvaluation } from '../scripts/agent-quality-evaluation.mjs'

// eslint-disable-next-line no-empty-pattern -- No browser fixture is needed; Playwright requires a destructured fixture argument.
test('authenticated six-photo evaluation retains evidence for human review', async ({}, info) => {
  // Explicit-only target. The value is a JSON runner-options object for a dedicated signed-in profile.
  const configured = process.env.IRODORI_AGENT_QUALITY_EVALUATION
  test.skip(
    !configured,
    'Set IRODORI_AGENT_QUALITY_EVALUATION explicitly; paid model evaluation is incomplete.',
  )
  test.setTimeout(3_000_000)
  const options = JSON.parse(configured!)
  expect(options.allowModelCalls).toBe(true)
  const result = await runAgentQualityEvaluation(options)
  await info.attach('evaluation-report', {
    path: `${result.output}/report.json`,
    contentType: 'application/json',
  })
  expect(result.report.status, result.report.error).toBe('review-required')
  expect(result.report.scenarios).toHaveLength(6)
  test.skip(true, `Photographic review remains required: ${result.output}/gallery.html`)
})
