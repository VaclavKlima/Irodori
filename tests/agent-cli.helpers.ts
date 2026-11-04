import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Deterministic CLI stand-in for PTY/lifecycle tests; it never calls a model or reads credentials. */
export async function agentCliFixture(directory: string) {
  const path = join(directory, 'codex-fixture')
  await writeFile(
    path,
    `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
if (process.argv.includes('--version')) { console.log('codex-cli 0.166.0'); process.exit(0); }
if (process.argv.includes('app-server')) {
  let buffer = '';
  process.stdin.on('data', data => {
    buffer += data; let end;
    while ((end = buffer.indexOf('\\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      if (message.id === 1) console.log(JSON.stringify({ id: 1, result: {} }));
      if (message.id === 2) {
        const text = readFileSync(join(process.env.CODEX_HOME, 'irodori-policy.toml'), 'utf8');
        const entries = text.split('[features]')[1].split('[')[0];
        const setting = key => JSON.parse(text.split('\\n').find(line => line.startsWith(key + ' = ')).slice(key.length + 3));
        const features = Object.fromEntries([...entries.matchAll(/(\\w+) = (true|false)/g)].map(m => [m[1], m[2] === 'true']));
        console.log(JSON.stringify({ id: 2, result: { config: { features, sandbox_mode: 'read-only', approval_policy: 'never', web_search: 'disabled', agents: { enabled: false }, model_instructions_file: setting('model_instructions_file'), mcp_servers: { irodori: { command: setting('command'), args: setting('args'), required: setting('required'), enabled_tools: setting('enabled_tools'), default_tools_approval_mode: setting('default_tools_approval_mode') } }, skills: { bundled: { enabled: false }, include_instructions: false } } } }));
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
