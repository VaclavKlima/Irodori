import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { PreviewEngine } from '../src/main/preview-engine'
import { neutralAdjustments } from '../src/shared/adjustments'
import { automaticLensSettings } from '../src/shared/lens'
import { hdrAdjustmentMatrix } from '../src/shared/hdr'
import { packAces } from '../src/shared/aces-data'
import { prepareDisplayRendering, DISPLAY_RENDERING_VERSION } from '../src/shared/display-rendering'
import { hdrCacheKernel, hdrMipShader, hdrShader } from '../src/renderer/src/preview/hdr-shader'
import { hdrCachePlan } from '../src/renderer/src/preview/hdr-render-cache'
import { selectInteractivePreviewPolicy } from '../src/shared/interactive-preview-policy'
import { fitScale } from '../src/renderer/src/preview/geometry'
import { provenance } from './research/pipeline/provenance'

const [directoryArgument, measurementArgument, sourceArgument] = process.argv.slice(2)
if (!directoryArgument || !measurementArgument || !sourceArgument)
  throw new Error(
    'Expected output directory, retained editor-responsiveness JSON and original RAW fixture.',
  )
const directory = resolve(directoryArgument)
const sourcePath = resolve(sourceArgument)
const measurementPath = resolve(measurementArgument)
const measurement = JSON.parse(await readFile(measurementPath, 'utf8')) as {
  viewport: { width: number; height: number; dpr: number }
  canvas: { cssBounds: { x: number; y: number; width: number; height: number } }
  windowState: { maximized: boolean; fullscreen: boolean }
  target: { mode: string; colorSpace: string; peak: number; headroom: number | null }
  tileBatch: number
  maximizedConfiguration: unknown
  provenance: unknown
  trials: { expectedSourceIdentity: string }[]
}
const geometry = {
  windowWidth: measurement.viewport.width,
  windowHeight: measurement.viewport.height,
  x: measurement.canvas.cssBounds.x,
  y: measurement.canvas.cssBounds.y,
  width: measurement.canvas.cssBounds.width,
  height: measurement.canvas.cssBounds.height,
  dpr: measurement.viewport.dpr,
}
if (
  !Object.values(geometry).every((value) => Number.isFinite(value)) ||
  [geometry.windowWidth, geometry.windowHeight, geometry.width, geometry.height, geometry.dpr].some(
    (value) => value <= 0,
  ) ||
  geometry.x < 0 ||
  geometry.y < 0 ||
  geometry.x + geometry.width > geometry.windowWidth ||
  geometry.y + geometry.height > geometry.windowHeight
)
  throw new Error('A valid measured window and viewport geometry is required.')
if (!measurement.windowState.maximized || measurement.windowState.fullscreen)
  throw new Error('The retained application measurement must be maximized, with desktop bars.')
if (
  measurement.target.mode !== 'sdr' ||
  measurement.target.peak !== 1 ||
  !['srgb', 'display-p3'].includes(measurement.target.colorSpace) ||
  (measurement.target.headroom !== null &&
    (!Number.isFinite(measurement.target.headroom) || measurement.target.headroom < 1)) ||
  !Number.isSafeInteger(measurement.tileBatch) ||
  measurement.tileBatch < 1 ||
  measurement.tileBatch > 2048
)
  throw new Error('An explicit supported SDR target and actual tile batch are required.')
const colorSpace = measurement.target.colorSpace as 'srgb' | 'display-p3'
await mkdir(directory, { recursive: true })
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const originalSha256 = sha(await readFile(sourcePath))
const engine = new PreviewEngine()
try {
  const metadata = await engine.inspect(sourcePath)
  const prepared = await engine.renderFull(sourcePath, directory, undefined, {
    metadata,
    settings: automaticLensSettings,
    revision: 0,
    processing: 'hdr-v1',
    adjustments: neutralAdjustments,
    workingOnly: true,
  })
  const asset = prepared.linear?.hdr
  if (!asset) throw new Error('The real RAW did not produce a validated scene-linear asset.')
  const sourceBytes = await readFile(join(directory, 'linear.f32'))
  if (
    sha(sourceBytes) !== asset.sha256 ||
    sourceBytes.byteLength !== asset.width * asset.height * 16
  )
    throw new Error('The working source does not match its dimensions and hash.')
  if (
    !measurement.trials.length ||
    measurement.trials.some(
      ({ expectedSourceIdentity }) =>
        !expectedSourceIdentity.includes(originalSha256) ||
        !expectedSourceIdentity.endsWith(`:${asset.sha256}`),
    )
  )
    throw new Error('The decoded working source differs from the measured application source.')
  await rename(join(directory, 'linear.f32'), join(directory, 'source.f32'))
  const view = { fit: true, scale: fitScale(asset, geometry), x: 0, y: 0 }
  const tileSize = 64
  const plan = hdrCachePlan(asset, asset, geometry, view, 'after', 0.5, tileSize)
  const target = { mode: 'sdr' as const, colorSpace, peak: 1 }
  const uniforms = new Float32Array(44)
  uniforms.set([
    geometry.width,
    geometry.height,
    asset.width,
    asset.height,
    0,
    0,
    view.scale,
    geometry.dpr,
    0,
    0,
    0,
    0,
    0,
    0,
    1,
    0,
    0,
    0.5,
    Math.floor(Math.log2(Math.max(asset.width, asset.height))) + 1,
    0,
  ])
  const wb = hdrAdjustmentMatrix(neutralAdjustments, asset.whiteBalance)
  uniforms[19] = Number(!!wb)
  for (let row = 0; row < 3; row++)
    uniforms.set((wb ?? [1, 0, 0, 0, 1, 0, 0, 0, 1]).slice(row * 3, row * 3 + 3), 20 + row * 4)
  uniforms[31] = Number(!!asset.source.display)
  uniforms.set([plan.columns, plan.columns * plan.rows, plan.width, plan.height], 32)
  uniforms[37] = 1
  uniforms[38] = colorSpace === 'display-p3' ? 2 : 1
  uniforms[40] = plan.level
  uniforms[42] = Number(measurement.target.headroom !== null)
  uniforms[43] = measurement.target.headroom ?? 1
  const serializedPlan = (value: ReturnType<typeof hdrCachePlan>) => ({
    level: value.level,
    width: value.width,
    height: value.height,
    columns: value.columns,
    rows: value.rows,
    tiles: value.tiles.map(({ x, y }) => [x, y]),
  })
  const files: Record<string, { path: string; sha256: string }> = {
    source: { path: 'source.f32', sha256: asset.sha256 },
  }
  const write = async (key: string, path: string, bytes: Uint8Array | string) => {
    await writeFile(join(directory, path), bytes)
    files[key] = { path, sha256: sha(bytes) }
  }
  const tables = packAces(prepareDisplayRendering(target))
  await write('tables', 'tables.f32', new Uint8Array(tables.buffer))
  await write('uniforms', 'uniforms.f32', new Uint8Array(uniforms.buffer))
  await write('canonical', 'canonical.wgsl', hdrCacheKernel().shader)
  await write(
    'interactive',
    'interactive.wgsl',
    hdrCacheKernel(selectInteractivePreviewPolicy('f32', target.mode)).shader,
  )
  await write('presentation', 'presentation.wgsl', hdrShader)
  await write('mip', 'mip.wgsl', hdrMipShader)
  const fixture = {
    schemaVersion: 1,
    source: {
      width: asset.width,
      height: asset.height,
      identity: `original:${originalSha256}/working:${asset.sha256}`,
      originalSha256,
      workingSha256: asset.sha256,
    },
    viewport: {
      ...geometry,
      scale: view.scale,
      panX: 0,
      panY: 0,
      fit: true,
    },
    target,
    tile: { size: tileSize, capacity: 2048, batch: measurement.tileBatch },
    plans: {
      fit: serializedPlan(plan),
      native: serializedPlan(
        hdrCachePlan(
          asset,
          asset,
          geometry,
          { fit: false, scale: 1, x: 0, y: 0 },
          'after',
          0.5,
          tileSize,
        ),
      ),
    },
    files,
    provenance: {
      ...(await provenance([
        sourcePath,
        measurementPath,
        'scripts/prepare-native-viewport-fixture.ts',
        'src/renderer/src/preview/hdr-shader.ts',
        'src/shared/display-rendering.ts',
        'src/shared/aces-preview-wgsl.ts',
      ])),
      build:
        'Actual PreviewEngine sensor decode and production shader exports for native comparison.',
      renderingVersion: DISPLAY_RENDERING_VERSION,
      measurement: { path: measurementPath, provenance: measurement.provenance },
      maximizedConfiguration: measurement.maximizedConfiguration,
      confirmedTarget: measurement.target,
      requestedSettings: automaticLensSettings,
      requestedAdjustments: neutralAdjustments,
      sourceContract: asset.source,
      whiteBalance: asset.whiteBalance,
      nativeRetainedPresentationReservationBytes: 0,
      resourceBoundary:
        'The native prototype has no application analysis or retained-presentation cache. Its independent allocation guard remains 768 MiB; equal source/target/geometry does not establish equal whole-application resources.',
      corrections: prepared.appliedCorrections,
      preparationDiagnostics: prepared.diagnostics,
    },
  }
  await writeFile(join(directory, 'fixture.json'), JSON.stringify(fixture, null, 2) + '\n')
  console.log(
    JSON.stringify({ directory, source: fixture.source, viewport: fixture.viewport, target }),
  )
} finally {
  await engine.close()
}
