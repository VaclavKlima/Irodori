/* eslint-disable no-empty-pattern -- Playwright requires destructured fixture arguments. */
import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import sharp from 'sharp'
import {
  prepareMaskStack,
  type MaskStackPreparationJob,
} from '../src/main/processing/mask-stack-preparation'
import { PreviewProcess } from '../src/main/preview-process'
import {
  neutralAdjustments,
  srgbTransform,
  type AdjustmentParameters,
} from '../src/shared/adjustments'
import { cropGeometry, type CropSettings } from '../src/shared/crop'
import { croppedMaskGeometry, identityMaskGeometry } from '../src/shared/mask-geometry'
import {
  neutralMaskColor,
  neutralMaskEdge,
  neutralMaskLight,
  type MaskGradient,
  type ResolvedMask,
} from '../src/shared/masks'
import { detailFrameJob } from './detail-frame.helpers'
import { workingAsset } from './export.helpers'
import { detailExportFixture } from './detail-export.helpers'
import { exportRenditions } from '../src/main/export/renditions'
import { exportTexturePolicy } from '../src/main/export/texture-policy'
import { ExportProcess } from '../src/main/export/process'
import { loadUltraHdr } from '../src/main/export/codec'
import { selectedExportEncoder } from '../src/main/export/encoder'
import { validatePrimary } from '../src/main/export/jpeg'
import { workingSourceIdentity } from '../src/main/working-assets'
import { fromHalf, readGainJpeg, reconstruct, srgbLinear, to2020 } from './export-reference'
import { noLensSettings } from '../src/shared/lens'

interface Root {
  id: string
  enabled: boolean
  amount: number
  gradient?: MaskGradient
  light: typeof neutralMaskLight
  color: typeof neutralMaskColor
}
interface Vector {
  id: string
  width: number
  height: number
  primaries: string
  rgba: number[]
  globals: Partial<AdjustmentParameters>
  roots: Root[]
  expected: number[]
  unionCoverage: number[]
  crop?: { sourceWidth: number; sourceHeight: number; settings: CropSettings }
}
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const reference = JSON.parse(
  await readFile('assets/tests/references/masked-texture/order-reference-v2.json', 'utf8'),
) as { cases: Vector[]; tolerance: { absolute: number; relative: number } }
async function fixture(directory: string, entry: Vector) {
  await mkdir(directory, { recursive: true })
  const bytes = Buffer.from(Float32Array.from(entry.rgba).buffer),
    path = join(directory, 'parent.f32')
  await writeFile(path, bytes)
  const maskGeometry = entry.crop
    ? croppedMaskGeometry(
        identityMaskGeometry(entry.crop.sourceWidth, entry.crop.sourceHeight),
        cropGeometry(
          { width: entry.crop.sourceWidth, height: entry.crop.sourceHeight },
          entry.crop.settings,
        ),
      )
    : identityMaskGeometry(entry.width, entry.height)
  const localMasks = entry.roots.map((root): ResolvedMask => ({
    id: root.id,
    name: root.id,
    enabled: root.enabled,
    inverted: false,
    head: null,
    edge: { ...neutralMaskEdge },
    strokes: [],
    operands: [],
    resultStrokes: [],
    gradient: root.gradient,
    light: { ...neutralMaskLight, ...root.light },
    color: { ...neutralMaskColor, ...root.color },
    texture: root.amount,
  }))
  const job: MaskStackPreparationJob = {
    parent: {
      identity: digest(Buffer.from(entry.id)),
      asset: {
        path,
        width: entry.width,
        height: entry.height,
        byteLength: bytes.byteLength,
        sha256: digest(bytes),
        transform: { ...srgbTransform },
        maskGeometry,
        ...(entry.primaries === 'rec2020'
          ? { hdr: workingAsset(bytes, entry.width, entry.height) }
          : {}),
      },
    },
    domain: entry.primaries === 'rec2020' ? 'scene-linear' : 'raster',
    adjustments: {
      ...structuredClone(neutralAdjustments),
      ...entry.globals,
      maskGeometry,
      localMasks,
    },
    admission: detailFrameJob().admission!,
  }
  return { job, bytes, directory }
}
function checkRgba(bytes: Buffer, expected: number[]) {
  const actual = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4),
    words = new Uint32Array(actual.buffer, actual.byteOffset, actual.length),
    wanted = Float32Array.from(expected),
    wantedWords = new Uint32Array(wanted.buffer)
  expect(actual.length).toBe(wanted.length)
  for (let i = 0; i < actual.length; i++) {
    if (i % 4 === 3) expect(words[i]).toBe(wantedWords[i])
    else
      expect(Math.abs(actual[i] - wanted[i]), `RGB ${i}`).toBeLessThanOrEqual(
        reference.tolerance.absolute + reference.tolerance.relative * Math.abs(wanted[i]),
      )
  }
}

test('production ordered Texture matches all unchanged independent prefixes and native crop-grid vectors', async ({}, info) => {
  test.setTimeout(180000)
  let preparedCases = 0,
    skippedCases = 0
  for (const entry of reference.cases) {
    const f = await fixture(info.outputPath(entry.id), entry),
      result = await prepareMaskStack(f.directory, f.job, new AbortController().signal)
    if (
      !entry.roots.some((root) => root.enabled && root.amount !== 0) ||
      !entry.unionCoverage.some((value) => value > 0)
    ) {
      expect(result.skipped, entry.id).toBe(true)
      expect(result.textureJobs).toBe(0)
      skippedCases++
      continue
    }
    expect(result.skipped, entry.id).toBe(false)
    expect(result.request).toBeDefined()
    const stack = result.request!.stack
    checkRgba(await readFile(stack.candidate.path), entry.expected)
    const coverageBytes = await readFile(stack.union.path),
      coverage = new Float32Array(
        coverageBytes.buffer,
        coverageBytes.byteOffset,
        coverageBytes.byteLength / 4,
      )
    for (let i = 0; i < coverage.length; i++)
      expect(
        Math.abs(coverage[i] - entry.unionCoverage[i]),
        `${entry.id}/coverage${i}`,
      ).toBeLessThanOrEqual(
        reference.tolerance.absolute +
          reference.tolerance.relative * Math.abs(entry.unionCoverage[i]),
      )
    expect(digest(await readFile(f.job.parent.asset.path))).toBe(f.job.parent.asset.sha256)
    expect(result.memory!.gpuBytes).toBeLessThanOrEqual(f.job.admission.policy.vram.effectiveBytes)
    test.info().annotations.push({ type: 'gpu-adapter', description: result.adapter! })
    preparedCases++
  }
  expect(preparedCases).toBeGreaterThan(8)
  expect(skippedCases).toBeGreaterThan(0)
})

test('production Texture uses native generated, compound and whole-mask edge coverage without dropping Texture-only roots', async ({}, info) => {
  const entry = reference.cases.find((value) => value.id === 'raster-single-active')!,
    f = await fixture(info.outputPath('coverage'), entry),
    mask = f.job.adjustments.localMasks![0]
  const png = await sharp(Buffer.alloc(entry.width * entry.height, 255), {
    raw: { width: entry.width, height: entry.height, channels: 1 },
  })
    .toColourspace('b-w')
    .png()
    .toBuffer()
  const generated: ResolvedMask = {
    ...mask,
    gradient: undefined,
    light: { ...neutralMaskLight },
    color: { ...neutralMaskColor },
    base: {
      version: 1,
      width: entry.width,
      height: entry.height,
      hash: digest(png),
      pngBase64: png.toString('base64'),
    },
  }
  const cases: [string, ResolvedMask][] = [
    ['generated', generated],
    ['edges', { ...generated, edge: { featherPx: 1, shiftPx: 0 } }],
    [
      'compound',
      {
        ...generated,
        operands: [
          {
            id: 'compound-subtract',
            name: 'Subtracted center',
            inverted: false,
            head: null,
            edge: { ...neutralMaskEdge },
            strokes: [],
            gradient: mask.gradient,
            operator: 'subtract' as const,
            enabled: true,
          },
        ],
      },
    ],
  ]
  for (const [name, root] of cases) {
    const directory = join(f.directory, name)
    await mkdir(directory)
    const result = await prepareMaskStack(
      directory,
      { ...f.job, adjustments: { ...f.job.adjustments, localMasks: [root] } },
      new AbortController().signal,
    )
    expect(result.skipped, name).toBe(false)
    const coverageBytes = await readFile(result.request!.stack.union.path),
      coverage = new Float32Array(
        coverageBytes.buffer,
        coverageBytes.byteOffset,
        coverageBytes.byteLength / 4,
      )
    expect(
      coverage.some((value) => value > 0),
      name,
    ).toBe(true)
    expect(
      coverage.every((value) => Number.isFinite(value) && value >= 0 && value <= 1),
      name,
    ).toBe(true)
    if (name === 'generated') expect(coverage.every((value) => value === 1)).toBe(true)
    if (name === 'compound') expect(coverage.some((value) => value < 1)).toBe(true)
    expect(digest(await readFile(f.job.parent.asset.path))).toBe(f.job.parent.asset.sha256)
  }
})

test('real preparation worker freezes its job, preserves prior outputs and refuses cancelled or exhausted admissions', async ({}, info) => {
  const entry = reference.cases.find((value) => value.id === 'raster-single-active')!,
    f = await fixture(info.outputPath('worker'), entry),
    worker = new PreviewProcess(resolve('out/main/preview-worker.js'))
  try {
    const output = join(f.directory, 'prepared')
    await mkdir(output)
    const submitted = structuredClone(f.job),
      pending = worker.prepareMaskStack(output, submitted, new AbortController().signal)
    Object.assign(submitted.adjustments, { exposureEv: 1 })
    const result = await pending
    checkRgba(await readFile(result.request!.stack.candidate.path), entry.expected)
    const before = await readFile(result.request!.stack.candidate.path)
    await expect(
      worker.prepareMaskStack(output, f.job, new AbortController().signal),
    ).rejects.toThrow(/exist/i)
    expect(await readFile(result.request!.stack.candidate.path)).toEqual(before)
    const denied = join(f.directory, 'denied')
    await mkdir(denied)
    await expect(
      worker.prepareMaskStack(
        denied,
        {
          ...f.job,
          admission: {
            ...f.job.admission,
            reservation: { ramBytes: f.job.admission.policy.ram.effectiveBytes, vramBytes: 0 },
          },
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/policy|resource|budget/i)
    const cancelled = join(f.directory, 'cancelled')
    await mkdir(cancelled)
    const controller = new AbortController()
    controller.abort()
    await expect(worker.prepareMaskStack(cancelled, f.job, controller.signal)).rejects.toThrow()
    await expect(readFile(join(cancelled, 'mask-stack.f32'))).rejects.toThrow()
  } finally {
    await worker.close()
  }
})

test('frozen export prepares Texture after shared Detail independently for raster, scene HDR and authored HDR primary', async ({}, info) => {
  test.setTimeout(120000)
  await mkdir(info.outputDir, { recursive: true })
  for (const domain of ['raster', 'scene-linear', 'authored-hdr'] as const) {
    const f = await detailExportFixture(domain !== 'raster', domain === 'authored-hdr')
    try {
      const root: ResolvedMask = {
        id: '00000000-0000-0000-0000-000000000001',
        name: 'Frozen Texture',
        enabled: true,
        inverted: false,
        head: null,
        edge: { ...neutralMaskEdge },
        strokes: [],
        gradient: {
          kind: 'radial',
          center: { x: 0.5, y: 0.5 },
          radiusX: 0.38,
          radiusY: 0.42,
          rotation: 0,
          feather: 35,
        },
        light: { ...neutralMaskLight, contrast: 12 },
        color: { ...neutralMaskColor, saturation: 10 },
        texture: 25,
      }
      const source = {
        ...f.source,
        processing: {
          ...f.source.processing,
          adjustments: { ...f.source.processing.adjustments!, localMasks: [root] },
        },
      }
      const before = await readFile(f.job.asset.path)
      const baseline = await exportRenditions({
        ...f.exportJob,
        source: {
          ...source,
          processing: {
            ...source.processing,
            adjustments: {
              ...source.processing.adjustments!,
              localMasks: [{ ...root, texture: 0 }],
            },
          },
        },
        directory: await f.directory('texture-baseline'),
      })
      const directory = await f.directory('texture-actual'),
        actual = await exportRenditions({
          ...f.exportJob,
          source,
          directory,
          texturePolicy: { ...exportTexturePolicy },
        })
      const unionPath = join(
          directory,
          domain === 'raster' ? 'texture-primary' : 'texture-working',
          'mask-union.f32',
        ),
        bytes = await readFile(unionPath),
        union = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
      let unchanged = 0,
        changed = 0
      for (let i = 0; i < union.length; i++) {
        const visible = f.frame.data[i * 4 + 3] > 0
        if (union[i] === 0 || !visible) {
          expect(actual.rgb.subarray(i * 3, i * 3 + 3), `${domain}/${i}`).toEqual(
            baseline.rgb.subarray(i * 3, i * 3 + 3),
          )
          if (actual.half)
            expect(actual.half.subarray(i * 4, i * 4 + 4)).toEqual(
              baseline.half!.subarray(i * 4, i * 4 + 4),
            )
          unchanged++
        } else {
          changed += Number(
            !actual.rgb.subarray(i * 3, i * 3 + 3).equals(baseline.rgb.subarray(i * 3, i * 3 + 3)),
          )
          if (actual.half)
            changed += Number(
              !Buffer.from(
                actual.half.subarray(i * 4, i * 4 + 4).buffer,
                actual.half.byteOffset + i * 8,
                8,
              ).equals(Buffer.from(baseline.half!.buffer, baseline.half!.byteOffset + i * 8, 8)),
            )
        }
      }
      expect(unchanged).toBeGreaterThan(0)
      expect(changed).toBeGreaterThan(0)
      expect(actual.diagnostics.preparedMaskStack).toBeDefined()
      if (domain === 'authored-hdr') {
        const primary = await readFile(join(directory, 'texture-primary', 'mask-stack.f32'))
        expect(primary).not.toEqual(
          await readFile(join(directory, 'texture-working', 'mask-stack.f32')),
        )
      }
      expect(await readFile(f.job.asset.path)).toEqual(before)
      test
        .info()
        .annotations.push({ type: 'gpu-adapter', description: actual.diagnostics.adapter! })
      await writeFile(
        info.outputPath(`${domain}-receipt.json`),
        JSON.stringify(
          {
            domain,
            unchanged,
            changed,
            headroom: actual.contentHeadroom,
            identity: actual.diagnostics.preparedMaskStack,
          },
          null,
          2,
        ),
      )
    } finally {
      await f.close()
    }
  }
})

test('actual Texture JPEG and gain-map exports preserve their selected rendition through a fresh decoder process', async ({}, info) => {
  test.setTimeout(120000)
  await mkdir(info.outputDir, { recursive: true })
  for (const domain of ['raster', 'scene-linear', 'authored-hdr'] as const) {
    const f = await detailExportFixture(domain !== 'raster', domain === 'authored-hdr')
    const decoder = new PreviewProcess(resolve('out/main/preview-worker.js'))
    try {
      let asset = f.job.asset
      if (domain !== 'raster') {
        // Prospectively chosen balanced synthetic HDR values make the existing 3% quality gate
        // meaningful in every channel, rather than testing relative error at clipped black.
        const rgba = new Float32Array(f.frame.width * f.frame.height * 4)
        for (let y = 0; y < f.frame.height; y++)
          for (let x = 0; x < f.frame.width; x++)
            rgba.set(
              [
                1.8 + 0.3 * Math.sin(x * 0.37 + y * 0.23),
                2.1 + 0.3 * Math.cos(x * 0.19 - y * 0.31),
                2.4 + 0.3 * Math.sin(x * 0.29 + y * 0.17),
                1,
              ],
              (y * f.frame.width + x) * 4,
            )
        const bytes = Buffer.from(rgba.buffer),
          hdr = workingAsset(bytes, f.frame.width, f.frame.height)
        hdr.source = structuredClone(asset.hdr!.source)
        asset = { ...asset, sha256: digest(bytes), hdr }
        await writeFile(asset.path, bytes)
      }
      const root: ResolvedMask = {
        id: '00000000-0000-0000-0000-000000000001',
        name: 'Encoded Texture',
        enabled: true,
        inverted: false,
        head: null,
        edge: { ...neutralMaskEdge },
        strokes: [],
        gradient: {
          kind: 'radial',
          center: { x: 0.5, y: 0.5 },
          radiusX: 0.4,
          radiusY: 0.43,
          rotation: 0,
          feather: 35,
        },
        light: { ...neutralMaskLight },
        color: { ...neutralMaskColor },
        texture: 25,
      }
      const source = {
        ...f.source,
        processing: {
          ...f.source.processing,
          ...(domain !== 'raster' ? { workingAsset: asset } : {}),
          adjustments: { ...f.source.processing.adjustments!, localMasks: [root] },
        },
      }
      const original = await readFile(f.original),
        workingBefore = await readFile(asset.path)
      const frozen = {
        ...f.exportJob,
        source,
        texturePolicy: { ...exportTexturePolicy },
        options: { ...f.exportJob.options, quality: 100 },
        ...(domain !== 'raster'
          ? {
              workingAsset: {
                identity: workingSourceIdentity(source.photo.id, source.processing, true),
                asset,
              },
            }
          : {}),
        ...(domain === 'authored-hdr'
          ? {
              primaryWorkingAsset: {
                identity: workingSourceIdentity(source.photo.id, source.processing, false),
                asset: f.primaryJob!.asset,
              },
            }
          : {}),
      }
      const expected = await exportRenditions({
        ...frozen,
        directory: await f.directory('encoded-reference'),
      })
      const expectedSdr = await sharp(expected.rgb, { raw: { ...expected.geometry, channels: 3 } })
        .withIccProfile('srgb')
        .jpeg({
          quality: 100,
          chromaSubsampling: '4:4:4',
          progressive: false,
          optimiseCoding: true,
        })
        .toBuffer()
      const worker = new ExportProcess(
        resolve('out/main/export-worker.js'),
        resolve('out/main/preview-worker.js'),
      )
      const result = await worker.render(
        { ...frozen, directory: await f.directory('encoded-worker') },
        new AbortController().signal,
      )
      const output = await readFile(result.path),
        sdr = await readFile(join(dirname(result.path), 'sdr.jpg'))
      expect(sdr).toEqual(expectedSdr)
      expect(result.sha256).toBe(digest(output))
      expect(result.diagnostics!.preparedMaskStack).toBeDefined()
      const ordinary = await sharp(output).removeAlpha().raw().toBuffer()
      expect(ordinary.byteLength).toBe(expected.rgb.byteLength)
      let squared = 0
      for (let i = 0; i < ordinary.length; i++) squared += (ordinary[i] - expected.rgb[i]) ** 2
      const psnr =
        squared === 0 ? Infinity : 10 * Math.log10(255 ** 2 / (squared / ordinary.length))
      // The exact independently encoded primary above proves which selected pixels were encoded;
      // JPEG is lossy, so decoded SDR differences are recorded rather than called byte parity.
      let maximumHdrRelativeError: number | undefined
      if (domain !== 'raster') {
        expect(result.diagnostics!.encoder).toBe(selectedExportEncoder())
        expect(result.diagnostics!.encoderFallback).toBeUndefined()
        const parsed = readGainJpeg(output)
        expect(() => validatePrimary(output, expectedSdr)).not.toThrow()
        expect(parsed.metadata.alternateHeadroom).toBeCloseTo(
          Math.log2(expected.contentHeadroom),
          5,
        )
        const gain = await sharp(parsed.gain, { ignoreIcc: true })
          .removeAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true })
        expect(gain.info).toMatchObject({ ...expected.geometry, channels: 3 })
        const codec = await loadUltraHdr(),
          decoded = codec.inspect(output, expected.contentHeadroom),
          decodedBase = codec.inspect(output, 1)
        expect(decoded.pixels).toBeDefined()
        expect(decodedBase.pixels).toBeDefined()
        // Boost 1 supplies zero gain weight only under these encoded metadata facts.
        expect(parsed.metadata.baseHeadroom).toBe(0)
        expect(parsed.metadata.useBase).toBe(false)
        expect(parsed.metadata.sdrOffset).toEqual(parsed.metadata.hdrOffset)
        expect(decoded.gamut).toBe(2)
        expect(decodedBase.gamut).toBe(2)
        maximumHdrRelativeError = 0
        let maximumOracleError = 0,
          maximumDecodedRelativeError = 0,
          maximumCodecBaseOracleError = 0,
          maximumCodecBaseRelativeError = 0,
          maximumLinearBaseDifference = 0
        const discrepancies: object[] = []
        await writeFile(info.outputPath(`${domain}-encoded.jpg`), output)
        await writeFile(info.outputPath(`${domain}-selected.rgb`), expected.rgb)
        await writeFile(
          info.outputPath(`${domain}-selected.half`),
          Buffer.from(expected.half!.buffer, expected.half!.byteOffset, expected.half!.byteLength),
        )
        for (let y = 0; y < expected.geometry.height; y++)
          for (let x = 0; x < expected.geometry.width; x++) {
            const i = y * expected.geometry.width + x,
              base = to2020([0, 1, 2].map((c) => srgbLinear(ordinary[i * 3 + c] / 255))),
              reconstructed = reconstruct(
                base,
                [0, 1, 2].map((c) => gain.data[i * 3 + c] / 255),
                parsed.metadata,
                expected.contentHeadroom,
              ),
              codecBase = [0, 1, 2].map((c) =>
                fromHalf(decodedBase.pixels![(y * decodedBase.stride! + x) * 4 + c]),
              ),
              fromCodecBase = reconstruct(
                codecBase,
                [0, 1, 2].map((c) => gain.data[i * 3 + c] / 255),
                parsed.metadata,
                expected.contentHeadroom,
              )
            for (let c = 0; c < 3; c++) {
              const actual = fromHalf(decoded.pixels![(y * decoded.stride! + x) * 4 + c]),
                target = fromHalf(expected.half![i * 4 + c])
              const error = Math.abs(actual - reconstructed[c])
              maximumOracleError = Math.max(maximumOracleError, error)
              maximumCodecBaseOracleError = Math.max(
                maximumCodecBaseOracleError,
                Math.abs(actual - fromCodecBase[c]),
              )
              maximumCodecBaseRelativeError = Math.max(
                maximumCodecBaseRelativeError,
                Math.abs(fromCodecBase[c] - target) / Math.max(0.01, target),
              )
              maximumLinearBaseDifference = Math.max(
                maximumLinearBaseDifference,
                Math.abs(base[c] - codecBase[c]),
              )
              maximumDecodedRelativeError = Math.max(
                maximumDecodedRelativeError,
                Math.abs(actual - target) / Math.max(0.01, target),
              )
              if (error >= 0.02)
                discrepancies.push({
                  x,
                  y,
                  c,
                  actual,
                  reconstructed: reconstructed[c],
                  target,
                  base,
                  codecBase,
                  fromCodecBase,
                  gain: [0, 1, 2].map((channel) => gain.data[i * 3 + channel]),
                  ordinary: [0, 1, 2].map((channel) => ordinary[i * 3 + channel]),
                  error,
                })
              maximumHdrRelativeError = Math.max(
                maximumHdrRelativeError,
                Math.abs(reconstructed[c] - target) / Math.max(0.01, target),
              )
            }
          }
        await writeFile(
          info.outputPath(`${domain}-codec-evidence.json`),
          JSON.stringify(
            {
              metadata: parsed.metadata,
              decoded: { info: decoded.info, gamut: decoded.gamut, stride: decoded.stride },
              maximumOracleError,
              maximumCodecBaseOracleError,
              maximumCodecBaseRelativeError,
              maximumLinearBaseDifference,
              maximumHdrRelativeError,
              maximumDecodedRelativeError,
              discrepancies,
            },
            null,
            2,
          ),
        )
        // The gain formula is independent; its JPEG base decode deliberately uses the
        // accepted codec. Sharp rounds primary YCbCr to RGB8 before linearization,
        // and the authored pair amplifies that rounding by up to 25x. The retained
        // failed all-pixel Sharp-base oracle remains recorded above, not relabelled.
        expect(maximumCodecBaseOracleError).toBeLessThan(0.02)
        // Keep the independent Sharp-base quality-100 3% gate over every pixel.
        expect(maximumHdrRelativeError).toBeLessThanOrEqual(0.03)
      }
      const metadata = await decoder.inspect(result.path, new AbortController().signal)
      if (domain !== 'raster') {
        expect(metadata.hdrJpeg?.state).toBe('supported')
        if (metadata.hdrJpeg?.state !== 'supported')
          throw new Error('Exported HDR source did not reopen as supported.')
        expect(metadata.hdrJpeg.headroom).toBeCloseTo(expected.contentHeadroom, 4)
        const reopened = await decoder.renderFull(
          result.path,
          await f.directory('reopened-output'),
          new AbortController().signal,
          {
            metadata,
            settings: { ...noLensSettings },
            revision: 0,
            processing: 'hdr-v1',
            workingOnly: true,
            adjustments: structuredClone(neutralAdjustments),
          },
        )
        expect(reopened.linear?.hdr?.source.display?.encoding).toBe('iso-21496-1-jpeg')
        expect(reopened.width).toBe(expected.geometry.width)
        expect(reopened.height).toBe(expected.geometry.height)
      } else expect(metadata.hdrJpeg?.state).not.toBe('supported')
      expect(await readFile(f.original)).toEqual(original)
      expect(await readFile(asset.path)).toEqual(workingBefore)
      await writeFile(
        info.outputPath(`${domain}-encoded-receipt.json`),
        JSON.stringify(
          {
            domain,
            psnr: Number.isFinite(psnr) ? psnr : 'infinite',
            headroom: expected.contentHeadroom,
            maximumHdrRelativeError,
            encoder: result.diagnostics!.encoder,
            sha256: result.sha256,
          },
          null,
          2,
        ),
      )
    } finally {
      await decoder.close()
      await f.close()
    }
  }
})
