/* eslint-disable no-empty-pattern -- Playwright requires destructured fixtures when only testInfo is used. */
import { test, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createConnection } from 'node:net'
import { processExists } from '../scripts/development-supervisor.mjs'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'irodori-launcher-model-'))
  const messages: string[] = []
  await Promise.all(
    ['scripts', 'node_modules/electron', 'node_modules/electron-vite/bin'].map((name) =>
      mkdir(join(root, name), { recursive: true }),
    ),
  )
  for (const name of ['dev-mcp.mjs', 'development-supervisor.mjs', 'development-protocol.mjs']) {
    const source = await readFile(join('scripts', name), 'utf8')
    await writeFile(
      join(root, 'scripts', name),
      source.replace(
        "probe.listen(9222, '127.0.0.1', resolve)",
        "probe.listen(0, '127.0.0.1', resolve)",
      ),
    )
  }
  await writeFile(join(root, 'node_modules/electron/package.json'), '{"main":"index.cjs"}')
  await writeFile(
    join(root, 'node_modules/electron/index.cjs'),
    "module.exports = 'fixture-runtime'",
  )
  await writeFile(
    join(root, 'node_modules/electron-vite/bin/electron-vite.js'),
    `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
fs.writeFileSync('vite.pid', String(process.pid));
fs.writeFileSync('supervisor.json', JSON.stringify({port:process.env.IRODORI_DEV_SUPERVISOR_PORT}));
const apps = [];
function launch() {
  const number = apps.length + 1;
  const app = spawn(process.execPath, ['app.mjs', String(number)], {stdio:'ignore'});
  apps.push(app);
  fs.writeFileSync('app-' + number + '.pid', String(app.pid));
}
launch();
const descendant = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'});
fs.writeFileSync('descendant.pid', String(descendant.pid));
setInterval(() => { if(fs.existsSync('replacement') && apps.length === 1) launch(); }, 20);
`,
  )
  await writeFile(
    join(root, 'app.mjs'),
    `
import { readFile, writeFile, access } from 'node:fs/promises';
import { connectDevelopmentSupervisor } from ${JSON.stringify(pathToFileURL(resolve('src/main/development-lifecycle.ts')).href)};
const number = process.argv[2];
let count = 0;
const client = connectDevelopmentSupervisor(async reason => {
  const current = ++count;
  await writeFile('request-' + number + '-' + current, reason);
  let answer;
  while(!answer) { try { answer = await readFile('answer-' + number + '-' + current,'utf8') } catch { await new Promise(r=>setTimeout(r,20)) } }
  if(answer === 'keep') return 'kept-open';
  client.closing(0);
  setTimeout(()=>process.exit(0), 150);
  return 'closing';
});
setInterval(async () => { try { await access('exit-' + number); process.exit(0) } catch { /* The fixture process has already exited. */ } }, 20);
`,
  )
  const child = spawn(process.execPath, ['scripts/dev-mcp.mjs'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout!.on('data', (data: Buffer) => messages.push(data.toString()))
  child.stderr!.on('data', (data: Buffer) => messages.push(data.toString()))
  const pid = async (name: string) => Number(await readFile(join(root, name + '.pid'), 'utf8'))
  const waitFile = async (name: string, expected?: string) => {
    await expect
      .poll(async () => readFile(join(root, name), 'utf8').catch(() => ''), { timeout: 10_000 })
      .toMatch(expected ? new RegExp(`^${expected}$`) : /.+/)
    return readFile(join(root, name), 'utf8')
  }
  await waitFile('app-1.pid')
  // Registration has no fixture-only timing override; wait for an actual request below.
  return {
    root,
    child,
    messages,
    pid,
    waitFile,
    write: (name: string, value = '') => writeFile(join(root, name), value),
    async exited(code: number) {
      await expect.poll(() => child.exitCode, { timeout: 10_000 }).toBe(code)
      expect(child.signalCode).toBeNull()
      expect(await processExists(await pid('app-1'))).toBe(false)
      await expect.poll(async () => processExists(await pid('descendant'))).toBe(false)
    },
    async cleanup() {
      // Teardown is never the process-exit assertion.
      await writeFile(join(root, 'exit-1'), '')
      await writeFile(join(root, 'exit-2'), '')
      const vite = await pid('vite').catch(() => 0)
      if (vite) {
        try {
          process.kill(-vite, 'SIGKILL')
        } catch {
          /* The fixture process has already exited. */
        }
      }
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit')
        child.kill('SIGKILL')
        await exited
      }
      await rm(root, { recursive: true, force: true })
    },
  }
}

test('launcher SIGINT/SIGTERM join recovery; Keep open retains Vite; closing/socket EOF never substitutes for actual exit', async ({}, info) => {
  test.skip(
    process.platform === 'win32',
    'Unix process-group signal acceptance; Windows remains unverified.',
  )
  const f = await fixture()
  try {
    f.child.kill('SIGINT')
    await f.waitFile('request-1-1', 'development-stop')
    f.child.kill('SIGTERM')
    await f.write('answer-1-1', 'keep')
    await expect.poll(() => f.messages.join('')).toContain('stop cancelled')
    expect(await processExists(await f.pid('vite'))).toBe(true)
    expect(await processExists(await f.pid('app-1'))).toBe(true)
    await expect(access(join(f.root, 'request-1-2'))).rejects.toThrow()
    f.child.kill('SIGTERM')
    await f.waitFile('request-1-2', 'development-stop')
    await f.write('answer-1-2', 'quit')
    expect(f.child.exitCode).toBeNull()
    await f.exited(0)
  } finally {
    await writeFile(info.outputPath('launcher.log'), f.messages.join(''))
    await f.cleanup()
  }
})

test('unexpected Vite exit recovers every replacement instance and waits for all live applications before descendant cleanup', async ({}, info) => {
  test.skip(
    process.platform === 'win32',
    'Unix process-group ownership; Windows remains unverified.',
  )
  const f = await fixture()
  try {
    f.child.kill('SIGINT')
    await f.waitFile('request-1-1')
    await f.write('answer-1-1', 'keep')
    await expect.poll(() => f.messages.join('')).toContain('stop cancelled')
    await f.write('replacement')
    await f.waitFile('app-2.pid')
    // A replacement also authenticates; signal it before losing Vite to establish registration.
    f.child.kill('SIGINT')
    await f.waitFile('request-1-2')
    await f.waitFile('request-2-1')
    await f.write('answer-1-2', 'keep')
    await f.write('answer-2-1', 'keep')
    await expect.poll(() => f.messages.join('').split('stop cancelled').length).toBe(4)
    process.kill(await f.pid('vite'), 'SIGKILL')
    await f.waitFile('request-1-3', 'development-lost')
    await f.waitFile('request-2-2', 'development-lost')
    await f.write('answer-1-3', 'keep')
    await f.write('answer-2-2', 'keep')
    await expect.poll(() => f.messages.join('')).toContain('Development has ended')
    await f.write('exit-1')
    await expect.poll(async () => processExists(await f.pid('app-1'))).toBe(false)
    expect(f.child.exitCode).toBeNull()
    expect(await processExists(await f.pid('app-2'))).toBe(true)
    expect(await processExists(await f.pid('descendant'))).toBe(true)
    await f.write('exit-2')
    await f.exited(1)
  } finally {
    await writeFile(info.outputPath('launcher.log'), f.messages.join(''))
    await f.cleanup()
  }
})

test('supervisor connection loss enters recovery once and Keep open preserves the application', async ({}, info) => {
  test.skip(
    process.platform === 'win32',
    'Unix supervisor loss acceptance; Windows remains unverified.',
  )
  const f = await fixture()
  try {
    f.child.kill('SIGINT')
    await f.waitFile('request-1-1')
    await f.write('answer-1-1', 'keep')
    await expect.poll(() => f.messages.join('')).toContain('stop cancelled')
    const exited = once(f.child, 'exit')
    f.child.kill('SIGKILL')
    await exited
    await f.waitFile('request-1-2', 'development-lost')
    await f.write('answer-1-2', 'keep')
    expect(await processExists(await f.pid('app-1'))).toBe(true)
    await expect(access(join(f.root, 'request-1-3'))).rejects.toThrow()
    // The editor's own subsequent quit is represented by its isolated fixture command.
    await f.write('exit-1')
    await expect.poll(async () => processExists(await f.pid('app-1'))).toBe(false)
  } finally {
    await writeFile(info.outputPath('launcher.log'), f.messages.join(''))
    await f.cleanup()
  }
})

test('unauthenticated loopback peers cannot stop a registered application', async ({}, info) => {
  const f = await fixture()
  try {
    const { port } = JSON.parse(await readFile(join(f.root, 'supervisor.json'), 'utf8'))
    const socket = createConnection({ host: '127.0.0.1', port: Number(port) })
    await once(socket, 'connect')
    socket.write(
      JSON.stringify({
        type: 'register',
        token: '0'.repeat(64),
        pid: 1,
        instance: '0'.repeat(36),
      }) + '\n',
    )
    await once(socket, 'close')
    await expect(access(join(f.root, 'request-1-1'))).rejects.toThrow()
    f.child.kill('SIGTERM')
    await f.waitFile('request-1-1', 'development-stop')
    await f.write('answer-1-1', 'quit')
    await f.exited(0)
  } finally {
    await writeFile(info.outputPath('launcher.log'), f.messages.join(''))
    await f.cleanup()
  }
})
