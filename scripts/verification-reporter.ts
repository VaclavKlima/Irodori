import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import type {
  FullConfig,
  FullResult,
  Reporter,
  TestCase,
  TestResult,
  TestError,
} from '@playwright/test/reporter'
import { suites } from './verification-plan'
import type { CaseResult, BenchmarkRecord } from './verification-types'
import { testUiMode } from './test-ui-mode.mjs'

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const regex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const concise = (message: string) =>
  message
    .replaceAll(String.fromCharCode(27), '')
    .replace(/\[[0-9;]*m/g, '')
    .slice(0, 1600)

export default class VerificationReporter implements Reporter {
  private counts = { passed: 0, failed: 0, skipped: 0, interrupted: 0 }
  private tests: CaseResult[] = []
  private errors: string[] = []
  private workers = 0
  private uiMode = testUiMode()
  constructor(private options: { outputDir: string }) {}
  onBegin(config: FullConfig) {
    this.workers = config.workers
  }
  onError(error: TestError) {
    this.errors.push(concise(error.message ?? String(error)))
  }
  onTestEnd(test: TestCase, result: TestResult) {
    const status =
      result.status === 'skipped' || result.status === 'interrupted'
        ? result.status
        : result.status === test.expectedStatus
          ? 'passed'
          : 'failed'
    this.counts[status]++
    let fileSuite = test.parent
    while (fileSuite.parent && fileSuite.type !== 'file') fileSuite = fileSuite.parent
    const suiteFile = fileSuite.location?.file ?? test.location.file
    const suite = suites.find((suite) => suiteFile.endsWith(suite.file))
    if (!suite) {
      this.errors.push(`Unregistered suite: ${suiteFile}. Case: ${test.title}`)
      return
    }
    const project = test.parent.project()!.name
    const benchmarks: BenchmarkRecord[] = []
    for (const attachment of result.attachments.filter((a) => a.name.startsWith('benchmark:'))) {
      try {
        benchmarks.push(
          JSON.parse(attachment.body?.toString() ?? readFileSync(attachment.path!, 'utf8')),
        )
      } catch (error) {
        this.errors.push(`Invalid benchmark attachment: ${String(error)}`)
      }
    }
    const benchmark = project === 'benchmark'
    const prefix = benchmark
      ? `LUMA_PREVIEW_BENCHMARK=1 LUMA_TEST_TRACE=0 ${process.env.LUMA_PREVIEW_BASELINE ? `LUMA_PREVIEW_BASELINE=${quote(process.env.LUMA_PREVIEW_BASELINE)} ` : ''}`
      : ''
    // Playwright appends tags to the title matched by --grep.
    const pattern = `${regex(test.titlePath().slice(3).join(' ') || test.title)}(?: @\\S+)*$`
    const command = `${prefix}npx playwright test --project=${project} ${quote(suite.file)} --workers=${benchmark || suite.exclusive || project === 'raw-gpu' ? 1 : 2} --grep ${quote(pattern)}`
    const requiresForeground = test.annotations.some((a) => a.type === 'requires-foreground')
    this.tests.push({
      target: suite.target,
      title: test.title,
      file: suite.file,
      definitionFile: relative(process.cwd(), test.location.file),
      line: test.location.line,
      status,
      durationMs: result.duration,
      worker: result.workerIndex,
      errors: result.errors.map((e) => concise(e.message ?? String(e))),
      annotations: test.annotations,
      evidence: result.attachments.flatMap((a) => (a.path ? [a.path] : [])),
      rerun: `LUMA_TEST_UI_MODE=${this.uiMode} ${command}`,
      ...(status === 'skipped' && this.uiMode === 'background' && requiresForeground
        ? { foregroundRerun: `LUMA_TEST_UI_MODE=foreground ${command}` }
        : {}),
      benchmarks,
    })
  }
  onEnd(result: FullResult) {
    mkdirSync(this.options.outputDir, { recursive: true })
    writeFileSync(
      join(this.options.outputDir, 'summary.json'),
      JSON.stringify(
        {
          ...this.counts,
          uiMode: this.uiMode,
          status: result.status,
          durationMs: result.duration,
          workers: this.workers,
          tests: this.tests,
          errors: this.errors,
        },
        null,
        2,
      ),
    )
  }
}
