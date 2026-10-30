import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, readlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PreviewProcess } from '../src/main/preview-process'
import type { HdrRawPreparation } from '../src/main/preview-types'
import { DEFAULT_RESOURCE_SETTINGS, resolveResourcePolicy } from '../src/shared/resource-policy'

// Actual bundled-Node children test transport and ownership only; no image/decoder/GPU is loaded.
function helperSource(mode: string) {
  return `#!${process.execPath}
import assert from 'node:assert/strict'
import {closeSync,existsSync,fstatSync,readSync,writeFileSync,writeSync} from 'node:fs'
import {dirname,join} from 'node:path'
import {fileURLToPath} from 'node:url'
const root=dirname(fileURLToPath(import.meta.url)), mode=${JSON.stringify(mode)}
const [entry,parent,nonce,dev,ino,length]=process.argv.slice(2)
assert.equal(entry,'--owned-rows-v1');assert.equal(Number(parent),process.ppid)
const stat=fstatSync(3,{bigint:true});assert(stat.isFile())
assert.equal(String(stat.dev),dev);assert.equal(String(stat.ino),ino);assert.equal(String(stat.size),length)
writeFileSync(join(root,'native-pid.txt'),String(process.pid))
const stubborn=mode==='held-stream'&&!existsSync(join(root,'release.txt'))
if(stubborn)process.on('SIGTERM',()=>{})
writeSync(4,'ARMED '+nonce+'\\n');closeSync(4)
const expected=Buffer.from('IRODORI-RAW-START1 '+nonce+'\\n'), token=Buffer.alloc(expected.length)
let filled=0
while(filled<token.length){const n=readSync(0,token,filled,token.length-filled,null);assert(n>0);filled+=n}
assert(token.equals(expected));assert.equal(readSync(0,Buffer.alloc(1),0,1,null),0)
writeFileSync(join(root,'native-started.txt'),'started')
const body=Buffer.alloc(65536)
let n
while((n=readSync(3,body,0,body.length,null))!==0){
 let sent=0
 while(sent<n){try{sent+=writeSync(1,body,sent,n-sent)}catch(error){
  if(!stubborn||!['EPIPE','ECONNRESET'].includes(error.code))throw error
  writeFileSync(join(root,'native-stubborn.txt'),error.code)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0)
 }}
}
closeSync(1)
writeFileSync(join(root,'native-eof.txt'),'eof')
if(mode==='held-exit')while(!existsSync(join(root,'release.txt')))
 Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5)
`
}
function workerSource(mode: string) {
  return `
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {existsSync,readFileSync,writeFileSync} from 'node:fs'
import {dirname,join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {Socket} from 'node:net'
import {spawn} from 'node:child_process'
const root=dirname(fileURLToPath(import.meta.url)),mode=${JSON.stringify(mode)}
let job,hash,bytes=0,eof=false,exit,held=false,requests=0
function send(value){process.send(value)}
function finish(){
 if(!eof||!exit)return
 assert.equal(exit.code,0);assert.equal(exit.signal,null)
 const pid=Number(readFileSync(join(root,'native-pid.txt'),'utf8'))
 let alive=true
 try{process.kill(pid,0)}catch(error){if(error.code!=='ESRCH')throw error;alive=false}
 assert.equal(alive,false,'native-exit must follow actual native retirement')
 send({type:'result',result:{width:1,height:1,format:'rgba8-srgb',byteLength:4,
  sha256:'a'.repeat(64),placeholderBytes:0,renderId:hash.digest('hex'),
  diagnostics:{backend:'cpu',timings:{bytes,requests,pid:process.pid,nativePid:pid}}}})
}
process.on('message',(message,handle)=>{
 try{
 if(message.type==='close'){process.exit(0);return}
 if(message.type==='release')return
 if(message.type==='full'){
  job=message;requests++;bytes=0;eof=false;exit=undefined;held=false;hash=createHash('sha256')
  writeFileSync(join(root,'worker-pid.txt'),String(process.pid))
  assert(job.nativeRaw)
  if(mode==='held-stdio'){
   const holder=spawn(process.execPath,[join(root,'stdio-holder.mjs')],{stdio:['ignore','ignore',process.stderr]})
   writeFileSync(join(root,'stdio-holder-pid.txt'),String(holder.pid))
   send({type:'error',error:'deliberate worker failure with held stderr'});return
  }
  send({type:'raw-source-request',nonce:job.nativeRaw.nonce});return
 }
 assert(job);assert.equal(message.nonce,job.nativeRaw.nonce)
 if(message.type==='raw-source-declined'){
  send({type:'error',error:message.reason==='memory-limit'?'resource budget rejected':'unavailable source'});return
 }
 if(message.type==='raw-source-stream'){
  assert(handle instanceof Socket)
  handle.on('error',error=>send({type:'error',error:String(error)}))
  handle.on('data',part=>{
   bytes+=part.length;hash.update(part)
   if(mode==='held-stream'&&!existsSync(join(root,'release.txt'))&&!held&&bytes>=65536){
    held=true;handle.pause();writeFileSync(join(root,'worker-held.txt'),String(bytes))
   }
  })
  handle.once('end',()=>{eof=true;handle.destroy();finish()})
  const wrong=(job.nativeRaw.nonce[0]==='0'?'1':'0')+job.nativeRaw.nonce.slice(1)
  send({type:'raw-source-reader-ready',nonce:mode==='wrong-ready'?wrong:job.nativeRaw.nonce});return
 }
 if(message.type==='raw-source-exit'){exit=message;finish();return}
 throw Error('unexpected fixture control')
 }catch(error){send({type:'error',error:String(error)})}
})
`
}
function preparation(ramMiB: number | null = null): HdrRawPreparation {
  return {
    originalSha256: 'a'.repeat(64),
    parentWorkingKey: 'verified-test-source',
    policy: resolveResourcePolicy(
      { ...DEFAULT_RESOURCE_SETTINGS, ramMiB },
      {
        ram: { totalBytes: 32 * 1024 ** 3, availableBytes: 24 * 1024 ** 3 },
        gpu: { status: 'unknown', reason: 'adapter-unverified' },
      },
      7,
    ),
    rendererReservation: { ramBytes: 64 * 1024 ** 2, vramBytes: 64 * 1024 ** 2 },
  }
}
function observed<T>(promise: Promise<T>) {
  let settled = false
  const outcome = promise
    .then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error: String(error) }),
    )
    .finally(() => {
      settled = true
    })
  return {
    outcome,
    get settled() {
      return settled
    },
  }
}
function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}
async function sourcePinned(path: string) {
  const names = await readdir(`/proc/${process.pid}/fd`)
  const paths = await Promise.all(
    names.map((name) => readlink(`/proc/${process.pid}/fd/${name}`).catch(() => '')),
  )
  return paths.includes(path)
}
async function fixture(mode: string, gate?: Promise<void>) {
  const root = test.info().outputPath('native-raw-owner')
  await mkdir(root, { recursive: true })
  const helper = join(root, 'native-helper.mjs'),
    worker = join(root, 'worker.mjs'),
    original = join(root, 'original.bin')
  const data = Buffer.alloc(4 * 1024 ** 2 + 333)
  for (let index = 0; index < data.length; index++) data[index] = (index * 17 + (index >>> 7)) & 255
  await writeFile(helper, helperSource(mode), { mode: 0o700 })
  await writeFile(worker, workerSource(mode))
  await writeFile(
    join(root, 'stdio-holder.mjs'),
    `
import {existsSync} from 'node:fs'
import {dirname,join} from 'node:path'
import {fileURLToPath} from 'node:url'
const release=join(dirname(fileURLToPath(import.meta.url)),'release.txt')
while(!existsSync(release))await new Promise(resolve=>setTimeout(resolve,5))
`,
  )
  await writeFile(original, data)
  let resolverStarted = false
  const preview = new PreviewProcess(worker, 15_000, 30_000, async () => {
    resolverStarted = true
    const started = performance.now()
    await gate
    const sha256 = createHash('sha256')
      .update(await readFile(helper))
      .digest('hex')
    return { status: 'ready', path: helper, sha256, validationMs: performance.now() - started }
  })
  return {
    root,
    preview,
    original,
    expected: createHash('sha256').update(data).digest('hex'),
    get resolverStarted() {
      return resolverStarted
    },
    marker: (name: string) => readFile(join(root, name), 'utf8').catch(() => ''),
    release: () => writeFile(join(root, 'release.txt'), 'released'),
    output: async (name: string) => {
      const path = join(root, name)
      await mkdir(path)
      return path
    },
  }
}

test('native EOF cannot settle a full request or release its source before actual helper close', async () => {
  const f = await fixture('held-exit'),
    abort = new AbortController()
  const work = observed(
    f.preview.renderFull(
      f.original,
      await f.output('first'),
      abort.signal,
      undefined,
      undefined,
      preparation(),
    ),
  )
  try {
    await expect.poll(() => f.marker('native-eof.txt')).toBe('eof')
    const pid = Number(await f.marker('native-pid.txt'))
    expect(alive(pid)).toBe(true)
    expect(await sourcePinned(f.original)).toBe(true)
    expect(work.settled).toBe(false)
    await f.release()
    const result = await work.outcome
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error)
    expect(result.value.renderId).toBe(f.expected)
    expect(result.value.diagnostics!.timings.bytes).toBe(4 * 1024 ** 2 + 333)
    expect(alive(pid)).toBe(false)
    expect(await sourcePinned(f.original)).toBe(false)
    const next = await f.preview.renderFull(
      f.original,
      await f.output('next'),
      abort.signal,
      undefined,
      undefined,
      preparation(),
    )
    expect(next.renderId).toBe(f.expected)
    expect(next.diagnostics!.timings.pid).toBe(result.value.diagnostics!.timings.pid)
    expect(next.diagnostics!.timings.nativePid).not.toBe(pid)
  } finally {
    await f.release()
    abort.abort()
    await f.preview.close(true)
    await work.outcome
  }
})

test('a real killed receiver drains its stubborn direct helper before original release and reuse', async () => {
  const f = await fixture('held-stream'),
    abort = new AbortController()
  const work = observed(
    f.preview.renderFull(
      f.original,
      await f.output('held'),
      abort.signal,
      undefined,
      undefined,
      preparation(),
    ),
  )
  try {
    await expect.poll(() => f.marker('worker-held.txt')).not.toBe('')
    const worker = Number(await f.marker('worker-pid.txt')),
      native = Number(await f.marker('native-pid.txt'))
    process.kill(worker, 'SIGKILL')
    await expect.poll(() => f.marker('native-stubborn.txt')).toMatch(/EPIPE|ECONNRESET/)
    expect(alive(native)).toBe(true)
    expect(work.settled).toBe(false)
    expect(await sourcePinned(f.original)).toBe(true)
    await expect(
      f.preview.renderFull(
        f.original,
        await f.output('too-early'),
        abort.signal,
        undefined,
        undefined,
        preparation(),
      ),
    ).rejects.toThrow('busy')
    expect(await work.outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining('worker stopped'),
    })
    expect(alive(native)).toBe(false)
    expect(await sourcePinned(f.original)).toBe(false)
    await f.release()
    const next = await f.preview.renderFull(
      f.original,
      await f.output('fresh'),
      abort.signal,
      undefined,
      undefined,
      preparation(),
    )
    expect(next.renderId).toBe(f.expected)
    expect(next.diagnostics!.timings.pid).not.toBe(worker)
  } finally {
    await f.release()
    abort.abort()
    await f.preview.close(true)
    await work.outcome
  }
})

test('close during resolver setup drains that setup and cannot spawn a late native helper', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const f = await fixture('plain', gate),
    abort = new AbortController()
  const work = observed(
    f.preview.renderFull(
      f.original,
      await f.output('pending'),
      abort.signal,
      undefined,
      undefined,
      preparation(),
    ),
  )
  let close: ReturnType<typeof observed<void>> | undefined
  try {
    await expect.poll(() => f.resolverStarted).toBe(true)
    close = observed(f.preview.close(true))
    expect(close.settled).toBe(false)
    expect(work.settled).toBe(false)
    expect(await f.marker('native-pid.txt')).toBe('')
    release()
    expect((await close.outcome).ok).toBe(true)
    expect((await work.outcome).ok).toBe(false)
    expect(await f.marker('native-pid.txt')).toBe('')
    expect(await sourcePinned(f.original)).toBe(false)
  } finally {
    release()
    abort.abort()
    await f.preview.close(true)
    await close?.outcome
    await work.outcome
  }
})

test('a mismatched reader acknowledgement fails closed before the native source starts', async () => {
  const f = await fixture('wrong-ready'),
    abort = new AbortController()
  const work = observed(
    f.preview.renderFull(
      f.original,
      await f.output('mismatch'),
      abort.signal,
      undefined,
      undefined,
      preparation(),
    ),
  )
  try {
    expect(await work.outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining('identity mismatch'),
    })
    const pid = Number(await f.marker('native-pid.txt'))
    expect(pid).toBeGreaterThan(0)
    expect(alive(pid)).toBe(false)
    expect(await f.marker('native-started.txt')).toBe('')
    expect(await sourcePinned(f.original)).toBe(false)
  } finally {
    abort.abort()
    await f.preview.close(true)
    await work.outcome
  }
})

test('frozen memory rejection closes the original without spawning a native helper', async () => {
  const f = await fixture('plain'),
    abort = new AbortController()
  const work = observed(
    f.preview.renderFull(
      f.original,
      await f.output('budget'),
      abort.signal,
      undefined,
      undefined,
      preparation(1),
    ),
  )
  try {
    expect(await work.outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining('resource budget'),
    })
    expect(await f.marker('native-pid.txt')).toBe('')
    expect(await sourcePinned(f.original)).toBe(false)
  } finally {
    abort.abort()
    await f.preview.close(true)
    await work.outcome
  }
})

test('worker exit cannot settle retirement while its actual stdio close is still held', async () => {
  const f = await fixture('held-stdio'),
    abort = new AbortController()
  const work = observed(
    f.preview.renderFull(
      f.original,
      await f.output('stdio'),
      abort.signal,
      undefined,
      undefined,
      preparation(),
    ),
  )
  try {
    await expect.poll(() => f.marker('stdio-holder-pid.txt')).not.toBe('')
    const worker = Number(await f.marker('worker-pid.txt')),
      holder = Number(await f.marker('stdio-holder-pid.txt'))
    await expect.poll(() => alive(worker)).toBe(false)
    expect(alive(holder)).toBe(true)
    expect(work.settled).toBe(false)
    await expect(
      f.preview.renderFull(
        f.original,
        await f.output('before-close'),
        abort.signal,
        undefined,
        undefined,
        preparation(),
      ),
    ).rejects.toThrow('busy')
    await f.release()
    expect(await work.outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining('held stderr'),
    })
    await expect.poll(() => alive(holder)).toBe(false)
  } finally {
    await f.release()
    const pid = Number(await f.marker('stdio-holder-pid.txt'))
    if (pid > 0 && alive(pid)) process.kill(pid, 'SIGKILL')
    abort.abort()
    await f.preview.close(true)
    await work.outcome
  }
})
