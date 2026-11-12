export interface AgentQualityScenario {
  id: string
  title: string
  inputs: string[]
  notice: string
  prompts: string[]
  merge?: boolean
  seed?: Record<string, unknown>
  resumeBeforeFollowup?: boolean
}
export const agentQualityScenarios: AgentQualityScenario[]
export interface AgentQualitySessionUsage {
  sessionId: string | null
  /** Raw counters, with uncached_input_tokens derived only when input and cached input exist. */
  usage: Record<string, number> | null
}
export interface AgentQualityToolCall {
  id: string
  name: string
  server: string | null
  turnId: string | null
  startedAt: number | null
  endedAt: number | null
  durationMs: number | null
  status: string | null
  error: boolean
}
export interface AgentQualityTranscript extends AgentQualitySessionUsage {
  model: string | null
  reasoningEffort: string | null
  usageSnapshots: number
  usageSource: 'cumulative' | 'response-records' | null
  /** Executed MCP operations; exec/wait/discovery wrappers are tracked separately. */
  toolCalls: AgentQualityToolCall[]
  orchestrationCalls: number
  orchestrationToolCalls: AgentQualityToolCall[]
  discoveryCalls: number
  toolErrors: number
  completedTurns: number
  completions: { timestamp: number | null; turnId: string | null }[]
  finalMessage: string
  malformedLines: number
}
export function parseAgentQualityTranscript(text: string): AgentQualityTranscript
export function aggregateAgentQualityUsage(sessions: AgentQualitySessionUsage[]): {
  available: boolean
  conversations: number
  measuredConversations?: number
  fieldCoverage?: Record<string, number>
  totals: Record<string, number> | null
}
export function escapeEvaluationHtml(value: unknown): string
export function sanitizeAgentQualityTerminal(text: string): string
export function agentQualityTerminalReadiness(text: string): {
  ready: boolean
  blocked: string | null
}
export function assertAgentQualityPathSeparation(paths: {
  output: string
  profile?: string
  library?: string
  archival?: string
  compiledRoot?: string
  baselineReference?: string | null
}): void
export function assessAgentQualityScenario(
  scenario: Record<string, unknown>,
): Record<string, unknown>
