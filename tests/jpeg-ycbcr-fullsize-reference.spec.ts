import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, readdir, stat, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { expect, test, type TestInfo } from '@playwright/test'
import {
  jpegReferencePrerequisite,
  readJpegReferenceSamples,
  type JpegReferencePrerequisite,
} from './jpeg-ycbcr-reference.helpers'
import {
  openFullsizeJpegReference,
  FULLSIZE_JPEG_MAX_INPUT_BYTES,
  FULLSIZE_JPEG_MAX_PIXELS,
  FULLSIZE_JPEG_MAX_SIDE,
  FULLSIZE_JPEG_MAX_STRIPE_BYTES,
  FULLSIZE_JPEG_MAX_STRIPE_ROWS,
} from './jpeg-ycbcr-fullsize-reference.helpers'
import { referenceBase2020 } from './jpeg-ycbcr-model.helpers'

const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
type Available = Extract<JpegReferencePrerequisite, { available: true }>
function prerequisite(): Available {
  const current = jpegReferencePrerequisite()
  test.skip(!current.available, current.available ? '' : current.reason)
  if (!current.available) throw new Error(current.reason)
  return current
}
async function fixture() {
  const width = 19,
    height = 17,
    pixels = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      for (let c = 0; c < 3; c++) pixels[(y * width + x) * 3 + c] = (x * 31 + y * 47 + c * 59) % 256
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 97, chromaSubsampling: '4:4:4', progressive: false })
    .toBuffer()
}
function alteredDimensions(jpeg: Buffer, width: number, height: number): Buffer {
  const copy = Buffer.from(jpeg)
  for (let at = 2; at + 9 < copy.length;) {
    if (copy[at] !== 255) throw new Error('Invalid synthetic JPEG marker.')
    const marker = copy[at + 1],
      bytes = copy.readUInt16BE(at + 2)
    if ([192, 193, 194].includes(marker)) {
      copy.writeUInt16BE(height, at + 5)
      copy.writeUInt16BE(width, at + 7)
      return copy
    }
    if (marker === 218) break
    at += bytes + 2
  }
  throw new Error('Synthetic JPEG has no dimensions.')
}
async function wrapper(info: TestInfo, current: Available, fault: string): Promise<Available> {
  const path = info.outputPath(`decoder-${fault}.cjs`),
    processRecord = info.outputPath(`decoder-${fault}-pids.json`),
    worker =
      'process.on("SIGTERM",()=>{});const fs=require("node:fs"),record=process.argv[2];fs.writeFileSync(record,JSON.stringify({leader:Number(process.argv[1]),descendant:process.pid}));setTimeout(()=>{fs.writeFileSync(record+".safety","descendant");process.exit(0);},4000)'
  await writeFile(
    path,
    `#!${process.execPath}\n` +
      `const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');\n` +
      `const args=process.argv.slice(2),fault=${JSON.stringify(fault)};\n` +
      `if(args.includes('--file-transport-v1') && fault==='hold'){\n` +
      `fs.writeFileSync(path.join(args.at(-1),'entered'),String(process.pid));setTimeout(()=>{},60000);\n` +
      `}else if(args.includes('--file-transport-v1') && fault.startsWith('tree-')){\n` +
      `process.on('SIGTERM',()=>{});const record=${JSON.stringify(processRecord)};\n` +
      `const worker=cp.spawn(process.execPath,['-e',${JSON.stringify(worker)},String(process.pid),record],{stdio:['ignore','inherit','inherit']});worker.unref();\n` +
      `if(fault==='tree-exit')setInterval(()=>{if(fs.existsSync(record))process.exit(0);},10);\n` +
      `setTimeout(()=>{fs.writeFileSync(record+'.leader-safety','leader');process.exit(0);},4000);\n` +
      `}else{\n` +
      `if(args.includes('--file-transport-v1') && fault==='exclusive')fs.writeFileSync(path.join(args.at(-1),'samples.bin'),'preserve-existing',{flag:'wx',mode:384});\n` +
      `const result=cp.spawnSync(${JSON.stringify(current.python)},args,{maxBuffer:65536,timeout:10000});\n` +
      `if(result.status!==0){if(fault==='exclusive'){if(fs.readFileSync(path.join(args.at(-1),'samples.bin'),'utf8')!=='preserve-existing')throw Error('Existing sample file changed');process.stderr.write('exclusive file preserved: ');}process.stderr.write(result.stderr??'');process.exit(result.status??1);}\n` +
      `if(!args.includes('--file-transport-v1')){process.stdout.write(result.stdout);}else{\n` +
      `const header=JSON.parse(result.stdout),sample=path.join(args.at(-1),'samples.bin');\n` +
      `if(fault==='layout')header.layout='interleaved-rgb8';\n` +
      `if(fault==='input-hash')header.inputSha256='f'.repeat(64);\n` +
      `if(fault==='toolchain')header.pythonSha256='e'.repeat(64);\n` +
      `if(fault==='sample-size')fs.truncateSync(sample,header.bytes-1);\n` +
      `if(fault==='sample-hash'){const b=fs.readFileSync(sample);b[0]^=1;fs.writeFileSync(sample,b);}\n` +
      `if(fault==='oversized-header')process.stdout.write('a'.repeat(16385)+'\\n');\n` +
      `else process.stdout.write(JSON.stringify(header)+'\\n');\n` +
      `}}\n`,
    { mode: 0o700 },
  )
  await chmod(path, 0o700)
  return { ...current, python: path }
}

async function running(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
  if (process.platform === 'linux') {
    try {
      const text = await readFile(`/proc/${pid}/stat`, 'utf8'),
        state = text.slice(text.lastIndexOf(')') + 2).split(' ')[0]
      return state !== 'Z' && state !== 'X'
    } catch (error) {
      if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return false
      throw error
    }
  }
  return true
}

// eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures.
test('private file samples equal the unchanged small reader across stripe boundaries and repeat reads', async ({}, info) => {
  const current = prerequisite(),
    jpeg = await fixture(),
    before = Buffer.from(jpeg),
    parent = info.outputPath('private-files')
  for (const mode of ['base-ycbcr', 'gain-rgb'] as const) {
    const small = readJpegReferenceSamples(jpeg, mode, current),
      full = await openFullsizeJpegReference(jpeg, mode, {
        prerequisite: current,
        parentDirectory: parent,
      })
    try {
      expect([full.width, full.height]).toEqual([19, 17])
      expect(full.inputSha256).toBe(sha(jpeg))
      expect(full.samplesSha256).toBe(sha(small.pixels))
      expect(full.provenance).toMatchObject(small.provenance)
      expect(full.provenance).toMatchObject({ idct: 'accurate-integer-jdct-islow' })
      expect(full.provenance.pythonSha256).toMatch(/^[a-f0-9]{64}$/)
      expect(full.provenance.readerSha256).toMatch(/^[a-f0-9]{64}$/)
      expect((await stat(full.privateDirectory)).mode & 0o777).toBe(0o700)
      expect((await stat(join(full.privateDirectory, 'samples.bin'))).mode & 0o777).toBe(0o600)
      for (let pass = 0; pass < 2; pass++) {
        const assembled = Buffer.alloc(small.pixels.length)
        for (const [top, count] of [
          [0, 1],
          [1, 5],
          [6, 11],
        ]) {
          const stripe = await full.readRows(top, count)
          expect(stripe).toMatchObject({ top, width: 19, height: count, mode })
          expect(stripe.pixels.length).toBe(19 * count * 3)
          if (mode === 'base-ycbcr') {
            for (let plane = 0; plane < 3; plane++)
              stripe.pixels.copy(
                assembled,
                plane * 19 * 17 + top * 19,
                plane * 19 * count,
                (plane + 1) * 19 * count,
              )
            expect(referenceBase2020(stripe, 7, count - 1)).toEqual(
              referenceBase2020(small, 7, top + count - 1),
            )
          } else stripe.pixels.copy(assembled, top * 19 * 3)
        }
        expect(assembled).toEqual(small.pixels)
      }
      expect(jpeg).toEqual(before)
    } finally {
      await Promise.all([full.close(), full.close()])
    }
    await expect(stat(full.privateDirectory)).rejects.toThrow()
  }
  expect(await readdir(parent)).toEqual([])
})

// eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures.
test('explicit file mode extends only its declared test bounds and refuses oversized or unsupported inputs with cleanup', async ({}, info) => {
  const current = prerequisite(),
    parent = info.outputPath('private-files'),
    jpeg = await fixture(),
    large = await sharp({
      create: { width: 1025, height: 1024, channels: 3, background: { r: 120, g: 70, b: 30 } },
    })
      .jpeg({ quality: 100, chromaSubsampling: '4:4:4' })
      .toBuffer()
  expect(() => readJpegReferenceSamples(large, 'base-ycbcr', current)).toThrow('1,048,576')
  expect(() =>
    readJpegReferenceSamples(Buffer.allocUnsafe(16 * 1024 ** 2 + 1), 'base-ycbcr', current),
  ).toThrow('16 MiB')
  const full = await openFullsizeJpegReference(large, 'base-ycbcr', {
    prerequisite: current,
    parentDirectory: parent,
  })
  try {
    expect([full.width, full.height]).toEqual([1025, 1024])
    expect(full.maxRowsPerRead).toBe(FULLSIZE_JPEG_MAX_STRIPE_ROWS)
    const last = await full.readRows(1023, 1)
    expect(last.pixels.length).toBe(1025 * 3)
    await expect(full.readRows(0, FULLSIZE_JPEG_MAX_STRIPE_ROWS + 1)).rejects.toThrow(
      'stripe exceeds',
    )
  } finally {
    await full.close()
  }
  await expect(stat(full.privateDirectory)).rejects.toThrow()
  expect(FULLSIZE_JPEG_MAX_PIXELS).toBe(33_554_432)
  expect(FULLSIZE_JPEG_MAX_SIDE).toBe(32_768)
  expect(FULLSIZE_JPEG_MAX_INPUT_BYTES).toBe(128 * 1024 ** 2)
  expect(FULLSIZE_JPEG_MAX_STRIPE_BYTES).toBe(16 * 1024 ** 2)
  await expect(
    openFullsizeJpegReference(Buffer.allocUnsafe(FULLSIZE_JPEG_MAX_INPUT_BYTES + 1), 'base-ycbcr', {
      prerequisite: current,
      parentDirectory: parent,
    }),
  ).rejects.toThrow('128 MiB')
  for (const input of [
    alteredDimensions(jpeg, 8192, 8192),
    alteredDimensions(jpeg, FULLSIZE_JPEG_MAX_SIDE + 1, 1),
  ])
    await expect(
      openFullsizeJpegReference(input, 'base-ycbcr', {
        prerequisite: current,
        parentDirectory: parent,
      }),
    ).rejects.toThrow('33,554,432 pixels and 32,768 per side')
  const subsampled = await sharp(jpeg).jpeg({ chromaSubsampling: '4:2:0' }).toBuffer()
  await expect(
    openFullsizeJpegReference(subsampled, 'base-ycbcr', {
      prerequisite: current,
      parentDirectory: parent,
    }),
  ).rejects.toThrow('three-component 4:4:4')
  await expect(
    openFullsizeJpegReference(Buffer.from([255, 216, 255, 217]), 'gain-rgb', {
      prerequisite: current,
      parentDirectory: parent,
    }),
  ).rejects.toThrow('reader failed')
  expect(await readdir(parent)).toEqual([])
})

// eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures.
test('header, sample length/hash and actual toolchain corruption fail before samples escape and remove private files', async ({}, info) => {
  const current = prerequisite(),
    jpeg = await fixture(),
    parent = info.outputPath('private-files')
  await mkdir(parent, { recursive: true })
  for (const [fault, expected] of [
    ['exclusive', 'exclusive file preserved'],
    ['layout', 'toolchain header'],
    ['input-hash', 'toolchain header'],
    ['toolchain', 'toolchain header'],
    ['sample-size', 'exact size changed'],
    ['sample-hash', 'sample file hash differs'],
    ['oversized-header', 'header exceeds 16 KiB'],
  ]) {
    await expect(
      openFullsizeJpegReference(jpeg, 'base-ycbcr', {
        prerequisite: await wrapper(info, current, fault),
        parentDirectory: parent,
      }),
    ).rejects.toThrow(expected)
    expect(await readdir(parent)).toEqual([])
  }
  await expect(
    openFullsizeJpegReference(jpeg, 'base-ycbcr', {
      prerequisite: { ...current, librarySha256: '0'.repeat(64) },
      parentDirectory: parent,
    }),
  ).rejects.toThrow('hashes differ')
  expect(await readdir(parent)).toEqual([])
})

// eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures.
test('changed sample files, aborted opens and idle cancellation drain cleanup without retaining test files', async ({}, info) => {
  const current = prerequisite(),
    jpeg = await fixture(),
    parent = info.outputPath('private-files')
  const corrupted = await openFullsizeJpegReference(jpeg, 'base-ycbcr', {
    prerequisite: current,
    parentDirectory: parent,
  })
  try {
    await truncate(join(corrupted.privateDirectory, 'samples.bin'), 19 * 17 * 3 - 1)
    await expect(corrupted.readRows(0, 1)).rejects.toThrow('exact size changed')
  } finally {
    await corrupted.close()
  }
  await expect(stat(corrupted.privateDirectory)).rejects.toThrow()
  const controller = new AbortController(),
    idle = await openFullsizeJpegReference(jpeg, 'gain-rgb', {
      prerequisite: current,
      parentDirectory: parent,
      signal: controller.signal,
    })
  controller.abort()
  await idle.close()
  await expect(idle.readRows(0, 1)).rejects.toThrow()
  await expect(stat(idle.privateDirectory)).rejects.toThrow()
  const openingController = new AbortController(),
    held = await wrapper(info, current, 'hold'),
    opening = openFullsizeJpegReference(jpeg, 'base-ycbcr', {
      prerequisite: held,
      parentDirectory: parent,
      signal: openingController.signal,
    }),
    failure = opening.then(
      async (opened) => {
        await opened.close()
        return undefined
      },
      (error: unknown) => error,
    )
  try {
    let entered = false
    for (let attempt = 0; attempt < 250 && !entered; attempt++) {
      for (const name of await readdir(parent))
        entered ||= await readFile(join(parent, name, 'entered')).then(
          () => true,
          () => false,
        )
      if (!entered) await new Promise((accept) => setTimeout(accept, 20))
    }
    expect(entered).toBe(true)
  } finally {
    openingController.abort()
    await failure
  }
  expect(await failure).toBeInstanceOf(Error)
  expect(await readdir(parent)).toEqual([])
})

// eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures.
test('abort and early wrapper exit retire real descendants holding inherited decoder pipes before cleanup', async ({}, info) => {
  test.setTimeout(15_000)
  const current = prerequisite(),
    jpeg = await fixture(),
    parent = info.outputPath('private-files'),
    records: unknown[] = []
  await mkdir(parent, { recursive: true })
  for (const mode of ['tree-abort', 'tree-exit']) {
    const controller = new AbortController(),
      configured = await wrapper(info, current, mode),
      opening = openFullsizeJpegReference(jpeg, 'base-ycbcr', {
        prerequisite: configured,
        parentDirectory: parent,
        signal: controller.signal,
      }),
      failure = opening.then(
        async (opened) => {
          await opened.close()
          return undefined
        },
        (error: unknown) => error,
      ),
      recordPath = info.outputPath(`decoder-${mode}-pids.json`)
    let pids: { leader: number; descendant: number } | undefined
    try {
      await expect
        .poll(
          async () => {
            const value = await readFile(recordPath, 'utf8').catch(() => undefined)
            if (!value) return false
            pids = JSON.parse(value) as typeof pids
            return true
          },
          { timeout: 5000 },
        )
        .toBe(true)
      expect(Number.isSafeInteger(pids?.leader)).toBe(true)
      expect(Number.isSafeInteger(pids?.descendant)).toBe(true)
      expect(pids!.leader).toBeGreaterThan(0)
      expect(pids!.descendant).toBeGreaterThan(0)
      expect(pids!.leader).not.toBe(pids!.descendant)
      const started = performance.now()
      if (mode === 'tree-abort') controller.abort()
      const error = await failure,
        elapsedMs = performance.now() - started
      expect(error).toBeInstanceOf(Error)
      // Both test processes have four-second safety exits. This bound must pass
      // through transport retirement, rather than those safety exits.
      expect(elapsedMs).toBeLessThan(3000)
      await expect.poll(() => running(pids!.leader)).toBe(false)
      await expect.poll(() => running(pids!.descendant)).toBe(false)
      await expect(readFile(recordPath + '.safety')).rejects.toThrow()
      await expect(readFile(recordPath + '.leader-safety')).rejects.toThrow()
      expect(await readdir(parent)).toEqual([])
      records.push({ mode, ...pids, elapsedMs, leaderRunning: false, descendantRunning: false })
    } finally {
      controller.abort()
      await failure
    }
  }
  await writeFile(
    info.outputPath('process-group-retirement.json'),
    JSON.stringify(records, null, 2),
  )
})
