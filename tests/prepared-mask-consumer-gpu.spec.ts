/* eslint-disable no-empty-pattern -- Playwright requires destructured fixture arguments. */
import { expect, test } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createPointGpu } from '../src/main/gpu/point-renderer'
import { exportRenditions } from '../src/main/export/renditions'
import type { ExportRenderJob, ExportSource } from '../src/main/export/types'
import { PreviewProcess } from '../src/main/preview-process'
import {
  preparedWorkingIdentity,
  validatePreparedPreviewLineage,
} from '../src/main/prepared-preview-lineage'
import {
  PREPARED_MASK_STACK_CONSUMED,
  PREPARED_MASK_STACK_GRID_POLICY,
  PREPARED_MASK_STACK_POLICY,
  preparedMaskStackContext,
  preparedMaskStackKey,
  type PreparedMaskStack,
  type PreparedMaskStackRequest,
} from '../src/main/processing/prepared-mask-stack'
import { processingMetadata } from '../src/main/processing/metadata'
import { workingSourceIdentity, type WorkingAsset } from '../src/main/working-assets'
import {
  neutralAdjustments,
  srgbTransform,
  type AdjustmentParameters,
} from '../src/shared/adjustments'
import { defaultExportOptions } from '../src/shared/export'
import { outputHdr, SDR_TARGET } from '../src/shared/hdr'
import { noLensSettings, type ProcessingOptions } from '../src/shared/lens'
import { identityMaskGeometry } from '../src/shared/mask-geometry'
import { neutralMaskColor, neutralMaskEdge, neutralMaskLight } from '../src/shared/masks'
import { detailFrameJob } from './detail-frame.helpers'
import { sha, workingAsset } from './export.helpers'
import { brush } from './helpers/mask-reference'
import { rasterLinear } from './raster-reference'

const width = 7,
  height = 65,
  signal = () => new AbortController().signal
type Domain = 'raster' | 'scene-linear'

/** Small synthetic pre-rendition pixels exercise consumption, not the Texture producer. */
function pixels() {
  const legacy = new Float32Array(width * height * 4),
    prepared = new Float32Array(legacy.length),
    union = new Float32Array(width * height)
  for (let i = 0; i < union.length; i++) {
    const alpha = i % 11 === 0 ? 0 : i % 7 === 0 ? 0.5 : 1
    legacy.set([0.08 + (i % 13) * 0.014, 0.14 + (i % 9) * 0.012, 0.04, alpha], i * 4)
    prepared.set([0.35 + (i % 5) * 0.025, 0.07 + (i % 3) * 0.01, 0.55, alpha], i * 4)
    union[i] = [0, 0.25, 1, 2 ** -149][i % 4]
  }
  return { legacy, prepared, union }
}

function controls(): AdjustmentParameters {
  return {
    ...structuredClone(neutralAdjustments),
    exposureEv: 0.42,
    contrast: 17,
    saturation: 11,
    maskGeometry: identityMaskGeometry(width, height),
    localMasks: [
      {
        id: '00000000-0000-0000-0000-000000000001',
        name: 'Synthetic active local controls',
        enabled: true,
        inverted: false,
        head: null,
        edge: { ...neutralMaskEdge },
        light: { ...neutralMaskLight, exposureEv: 0.35, contrast: 13 },
        color: { ...neutralMaskColor, saturation: 9 },
        strokes: [brush('add', 0.25, 0.7, [[0.45, 0.5]])],
      },
    ],
  }
}

function words(bytes: Buffer) {
  return new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
}

async function renderNative(
  domain: Domain,
  packed: boolean,
  preserveAlpha: boolean,
  input = pixels(),
) {
  const a = controls(),
    alternate = { ...a, exposureEv: -0.65, contrast: -23, saturation: -35 },
    options = { domain, preserveAlpha, transform: srgbTransform },
    ordinary = await createPointGpu(
      width * 64,
      a,
      undefined,
      false,
      packed,
      64,
      0,
      undefined,
      options,
    )
  let preparedOwner: Awaited<ReturnType<typeof createPointGpu>> | undefined,
    alternateOwner: Awaited<ReturnType<typeof createPointGpu>> | undefined
  try {
    preparedOwner = await createPointGpu(
      width * 64,
      a,
      undefined,
      false,
      packed,
      64,
      0,
      undefined,
      {
        ...options,
        preparedPoint: true,
      },
    )
    alternateOwner = await createPointGpu(
      width * 64,
      alternate,
      domain === 'scene-linear' ? [1.2, 0, 0, 0, 0.8, 0, 0, 0, 1.1] : undefined,
      false,
      packed,
      64,
      0,
      undefined,
      { ...options, preparedPoint: true },
    )
    expect(ordinary.renderPrepared).toBeUndefined()
    expect(preparedOwner.renderPrepared).toBeDefined()
    const legacyOutput: Buffer[] = [],
      selectedOutput: Buffer[] = [],
      alternateOutput: Buffer[] = []
    for (let y = 0; y < height; y += 64) {
      const start = y * width,
        end = Math.min(height, y + 64) * width,
        legacy = input.legacy.subarray(start * 4, end * 4),
        prepared = input.prepared.subarray(start * 4, end * 4),
        union = input.union.subarray(start, end)
      legacyOutput.push((await ordinary.render(legacy, start)).data)
      selectedOutput.push(
        (await preparedOwner.renderPrepared!(legacy, prepared, union, start)).data,
      )
      alternateOutput.push(
        (await alternateOwner.renderPrepared!(legacy, prepared, union, start)).data,
      )
    }
    return {
      legacy: Buffer.concat(legacyOutput),
      selected: Buffer.concat(selectedOutput),
      alternate: Buffer.concat(alternateOutput),
      adapter: ordinary.adapter,
    }
  } finally {
    await alternateOwner?.close()
    await preparedOwner?.close()
    await ordinary.close()
  }
}

for (const domain of ['raster', 'scene-linear'] as const)
  for (const packed of [true, false])
    test(`prepared ${domain} ${packed ? 'RGBA8' : 'Float32 SDR'} consumes point edits once and retains actual legacy words across row 64`, async () => {
      const input = pixels(),
        before = [input.legacy.slice(), input.prepared.slice(), input.union.slice()],
        preserveAlpha = packed,
        rendered = await renderNative(domain, packed, preserveAlpha, input),
        legacy = words(rendered.legacy),
        actual = words(rendered.selected),
        alternate = words(rendered.alternate),
        floats = new Float32Array(actual.buffer, actual.byteOffset, actual.length),
        stride = packed ? 1 : 3
      test.info().annotations.push({ type: 'adapter', description: rendered.adapter })
      let changed = 0,
        partial = 0,
        hidden = 0,
        subnormal = 0
      for (let i = 0; i < input.union.length; i++) {
        const alpha = input.legacy[i * 4 + 3],
          selected = input.union[i] > 0 && alpha > 0
        if (!selected) {
          for (let c = 0; c < stride; c++)
            expect(actual[i * stride + c]).toBe(legacy[i * stride + c])
          if (alpha === 0 && input.union[i] > 0) hidden++
          continue
        }
        if (input.union[i] === 0.25) partial++
        if (input.union[i] === 2 ** -149) subnormal++
        for (let c = 0; c < stride; c++) {
          expect(actual[i * stride + c]).toBe(alternate[i * stride + c])
          changed += Number(actual[i * stride + c] !== legacy[i * stride + c])
        }
        const rgb = Array.from(input.prepared.subarray(i * 4, i * 4 + 3)) as [
            number,
            number,
            number,
          ],
          reference =
            domain === 'raster'
              ? rasterLinear(rgb, neutralAdjustments)
              : outputHdr(rgb, SDR_TARGET).rgb
        for (let c = 0; c < 3; c++) {
          const linear = preserveAlpha ? reference[c] : reference[c] * alpha + 1 - alpha
          if (packed) {
            const encoded = Math.round(
              Math.min(
                1,
                Math.max(
                  0,
                  linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055,
                ),
              ) * 255,
            )
            expect(Math.abs(((actual[i] >>> (c * 8)) & 255) - encoded)).toBeLessThanOrEqual(1)
          } else
            expect(Math.abs(floats[i * 3 + c] - linear)).toBeLessThanOrEqual(
              2e-6 + 2e-5 * Math.abs(linear),
            )
        }
        if (packed) expect(actual[i] >>> 24).toBe(Math.round(alpha * 255))
      }
      expect(changed).toBeGreaterThan(0)
      expect(partial).toBeGreaterThan(0)
      expect(hidden).toBeGreaterThan(0)
      expect(subnormal).toBeGreaterThan(0)
      expect(input.legacy).toEqual(before[0])
      expect(input.prepared).toEqual(before[1])
      expect(input.union).toEqual(before[2])
    })

test('prepared native ownership refuses malformed coverage, alpha changes and nonfinite pixels without poisoning the next valid strip', async () => {
  const input = pixels(),
    legacy = input.legacy.subarray(0, width * 4),
    prepared = input.prepared.subarray(0, width * 4),
    union = input.union.subarray(0, width),
    owner = await createPointGpu(width, controls(), undefined, false, true, 64, 0, undefined, {
      domain: 'raster',
      preserveAlpha: true,
      preparedPoint: true,
    })
  try {
    await expect(owner.render(legacy)).rejects.toThrow(/prepared|consum/i)
    for (const value of [NaN, Infinity, -Infinity, -0.25, 1.01]) {
      const invalid = union.slice()
      invalid[1] = value
      await expect(owner.renderPrepared!(legacy, prepared, invalid)).rejects.toThrow(
        /invalid|prepared/i,
      )
    }
    for (const target of ['parent', 'candidate'] as const) {
      const invalid = (target === 'parent' ? legacy : prepared).slice()
      invalid[4] = NaN
      await expect(
        owner.renderPrepared!(
          target === 'parent' ? invalid : legacy,
          target === 'candidate' ? invalid : prepared,
          union,
        ),
      ).rejects.toThrow(/invalid|prepared/i)
    }
    const changedAlpha = prepared.slice()
    changedAlpha[7] = 0.25
    await expect(owner.renderPrepared!(legacy, changedAlpha, union)).rejects.toThrow(
      /invalid|prepared/i,
    )
    await expect(owner.renderPrepared!(legacy, prepared, union.subarray(1))).rejects.toThrow(
      /length|strip|prepared/i,
    )
    const valid = await owner.renderPrepared!(legacy, prepared, union)
    expect(valid.data.byteLength).toBe(width * 4)
    expect(Number.isFinite(valid.headroom)).toBe(true)
  } finally {
    await owner.close()
  }
})

async function fixture(directory: string, domain: Domain) {
  await mkdir(directory, { recursive: true })
  const input = pixels(),
    bytes = Buffer.from(input.legacy.buffer),
    candidate = Buffer.from(input.prepared.buffer),
    union = Buffer.from(input.union.buffer),
    path = join(directory, 'parent.f32'),
    asset: WorkingAsset = {
      path,
      width,
      height,
      byteLength: bytes.byteLength,
      sha256: sha(bytes),
      transform: { ...srgbTransform },
      maskGeometry: identityMaskGeometry(width, height),
      ...(domain === 'scene-linear' ? { hdr: workingAsset(bytes, width, height) } : {}),
    },
    options: ProcessingOptions = {
      metadata: processingMetadata({}, []),
      settings: { ...noLensSettings },
      revision: 7,
      adjustments: controls(),
      workingAsset: asset,
    },
    photoId = sha(bytes),
    parent = {
      identity: workingSourceIdentity(photoId, options, domain === 'scene-linear'),
      asset,
    },
    textureIdentity = sha(
      Buffer.from('synthetic baked candidate and unquantized final Texture union'),
    ),
    unkeyed: Omit<PreparedMaskStack, 'key'> = {
      policy: PREPARED_MASK_STACK_POLICY,
      state: 'complete',
      consumed: PREPARED_MASK_STACK_CONSUMED,
      gridPolicy: PREPARED_MASK_STACK_GRID_POLICY,
      domain,
      parent,
      context: preparedMaskStackContext({ parent, adjustments: options.adjustments!, domain }),
      textureIdentity,
      candidate: {
        path: join(directory, 'candidate.f32'),
        width,
        height,
        byteLength: candidate.byteLength,
        sha256: sha(candidate),
      },
      union: {
        path: join(directory, 'union.f32'),
        byteLength: union.byteLength,
        sha256: sha(union),
      },
    },
    request: PreparedMaskStackRequest = {
      stack: { ...unkeyed, key: preparedMaskStackKey(unkeyed) },
      admission: detailFrameJob().admission!,
    },
    source: ExportSource = {
      hdr: domain === 'scene-linear',
      // A correctly selected managed parent never needs an original decoder.
      path: join(directory, 'original-decoder-must-not-open.png'),
      identity: { dev: 0, ino: 0, size: 0, mtimeMs: 0, ctimeMs: 0 },
      photo: {
        id: photoId,
        filename: 'Synthetic.png',
        format: 'PNG',
        width,
        height,
        bytes: bytes.byteLength,
        importedAt: '',
        previewSource: 'decoded',
        previewUrl: '',
        thumbnailUrl: '',
      },
      processing: options,
    }
  await writeFile(path, bytes)
  await writeFile(request.stack.candidate.path, candidate)
  await writeFile(request.stack.union.path, union)
  const directoryFor = async (name: string) => {
    const selected = join(directory, name)
    await mkdir(selected)
    return selected
  }
  const exportJob = async (name: string): Promise<ExportRenderJob> => ({
    source,
    directory: await directoryFor(name),
    options: { ...defaultExportOptions, metadata: 'none' },
    hdr: false,
    workingAsset: parent,
    detailAdmission: request.admission,
    preparedMaskStack: request,
  })
  return { input, options, request, bytes, candidate, union, directoryFor, exportJob }
}

for (const domain of ['raster', 'scene-linear'] as const)
  test(`prepared ${domain} is consumed through the real preview worker and frozen SDR export`, async ({}, info) => {
    const f = await fixture(info.outputPath(domain), domain),
      worker = new PreviewProcess(resolve('out/main/preview-worker.js'))
    try {
      const output = await f.directoryFor('preview'),
        submitted = structuredClone(f.request),
        pending = worker.renderPreparedFull(output, f.options, signal(), 'gpu', submitted)
      // The caller can change its own object during the asynchronous warm-up boundary.
      Object.assign(submitted.stack, { context: 'f'.repeat(64) })
      const result = await pending,
        expectedPreview = await renderNative(domain, true, true, f.input)
      expect(await readFile(join(output, 'full.rgba'))).toEqual(expectedPreview.selected)
      expect(result.sha256).toBe(sha(expectedPreview.selected))
      expect(result.linear).toBeUndefined()
      expect(result.preparedMaskStack?.key).toBe(f.request.stack.key)
      expect(result.preparedMaskStack?.consumed).toBe(PREPARED_MASK_STACK_CONSUMED)
      expect(() =>
        validatePreparedPreviewLineage(result, f.request.stack.parent.identity, {}),
      ).toThrow(/consumed.*not.*source/i)
      expect(
        preparedWorkingIdentity(
          f.request.stack.parent.identity,
          f.options,
          domain === 'scene-linear',
          result,
        ),
      ).toBeUndefined()
      const job = await f.exportJob('export')
      // The prepared request supplies the actual frozen admission when no other stage owns one.
      delete job.detailAdmission
      const exported = await exportRenditions(job),
        expectedExport = await renderNative(domain, true, false, f.input),
        rgb = Buffer.alloc(width * height * 3)
      for (let i = 0; i < width * height; i++)
        expectedExport.selected.copy(rgb, i * 3, i * 4, i * 4 + 3)
      expect(exported.rgb).toEqual(rgb)
      expect(await readFile(f.options.workingAsset!.path)).toEqual(f.bytes)
      expect(await readFile(f.request.stack.candidate.path)).toEqual(f.candidate)
      expect(await readFile(f.request.stack.union.path)).toEqual(f.union)
    } finally {
      await worker.close()
    }
  })

test('prepared preview and export refuse stale context, incomplete receipt and corrupt candidate, union or parent before returning a result', async ({}, info) => {
  const f = await fixture(info.outputPath('refusals'), 'raster'),
    worker = new PreviewProcess(resolve('out/main/preview-worker.js'))
  let ordinal = 0
  const refuse = async (request: PreparedMaskStackRequest, options = f.options) => {
    const output = await f.directoryFor(`refused-preview-${ordinal++}`)
    await expect(
      worker.renderPreparedFull(output, options, signal(), 'gpu', request),
    ).rejects.toThrow(/prepared|point|context|source|hash|damaged/i)
    await expect(readFile(join(output, 'full.rgba'))).rejects.toThrow()
    const job = await f.exportJob(`refused-export-${ordinal++}`)
    await expect(
      exportRenditions({
        ...job,
        source: { ...job.source, processing: options },
        preparedMaskStack: request,
      }),
    ).rejects.toThrow(/prepared|point|context|source|hash|damaged/i)
  }
  try {
    await refuse(f.request, {
      ...f.options,
      adjustments: { ...f.options.adjustments!, exposureEv: 0.43 },
    })
    await refuse({
      ...f.request,
      stack: { ...f.request.stack, state: 'pending' },
    } as unknown as PreparedMaskStackRequest)
    await refuse({ ...f.request, stack: { ...f.request.stack, context: 'a'.repeat(64) } })
    const exhausted: PreparedMaskStackRequest = {
      ...f.request,
      admission: {
        ...f.request.admission,
        reservation: {
          ...f.request.admission.reservation,
          ramBytes: f.request.admission.policy.ram.effectiveBytes,
        },
      },
    }
    const refusedResources = await f.directoryFor('refused-preview-resource-admission')
    await expect(
      worker.renderPreparedFull(refusedResources, f.options, signal(), 'gpu', exhausted),
    ).rejects.toThrow(/resource admission/i)
    await expect(readFile(join(refusedResources, 'full.rgba'))).rejects.toThrow()
    const incoherent = await f.exportJob('refused-export-incoherent-admission')
    await expect(
      exportRenditions({
        ...incoherent,
        preparedMaskStack: {
          ...f.request,
          admission: {
            ...f.request.admission,
            reservation: {
              ...f.request.admission.reservation,
              ramBytes: f.request.admission.reservation.ramBytes + 1,
            },
          },
        },
      }),
    ).rejects.toThrow(/coherent frozen resource admission/i)
    for (const [path, original] of [
      [f.request.stack.candidate.path, f.candidate],
      [f.request.stack.union.path, f.union],
      [f.options.workingAsset!.path, f.bytes],
    ] as const) {
      const damaged = Buffer.from(original)
      damaged[0] ^= 1
      await writeFile(path, damaged)
      try {
        await refuse(f.request)
      } finally {
        await writeFile(path, original)
      }
    }
  } finally {
    await worker.close()
  }
})
