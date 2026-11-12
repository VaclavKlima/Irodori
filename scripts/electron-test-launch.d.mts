import type { ElectronApplication } from '@playwright/test'
import type { ChildProcess } from 'node:child_process'
export interface WindowPolicyEvidence {
  mode: 'background' | 'foreground'
  pid: number
  profile: string
  windows: { id: number; showEvents: number; focusEvents: number; closed: boolean }[]
  violations: string[]
}
export function prepareTestElectron(options: {
  userDataDir: string
  artifacts: string
  entry?: 'index' | 'hdr-diagnostic'
  compiledRoot?: string
  env?: NodeJS.ProcessEnv
}): Promise<{
  profile: string
  packageDirectory: string
  evidenceFile: string
  launchEnv: NodeJS.ProcessEnv
  mode: 'background' | 'foreground'
}>
export function launchTestElectron(options: {
  userDataDir: string
  artifacts: string
  entry?: 'index' | 'hdr-diagnostic'
  compiledRoot?: string
  args?: string[]
  env?: NodeJS.ProcessEnv
  offline?: boolean
}): Promise<{ app: ElectronApplication; child: ChildProcess; evidenceFile: string }>
export function assertTestWindowPolicy(evidenceFile: string): Promise<WindowPolicyEvidence>
export function launchPackagedTestElectron(options: {
  executablePath: string
  userDataDir: string
  artifacts: string
  env?: NodeJS.ProcessEnv
}): Promise<{ app: ElectronApplication; child: ChildProcess; evidenceFile: string }>
