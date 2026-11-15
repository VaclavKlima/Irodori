import { execFile, spawn } from 'node:child_process'
import { chmod, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, delimiter } from 'node:path'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import { agentInstructions, agentTools } from './policy'

export function bundledNodeExecutable() {
  const require = createRequire(import.meta.url)
  return join(
    dirname(
      require.resolve(
        `node-${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}/package.json`,
      ),
    ),
    'bin',
    process.platform === 'win32' ? 'node.exe' : 'node',
  ).replace('app.asar/', 'app.asar.unpacked/')
}

/** Never inherit the development agent's credentials, endpoints, session or configuration. */
export function agentEnvironment(home: string, workspace: string, connection: string) {
  const env: Record<string, string> = {}
  for (const key of [
    'HOME',
    'USERPROFILE',
    'SystemRoot',
    'WINDIR',
    'COMSPEC',
    'TMP',
    'TEMP',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TZ',
    'XDG_RUNTIME_DIR',
    'DISPLAY',
    'WAYLAND_DISPLAY',
    'DBUS_SESSION_BUS_ADDRESS',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'NODE_EXTRA_CA_CERTS',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'NO_PROXY',
    'https_proxy',
    'http_proxy',
    'no_proxy',
  ])
    if (process.env[key]) env[key] = process.env[key]!
  env.PATH = [dirname(bundledNodeExecutable()), process.env.PATH ?? ''].join(delimiter)
  env.CODEX_HOME = home
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.IRODORI_AGENT_CONNECTION = connection
  env.IRODORI_AGENT_REQUEST = join(workspace, 'request.json')
  env.IRODORI_AGENT_TOOLS = JSON.stringify(agentTools)
  return env
}

export async function discoverCodex(selected?: string) {
  const paths = selected
    ? [selected]
    : [
        ...(process.env.PATH ?? '')
          .split(delimiter)
          .filter(Boolean)
          .map((path) => join(path, process.platform === 'win32' ? 'codex.exe' : 'codex')),
        join(homedir(), '.local', 'bin', 'codex'),
        '/opt/homebrew/bin/codex',
        '/usr/local/bin/codex',
        '/home/linuxbrew/.linuxbrew/bin/codex',
      ]
  for (const candidate of paths) {
    try {
      const path = await realpath(candidate)
      if (!(await stat(path)).isFile() || /\.(cmd|bat)$/i.test(path)) continue
      await access(path, constants.X_OK)
      return path
    } catch {
      /* Try the next installed executable. */
    }
  }
  throw new Error('Codex was not found. Install Codex or use Choose Codex executable.')
}

export const disabledAgentFeatures = [
  'shell_tool',
  'unified_exec',
  'apps',
  'plugins',
  'remote_plugin',
  'remote_control',
  'tool_suggest',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'computer_use',
  'in_app_browser',
  'view_image',
  'image_generation',
  'multi_agent',
  'multi_agent_v2',
  'memories',
  'skill_mcp_dependency_install',
  'request_permissions_tool',
  'goals',
] as const

/** The generated policy uses single-line JSON-compatible TOML values only. */
export async function agentConfigOverrides(home: string): Promise<string[]> {
  const args: string[] = []
  const features: string[] = []
  let section = ''
  for (const line of (await readFile(join(home, 'irodori-policy.toml'), 'utf8')).split('\n')) {
    if (!line.trim()) continue
    if (line.startsWith('[') && line.endsWith(']')) {
      section = line.slice(1, -1)
      continue
    }
    const match = line.match(/^([a-zA-Z_][\w]*|"[a-z][a-z0-9_.]*")\s*=\s*(.+)$/)
    if (!match) throw new Error('Invalid generated Codex policy.')
    // CLI dotted overrides split literal dots and do not decode quoted path segments.
    // One TOML table preserves feature names exactly, including future dotted names.
    if (section === 'features') {
      features.push(`${match[1]} = ${match[2]}`)
      continue
    }
    args.push('-c', `${section ? `${section}.` : ''}${match[1]}=${match[2]}`)
  }
  args.push('-c', `features={${features.join(', ')}}`)
  return args
}
const quoted = (text: string) => JSON.stringify(text)
const shellQuote = (text: string) =>
  process.platform === 'win32'
    ? `"${text.replaceAll('"', '""')}"`
    : `'${text.replaceAll("'", "'\\''")}'`

export async function prepareAgentConfig(
  home: string,
  workspace: string,
  development: boolean,
  runtimeDirectory = import.meta.dirname,
) {
  await mkdir(home, { recursive: true, mode: 0o700 })
  await mkdir(workspace, { recursive: true, mode: 0o700 })
  await chmod(home, 0o700)
  const node = bundledNodeExecutable()
  const hook = `${shellQuote(node)} ${shellQuote(join(runtimeDirectory, 'agent-hook.mjs'))}`
  const instructions = join(home, 'photo-agent.md')
  await writeFile(instructions, agentInstructions(development), { mode: 0o600 })
  const config =
    [
      'approval_policy = "never"',
      'sandbox_mode = "read-only"',
      'web_search = "disabled"',
      'cli_auth_credentials_store = "file"',
      'check_for_update_on_startup = false',
      'project_doc_max_bytes = 0',
      'allow_login_shell = false',
      `model_instructions_file = ${quoted(instructions)}`,
      '[agents]',
      'enabled = false',
      '[skills]',
      'include_instructions = false',
      '[skills.bundled]',
      'enabled = false',
      '[features]',
      'hooks = true',
      ...disabledAgentFeatures.map((key) => `${key} = false`),
      '[plugins._default]',
      'enabled = false',
      '[mcp_servers.irodori]',
      `command = ${quoted(node)}`,
      `args = [${quoted(join(runtimeDirectory, 'editor-mcp.js'))}]`,
      'required = true',
      'default_tools_approval_mode = "approve"',
      'startup_timeout_sec = 30',
      'tool_timeout_sec = 120',
      `env_vars = ["IRODORI_AGENT_CONNECTION", "IRODORI_AGENT_REQUEST"]`,
      `enabled_tools = ${JSON.stringify(agentTools)}`,
      '[history]',
      'persistence = "save-all"',
      'max_bytes = 16777216',
      '[tui]',
      'show_tooltips = false',
    ].join('\n') + '\n'
  // Codex owns base preferences, including normal hook-trust hashes. Keep policy in its own layer.
  try {
    await writeFile(join(home, 'config.toml'), '', { mode: 0o600, flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  await writeFile(join(home, 'irodori-policy.toml'), config, { mode: 0o600 })
  const handler = { type: 'command', command: hook, timeout: 30 }
  await writeFile(
    join(home, 'hooks.json'),
    JSON.stringify(
      {
        description: 'Irodori frozen photo targets and tool restrictions',
        hooks: {
          UserPromptSubmit: [{ hooks: [{ ...handler, additionalContextLimit: 6000 }] }],
          PreToolUse: [{ matcher: '*', hooks: [handler] }],
          Stop: [{ hooks: [handler] }],
          Interrupt: [{ hooks: [handler] }],
        },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  )
}

type AgentFeature = { stage: string; enabled: boolean }
// Codex routes MCP tools through its execution host even when code mode is not opted in.
// This infrastructure does not enable shell tools or add any MCP capabilities.
const enabledAgentFeatures = new Set(['hooks', 'code_mode_host', 'code_mode_interrupt'])
// This retired alias is absent from some inventories; active tool gates remain required.
const requiredAgentFeatures = [
  'hooks',
  ...disabledAgentFeatures.filter((name) => name !== 'remote_control'),
]

/** Inventory is read from the installed CLI, including flags added by future releases. */
async function agentFeatures(executable: string, workspace: string, env: Record<string, string>) {
  let stdout: string
  try {
    ;({ stdout } = await promisify(execFile)(
      executable,
      [
        '--no-daemon',
        ...(await agentConfigOverrides(env.CODEX_HOME)),
        '-C',
        workspace,
        'features',
        'list',
      ],
      { env, timeout: 10_000, maxBuffer: 256 * 1024 },
    ))
  } catch (error) {
    const reason = (error as { stderr?: string }).stderr ?? String(error)
    throw new Error(
      `Codex feature compatibility could not be inspected. Startup was refused. ${reason.slice(-1200)}`,
      { cause: error },
    )
  }
  const features = new Map<string, AgentFeature>()
  for (const line of stdout.trim().split(/\r?\n/)) {
    const match = line.match(
      /^([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*)\s+(stable|under development|experimental|deprecated|removed)\s+(true|false)\s*$/,
    )
    if (!match || features.has(match[1]))
      throw new Error('Codex returned an invalid feature inventory. Startup was refused.')
    features.set(match[1], { stage: match[2], enabled: match[3] === 'true' })
  }
  if (
    requiredAgentFeatures.some(
      (name) => !features.has(name) || features.get(name)!.stage === 'removed',
    )
  )
    throw new Error('Codex is missing required restriction features. Startup was refused.')
  return features
}

async function restrictAgentFeatures(
  executable: string,
  workspace: string,
  env: Record<string, string>,
) {
  const features = await agentFeatures(executable, workspace, env)
  // Closed by default except the hooks and execution infrastructure needed for photo tools.
  // Removed aliases have no runtime effect and may report immutable legacy defaults.
  const flags = new Map<string, boolean>()
  for (const [name, feature] of features)
    if (feature.stage !== 'removed') flags.set(name, enabledAgentFeatures.has(name))
  const path = join(env.CODEX_HOME, 'irodori-policy.toml')
  const policy = await readFile(path, 'utf8')
  await writeFile(
    path,
    policy.replace(
      /\[features\]\n[^[]*/,
      `[features]\n${[...flags].map(([name, enabled]) => `${quoted(name)} = ${enabled}`).join('\n')}\n`,
    ),
    { mode: 0o600 },
  )
  const effective = await agentFeatures(executable, workspace, env)
  if (
    features.size !== effective.size ||
    [...features].some(([name, feature]) => {
      const actual = effective.get(name)
      return (
        !actual ||
        actual.stage !== feature.stage ||
        (actual.stage !== 'removed' &&
          actual.enabled !== enabledAgentFeatures.has(name) &&
          // Newer CLIs force this execution-engine selector on. It cannot expose
          // command tools while the separately verified shell_tool capability is off.
          !(
            name === 'unified_exec' &&
            effective.get('shell_tool')?.enabled === false &&
            effective.get('unified_exec_tty')?.enabled === false
          ))
      )
    })
  )
    throw new Error(
      'The required Codex feature restrictions could not be applied. Startup was refused.',
    )
  return flags
}

/** Strict parsing and the effective config are checked without signing in or starting a model turn. */
export async function verifyAgentConfig(
  executable: string,
  workspace: string,
  env: Record<string, string>,
  runtimeDirectory = import.meta.dirname,
) {
  const { stdout } = await promisify(execFile)(executable, ['--version'], {
    env,
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  })
  // Version is a protocol floor, not a list requiring an app update for every CLI release.
  const reportedVersion = stdout.trim()
  const version = reportedVersion.match(/^codex-cli (0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
  if (!version || (Number(version[1]) === 0 && Number(version[2]) < 166))
    throw new Error(
      `The photo console requires a stable Codex release from 0.166.0 onward. Detected: ${JSON.stringify(reportedVersion.slice(0, 120))}.`,
    )
  const featureRestrictions = await restrictAgentFeatures(executable, workspace, env)
  // Strict preflight and the terminal use the identical generated policy overrides.
  const args = [
    '--no-daemon',
    '--strict-config',
    ...(await agentConfigOverrides(env.CODEX_HOME)),
    '-C',
    workspace,
    'app-server',
    '--stdio',
  ]
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let buffer = '',
      bytes = 0,
      diagnostics = '',
      finished = false
    const finish = (error?: Error) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      child.stdin.end()
      child.kill('SIGKILL')
      child.once('close', () => (error ? reject(error) : resolve()))
    }
    const timer = setTimeout(
      () => finish(new Error('Codex configuration validation timed out.')),
      15_000,
    )
    child.on('error', (error) => finish(error))
    child.stderr.on('data', (value) => {
      diagnostics = (diagnostics + value).slice(-1200)
    })
    child.on('exit', () => {
      if (!finished) finish(new Error(`Codex refused its restricted configuration. ${diagnostics}`))
    })
    child.stdout.on('data', (value) => {
      bytes += value.length
      if (bytes > 2 * 1024 * 1024)
        return finish(new Error('Codex returned an oversized configuration.'))
      buffer += value.toString()
      let end: number
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        try {
          const response = JSON.parse(line)
          if (response.id === 1) {
            if (response.error) throw new Error(response.error.message)
            child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n')
            child.stdin.write(
              JSON.stringify({ id: 2, method: 'config/read', params: { includeLayers: false } }) +
                '\n',
            )
          } else if (response.id === 2) {
            const config = response.result?.config
            const server = config?.mcp_servers?.irodori
            if (
              !config ||
              config.sandbox_mode !== 'read-only' ||
              config.approval_policy !== 'never' ||
              config.web_search !== 'disabled' ||
              config.project_doc_max_bytes !== 0 ||
              config.allow_login_shell !== false ||
              config.plugins?._default?.enabled !== false ||
              config.agents?.enabled !== false ||
              config.features?.hooks !== true ||
              [...featureRestrictions].some(
                ([name, enabled]) => config.features?.[name] !== enabled,
              ) ||
              Object.entries(config.features ?? {}).some(
                ([name, enabled]) => enabled !== enabledAgentFeatures.has(name),
              ) ||
              Object.keys(config.mcp_servers ?? {}).join(',') !== 'irodori' ||
              config.skills?.bundled?.enabled !== false ||
              config.skills?.include_instructions !== false ||
              config.model_instructions_file !== join(env.CODEX_HOME, 'photo-agent.md') ||
              server?.command !== bundledNodeExecutable() ||
              JSON.stringify(server?.args) !==
                JSON.stringify([join(runtimeDirectory, 'editor-mcp.js')]) ||
              JSON.stringify([...(server?.enabled_tools ?? [])].sort()) !==
                JSON.stringify([...agentTools].sort()) ||
              server?.required !== true ||
              server?.default_tools_approval_mode !== 'approve'
            )
              throw new Error(
                'The required Codex restrictions could not be applied. Startup was refused.',
              )
            finish()
          }
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)))
        }
      }
    })
    child.stdin.write(
      JSON.stringify({
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'irodori-console', version: '1' }, capabilities: {} },
      }) + '\n',
    )
  })
}
