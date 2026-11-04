import { readFile, writeFile, rename, rm } from 'node:fs/promises'

// Trusted application code. Prompt text and tool arguments are never executed.
let input = ''
try {
  for await (const part of process.stdin) {
    input += part.toString()
    if (Buffer.byteLength(input) > 1024 * 1024) throw new Error('Hook input is too large.')
  }
  const event = JSON.parse(input)
  const connection = JSON.parse(process.env.IRODORI_AGENT_CONNECTION ?? 'null')
  const requestFile = process.env.IRODORI_AGENT_REQUEST
  if (
    !requestFile ||
    !connection ||
    !Number.isInteger(connection.port) ||
    !/^[a-f0-9]{64}$/.test(connection.token)
  )
    throw new Error('Irodori console connection is unavailable.')
  const call = async (operation, extra = {}) => {
    const response = await fetch(`http://127.0.0.1:${connection.port}/editor`, {
      method: 'POST',
      redirect: 'error',
      headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operation,
        sessionId: event.session_id,
        turnId: event.turn_id,
        ...extra,
      }),
      signal: AbortSignal.timeout(25000),
    })
    const value = await response.json()
    if (!response.ok || value.error) throw new Error(value.error ?? 'Irodori hook failed.')
    return value.result
  }
  if (event.hook_event_name === 'UserPromptSubmit') {
    await rm(requestFile, { force: true })
    const context = await call('irodori_agent_begin_request')
    await writeFile(
      `${requestFile}.tmp`,
      JSON.stringify({
        requestId: context.requestId,
        sessionId: event.session_id,
        turnId: event.turn_id,
      }),
      { mode: 0o600 },
    )
    await rename(`${requestFile}.tmp`, requestFile)
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: `Irodori request context (targets remain frozen for this request):\n${JSON.stringify(context)}`,
        },
      }),
    )
  } else if (event.hook_event_name === 'PreToolUse') {
    const tools = JSON.parse(process.env.IRODORI_AGENT_TOOLS ?? '[]')
    const state = JSON.parse(await readFile(requestFile, 'utf8'))
    const permitted = tools.some((name) => event.tool_name === `mcp__irodori__${name}`)
    if (
      !permitted ||
      state.sessionId !== event.session_id ||
      state.turnId !== event.turn_id ||
      event.tool_input?.requestId !== state.requestId
    ) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason:
              "Only Irodori photo tools with this prompt's frozen requestId are available. Explain missing capabilities and end the turn; no workarounds.",
          },
        }),
      )
    }
  } else if (['Stop', 'Interrupt'].includes(event.hook_event_name)) {
    await call('irodori_agent_end_request')
    await rm(requestFile, { force: true })
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  if (input.includes('PreToolUse'))
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: message,
        },
      }),
    )
  else {
    process.stderr.write(message)
    process.exitCode = 2
  }
}
