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
  let section = ''
  for (const line of (await readFile(join(home, 'irodori-policy.toml'), 'utf8')).split('\n')) {
    if (!line.trim()) continue
    if (line.startsWith('[') && line.endsWith(']')) {
      section = line.slice(1, -1)
      continue
    }
    const match = line.match(/^([a-zA-Z_][\w]*)\s*=\s*(.+)$/)
    if (!match) throw new Error('Invalid generated Codex policy.')
    args.push('-c', `${section ? `${section}.` : ''}${match[1]}=${match[2]}`)
  }
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
  // A new CLI needs an explicit compatibility review, particularly for default tool additions.
  if (stdout.trim() !== 'codex-cli 0.166.0')
    throw new Error(
      'This Codex version has not been verified for the restricted photo console. Supported: 0.166.0.',
    )
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
              config.agents?.enabled !== false ||
              config.features?.hooks !== true ||
              disabledAgentFeatures.some((key) => config.features?.[key] !== false) ||
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
