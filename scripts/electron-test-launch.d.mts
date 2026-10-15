import type { ElectronApplication } from '@playwright/test'
import type { ChildProcess } from 'node:child_process'
export interface WindowPolicyEvidence {
  mode: 'background' | 'foreground'
  pid: number
  profile: string
  windows: { id: number; showEvents: number; focusEvents: number; closed: boolean }[]
  violations: string[]
}
export function launchTestElectron(options: {
  userDataDir: string
  artifacts: string
  entry?: 'index' | 'hdr-diagnostic'
  args?: string[]
  env?: NodeJS.ProcessEnv
  offline?: boolean
}): Promise<{ app: ElectronApplication; child: ChildProcess; evidenceFile: string }>
export function assertTestWindowPolicy(evidenceFile: string): Promise<WindowPolicyEvidence>
