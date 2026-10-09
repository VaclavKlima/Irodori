import { relative } from 'node:path'

// Successful logs and images stay in artifacts; the compact report links failures.
export function renderSummary(result) {
  const link = (path, label = relative(result.artifacts, path)) =>
    `[${label}](${relative(result.artifacts, path).replaceAll(' ', '%20')})`
  const seconds = (ms) => `${(ms / 1000).toFixed(2)} s`
  const lines = [
    `# Verification: ${result.status.toUpperCase()}`,
    '',
    `${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped, ${result.interrupted} interrupted; ${seconds(result.durationMs)}; exit ${result.exitCode}.`,
    '',
    `Selection: \`${result.scope}\`. Requested targets: ${result.plan.requestedTargets.join(', ') || '(command/scopes)'}.`,
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
  if (failures.length || result.stages.some((s) => s.status === 'failed')) {
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
        '```text',
        ...test.errors,
        '```',
        '',
        '```sh',
        test.rerun,
        '```',
        '',
      )
      if (test.evidence.length) lines.push(test.evidence.map((p) => link(p)).join(' · '), '')
    }
    for (const stage of result.stages.filter((s) => s.status === 'failed')) {
      lines.push(
        `Stage ${stage.name}: ${link(stage.log)}.`,
        '',
        '```text',
        stage.error ?? 'See stage log.',
        '```',
        '',
      )
      if (!failures.some((t) => stage.targets.includes(t.target)))
        lines.push('```sh', stage.rerun, '```', '')
    }
  }
  if (skipped.length)
    lines.push(
      '',
      '## Skipped cases',
      '',
      ...skipped.map(
        (t) =>
          `- ${t.target}: ${t.title}. ${
            t.annotations
              .filter((a) => a.type === 'skip')
              .map((a) => a.description)
              .join('; ') || 'No reason supplied.'
          }`,
      ),
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
    lines.push('', '## Benchmark measurements', '')
    for (const record of result.benchmarks) {
      lines.push(
        `### ${record.family}`,
        '',
        '```json',
        JSON.stringify(record.measurements, null, 2),
        '```',
        '',
      )
      if (record.gates.length)
        lines.push(
          `Gates: ${record.gates.map((g) => `${g.metric} ${g.operator} ${g.limit}`).join('; ')}.`,
          '',
        )
      lines.push(record.evidence.map((path) => link(path)).join(' · '), '')
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
