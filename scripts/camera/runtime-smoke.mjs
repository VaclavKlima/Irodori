import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { checkoutRoot, resolveRuntime, runtimePlatform } from './runtime.ts'

if (process.argv.length !== 3)
  throw new Error('Usage: node scripts/camera/runtime-smoke.mjs <candidate-distribution-directory>')
const distribution = resolve(process.argv[2])
const platform = runtimePlatform()
const candidate = JSON.parse(
  await readFile(join(distribution, `candidate-${platform}.json`), 'utf8'),
)
const directory = await mkdtemp(join(tmpdir(), 'irodori camera runtime smoke '))
const client = new Client({ name: 'camera-runtime-packaging', version: '1' })
let transport
try {
  for (const path of [
    'package.json',
    'scripts/camera-mcp.mjs',
    'scripts/camera',
    'src/main/camera-control',
  ])
    await cp(join(checkoutRoot, path), join(directory, path), { recursive: true })
  await symlink(join(checkoutRoot, 'node_modules'), join(directory, 'node_modules'), 'junction')
  await mkdir(join(directory, 'assets/app/camera-runtime'), { recursive: true })
  await writeFile(
    join(directory, 'assets/app/camera-runtime/manifest.json'),
    JSON.stringify({
      schema: 1,
      release: `camera-runtime-v${candidate.version}`,
      platforms: { [platform]: candidate },
    }),
  )
  const setup = ['scripts/camera/setup.mjs', '--archive', join(distribution, candidate.archive)]
  const env = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }
  const first = execFileSync(process.execPath, setup, { cwd: directory, env }).toString()
  const second = execFileSync(process.execPath, ['scripts/camera/setup.mjs'], {
    cwd: directory,
    env,
  }).toString()
  if (!first.includes('installed:') || !second.includes('verified and reused:'))
    throw new Error('Install/offline reuse failed.')
  const runtime = await resolveRuntime(directory)
  if (!runtime.executable.startsWith(directory))
    throw new Error('Executable escaped relocated checkout.')
  if (platform === 'linux-x64') {
    for (const args of [['--version'], ['--list-cameras'], ['--list-ports'], ['--auto-detect']]) {
      const output = execFileSync(runtime.executable, args, {
        cwd: directory,
        env: { ...env, ...runtime.env },
      }).toString()
      if (
        (args[0] === '--list-cameras' && !output.includes('Sony ZV-1')) ||
        (args[0] === '--list-ports' && !output.includes('usb:'))
      )
        throw new Error(`Private module resolution failed: ${args[0]}`)
    }
  }
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(directory, 'scripts/camera-mcp.mjs')],
    cwd: tmpdir(),
    env,
    stderr: 'pipe',
  })
  transport.stderr?.on('data', () => {})
  await client.connect(transport)
  const tools = (await client.listTools()).tools
  if (tools.length !== 7) throw new Error('Seven-tool API changed.')
  const listed = await client.callTool({ name: 'irodori_camera_list', arguments: {} })
  if (listed.isError || !listed.structuredContent.diagnostics.every((entry) => entry.available))
    throw new Error(`Runtime discovery failed: ${JSON.stringify(listed.structuredContent)}`)
  await writeFile(
    join(distribution, 'packaging-acceptance.json'),
    JSON.stringify(
      {
        platform,
        archiveSha256: candidate.sha256,
        tools: tools.map((tool) => tool.name),
        setup: 'passed without compiler/Homebrew on PATH',
        offlineReuse: 'passed',
        discovery: listed.structuredContent,
        limitations: ['No physical Linux camera acceptance.'],
      },
      null,
      2,
    ) + '\n',
  )
  console.log(
    `${platform}: setup, offline reuse, private modules, SDK initialization and discovery passed.`,
  )
} finally {
  await client.close()
  await transport?.close()
  await rm(directory, { recursive: true, force: true })
}
