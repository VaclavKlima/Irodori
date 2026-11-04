import { fork, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AGENT_INPUT_LIMIT,
  AGENT_OUTPUT_LIMIT,
  AGENT_SELECTION_LIMIT,
  agentTerminalSize,
  terminalChunks,
  type AgentOutput,
  type AgentSessionState,
} from '../../shared/agent'
import {
  agentEnvironment,
  bundledNodeExecutable,
  discoverCodex,
  prepareAgentConfig,
  verifyAgentConfig,
  agentConfigOverrides,
} from './config'
import { AgentRequestGate } from './request-gate'
import { agentSignInUrl, latestAgentSignInUrl } from './sign-in-links'

interface SessionOptions {
  profile: string
  development: boolean
  connection: (token: string) => { port: number; token: string }
  gate: (onConversation: (id: string) => Promise<void>) => AgentRequestGate
  onState: (state: AgentSessionState) => void
  onOutput: (output: AgentOutput) => void
  runtimeDirectory?: string
}

/** One owned process and conversation survives every renderer panel/workspace change. */
export class AgentSessions {
  private state: AgentSessionState = {
    sessionId: randomUUID(),
    status: 'disconnected',
    resumable: false,
    message:
      'Connect Codex to edit photos. Sign-in and conversations are separate from your coding profile.',
  }
  private child?: ChildProcess
  private gate?: AgentRequestGate
  private credential?: string
  private signInUrl?: string
  private conversation?: string
  private executable?: string
  private output: AgentOutput[] = []
  private bytes = 0
  private transition?: Promise<AgentSessionState>
  private closing = false
  private directory: string
  private runtime: string
  constructor(private options: SessionOptions) {
    this.directory = join(options.profile, 'agent')
    this.runtime = options.runtimeDirectory ?? import.meta.dirname
  }
  async open() {
    try {
      const saved = JSON.parse(await readFile(join(this.directory, 'conversation.json'), 'utf8'))
      if (typeof saved.id === 'string' && /^[a-f0-9-]{36}$/.test(saved.id))
        this.conversation = saved.id
      if (typeof saved.executable === 'string') this.executable = saved.executable
    } catch {
      /* A first launch has no saved conversation. */
    }
    this.update(
      this.conversation ? 'choice' : 'disconnected',
      this.conversation
        ? 'Resume the previous conversation or start a new one.'
        : this.state.message,
    )
  }
  get() {
    return { ...this.state, output: this.output.map((value) => ({ ...value })) }
  }
  private update(status: AgentSessionState['status'], message: string) {
    this.state = { ...this.state, status, message, resumable: !!this.conversation }
    this.options.onState({ ...this.state })
  }
  private async save() {
    await writeFile(
      join(this.directory, 'conversation.json.tmp'),
      JSON.stringify({ id: this.conversation ?? null, executable: this.executable ?? null }),
      { mode: 0o600 },
    )
    await rename(
      join(this.directory, 'conversation.json.tmp'),
      join(this.directory, 'conversation.json'),
    )
  }
  authenticate(token: string) {
    return this.credential === token ? this.gate : undefined
  }
  async selectExecutable(path: string) {
    this.executable = await discoverCodex(path)
    await prepareAgentConfig(
      join(this.directory, 'codex'),
      join(this.directory, 'workspace'),
      this.options.development,
      this.runtime,
    )
    await this.save()
  }
  connect(choice: 'new' | 'resume' | 'reconnect') {
    if (!['new', 'resume', 'reconnect'].includes(choice))
      return Promise.reject(new Error('Invalid conversation choice.'))
    if (this.closing) return Promise.reject(new Error('The agent console is shutting down.'))
    if (this.transition) return this.transition
    this.transition = this.start(choice).finally(() => {
      this.transition = undefined
    })
    return this.transition
  }
  private async start(choice: 'new' | 'resume' | 'reconnect') {
    if (choice === 'reconnect' && this.child && this.state.status === 'connected')
      return { ...this.state }
    if (choice !== 'new' && !this.conversation && this.state.status === 'choice')
      throw new Error('Choose New conversation.')
    await this.stopProcess()
    if (choice === 'new') this.conversation = undefined
    this.state.sessionId = randomUUID()
    this.output = []
    this.signInUrl = undefined
    this.state.signInAvailable = false
    this.bytes = 0
    this.update('connecting', 'Checking the Codex connection and photo-tool restrictions…')
    try {
      const home = join(this.directory, 'codex'),
        workspace = join(this.directory, 'workspace')
      await prepareAgentConfig(home, workspace, this.options.development, this.runtime)
      await this.save()
      this.executable = await discoverCodex(this.executable)
      this.credential = randomBytes(32).toString('hex')
      const connection = this.options.connection(this.credential)
      const env = agentEnvironment(home, workspace, JSON.stringify(connection))
      await verifyAgentConfig(this.executable, workspace, env, this.runtime)
      const policyOverrides = await agentConfigOverrides(home)
      if (this.closing) throw new Error('The agent console is shutting down.')
      this.gate = this.options.gate(async (id) => {
        this.conversation = id
        await this.save()
        this.state.resumable = true
        this.state.signInAvailable = false
        this.options.onState({ ...this.state })
      })
      const workerEnv = { ...env }
      const child = fork(join(this.runtime, 'agent-worker.js'), [], {
        execPath: bundledNodeExecutable(),
        execArgv: [],
        env: workerEnv,
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      })
      this.child = child
      child.stderr?.on('data', () => {})
      const id = this.state.sessionId
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('The Codex terminal did not start.')),
          15000,
        )
        child.on(
          'message',
          (message: {
            type: string
            data?: string
            sequence?: number
            message?: string
            code?: number
          }) => {
            if (this.child !== child) return
            if (message.type === 'ready') {
              clearTimeout(timer)
              this.update(
                'connected',
                'Codex connected · review Irodori hooks in /hooks before the first request.',
              )
              resolve()
            } else if (
              message.type === 'output' &&
              typeof message.data === 'string' &&
              Number.isSafeInteger(message.sequence)
            ) {
              const output = { sessionId: id, sequence: message.sequence!, data: message.data }
              this.output.push(output)
              this.bytes += Buffer.byteLength(output.data)
              while (this.bytes > AGENT_OUTPUT_LIMIT && this.output.length > 1)
                this.bytes -= Buffer.byteLength(this.output.shift()!.data)
              this.options.onOutput(output)
              const signInUrl = latestAgentSignInUrl(
                this.output.map((chunk) => chunk.data).join(''),
              )
              if (signInUrl && signInUrl !== this.signInUrl) {
                this.signInUrl = signInUrl
                this.state.signInAvailable = true
                this.options.onState({ ...this.state })
              }
            } else if (message.type === 'error') {
              clearTimeout(timer)
              reject(new Error(message.message ?? 'The Codex terminal failed.'))
              this.update('error', message.message ?? 'The Codex terminal failed.')
            }
          },
        )
        child.once('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
        child.once('exit', () => {
          clearTimeout(timer)
          reject(new Error('Codex stopped before connecting.'))
          if (this.child !== child) return
          this.child = undefined
          this.credential = undefined
          this.gate?.stop()
          this.update('disconnected', 'Codex stopped. Reconnect to continue the conversation.')
        })
        child.send({
          type: 'start',
          executable: this.executable!,
          args: [
            '--no-daemon',
            '--strict-config',
            '--no-alt-screen',
            '--profile',
            'irodori',
            ...policyOverrides,
            '-C',
            workspace,
            ...(this.conversation ? ['resume', this.conversation] : []),
          ],
          cwd: workspace,
          env,
          columns: 100,
          rows: 12,
        })
      })
      await this.save()
    } catch (error) {
      await this.stopProcess()
      this.update('error', error instanceof Error ? error.message : String(error))
    }
    return { ...this.state }
  }
  private owned(sessionId: string) {
    if (sessionId !== this.state.sessionId || !this.child || this.state.status !== 'connected')
      throw new Error('This terminal session is no longer connected.')
    return this.child
  }
  input(sessionId: string, data: string) {
    if (typeof data !== 'string' || Buffer.byteLength(data) > AGENT_INPUT_LIMIT)
      throw new Error('Terminal input is too large.')
    this.owned(sessionId).send({ type: 'input', data })
  }
  resize(sessionId: string, columns: number, rows: number) {
    const size = agentTerminalSize(columns, rows)
    this.owned(sessionId).send({ type: 'resize', ...size })
  }
  paste(sessionId: string, text: string, bracketed: boolean) {
    this.owned(sessionId)
    if (typeof bracketed !== 'boolean' || Buffer.byteLength(text) > 64 * 1024)
      throw new Error('Paste is limited to 64 KiB. Use a shorter photo request.')
    const normalized = text.replace(/\r?\n/g, '\r').replaceAll('\x1b[201~', '')
    const data = bracketed ? `\x1b[200~${normalized}\x1b[201~` : normalized
    for (const chunk of terminalChunks(data)) this.input(sessionId, chunk)
  }
  signInLink(sessionId: string, url = this.signInUrl) {
    this.owned(sessionId)
    return agentSignInUrl(url, this.output.map((chunk) => chunk.data).join(''))
  }
  selectionText(sessionId: string, text: string) {
    if (sessionId !== this.state.sessionId)
      throw new Error('This terminal selection belongs to an older session.')
    if (
      typeof text !== 'string' ||
      !text.length ||
      text.length > AGENT_SELECTION_LIMIT ||
      Buffer.byteLength(text) > AGENT_SELECTION_LIMIT
    )
      throw new Error('Select at most 4 MiB of terminal text.')
    return text
  }
  interrupt(sessionId: string) {
    this.gate?.end()
    this.owned(sessionId).send({ type: 'interrupt' })
  }
  acknowledge(sessionId: string, sequence: number) {
    if (!Number.isSafeInteger(sequence) || sequence < 1)
      throw new Error('Invalid terminal acknowledgement.')
    if (sessionId === this.state.sessionId && this.child?.connected)
      this.child.send({ type: 'ack', sequence })
  }
  private async stopProcess() {
    this.credential = undefined
    const gate = this.gate
    gate?.stop()
    const child = this.child
    this.child = undefined
    if (child)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
        }, 3000)
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
        if (child.connected) child.send({ type: 'close' })
        else child.kill('SIGKILL')
      })
    await gate?.settled()
    this.gate = undefined
  }
  async close() {
    this.closing = true
    await this.disconnect()
  }
  async disconnect() {
    await this.transition
    await this.stopProcess()
    this.update('disconnected', 'Codex stopped. Reconnect to continue the conversation.')
  }
}
