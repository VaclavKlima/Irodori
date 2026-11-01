import { relative } from 'node:path'

export const SUMMARY_MAX_BYTES = 4096

// Bound individual descriptions before assembling blocks; never slice Markdown or commands.
function compact(value, limit = 160) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .replaceAll('`', "'")
    .replaceAll('|', '/')
    .replace(/[<>[\]]/g, '')
  if (Buffer.byteLength(text, 'utf8') <= limit) return text
  let shortened = ''
  for (const character of text) {
    if (Buffer.byteLength(shortened + character, 'utf8') > limit - 3) break
    shortened += character
  }
  return shortened + '...'
}

function fenced(text, language) {
  let length = 3
  for (const match of text.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1)
  const fence = '`'.repeat(length)
  return `${fence}${language}\n${text}\n${fence}`
}

export function renderSummary(result) {
  const failures = result.tests.filter((t) => ['failed', 'interrupted'].includes(t.status))
  const failedStages = result.stages.filter((s) => ['failed', 'interrupted'].includes(s.status))
  const skipped = result.tests.filter((t) => t.status === 'skipped')
  const footer =
    '\n\nFull diagnostics, additional issues and shortened or omitted fields are retained in ' +
    '[details.md](details.md). Full structured evidence: [result.json](result.json). ' +
    'Local evidence only; platform/display limitations are in details.\n'
  const lines = []
  let bytes = Buffer.byteLength(footer, 'utf8')
  const add = (block) => {
    const size = Buffer.byteLength(block, 'utf8') + (lines.length ? 2 : 0)
    if (bytes + size > SUMMARY_MAX_BYTES) return false
    lines.push(block)
    bytes += size
    return true
  }
  const requested = result.plan.requestedTargets
  const selection = requested
    .slice(0, 3)
    .map((t) => compact(t, 48))
    .join(', ')
  const stages = ['passed', 'failed', 'blocked', 'skipped', 'interrupted', 'incomplete']
    .map((status) => `${result.stages.filter((s) => s.status === status).length} ${status}`)
    .join(', ')
  const git = result.runtime.git ?? {}
  add(`# Verification: ${result.status.toUpperCase()}`)
  add(
    `${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped, ${result.interrupted} interrupted; ${(result.durationMs / 1000).toFixed(2)} s; exit ${result.exitCode}.`,
  )
  add(
    `Selection: \`${compact(result.scope, 96)}\`. Requested targets (${requested.length}): ${selection || '(command/scopes)'}${requested.length > 3 ? `; ${requested.length - 3} more in details` : ''}. Selected targets including cheap checks: ${result.targets.length}.`,
  )
  add(
    `UI mode: \`${compact(result.uiMode, 24)}\`. Baseline: \`${compact(result.baseline.status, 24)}\`.`,
  )
  add(
    `Revision: \`${compact(git.revision ?? 'unknown', 48)}\`; dirty: ${compact(git.dirty ?? 'unknown', 16)}. Platform: ${compact(result.runtime.platform ?? 'unknown', 24)}.`,
  )
  add(`Stages: ${stages}.`)
  add(
    `Issues: ${failures.length} failed/interrupted cases; ${failedStages.length} failed/interrupted stages; ${result.incomplete.length} incomplete reasons; ${skipped.length} skipped cases; ${result.warnings.length} warnings. Benchmark records: ${result.benchmarks.length}.`,
  )

  const test = failures[0] ?? skipped[0]
  const stage = failures.length ? undefined : failedStages[0]
  const issue = failures[0] ?? stage ?? test
  const reason = issue
    ? (issue.errors?.[0] ??
      issue.error ??
      issue.reason ??
      issue.annotations?.find((a) => a.type === 'skip')?.description ??
      'See detailed evidence.')
    : (result.incomplete[0] ?? result.warnings[0])
  const section =
    failures.length || stage
      ? 'failures-and-exact-reruns'
      : skipped.length
        ? 'skipped-cases'
        : 'incomplete-verification-and-budget-warnings'
  if (reason !== undefined) {
    const label = issue
      ? `${issue.target ?? issue.name}: ${issue.title ?? issue.status}`
      : 'Verification'
    add(`## First issue\n\n${compact(label, 160)}\n\n${compact(reason, 240)}`)
    const rerun = issue?.foregroundRerun ?? issue?.rerun
    if (!rerun || !add(`Next action — exact rerun:\n\n${fenced(rerun, 'sh')}`))
      add(
        `Next action: [inspect this issue${rerun ? ' and its exact rerun' : ''} in details](details.md#${section}).`,
      )
  } else {
    add(
      'Selected verification completed. Read additional evidence only for a concrete unresolved concern.',
    )
  }
  const rows = result.stages
    .slice(0, 8)
    .map((s) => `| ${compact(s.name, 48)} | ${s.status} | ${(s.durationMs / 1000).toFixed(2)} s |`)
  add(
    `## Stage outcomes\n\n| Stage | Outcome | Duration |\n| --- | --- | ---: |\n${rows.join('\n')}\n\n${Math.min(8, result.stages.length)} of ${result.stages.length} stages listed; all stage outcomes and logs are in details.`,
  )
  return lines.join('\n\n') + footer
}

// Full diagnostics remain opt-in; measurements themselves stay in structured artifacts.
export function renderDetails(result) {
  const link = (path, label = relative(result.artifacts, path)) =>
    `[${label}](${relative(result.artifacts, path).replaceAll(' ', '%20')})`
  const seconds = (ms) => `${(ms / 1000).toFixed(2)} s`
  const lines = [
    `# Verification details: ${result.status.toUpperCase()}`,
    '',
    `${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped, ${result.interrupted} interrupted; ${seconds(result.durationMs)}; exit ${result.exitCode}.`,
    '',
    'Read [summary.md](summary.md) first. Full structured evidence: [result.json](result.json).',
    '',
    `Selection: \`${result.scope}\`. Requested targets: ${result.plan.requestedTargets.join(', ') || '(command/scopes)'}.`,
    `UI mode: \`${result.uiMode}\`.`,
    `Selected targets (including cheap checks): ${result.targets.join(', ')}.`,
    '',
    '## Stages',
    '',
    '| Stage | Outcome | Duration | Workers | Evidence |',
    '| --- | --- | ---: | ---: | --- |',
    ...result.stages.map(
      (s) =>
        `| ${s.name} | ${s.status}${s.code ? ` (${s.code})` : ''} | ${seconds(s.durationMs)} | ${s.workers || '—'} | ${link(s.log)} |`,
    ),
    '',
  ]
  for (const stage of result.stages.filter((s) =>
    ['blocked', 'skipped', 'incomplete'].includes(s.status),
  ))
    lines.push(
      `- ${stage.name}: ${stage.reason ?? 'See incomplete verification below.'} Targets: ${stage.targets.join(', ') || '(prerequisite)'}.`,
    )
  if (result.incomplete.length || result.warnings.length)
    lines.push(
      '',
      '## Incomplete verification and budget warnings',
      '',
      ...[...result.incomplete, ...result.warnings].map((s) => `- ${s}`),
    )
  const failures = result.tests.filter((t) => t.status === 'failed' || t.status === 'interrupted')
  const skipped = result.tests.filter((t) => t.status === 'skipped')
  if (failures.length || result.stages.some((s) => ['failed', 'interrupted'].includes(s.status))) {
    lines.push(
      '',
      '## Failures and exact reruns',
      '',
      'Rerun failed cases first. These case commands reuse the existing build; rebuild only after application changes.',
      '',
    )
    for (const test of failures) {
      lines.push(
        `### ${test.target}: ${test.title}`,
        '',
        `\`${test.definitionFile ?? test.file}:${test.line}\`; ${seconds(test.durationMs)}.`,
        '',
        fenced(test.errors.join('\n'), 'text'),
        '',
        fenced(test.rerun, 'sh'),
        '',
      )
      if (test.evidence.length) lines.push(test.evidence.map((p) => link(p)).join(' · '), '')
    }
    for (const stage of result.stages.filter((s) => ['failed', 'interrupted'].includes(s.status))) {
      lines.push(
        `Stage ${stage.name}: ${link(stage.log)}.`,
        '',
        fenced(stage.error ?? 'See stage log.', 'text'),
        '',
      )
      lines.push(fenced(stage.rerun, 'sh'), '')
    }
  }
  if (skipped.length)
    lines.push(
      '',
      '## Skipped cases',
      '',
      ...skipped.flatMap((t) => [
        `- ${t.target}: ${t.title}. ${
          t.annotations
            .filter((a) => a.type === 'skip')
            .map((a) => a.description)
            .join('; ') || 'No reason supplied.'
        }`,
        '',
        ...(t.evidence.length ? [t.evidence.map((path) => link(path)).join(' · '), ''] : []),
        fenced(t.foregroundRerun ?? t.rerun, 'sh'),
        '',
      ]),
    )
  lines.push(
    '',
    '## Ten slowest tests',
    '',
    '| Target / case | Duration | Outcome |',
    '| --- | ---: | --- |',
    ...[...result.tests]
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, 10)
      .map(
        (t) =>
          `| ${t.target}: ${t.title.replaceAll('|', '\\|')} | ${seconds(t.durationMs)} | ${t.status} |`,
      ),
  )
  if (result.benchmarks.length) {
    lines.push(
      '',
      '## Benchmark records',
      '',
      `${result.benchmarks.length} records. Recorded case outcomes below do not infer individual gate results. Measurements are retained in [result.json](result.json) and linked evidence.`,
      '',
    )
    for (const test of result.tests.filter((t) => t.benchmarks.length)) {
      lines.push(`### ${test.target}: ${test.title} — ${test.status}`, '')
      for (const record of test.benchmarks) {
        lines.push(`Family: ${record.family}; ${record.gates.length} declared gates.`, '')
        if (record.gates.length)
          lines.push(
            `Gate definitions: ${record.gates.map((g) => `${g.metric} ${g.operator} ${g.limit}`).join('; ')}.`,
            '',
          )
        lines.push(record.evidence.map((path) => link(path)).join(' · '), '')
      }
    }
  }
  lines.push(
    '',
    '## Baseline provenance',
    '',
    '```json',
    JSON.stringify(result.baseline, null, 2),
    '```',
    '',
    '## Runtime and hardware',
    '',
    '```json',
    JSON.stringify(
      {
        ...result.runtime,
        git: {
          ...result.runtime.git,
          changes: undefined,
          changedPaths: result.runtime.git?.changes?.length,
        },
      },
      null,
      2,
    ),
    '```',
    '',
    `Local ${{ darwin: 'macOS', linux: 'Linux', win32: 'Windows' }[result.runtime?.platform] ?? 'runtime'} evidence only. This run does not certify physical HDR luminance, other platforms, packaging, or a particular client MCP connection. Native picker interaction requires separate manual evidence.`,
    '',
  )
  return lines.join('\n')
}
