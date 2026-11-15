import { expect, test } from '@playwright/test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { AgentSessions } from '../src/main/agent/sessions'
import { AgentRequestGate } from '../src/main/agent/request-gate'
import {
  agentEnvironment,
  agentConfigOverrides,
  discoverCodex,
  prepareAgentConfig,
  verifyAgentConfig,
} from '../src/main/agent/config'
import { AGENT_OUTPUT_LIMIT, type AgentOutput } from '../src/shared/agent'
import { agentCliFixture } from './agent-cli.helpers'

// Native PTYs and CLI configuration are isolated from Electron and from the user's Codex profile.
test('current and future stable CLI releases pass capability validation without a release list', async () => {
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
    for (const version of ['0.166.0', '0.167.2', '0.168.0', '0.999.1', '1.0.0']) {
      const executable = await agentCliFixture(root, version)
      await verifyAgentConfig(executable, workspace, env, resolve('out/main'))
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('future stable CLI releases still require the effective photo-tool restrictions', async () => {
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
      { 'features.code_mode_host': false },
      { 'features.code_mode_interrupt': false },
      { sandbox_mode: 'danger-full-access' },
      { approval_policy: 'on-request' },
      { 'mcp_servers.irodori.enabled_tools': ['exec_command'] },
      { 'skills.bundled.enabled': true },
      { 'plugins._default.enabled': true },
      { project_doc_max_bytes: 32768 },
      { allow_login_shell: true },
    ]) {
      const executable = await agentCliFixture(root, '0.168.0', configOverrides)
      await expect(
        verifyAgentConfig(executable, workspace, env, resolve('out/main')),
      ).rejects.toThrow('restrictions')
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('older, prerelease and malformed CLI versions are refused with the detected version', async () => {
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
      ).rejects.toThrow(`Detected: "codex-cli ${version}"`)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('new default-enabled features are disabled in the dedicated configuration inspected before terminal startup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-agent-new-features-'))
  try {
    const home = join(root, 'codex'),
      workspace = join(root, 'workspace')
    await prepareAgentConfig(home, workspace, true, resolve('out/main'))
    const env = agentEnvironment(
      home,
      workspace,
      JSON.stringify({ port: 1, token: 'a'.repeat(64) }),
    )
    const executable = await agentCliFixture(
      root,
      '0.168.0',
      {},
      {
        featureDefaults: { future_tool: true, 'future.tool_2': true, future_experiment: false },
        featureStages: {
          future_tool: 'under development',
          'future.tool_2': 'experimental',
          future_experiment: 'deprecated',
          remote_control: 'removed',
        },
      },
    )
    await verifyAgentConfig(executable, workspace, env, resolve('out/main'))
    const policy = await readFile(join(home, 'irodori-policy.toml'), 'utf8')
    expect(policy).toContain('"future_tool" = false')
    expect(policy).toContain('"future.tool_2" = false')
    expect(policy).toContain('"future_experiment" = false')
    expect(policy).toContain('"code_mode_host" = true')
    expect(policy).toContain('"code_mode_interrupt" = true')
    expect(policy).toContain('"code_mode" = false')
    expect(policy).toContain('"code_mode_host_grpc" = false')
    expect(policy).not.toContain('"remote_control"')
    const invocations = (await readFile(join(root, 'fixture-invocations.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line): string[] => JSON.parse(line))
    const probes = invocations.filter((args) => args.includes('features'))
    expect(probes).toHaveLength(2)
    const configProbe = invocations.find((args) => args.includes('app-server'))!
    expect(configProbe).toBeTruthy()
    const generated = await agentConfigOverrides(home)
    for (const args of [...probes, configProbe]) {
      expect(args).not.toContain('--profile')
    }
    const overrides = (args: string[]) => args.filter((_, i) => args[i - 1] === '-c')
    expect(overrides(probes[1])).toEqual(overrides(generated))
    expect(overrides(configProbe)).toEqual(overrides(generated))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('photo-tool execution infrastructure is enabled without enabling unrelated tool capabilities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-agent-tool-host-'))
  try {
    const home = join(root, 'codex'),
      workspace = join(root, 'workspace')
    const env = agentEnvironment(
      home,
      workspace,
      JSON.stringify({ port: 1, token: 'a'.repeat(64) }),
    )
    for (const ignoredFeatures of [[], ['code_mode_host'], ['code_mode_interrupt']]) {
      await prepareAgentConfig(home, workspace, true, resolve('out/main'))
      const executable = await agentCliFixture(
        root,
        '0.168.0',
        {},
        {
          featureDefaults: {
            code_mode_host: false,
            code_mode_interrupt: false,
            code_mode: true,
            code_mode_host_grpc: true,
          },
          ignoredFeatures,
        },
      )
      if (ignoredFeatures.length === 0) {
        await verifyAgentConfig(executable, workspace, env, resolve('out/main'))
        const policy = await readFile(join(home, 'irodori-policy.toml'), 'utf8')
        expect(policy).toContain('"code_mode_host" = true')
        expect(policy).toContain('"code_mode_interrupt" = true')
        expect(policy).toContain('"code_mode" = false')
        expect(policy).toContain('"code_mode_host_grpc" = false')
        expect(policy).toContain('"shell_tool" = false')
        expect(policy).toContain('"apps" = false')
        expect(policy).toContain('"browser_use" = false')
      } else {
        await expect(
          verifyAgentConfig(executable, workspace, env, resolve('out/main')),
        ).rejects.toThrow(/feature|restriction/i)
        const invocations = await readFile(join(root, 'fixture-invocations.jsonl'), 'utf8')
        expect(invocations).not.toContain('app-server')
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('older CLIs without the tool-host feature retain their existing photo-tool transport', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-agent-legacy-tool-host-'))
  try {
    const home = join(root, 'codex'),
      workspace = join(root, 'workspace')
    await prepareAgentConfig(home, workspace, true, resolve('out/main'))
    const env = agentEnvironment(
      home,
      workspace,
      JSON.stringify({ port: 1, token: 'a'.repeat(64) }),
    )
    const executable = await agentCliFixture(
      root,
      '0.166.0',
      {},
      { omitFeatures: ['code_mode_host'] },
    )
    await verifyAgentConfig(executable, workspace, env, resolve('out/main'))
    const policy = await readFile(join(home, 'irodori-policy.toml'), 'utf8')
    expect(policy).not.toContain('"code_mode_host"')
    expect(policy).toContain('"code_mode" = false')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('dropping the already-retired remote-control alias does not block active restriction validation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-agent-retired-alias-'))
  try {
    const home = join(root, 'codex'),
      workspace = join(root, 'workspace')
    await prepareAgentConfig(home, workspace, true, resolve('out/main'))
    const env = agentEnvironment(
      home,
      workspace,
      JSON.stringify({ port: 1, token: 'a'.repeat(64) }),
    )
    const executable = await agentCliFixture(
      root,
      '0.168.0',
      {},
      { omitFeatures: ['remote_control'] },
    )
    await verifyAgentConfig(executable, workspace, env, resolve('out/main'))
    const policy = await readFile(join(home, 'irodori-policy.toml'), 'utf8')
    expect(policy).not.toContain('remote_control')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('missing, malformed and changing feature inventories refuse compatibility validation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-agent-feature-inventory-'))
  try {
    const home = join(root, 'codex'),
      workspace = join(root, 'workspace')
    const env = agentEnvironment(
      home,
      workspace,
      JSON.stringify({ port: 1, token: 'a'.repeat(64) }),
    )
    const cases: NonNullable<Parameters<typeof agentCliFixture>[3]>[] = [
      { failFeatureList: true },
      { featureOutput: '' },
      { featureOutput: 'hooks stable true\nhooks stable true\n' },
      { featureOutput: 'hooks stable true\nunknown stable perhaps\n' },
      { featureOutput: 'hooks stable true\ninvalid-name stable false\n' },
      { featureOutput: 'hooks stable true\nunknown mysterious false\n' },
      { featureOutput: 'hooks stable true\n' + 'x'.repeat(3 * 1024 * 1024) },
      { omitFeatures: ['hooks'] },
      { omitFeatures: ['shell_tool'] },
      { featureStages: { shell_tool: 'removed' } },
      { changeInventory: true },
      { featureDefaults: { future_tool: true }, ignoredFeatures: ['future_tool'] },
    ]
    for (const options of cases) {
      await prepareAgentConfig(home, workspace, true, resolve('out/main'))
      const executable = await agentCliFixture(root, '0.168.0', {}, options)
      await expect(
        verifyAgentConfig(executable, workspace, env, resolve('out/main')),
      ).rejects.toThrow(/feature|restriction/i)
      const invocations = await readFile(join(root, 'fixture-invocations.jsonl'), 'utf8')
      expect(invocations).not.toContain('app-server')
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a mandatory unified-exec backend is accepted only while shell execution and terminal allocation stay disabled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-agent-unified-exec-'))
  try {
    const home = join(root, 'codex'),
      workspace = join(root, 'workspace')
    const env = agentEnvironment(
      home,
      workspace,
      JSON.stringify({ port: 1, token: 'a'.repeat(64) }),
    )
    for (const ignoredFeatures of [
      ['unified_exec'],
      ['unified_exec', 'shell_tool'],
      ['unified_exec', 'unified_exec_tty'],
    ]) {
      await prepareAgentConfig(home, workspace, true, resolve('out/main'))
      const executable = await agentCliFixture(
        root,
        '0.168.0',
        {},
        { featureDefaults: { unified_exec: true, unified_exec_tty: true }, ignoredFeatures },
      )
      if (ignoredFeatures.length === 1) {
        await verifyAgentConfig(executable, workspace, env, resolve('out/main'))
      } else {
        await expect(
          verifyAgentConfig(executable, workspace, env, resolve('out/main')),
        ).rejects.toThrow(/feature|restriction/i)
      }
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
    const policy = await readFile(join(home, 'irodori-policy.toml'), 'utf8')
    expect(policy).toContain('"code_mode_host" = true')
    expect(policy).toContain('"code_mode_interrupt" = true')
    expect(policy).toContain('"code_mode" = false')
    expect(policy).toContain('"shell_tool" = false')
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
    const executable = await agentCliFixture(
      profile,
      '0.168.0',
      {},
      { featureDefaults: { future_tool: true } },
    )
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
    const invocations: string[][] = (
      await readFile(join(profile, 'fixture-invocations.jsonl'), 'utf8')
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const terminalArgs = invocations.find(
      (args) =>
        !args.includes('--version') && !args.includes('features') && !args.includes('app-server'),
    )!
    expect(terminalArgs).not.toContain('--profile')
    const terminalOverrides = terminalArgs.filter((_, i) => terminalArgs[i - 1] === '-c')
    const inspected = invocations.find((args) => args.includes('app-server'))!
    expect(terminalOverrides).toEqual(inspected.filter((_, i) => inspected[i - 1] === '-c'))
    expect(terminalOverrides.find((value) => value.startsWith('features='))).toContain(
      '"future_tool" = false',
    )
    expect(terminalOverrides.find((value) => value.startsWith('features='))).toContain(
      '"code_mode_host" = true',
    )
    expect(terminalOverrides.find((value) => value.startsWith('features='))).toContain(
      '"code_mode_interrupt" = true',
    )
    expect(terminalOverrides.find((value) => value.startsWith('features='))).toContain(
      '"code_mode" = false',
    )
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
