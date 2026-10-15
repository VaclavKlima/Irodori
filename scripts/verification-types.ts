import type { VerificationPlan, BenchmarkFamily } from './verification-plan'

export interface BenchmarkRecord {
  family: BenchmarkFamily
  measurements: Record<string, unknown>
  gates: { metric: string; operator: '<' | '<='; limit: number }[]
  evidence: string[]
}

export interface CaseResult {
  target: string
  title: string
  file: string
  definitionFile?: string
  line: number
  status: 'passed' | 'failed' | 'skipped' | 'interrupted'
  durationMs: number
  worker: number
  errors: string[]
  annotations: { type: string; description?: string }[]
  evidence: string[]
  rerun: string
  foregroundRerun?: string
  benchmarks: BenchmarkRecord[]
}

export interface GroupSummary {
  uiMode: VerificationPlan['uiMode']
  passed: number
  failed: number
  skipped: number
  interrupted: number
  status: string
  durationMs: number
  workers: number
  tests: CaseResult[]
  errors: string[]
}

export interface StageResult {
  name: string
  phase: 'static' | 'build' | 'functional' | 'benchmark'
  status: 'passed' | 'failed' | 'blocked' | 'skipped' | 'interrupted' | 'incomplete'
  code: number | null
  durationMs: number
  log: string
  targets: string[]
  workers: number
  reason?: string
  error?: string
  rerun: string
}

export interface VerificationResult {
  scope: string
  uiMode: VerificationPlan['uiMode']
  plan: VerificationPlan
  targets: string[]
  exitCode: number
  status: 'passed' | 'failed' | 'incomplete' | 'interrupted'
  passed: number
  failed: number
  skipped: number
  interrupted: number
  durationMs: number
  artifacts: string
  stages: StageResult[]
  tests: CaseResult[]
  benchmarks: BenchmarkRecord[]
  incomplete: string[]
  warnings: string[]
  runtime: Record<string, unknown>
  baseline: {
    status: 'available' | 'missing' | 'invalid' | 'not-required'
    path?: string
    snapshot?: string
    sha256?: string
    sample?: string
    medians?: Record<string, number>
    reason?: string
  }
}
