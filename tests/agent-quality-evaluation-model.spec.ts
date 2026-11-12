import { expect, test } from '@playwright/test'
import {
  aggregateAgentQualityUsage,
  parseAgentQualityTranscript,
  sanitizeAgentQualityTerminal,
  agentQualityTerminalReadiness,
  assertAgentQualityPathSeparation,
  assessAgentQualityScenario,
} from '../scripts/agent-quality-evaluation-model.mjs'
import {
  planAgentQualityEvaluation,
  runAgentQualityEvaluation,
} from '../scripts/agent-quality-evaluation.mjs'

test('evaluation writes and library archival cannot overlap protected compiled trees', () => {
  const paths = {
    output: '/tmp/evaluation/result',
    profile: '/tmp/evaluation/profile',
    compiledRoot: '/tmp/evaluation/baseline/out',
  }
  expect(() => assertAgentQualityPathSeparation(paths)).not.toThrow()
  for (const output of [
    paths.compiledRoot,
    '/tmp/evaluation/baseline/out/result',
    '/tmp/evaluation/baseline',
  ])
    expect(() => assertAgentQualityPathSeparation({ ...paths, output })).toThrow(
      'protected compiled tree',
    )
  expect(() =>
    assertAgentQualityPathSeparation({ ...paths, profile: paths.compiledRoot }),
  ).toThrow()
  expect(() =>
    assertAgentQualityPathSeparation({ ...paths, archival: paths.compiledRoot }),
  ).toThrow()
  expect(() =>
    assertAgentQualityPathSeparation({ ...paths, library: paths.compiledRoot }),
  ).toThrow()
  expect(() =>
    assertAgentQualityPathSeparation({ ...paths, baselineReference: paths.output }),
  ).toThrow()
})

test('contract flags report state preservation, precise diffs and missing proof evidence without grading quality', () => {
  const session = {
    toolCalls: [
      { id: 'edit', name: 'irodori_update_edits', error: false, status: 'completed', endedAt: 1 },
    ],
  }
  expect(
    assessAgentQualityScenario({
      id: 'bicycle-existing-look',
      initial: { revision: 1, settings: { contrast: 12 } },
      turnStates: [{ revision: 2, settings: { contrast: 14 } }],
      session,
    }),
  ).toMatchObject({
    existingLookBeforeReply: { status: 'violated' },
    visualReviewEvidence: { status: 'missing' },
    humanReviewRequired: true,
  })
  expect(
    assessAgentQualityScenario({
      id: 'mug-precise-followup',
      session,
      turnStates: [
        { settings: { contrast: 12, whiteBalance: { mode: 'custom', kelvin: 6000 } } },
        { settings: { contrast: 14, whiteBalance: { mode: 'custom', kelvin: 5900 } } },
      ],
    }),
  ).toMatchObject({
    noExport: { status: 'observed' },
    outputProofEvidence: { status: 'missing' },
    preciseFollowup: { pathsOutsideTemperature: ['contrast'], scopeRequiresHumanReview: true },
  })
})

test('the evaluation plan uses six tracked photographic cases and at most eight explicit model turns', async () => {
  const plan = await planAgentQualityEvaluation()
  expect(plan.scenarios).toHaveLength(6)
  expect(plan.maxModelTurns).toBe(8)
  expect(plan.scenarios.filter((scenario) => scenario.resumeBeforeFollowup)).toHaveLength(1)
  expect(plan.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true)
  expect(plan.hdrLimit).toContain('SDR')
  expect(plan.reviewRequired).toBe(true)
  await expect(runAgentQualityEvaluation({ allowModelCalls: false })).rejects.toThrow(
    'explicit --allow-model-calls',
  )
})

test('actual cumulative token snapshots and duplicate tool events are counted once', () => {
  const record = (type: string, payload: Record<string, unknown>) =>
    JSON.stringify({ timestamp: '2026-11-12T12:00:00Z', type, payload })
  const count = (input_tokens: number, output_tokens: number) =>
    record('event_msg', {
      type: 'token_count',
      info: { total_token_usage: { input_tokens, output_tokens } },
    })
  const metrics = parseAgentQualityTranscript(
    [
      record('session_meta', { id: 'session-one' }),
      record('turn_context', { model: 'fixture-model' }),
      count(100, 20),
      count(100, 20),
      record('response_item', {
        type: 'function_call',
        name: 'irodori_update_edits',
        call_id: 'one',
      }),
      record('event_msg', {
        type: 'mcp_tool_call_begin',
        invocation: { tool: 'irodori_update_edits' },
        call_id: 'one',
      }),
      record('event_msg', {
        type: 'mcp_tool_call_end',
        invocation: { tool: 'irodori_update_edits' },
        call_id: 'one',
        result: { Ok: { isError: true } },
      }),
      count(150, 40),
      count(150, 40),
      record('event_msg', {
        type: 'task_complete',
        turn_id: 'turn-one',
        last_agent_message: 'Done.',
      }),
      record('event_msg', {
        type: 'turn_complete',
        turn_id: 'turn-one',
        last_agent_message: 'Done.',
      }),
    ].join('\n'),
  )
  expect(metrics.usage).toEqual({ input_tokens: 150, output_tokens: 40 })
  expect(metrics.usageSnapshots).toBe(2)
  expect(metrics.toolCalls).toHaveLength(1)
  expect(metrics.toolErrors).toBe(1)
  expect(metrics.completedTurns).toBe(1)
  expect(metrics.finalMessage).toBe('Done.')
  expect(metrics.model).toBe('fixture-model')
  expect(
    aggregateAgentQualityUsage([
      { ...metrics, usage: { input_tokens: 100, output_tokens: 20 } },
      metrics,
      { sessionId: 'session-two', usage: { input_tokens: 10, output_tokens: 2 } },
    ]),
  ).toMatchObject({ conversations: 2, totals: { input_tokens: 160, output_tokens: 42 } })
})

test('reasoning effort comes from actual turn context metadata and stays unknown when absent', () => {
  const turn = (payload: Record<string, unknown>) =>
    JSON.stringify({ type: 'turn_context', payload })
  const actualShape = turn({ model: 'fixture-model', effort: 'ultra' })
  expect(parseAgentQualityTranscript(actualShape)).toMatchObject({
    model: 'fixture-model',
    reasoningEffort: 'ultra',
  })
  expect(
    parseAgentQualityTranscript(
      [actualShape, turn({ model: 'fixture-model', reasoning_effort: 'low' })].join('\n'),
    ).reasoningEffort,
  ).toBe('low')
  expect(
    parseAgentQualityTranscript([actualShape, turn({ model: 'fixture-model' })].join('\n'))
      .reasoningEffort,
  ).toBeNull()
  expect(parseAgentQualityTranscript('').reasoningEffort).toBeNull()
})

test('CLI item_completed MCP records measure API calls separately from exec and discovery', () => {
  const base = Date.parse('2026-11-12T12:00:00Z')
  const record = (type: string, payload: Record<string, unknown>, offset = 0) =>
    JSON.stringify({ timestamp: new Date(base + offset).toISOString(), type, payload })
  const completed = (id: string, tool: string, start: number, failed = false) =>
    record(
      'event_msg',
      {
        type: 'item_completed',
        thread_id: 'fixture-thread',
        turn_id: 'fixture-turn',
        started_at_ms: base + start,
        completed_at_ms: base + start + 2,
        item: {
          type: 'McpToolCall',
          id,
          server: 'irodori',
          tool,
          arguments: {},
          status: failed ? 'failed' : 'completed',
          duration: { secs: 0, nanos: 1_500_000 },
          result: failed ? { content: [], isError: true } : { content: [] },
        },
      },
      start + 2,
    )
  const metrics = parseAgentQualityTranscript(
    [
      record('response_item', {
        type: 'custom_tool_call',
        name: 'exec',
        call_id: 'wrapper',
        // A name in source text does not establish that this operation executed.
        input: 'const unused = "irodori_mutate_masks";',
      }),
      record('response_item', {
        type: 'tool_search_call',
        id: 'discovery',
        query: 'fixture',
      }),
      completed('later', 'irodori_get_edits', 200, true),
      completed('earlier', 'irodori_update_edits', 100),
      completed('earlier', 'irodori_update_edits', 100),
      record(
        'response_item',
        { type: 'custom_tool_call_output', call_id: 'wrapper', output: [{ type: 'text' }] },
        300,
      ),
    ].join('\n'),
  )
  expect(metrics.toolCalls).toHaveLength(2)
  expect(metrics.toolCalls[0]).toEqual({
    id: 'earlier',
    name: 'irodori_update_edits',
    server: 'irodori',
    turnId: 'fixture-turn',
    startedAt: base + 100,
    endedAt: base + 102,
    durationMs: 1.5,
    status: 'completed',
    error: false,
  })
  expect(metrics.toolCalls[1].error).toBe(true)
  expect(metrics.toolErrors).toBe(1)
  expect(metrics.orchestrationCalls).toBe(2)
  expect(metrics.orchestrationToolCalls.find((call) => call.name === 'exec')).toMatchObject({
    endedAt: base + 300,
    durationMs: 300,
  })
  expect(metrics.discoveryCalls).toBe(1)
})

test('raw thread usage and token_count are cumulative, retain cache counters and derive uncached input', () => {
  const record = (type: string, payload: Record<string, unknown>) =>
    JSON.stringify({ type, payload })
  const initial = {
    input_tokens: 100,
    cached_input_tokens: 60,
    cache_write_input_tokens: 10,
    output_tokens: 20,
    reasoning_output_tokens: 5,
    total_tokens: 120,
  }
  const final = {
    input_tokens: 150,
    cached_input_tokens: 90,
    cache_write_input_tokens: 12,
    output_tokens: 30,
    reasoning_output_tokens: 7,
    total_tokens: 180,
  }
  const metrics = parseAgentQualityTranscript(
    [
      record('token_usage_record', {
        response_id: 'one',
        usage: initial,
        thread_token_usage: initial,
        turn_token_usage: initial,
      }),
      record('event_msg', { type: 'token_count', info: { total_token_usage: initial } }),
      record('token_usage_record', {
        response_id: 'two',
        usage: { input_tokens: 50, cached_input_tokens: 30, output_tokens: 10 },
        thread_token_usage: final,
        turn_token_usage: { input_tokens: 50, output_tokens: 10 },
      }),
      record('event_msg', { type: 'token_count', info: { total_token_usage: final } }),
    ].join('\n'),
  )
  expect(metrics.usage).toEqual({ ...final, uncached_input_tokens: 60 })
  expect(metrics.usageSource).toBe('cumulative')
  expect(metrics.usageSnapshots).toBe(2)
})

test('deduplicated response usage is only a fallback and missing cache measurements stay unavailable', () => {
  const record = (response_id: string, usage: Record<string, number>) =>
    JSON.stringify({ type: 'token_usage_record', payload: { response_id, usage } })
  const metrics = parseAgentQualityTranscript(
    [
      record('one', { input_tokens: 100, cached_input_tokens: 60, output_tokens: 20 }),
      record('one', { input_tokens: 100, cached_input_tokens: 60, output_tokens: 20 }),
      record('two', { input_tokens: 50, cached_input_tokens: 30, output_tokens: 10 }),
    ].join('\n'),
  )
  expect(metrics.usage).toEqual({
    input_tokens: 150,
    cached_input_tokens: 90,
    uncached_input_tokens: 60,
    output_tokens: 30,
  })
  expect(metrics.usageSource).toBe('response-records')
  expect(metrics.usageSnapshots).toBe(0)
  expect(
    parseAgentQualityTranscript(
      [
        record('one', { input_tokens: 100, cached_input_tokens: 60 }),
        record('two', { input_tokens: 50 }),
      ].join('\n'),
    ).usage,
  ).toEqual({ input_tokens: 150 })
  expect(
    parseAgentQualityTranscript(
      record('invalid-cache', { input_tokens: 10, cached_input_tokens: 20 }),
    ).usage,
  ).toEqual({ input_tokens: 10, cached_input_tokens: 20 })
  expect(parseAgentQualityTranscript('null\n[]\n{invalid')).toMatchObject({ malformedLines: 3 })
})

test('missing runtime usage stays unavailable instead of becoming invented zero-token measurements', () => {
  expect(parseAgentQualityTranscript('')).toMatchObject({ usage: null, completedTurns: 0 })
  expect(
    aggregateAgentQualityUsage([
      { sessionId: 'one', usage: { input_tokens: 100 } },
      { sessionId: 'two', usage: null },
    ]),
  ).toMatchObject({ available: false, measuredConversations: 1, totals: {} })
})

test('terminal readiness distinguishes trusted idle input from authentication and startup choices', () => {
  expect(agentQualityTerminalReadiness('› Improve this photo\n? for shortcuts').ready).toBe(true)
  for (const text of [
    'Sign in with ChatGPT',
    'Review and trust hooks',
    'Press Enter to continue',
    'Error loading configuration',
  ])
    expect(agentQualityTerminalReadiness(text)).toMatchObject({
      ready: false,
      blocked: expect.any(String),
    })
  expect(agentQualityTerminalReadiness('Starting MCP server…')).toEqual({
    ready: false,
    blocked: null,
  })
  const diagnostic = sanitizeAgentQualityTerminal(
    'https://auth.openai.com/oauth/authorize?state=secret&code=private Bearer sensitive',
  )
  expect(diagnostic).not.toContain('secret')
  expect(diagnostic).not.toContain('private')
  expect(diagnostic).not.toContain('sensitive')
  expect(diagnostic).toContain('?[redacted]')
})
