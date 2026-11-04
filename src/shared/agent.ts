import type { WorkspaceState } from './workspace'
type WorkspaceMode = WorkspaceState['mode']

export interface EditorContextSnapshot {
  workspace: WorkspaceMode
  activePhotoId: string | null
  selectedIds: string[]
  transient: { crop: boolean; saving: boolean }
}
export interface AgentPhotoTarget {
  photoId: string
  revision: number
}
export interface EditorContext {
  requestId: string
  workspace: WorkspaceMode
  active: AgentPhotoTarget | null
  selection: AgentPhotoTarget[]
  selectionTotal: number
  offset: number
  nextOffset: number | null
  transient: EditorContextSnapshot['transient']
  development: boolean
}
export interface AgentPhotoPreview {
  photoId: string
  revision: number
  renderingIdentity: string
  width: number
  height: number
  colorSpace: 'srgb'
  rendition: 'sRGB SDR rendition'
  mimeType: 'image/jpeg'
  quality: 80
  byteLength: number
  data: string
}
export type AgentStatus = 'disconnected' | 'connecting' | 'connected' | 'choice' | 'error'
export interface AgentSessionState {
  signInAvailable?: boolean
  sessionId: string
  status: AgentStatus
  resumable: boolean
  message: string
}
export interface AgentOutput {
  sessionId: string
  sequence: number
  data: string
}
export interface AgentApi {
  getAgentSession(): Promise<AgentSessionState & { output: AgentOutput[] }>
  connectAgent(choice: 'new' | 'resume' | 'reconnect'): Promise<AgentSessionState>
  chooseAgentExecutable(): Promise<boolean>
  writeAgentInput(sessionId: string, data: string): Promise<void>
  pasteAgentInput(sessionId: string, bracketed: boolean): Promise<void>
  copyAgentSelection(sessionId: string, text: string): Promise<void>
  openAgentSignInLink(sessionId: string, url: string): Promise<void>
  openAgentSignIn(sessionId: string): Promise<void>
  copyAgentSignInLink(sessionId: string): Promise<void>
  resizeAgent(sessionId: string, columns: number, rows: number): Promise<void>
  interruptAgent(sessionId: string): Promise<void>
  acknowledgeAgentOutput(sessionId: string, sequence: number): Promise<void>
  onAgentState(listener: (state: AgentSessionState) => void): () => void
  onAgentOutput(listener: (output: AgentOutput) => void): () => void
  onAgentContextQuery(listener: () => Promise<EditorContextSnapshot>): () => void
}

export const AGENT_OUTPUT_LIMIT = 256 * 1024
export const AGENT_INPUT_LIMIT = 16 * 1024
export const AGENT_SELECTION_LIMIT = 4 * 1024 * 1024
export const AGENT_PREVIEW_LIMIT = 1024 * 1024
export const AGENT_PREVIEW_CACHE_LIMIT = 8 * 1024 * 1024

/** Preserve surrogate pairs when sending bounded terminal messages. */
export function terminalChunks(text: string, units = 4096): string[] {
  const chunks: string[] = []
  let part = ''
  for (const point of text) {
    if (part.length + point.length > units) {
      chunks.push(part)
      part = ''
    }
    part += point
  }
  if (part) chunks.push(part)
  return chunks
}

export function agentTerminalSize(columns: number, rows: number) {
  if (
    !Number.isInteger(columns) ||
    !Number.isInteger(rows) ||
    columns < 2 ||
    rows < 2 ||
    columns > 500 ||
    rows > 200
  )
    throw new Error('Invalid agent terminal size.')
  return { columns, rows }
}
