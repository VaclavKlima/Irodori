import { stripVTControlCharacters } from 'node:util'
import { resolve, sep } from 'node:path'

/** Explicit live-model scenarios. Photographs stay in the isolated evaluation library. */
const raw = 'assets/tests/images/raw/sony-zv-1a'
const raster = 'assets/tests/images/raster/wikimedia'
const broad = 'Make this photograph look its best. Choose a direction that suits the scene.'
export const agentQualityScenarios = [
  {
    id: 'forest-hdr',
    title: 'Forest HDR master',
    inputs: [77, 78, 79].map((id) => `${raw}/forest-bracket/originals/DSC032${id}.ARW`),
    notice: `${raw}/forest-bracket/README.md`,
    merge: true,
    prompts: [broad],
  },
  {
    id: 'fog-dogs',
    title: 'Dogs in fog',
    inputs: [`${raw}/fog-dogs/originals/DSC03280.ARW`],
    notice: `${raw}/fog-dogs/README.md`,
    prompts: [broad],
  },
  {
    id: 'flamingo',
    title: 'Expressive flamingo and reflection',
    inputs: [`${raster}/flamingo-reflection/originals/Flamant_rose_Salines_de_Thyna.jpg`],
    notice: `${raster}/flamingo-reflection/README.md`,
    prompts: [
      'Give this photograph a polished, expressive look that suits it. Preserve the reflection and important feather detail.',
    ],
  },
  {
    id: 'bicycle-existing-look',
    title: 'Refine an existing bicycle look',
    inputs: [`${raster}/object-selection/originals/Bicycle_with_Mavic_CXP_14_wheels.jpg`],
    notice: `${raster}/object-selection/README.md`,
    seed: {
      exposureEv: -0.15,
      contrast: 12,
      saturation: -6,
      colorGrading: {
        tones: { shadows: { hue: 205, saturation: 10 }, highlights: { hue: 40, saturation: 12 } },
      },
    },
    prompts: [
      'Improve this photo.',
      'Refine the existing look while keeping the bicycle the focus.',
    ],
  },
  {
    id: 'mug-precise-followup',
    title: 'Product finish, output proof and precise follow-up',
    inputs: [`${raster}/object-selection/originals/Mug_image.jpg`],
    notice: `${raster}/object-selection/README.md`,
    resumeBeforeFollowup: true,
    prompts: [
      'Give this a natural, clean product-photography finish. Before finishing, inspect an SDR JPEG output proof at quality 90 with Standard output sharpening; do not export.',
      'Reduce the warmth slightly; preserve everything else.',
    ],
  },
  {
    id: 'high-iso-limit',
    title: 'High ISO and unavailable local noise reduction',
    inputs: [`${raw}/carpet-high-iso/originals/DSC03489.ARW`],
    notice: `${raw}/carpet-high-iso/README.md`,
    prompts: [
      'Improve this noisy photograph, keeping believable texture. Use local noise reduction only on the background if possible.',
    ],
  },
]

const numericUsage = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const result = Object.fromEntries(
    Object.entries(value).filter(([, count]) => Number.isSafeInteger(count) && count >= 0),
  )
  return Object.keys(result).length ? result : null
}
const usageIdentity = (value) =>
  JSON.stringify(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
const withUncachedInput = (value) => {
  if (!value) return null
  const { input_tokens: input, cached_input_tokens: cached } = value
  return {
    ...value,
    ...(Number.isSafeInteger(input) && Number.isSafeInteger(cached) && cached <= input
      ? { uncached_input_tokens: input - cached }
      : {}),
  }
}
const sumCompleteUsageFields = (values) => {
  if (!values.length) return null
  const fields = [...new Set(values.flatMap((value) => Object.keys(value)))]
  const total = Object.fromEntries(
    fields.flatMap((field) => {
      if (!values.every((value) => field in value)) return []
      const count = values.reduce((sum, value) => sum + value[field], 0)
      return Number.isSafeInteger(count) ? [[field, count]] : []
    }),
  )
  return Object.keys(total).length ? total : null
}
const epochMilliseconds = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null)
const durationMilliseconds = (value) => {
  if (
    !value ||
    !Number.isSafeInteger(value.secs) ||
    value.secs < 0 ||
    !Number.isSafeInteger(value.nanos) ||
    value.nanos < 0 ||
    value.nanos >= 1_000_000_000
  )
    return null
  const duration = value.secs * 1000 + value.nanos / 1_000_000
  return Number.isFinite(duration) ? duration : null
}
const toolError = (result) =>
  result?.isError === true || result?.Err !== undefined || result?.Ok?.isError === true
const photoTool = (name) => /(?:^|__)irodori_/.test(name)
const finalText = (message) =>
  typeof message === 'string'
    ? message
    : Array.isArray(message)
      ? message.map((part) => part.text ?? '').join('\n')
      : ''

/** Cumulative usage snapshots are never summed; duplicated tool events share one call ID. */
export function parseAgentQualityTranscript(text) {
  const calls = new Map()
  const orchestration = new Map()
  const usageSnapshots = new Set()
  const responseUsage = new Map()
  const completions = []
  const completedIds = new Set()
  let cumulativeUsage = null
  const observeUsage = (total) => {
    if (!total) return
    usageSnapshots.add(usageIdentity(total))
    cumulativeUsage = total
  }
  const observeCall = (destination, call) => {
    const previous = destination.get(call.id)
    destination.set(call.id, {
      id: call.id,
      name: call.name ?? previous?.name,
      server: call.server ?? previous?.server ?? null,
      turnId: call.turnId ?? previous?.turnId ?? null,
      startedAt: call.startedAt ?? previous?.startedAt ?? null,
      endedAt: call.endedAt ?? previous?.endedAt ?? null,
      durationMs: call.durationMs ?? previous?.durationMs ?? null,
      status: call.status ?? previous?.status ?? null,
      error: previous?.error === true || call.error === true,
    })
  }
  let sessionId = null,
    model = null,
    reasoningEffort = null,
    finalMessage = '',
    malformedLines = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      malformedLines++
      continue
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      malformedLines++
      continue
    }
    const payload = record.payload && typeof record.payload === 'object' ? record.payload : {}
    const timestamp = Date.parse(record.timestamp)
    const observedAt = Number.isFinite(timestamp) ? timestamp : null
    if (record.type === 'session_meta') sessionId = payload.id ?? sessionId
    if (record.type === 'turn_context') {
      model = payload.model ?? model
      reasoningEffort =
        typeof payload.effort === 'string'
          ? payload.effort
          : typeof payload.reasoning_effort === 'string'
            ? payload.reasoning_effort
            : null
    }
    if (record.type === 'event_msg' && payload.type === 'token_count')
      observeUsage(numericUsage(payload.info?.total_token_usage))
    if (record.type === 'token_usage_record') {
      observeUsage(numericUsage(payload.thread_token_usage))
      const usage = numericUsage(payload.usage)
      if (typeof payload.response_id === 'string' && usage)
        responseUsage.set(payload.response_id, usage)
    }
    // CLI 0.167 records actual MCP execution separately from the surrounding exec call.
    // Never infer executed operations from source text, prompts or tool descriptions.
    if (
      record.type === 'event_msg' &&
      payload.type === 'item_completed' &&
      payload.item?.type === 'McpToolCall'
    ) {
      const item = payload.item
      if (typeof item.id === 'string' && typeof item.tool === 'string')
        observeCall(calls, {
          id: item.id,
          name: item.tool,
          server: typeof item.server === 'string' ? item.server : null,
          turnId: typeof payload.turn_id === 'string' ? payload.turn_id : null,
          startedAt: epochMilliseconds(payload.started_at_ms),
          endedAt: epochMilliseconds(payload.completed_at_ms),
          durationMs: durationMilliseconds(item.duration),
          status: typeof item.status === 'string' ? item.status : null,
          error: item.status === 'failed' || toolError(item.result),
        })
    }
    if (record.type === 'event_msg' && ['task_complete', 'turn_complete'].includes(payload.type)) {
      finalMessage = finalText(payload.last_agent_message) || finalMessage
      const identity = payload.turn_id ?? `${observedAt}:${finalMessage}`
      if (!completedIds.has(identity)) {
        completedIds.add(identity)
        completions.push({ timestamp: observedAt, turnId: payload.turn_id ?? null })
      }
    }
    if (
      record.type === 'response_item' &&
      payload.type === 'message' &&
      payload.role === 'assistant'
    ) {
      if (payload.phase === 'final_answer' || payload.phase === 'final')
        finalMessage = finalText(payload.content) || finalMessage
    }
    const invocation = payload.invocation
    const responseCall =
      record.type === 'response_item' &&
      ['function_call', 'custom_tool_call', 'tool_search_call'].includes(payload.type)
    const begin = record.type === 'event_msg' && payload.type === 'mcp_tool_call_begin'
    const end = record.type === 'event_msg' && payload.type === 'mcp_tool_call_end'
    if (responseCall || begin || end) {
      const name =
        payload.name ??
        invocation?.tool ??
        (payload.type === 'tool_search_call' ? 'tool_search' : null)
      const id = payload.call_id ?? payload.id
      if (typeof name === 'string' && typeof id === 'string') {
        const destination = begin || end || photoTool(name) ? calls : orchestration
        observeCall(destination, {
          id,
          name,
          startedAt: destination.get(id)?.startedAt ?? observedAt,
          endedAt: end ? observedAt : null,
          error: !!payload.error || toolError(payload.result),
        })
      }
    }
    if (
      record.type === 'response_item' &&
      ['function_call_output', 'custom_tool_call_output'].includes(payload.type)
    ) {
      const call = calls.get(payload.call_id) ?? orchestration.get(payload.call_id)
      if (call) {
        call.endedAt ??= observedAt
        try {
          const output =
            typeof payload.output === 'string' ? JSON.parse(payload.output) : payload.output
          call.error ||= toolError(output)
        } catch {
          // Plain tool output does not establish an error.
        }
      }
    }
  }
  const byStart = (left, right) => (left.startedAt ?? Infinity) - (right.startedAt ?? Infinity)
  const toolCalls = [...calls.values()].sort(byStart)
  const orchestrationToolCalls = [...orchestration.values()].sort(byStart)
  for (const call of [...toolCalls, ...orchestrationToolCalls])
    if (
      call.durationMs === null &&
      call.startedAt !== null &&
      call.endedAt !== null &&
      call.endedAt >= call.startedAt
    )
      call.durationMs = call.endedAt - call.startedAt
  const usage = cumulativeUsage ?? sumCompleteUsageFields([...responseUsage.values()])
  return {
    sessionId,
    model,
    reasoningEffort,
    usage: withUncachedInput(usage),
    usageSource: cumulativeUsage ? 'cumulative' : usage ? 'response-records' : null,
    usageSnapshots: usageSnapshots.size,
    toolCalls,
    orchestrationCalls: orchestrationToolCalls.length,
    orchestrationToolCalls,
    discoveryCalls: orchestrationToolCalls.filter((call) => /(^|__)tool_search$/.test(call.name))
      .length,
    toolErrors: toolCalls.filter((call) => call.error).length,
    completedTurns: completions.length,
    completions,
    finalMessage,
    malformedLines,
  }
}

/** One final cumulative snapshot per conversation, including a resumed conversation only once. */
export function aggregateAgentQualityUsage(sessions) {
  const unique = new Map()
  for (const session of sessions) {
    if (!session.sessionId) continue
    unique.set(session.sessionId, session)
  }
  const measured = [...unique.values()].filter((session) => session.usage)
  if (!measured.length) return { available: false, conversations: unique.size, totals: null }
  const keys = [...new Set(measured.flatMap((session) => Object.keys(session.usage)))]
  const fieldCoverage = Object.fromEntries(
    keys.map((key) => [key, measured.filter((session) => key in session.usage).length]),
  )
  const totals = Object.fromEntries(
    keys
      .filter((key) => fieldCoverage[key] === unique.size)
      .map((key) => [key, measured.reduce((sum, session) => sum + session.usage[key], 0)]),
  )
  return {
    available: measured.length === unique.size,
    conversations: unique.size,
    measuredConversations: measured.length,
    fieldCoverage,
    totals,
  }
}

export const escapeEvaluationHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character],
  )

/** Authentication callback parameters and bearer values never enter terminal diagnostics. */
export function sanitizeAgentQualityTerminal(text) {
  return stripVTControlCharacters(text)
    .replace(/https?:\/\/[^\s<>"']+/g, (value) => {
      try {
        const url = new URL(value)
        return `${url.origin}${url.pathname}${url.search || url.hash ? '?[redacted]' : ''}`
      } catch {
        return '[URL redacted]'
      }
    })
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .slice(-12_000)
}

export function agentQualityTerminalReadiness(text) {
  if (/sign in with (?:chatgpt|an api key)|finish signing in|paste your api key/i.test(text))
    return { ready: false, blocked: 'Codex is awaiting authentication in the evaluation profile.' }
  if (/trust.*(?:hook|director)|(?:hook|director).*trust|review.*hooks/i.test(text))
    return { ready: false, blocked: 'Codex requires normal hook or workspace trust review.' }
  if (/press (?:enter|return) to continue|select.*(?:theme|account)/i.test(text))
    return { ready: false, blocked: 'Codex is awaiting a startup choice.' }
  if (/error loading|configuration error|profile .*not found|failed to start/i.test(text))
    return { ready: false, blocked: 'Codex reported a startup configuration failure.' }
  return { ready: /(?:^|\n)\s*[›❯]\s|\?\s+for shortcuts/i.test(text), blocked: null }
}

/** Call with canonical existing paths or canonical nearest ancestors before creating anything. */
export function assertAgentQualityPathSeparation(paths) {
  const overlap = (a, b) => {
    const left = resolve(a),
      right = resolve(b)
    return left === right || left.startsWith(right + sep) || right.startsWith(left + sep)
  }
  if (paths.profile && overlap(paths.output, paths.profile))
    throw new Error('Evaluation output and profile must not overlap.')
  for (const [name, path] of Object.entries({
    output: paths.output,
    profile: paths.profile,
    library: paths.library,
    archival: paths.archival,
  })) {
    if (!path) continue
    for (const protectedPath of [paths.compiledRoot, paths.baselineReference].filter(Boolean))
      if (overlap(path, protectedPath))
        throw new Error(`Evaluation ${name} overlaps a protected compiled tree.`)
  }
}

const equalValue = (left, right) => {
  if (left === right) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])]
  return keys.every((key) => equalValue(left[key], right[key]))
}
const changedValues = (before, after, path = '') => {
  if (equalValue(before, after)) return []
  if (before && after && typeof before === 'object' && typeof after === 'object')
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap((key) =>
      changedValues(before[key], after[key], path ? `${path}.${key}` : key),
    )
  return [{ path, before: before ?? null, after: after ?? null }]
}

/** Structural and observed-tool evidence only; this never grades photographic quality or wording. */
export function assessAgentQualityScenario(scenario) {
  const calls = scenario.session?.toolCalls ?? []
  const knownCalls = calls.length > 0
  const successful = (call) => !call.error && (call.status === 'completed' || call.endedAt !== null)
  const reviews = calls.filter(
    (call) =>
      /(?:^|__)irodori_get_(photo_preview|output_proof|mask_preview)$/.test(call.name) &&
      successful(call),
  )
  const proofs = reviews.filter((call) => /irodori_get_output_proof$/.test(call.name))
  const flags = {
    humanReviewRequired: true,
    visualReviewEvidence: {
      status: reviews.length ? 'observed' : knownCalls ? 'missing' : 'unavailable',
      callIds: reviews.map((call) => call.id),
    },
  }
  if (scenario.id === 'bicycle-existing-look') {
    const first = scenario.turnStates?.[0]
    flags.existingLookBeforeReply =
      !scenario.initial || !first
        ? { status: 'unavailable' }
        : {
            status:
              equalValue(scenario.initial.settings, first.settings) &&
              scenario.initial.revision === first.revision
                ? 'observed'
                : 'violated',
            changes: changedValues(scenario.initial.settings, first.settings),
          }
  }
  if (scenario.id === 'mug-precise-followup') {
    const exports = calls.filter((call) => /irodori_start_export$/.test(call.name))
    const newExports = scenario.exportTasksAfter?.filter(
      (task) => !scenario.taskIdsBefore?.includes(task.id),
    )
    flags.noExport = {
      status:
        exports.length || newExports?.length
          ? 'violated'
          : knownCalls || newExports
            ? 'observed'
            : 'unavailable',
      callIds: exports.map((call) => call.id),
      newTaskIds: newExports?.map((task) => task.id) ?? null,
    }
    flags.outputProofEvidence = {
      status: proofs.length ? 'observed' : knownCalls ? 'missing' : 'unavailable',
      callIds: proofs.map((call) => call.id),
    }
    const before = scenario.turnStates?.[0],
      after = scenario.turnStates?.[1]
    const changes = before && after ? changedValues(before.settings, after.settings) : null
    flags.preciseFollowup = {
      status: changes ? 'observed' : 'unavailable',
      changes,
      pathsOutsideTemperature:
        changes
          ?.filter(
            (change) =>
              !/^(whiteBalance\.(mode|kelvin)|maskStack\.\d+\.color\.temperature)$/.test(
                change.path,
              ),
          )
          .map((change) => change.path) ?? null,
      scopeRequiresHumanReview: true,
    }
  }
  return flags
}
