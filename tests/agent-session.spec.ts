import { expect, test } from '@playwright/test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { AgentSessions } from '../src/main/agent/sessions'
import { AgentRequestGate } from '../src/main/agent/request-gate'
import {
  agentEnvironment,
  discoverCodex,
  prepareAgentConfig,
  verifyAgentConfig,
} from '../src/main/agent/config'
import { AGENT_OUTPUT_LIMIT, type AgentOutput } from '../src/shared/agent'
import { agentCliFixture } from './agent-cli.helpers'

// Native PTYs and CLI configuration are isolated from Electron and from the user's Codex profile.
test('stable patches in reviewed CLI release families pass configuration validation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-agent-versions-'))
  try {
    const home = join(root, 'codex'),
      workspace = join(root, 'workspace')
    const env = agentEnvironment(
      home,
      workspace,
      JSON.stringify({ port: 1, token: 'a'.repeat(64) }),
    )
    await prepareAgentConfig(home, workspace, true, resolve('out/main'))
    for (const version of ['0.166.0', '0.166.7', '0.167.0', '0.167.2', '0.167.999']) {
      const executable = await agentCliFixture(root, version)
      await verifyAgentConfig(executable, workspace, env, resolve('out/main'))
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('stable CLI patches still require the effective photo-tool restrictions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-agent-restrictions-'))
  try {
    const home = join(root, 'codex'),
      workspace = join(root, 'workspace')
    await prepareAgentConfig(home, workspace, true, resolve('out/main'))
    const env = agentEnvironment(
      home,
      workspace,
      JSON.stringify({ port: 1, token: 'a'.repeat(64) }),
    )
    for (const configOverrides of [
      { 'features.shell_tool': true },
      { 'features.hooks': false },
      { sandbox_mode: 'danger-full-access' },
      { approval_policy: 'on-request' },
      { 'mcp_servers.irodori.enabled_tools': ['exec_command'] },
      { 'skills.bundled.enabled': true },
    ]) {
      const executable = await agentCliFixture(root, '0.167.2', configOverrides)
      await expect(
        verifyAgentConfig(executable, workspace, env, resolve('out/main')),
      ).rejects.toThrow('restrictions')
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('unreviewed, prerelease and malformed CLI versions are refused with the detected version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-agent-unreviewed-'))
  try {
    const home = join(root, 'codex'),
      workspace = join(root, 'workspace')
    await prepareAgentConfig(home, workspace, true, resolve('out/main'))
    const env = agentEnvironment(
      home,
      workspace,
      JSON.stringify({ port: 1, token: 'a'.repeat(64) }),
    )
    for (const version of [
      '0.165.0',
      '0.168.0',
      '1.167.0',
      '0.167.2-alpha.1',
      '0.167.2+build.1',
      '0.167',
      '0.167.2 extra',
      '00.167.2',
      '0.0167.2',
      '0.167.02',
    ]) {
      const executable = await agentCliFixture(root, version)
      await expect(
        verifyAgentConfig(executable, workspace, env, resolve('out/main')),
      ).rejects.toThrow(
        `Detected: "codex-cli ${version}". Supported stable releases: 0.166.x, 0.167.x.`,
      )
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('installed Codex accepts the strict photo configuration without sign-in or model calls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-agent-config-'))
  try {
    const home = join(root, 'codex'),
      workspace = join(root, 'workspace')
    await prepareAgentConfig(home, workspace, true, resolve('out/main'))
    const env = agentEnvironment(
      home,
      workspace,
      JSON.stringify({ port: 1, token: 'a'.repeat(64) }),
    )
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.CODEX_SESSION_ID).toBeUndefined()
    expect(env.NODE_OPTIONS).toBeUndefined()
    expect((await stat(join(home, 'config.toml'))).mode & 0o777).toBe(0o600)
    const executable = await discoverCodex()
    await verifyAgentConfig(executable, workspace, env, resolve('out/main'))
    const trust = `[hooks.state."fixture:stop:0:0"]\ntrusted_hash = "${'a'.repeat(64)}"\n`
    await writeFile(join(home, 'config.toml'), trust)
    await prepareAgentConfig(home, workspace, true, resolve('out/main'))
    expect(await readFile(join(home, 'config.toml'), 'utf8')).toBe(trust)
    await verifyAgentConfig(executable, workspace, env, resolve('out/main'))
    const path = join(home, 'irodori-policy.toml')
    const original = await readFile(path, 'utf8')
    await writeFile(path, original.replace(/^command = .*$/m, 'command = "/unrelated/server"'))
    await expect(
      verifyAgentConfig(executable, workspace, env, resolve('out/main')),
    ).rejects.toThrow('restrictions')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('failed stable-patch restriction validation does not launch the terminal', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'irodori-agent-refused-'))
  let sessions: AgentSessions | undefined
  let gateStarts = 0
  const outputs: AgentOutput[] = []
  try {
    const executable = await agentCliFixture(profile, '0.167.2', {
      'features.shell_tool': true,
    })
    sessions = new AgentSessions({
      profile,
      development: false,
      runtimeDirectory: resolve('out/main'),
      connection: (token: string) => ({ port: 1, token }),
      gate: () => {
        gateStarts++
        throw new Error('A refused CLI must not create a request gate.')
      },
      onState: () => {},
      onOutput: (output) => outputs.push(output),
    })
    await sessions.open()
    await sessions.selectExecutable(executable)
    expect(await sessions.connect('new')).toMatchObject({
      status: 'error',
      message: 'The required Codex restrictions could not be applied. Startup was refused.',
    })
    expect(gateStarts).toBe(0)
    expect(outputs).toEqual([])
    await expect(
      stat(join(profile, 'agent/workspace/fixture-connection.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await sessions?.close()
    await rm(profile, { recursive: true, force: true })
  }
})

test('PTY input, paste, resize, interrupt, output pressure, resume choice and owned-process cleanup', async () => {
  test.setTimeout(45000)
  const profile = await mkdtemp(join(tmpdir(), 'irodori-agent-session-'))
  let gate!: AgentRequestGate
  let sessions!: AgentSessions
  let acknowledge = false
  const outputs: AgentOutput[] = []
  const options = {
    profile,
    development: false,
    runtimeDirectory: resolve('out/main'),
    connection: (token: string) => ({ port: 1, token }),
    gate: (save: (id: string) => Promise<void>) =>
      (gate = new AgentRequestGate(
        async () => ({
          workspace: 'editor',
          activePhotoId: null,
          selectedIds: [],
          transient: { crop: false, saving: false },
        }),
        async () => 0,
        false,
        save,
      )),
    onState: () => {},
    onOutput: (output: AgentOutput) => {
      outputs.push(output)
      if (acknowledge) sessions.acknowledge(output.sessionId, output.sequence)
    },
  }
  try {
    const executable = await agentCliFixture(profile)
    sessions = new AgentSessions(options)
    await sessions.open()
    await sessions.selectExecutable(executable)
    expect((await sessions.connect('new')).status).toBe('connected')
    const id = sessions.get().sessionId
    const record = join(profile, 'agent/workspace/fixture-connection.json')
    await expect
      .poll(async () => {
        try {
          return JSON.parse(await readFile(record, 'utf8')).pid
        } catch {
          return null
        }
      })
      .toBeTruthy()
    const fixture = JSON.parse(await readFile(record, 'utf8'))
    sessions.input(id, 'photo request\r')
    sessions.paste(id, 'unicode 🌻 request', false)
    sessions.resize(id, 87, 19)
    sessions.interrupt(id)
    await expect.poll(() => outputs.map((value) => value.data).join('')).toContain('INTERRUPTED')
    await expect.poll(() => outputs.map((value) => value.data).join('')).toContain('87x19')
    await expect.poll(() => outputs.map((value) => value.data).join('')).toContain('photo request')
    sessions.input(id, 'flood\r')
    await expect
      .poll(() => outputs.reduce((n, value) => n + Buffer.byteLength(value.data), 0))
      .toBeGreaterThan(60 * 1024)
    expect(outputs.reduce((n, value) => n + Buffer.byteLength(value.data), 0)).toBeLessThan(
      AGENT_OUTPUT_LIMIT,
    )
    acknowledge = true
    for (const output of outputs) sessions.acknowledge(output.sessionId, output.sequence)
    await expect.poll(() => outputs.map((value) => value.data).join('')).toContain('FLOOD DONE')
    expect(
      sessions.get().output.reduce((n, value) => n + Buffer.byteLength(value.data), 0),
    ).toBeLessThanOrEqual(AGENT_OUTPUT_LIMIT)
    await gate.begin(fixture.session, 'one')
    await sessions.disconnect()
    expect((await sessions.connect('resume')).status).toBe('connected')
    await sessions.close()
    for (const pid of [fixture.pid, fixture.child])
      await expect
        .poll(() => {
          try {
            process.kill(pid, 0)
            return false
          } catch {
            return true
          }
        })
        .toBe(true)
    sessions = new AgentSessions(options)
    await sessions.open()
    expect(sessions.get()).toMatchObject({ status: 'choice', resumable: true, output: [] })
    expect((await sessions.connect('resume')).status).toBe('connected')
    await expect
      .poll(async () => JSON.parse(await readFile(record, 'utf8')).pid)
      .not.toBe(fixture.pid)
    expect(JSON.parse(await readFile(record, 'utf8')).session).toBe(fixture.session)
    const prior = sessions.get().sessionId
    await sessions.connect('new')
    expect(sessions.get().sessionId).not.toBe(prior)
    expect(sessions.get().resumable).toBe(false)
    expect(() => sessions.input(prior, 'late')).toThrow('no longer')
  } finally {
    await sessions?.close()
    await rm(profile, { recursive: true, force: true })
  }
})
