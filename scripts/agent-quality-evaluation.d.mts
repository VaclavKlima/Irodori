import type { AgentQualityScenario } from './agent-quality-evaluation-model.mjs'
export interface AgentQualityPlan {
  version: number
  scenarios: AgentQualityScenario[]
  files: { path: string; bytes: number; sha256: string }[]
  maxModelTurns: number
  reviewRequired: boolean
  hdrLimit: string
}
export interface AgentQualityEvaluationOptions {
  allowModelCalls: boolean
  variant: 'baseline' | 'candidate'
  profile: string
  output: string
  compiledRoot?: string
  baselineReference?: string
  foreground?: boolean
  timeoutMs?: number
}
export function planAgentQualityEvaluation(): Promise<AgentQualityPlan>
export function runAgentQualityEvaluation(
  options: Partial<AgentQualityEvaluationOptions>,
): Promise<{
  output: string
  report: {
    status: 'incomplete' | 'review-required'
    error?: string
    scenarios: unknown[]
  }
}>
export function compareAgentQualityEvaluations(
  baselinePath: string,
  candidatePath: string,
  outputPath: string,
): Promise<string>
export function assessAgentQualityEvaluation(
  reportPath: string,
  outputPath: string,
): Promise<string>
