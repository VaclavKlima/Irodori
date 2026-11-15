import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { disabledAgentFeatures } from '../src/main/agent/config'

interface AgentCliFixtureOptions {
  featureDefaults?: Record<string, boolean>
  featureStages?: Record<string, string>
  omitFeatures?: string[]
  ignoredFeatures?: string[]
  featureOutput?: string
  changeInventory?: boolean
  failFeatureList?: boolean
}

/** Deterministic CLI stand-in for PTY/lifecycle tests; it never calls a model or reads credentials. */
export async function agentCliFixture(
  directory: string,
  version = '0.166.0',
  configOverrides: Record<string, unknown> = {},
  options: AgentCliFixtureOptions = {},
) {
  const path = join(directory, 'codex-fixture')
  const invocations = join(directory, 'fixture-invocations.jsonl')
  const probes = join(directory, 'fixture-feature-probes')
  await writeFile(invocations, '')
  await writeFile(probes, '0')
  await writeFile(
    path,
    `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
const options = ${JSON.stringify(options)};
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(invocations)}, JSON.stringify(argv) + '\\n');
if (process.argv.includes('--version')) { console.log(${JSON.stringify(`codex-cli ${version}`)}); process.exit(0); }
if (argv.includes('--profile')) {
  console.error('Named profiles are no longer supported.'); process.exit(1);
}
const overrides = new Map();
for (let i = 0; i < argv.length; i++) if (argv[i] === '-c') {
  const entry = argv[++i], separator = entry.indexOf('=');
  const key = entry.slice(0, separator), value = entry.slice(separator + 1);
  overrides.set(key, key === 'features'
    ? Object.fromEntries([...value.matchAll(/"([^"]+)"\\s*=\\s*(true|false)/g)].map(match => [match[1], match[2] === 'true']))
    : JSON.parse(value));
}
const defaults = { hooks: true, code_mode_host: true, code_mode_interrupt: true, code_mode: false, code_mode_host_grpc: false, ...Object.fromEntries(${JSON.stringify(disabledAgentFeatures)}.map(name => [name, true])), ordinary_feature: true, removed_alias: true, ...options.featureDefaults };
const features = { ...defaults };
const configuredFeatures = { ...(overrides.get('features') ?? {}) };
for (const [path, value] of overrides) if (path.startsWith('features.')) {
  const key = path.slice('features.'.length);
  const name = key.startsWith('"') ? JSON.parse(key) : key;
  configuredFeatures[name] = value;
}
for (const [name, value] of Object.entries(configuredFeatures)) {
  if (!(options.ignoredFeatures ?? []).includes(name)) features[name] = value;
}
if (argv.includes('features') && argv.includes('list')) {
  const count = Number(readFileSync(${JSON.stringify(probes)}, 'utf8'));
  writeFileSync(${JSON.stringify(probes)}, String(count + 1));
  if (options.failFeatureList) { console.error('Feature inventory unavailable.'); process.exit(1); }
  if (options.featureOutput !== undefined) { process.stdout.write(options.featureOutput); process.exit(0); }
  if (count > 0 && options.changeInventory) features.unexpected_tool = true;
  for (const [name, value] of Object.entries(features)) {
    if ((options.omitFeatures ?? []).includes(name)) continue;
    const stage = options.featureStages?.[name] ?? (name === 'removed_alias' ? 'removed' : 'stable');
    console.log(name + '\\t' + stage + '\\t' + value);
  }
  process.exit(0);
}
if (process.argv.includes('app-server')) {
  let buffer = '';
  process.stdin.on('data', data => {
    buffer += data; let end;
    while ((end = buffer.indexOf('\\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      if (message.id === 1) console.log(JSON.stringify({ id: 1, result: {} }));
      if (message.id === 2) {
        const text = readFileSync(join(process.env.CODEX_HOME, 'irodori-policy.toml'), 'utf8');
        const setting = key => JSON.parse(text.split('\\n').find(line => line.startsWith(key + ' = ')).slice(key.length + 3));
        const config = { features: configuredFeatures, sandbox_mode: 'read-only', approval_policy: 'never', web_search: 'disabled', project_doc_max_bytes: 0, allow_login_shell: false, plugins: { _default: { enabled: false } }, agents: { enabled: false }, model_instructions_file: setting('model_instructions_file'), mcp_servers: { irodori: { command: setting('command'), args: setting('args'), required: setting('required'), enabled_tools: setting('enabled_tools'), default_tools_approval_mode: setting('default_tools_approval_mode') } }, skills: { bundled: { enabled: false }, include_instructions: false } };
        for (const [path, value] of Object.entries(${JSON.stringify(configOverrides)})) {
          const keys = path.split('.'), key = keys.pop();
          const target = keys.reduce((object, key) => object[key], config);
          target[key] = value;
        }
        console.log(JSON.stringify({ id: 2, result: { config } }));
      }
    }
  });
} else {
  process.stdin.setRawMode(true);
  const session = process.argv.includes('resume') ? process.argv.at(-1) : randomUUID();
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const link = 'https://auth.openai.com/oauth/authorize?client_id=fixture&state=fixture&code_challenge=fixture&redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback';
  writeFileSync(join(process.cwd(), 'fixture-connection.json'), JSON.stringify({ link, connection: JSON.parse(process.env.IRODORI_AGENT_CONNECTION), session, pid: process.pid, child: child.pid }));
  console.log('IRODORI TEST CODEX ' + session);
  const osc = String.fromCharCode(27) + ']8;;', end = String.fromCharCode(27, 92);
  console.log(osc + link + end + 'Sign in' + osc + end);
  process.on('SIGWINCH', () => console.log('SIZE ' + process.stdout.columns + 'x' + process.stdout.rows));
  process.on('SIGTERM', () => { child.once('exit', () => process.exit(0)); child.kill(); });
  process.stdin.on('data', data => {
    const text = data.toString();
    if (text.includes('\\x03')) console.log('INTERRUPTED');
    else if (text.includes('flood')) { for (let i = 0; i < 200; i++) process.stdout.write('flood-' + i + ' ' + 'x'.repeat(2048) + '\\r\\n'); console.log('FLOOD DONE'); }
    else console.log('INPUT ' + text.replaceAll('\\r', '<ENTER>'));
  });
}
`,
    { mode: 0o755 },
  )
  return path
}

export async function runAgentHook(env: Record<string, string>, event: Record<string, unknown>) {
  const { execFile } = await import('node:child_process')
  const { resolve } = await import('node:path')
  return new Promise<string>((accept, reject) => {
    const child = execFile(
      process.execPath,
      [resolve('out/main/agent-hook.mjs')],
      { env: { ...process.env, ...env }, timeout: 30000 },
      (error, stdout, stderr) =>
        error ? reject(new Error(stderr || error.message)) : accept(stdout),
    )
    child.stdin!.end(JSON.stringify(event))
  })
}
