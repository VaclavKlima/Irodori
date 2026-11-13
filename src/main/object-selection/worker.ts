import { readFile, rename, rm, stat } from 'node:fs/promises'
import { endianness } from 'node:os'
import * as ort from 'onnxruntime-node'
import sharp from 'sharp'
import { createObjectSelectionGpu, validateObjectSelectionSize } from './gpu'
import {
  loadObjectSelectionGraph,
  OBJECT_SELECTION_MODEL_ID,
  objectSelectionSessionOptions,
  sha256,
} from './model'
import { packObjectSelectionPrompts } from './prompts'
import { AUTOMATIC_SELECTION_ID, loadAutomaticSelectionGraph } from './automatic-model'
import { refineAutomaticSelection } from './automatic-gpu'
import { maskCapabilities } from '../../shared/masks'
import type {
  ObjectSelectionPrepared,
  ObjectSelectionSource,
  ObjectSelectionWorkerReply,
  ObjectSelectionWorkerRequest,
} from './types'

process.env.ORT_DISABLE_TELEMETRY = '1'
let encoder: ort.InferenceSession | undefined
let decoder: ort.InferenceSession | undefined
let gpu: Awaited<ReturnType<typeof createObjectSelectionGpu>> | undefined
let retained: ort.InferenceSession.ReturnType | undefined
let prepared: ObjectSelectionPrepared | undefined
let busy = false
let automaticSession: { kind: 'sky' | 'background'; session: ort.InferenceSession } | undefined

async function close() {
  for (const tensor of Object.values(retained ?? {})) tensor.dispose()
  retained = undefined
  prepared = undefined
  await Promise.allSettled([
    encoder?.release(),
    decoder?.release(),
    automaticSession?.session.release(),
  ])
  automaticSession = undefined
  encoder = decoder = undefined
  gpu?.close()
  gpu = undefined
}

async function initialize(directory: string) {
  if (automaticSession) await close()
  if (encoder && decoder && gpu) return
  if (process.versions.electron || endianness() !== 'LE')
    throw new Error('Object selection requires the isolated little-endian Node worker.')
  if (!ort.listSupportedBackends().some((backend) => backend.name === 'webgpu' && backend.bundled))
    throw new Error(
      'The native WebGPU inference provider is unavailable. CPU inference is disabled.',
    )
  gpu = await createObjectSelectionGpu()
  const options = objectSelectionSessionOptions()
  encoder = await ort.InferenceSession.create(
    await loadObjectSelectionGraph(directory, 'encoder'),
    options,
  )
  decoder = await ort.InferenceSession.create(
    await loadObjectSelectionGraph(directory, 'decoder'),
    options,
  )
}

async function automatic(
  request: Extract<ObjectSelectionWorkerRequest, { operation: 'automatic' }>,
) {
  const { source, selection } = request
  validateObjectSelectionSize(source.width, source.height)
  if (
    source.format !== 'rgba8' ||
    typeof source.key !== 'string' ||
    !source.key ||
    source.key.length > 1024 ||
    (await stat(source.path)).size !== source.width * source.height * 4
  )
    throw new Error('Automatic selection requires the confirmed canonical RGBA source.')
  if (
    process.versions.electron ||
    endianness() !== 'LE' ||
    !ort.listSupportedBackends().some((backend) => backend.name === 'webgpu' && backend.bundled)
  )
    throw new Error('The native WebGPU selection provider is unavailable. Retry GPU.')
  if (encoder || (automaticSession && automaticSession.kind !== selection)) await close()
  const edge = selection === 'sky' ? 512 : 1024
  const guideEdge = selection === 'sky' ? 128 : 1024
  const temporary = `${request.outputPath}.tmp`
  let input: ort.Tensor | undefined
  let outputs: ort.InferenceSession.ReturnType | undefined
  try {
    if (!automaticSession)
      automaticSession = {
        kind: selection,
        session: await ort.InferenceSession.create(
          await loadAutomaticSelectionGraph(request.modelDirectory, selection),
          objectSelectionSessionOptions(),
        ),
      }
    const rgba = await readFile(source.path)
    const mask = new Float32Array(guideEdge * guideEdge)
    let selected = 0
    // The same sky model sees color and luminance, so strong sunset casts do not
    // hide disconnected sky. Views run sequentially within the same reservation.
    for (const monochrome of selection === 'sky' ? [false, true] : [false]) {
      gpu = await createObjectSelectionGpu(edge, true, monochrome)
      input = new ort.Tensor('float32', await gpu.preprocess(rgba, source.width, source.height), [
        1,
        3,
        edge,
        edge,
      ])
      gpu.close()
      gpu = undefined
      outputs = await automaticSession.session.run({
        [selection === 'sky' ? 'pixel_values' : 'input_image']: input,
      })
      const tensor = outputs[selection === 'sky' ? 'semantic' : 'output_image']
      const expected = selection === 'sky' ? '1,150,128,128' : '1,1,1024,1024'
      if (tensor?.type !== 'float32' || tensor.dims.join(',') !== expected)
        throw new Error('Automatic selection returned an unsupported model grid.')
      const values = tensor.data as Float32Array
      if (!values.every(Number.isFinite))
        throw new Error('Automatic selection returned non-finite model output. Retry GPU.')
      if (selection === 'sky') {
        for (let pixel = 0; pixel < mask.length; pixel++) {
          const sky = values[2 * mask.length + pixel]
          let isSky = true
          for (let label = 0; label < 150; label++) {
            if (
              label !== 2 &&
              (values[label * mask.length + pixel] > sky ||
                (label < 2 && values[label * mask.length + pixel] === sky))
            ) {
              isSky = false
              break
            }
          }
          if (isSky && !mask[pixel]) {
            mask[pixel] = 1
            selected++
          }
        }
      } else {
        for (let pixel = 0; pixel < mask.length; pixel++) {
          mask[pixel] = 1 / (1 + Math.exp(values[pixel]))
          if (values[pixel] > 0) selected++
        }
        if (!selected || selected === mask.length)
          throw new Error(
            'A foreground subject and background could not be separated. Existing masks are unchanged. Use Select object or Paint/Erase.',
          )
      }
      input.dispose()
      input = undefined
      Object.values(outputs).forEach((value) => value.dispose())
      outputs = undefined
    }
    if (selection === 'sky' && !selected)
      throw new Error(
        'No sky was found. Existing masks are unchanged. Use Paint/Erase or indicate an object instead.',
      )
    gpu = await createObjectSelectionGpu(guideEdge)
    const guide = await gpu.preprocess(rgba, source.width, source.height)
    const coverage = await refineAutomaticSelection(
      gpu.device,
      rgba,
      guide,
      mask,
      source.width,
      source.height,
      guideEdge,
    )
    if (gpu.failure) throw new Error(gpu.failure)
    await sharp(coverage, { raw: { width: source.width, height: source.height, channels: 1 } })
      .toColourspace('b-w')
      .png()
      .toFile(temporary)
    const encoded = await readFile(temporary)
    if (encoded.byteLength > maskCapabilities.maxBaseEncodedBytes)
      throw new Error(
        'Automatic mask exceeds the 16 MiB encoded limit. Existing masks are unchanged.',
      )
    await rename(temporary, request.outputPath)
    return {
      key: source.key,
      width: source.width,
      height: source.height,
      modelIdentity: `${AUTOMATIC_SELECTION_ID}:${selection}`,
      path: request.outputPath,
      sha256: sha256(encoded),
      encodedBytes: encoded.byteLength,
      selectedCandidate: 0,
      predictedIou: 0,
    }
  } finally {
    input?.dispose()
    Object.values(outputs ?? {}).forEach((value) => value.dispose())
    gpu?.close()
    gpu = undefined
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function prepare(source: ObjectSelectionSource) {
  validateObjectSelectionSize(source.width, source.height)
  if (
    source.format !== 'rgba8' ||
    typeof source.key !== 'string' ||
    !source.key ||
    source.key.length > 1024
  )
    throw new Error(
      'Object selection requires a canonical neutral RGBA source and frozen identity.',
    )
  if (prepared?.key === source.key) {
    if (source.width !== prepared.width || source.height !== prepared.height)
      throw new Error('The frozen object selection source dimensions changed.')
    return prepared
  }
  const bytes = source.width * source.height * 4
  if ((await stat(source.path)).size !== bytes)
    throw new Error('The object selection source byte count changed.')
  for (const tensor of Object.values(retained ?? {})) tensor.dispose()
  retained = undefined
  prepared = undefined
  const input = new ort.Tensor(
    'float32',
    await gpu!.preprocess(await readFile(source.path), source.width, source.height),
    [1, 3, 1024, 1024],
  )
  try {
    retained = await encoder!.run({ image: input })
    for (const [name, shape] of [
      ['feature0', '1,32,256,256'],
      ['feature1', '1,64,128,128'],
      ['image_embeddings', '1,256,64,64'],
    ] as const)
      if (retained[name]?.type !== 'float32' || retained[name].dims.join(',') !== shape)
        throw new Error('Object selection encoder returned unsupported features.')
    prepared = {
      key: source.key,
      width: source.width,
      height: source.height,
      modelIdentity: OBJECT_SELECTION_MODEL_ID,
    }
    return prepared
  } finally {
    input.dispose()
  }
}

async function refine(request: Extract<ObjectSelectionWorkerRequest, { operation: 'refine' }>) {
  if (!prepared || !retained || prepared.key !== request.prompts.key)
    throw new Error('The object selection source changed. Select the object again.')
  const packed = packObjectSelectionPrompts(request.prompts)
  const tensors = {
    coordinates: new ort.Tensor('float32', packed.coordinates, [1, 6, 2]),
    labels: new ort.Tensor('float32', packed.labels, [1, 6]),
    mask_input: new ort.Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256]),
    has_mask: new ort.Tensor('float32', new Float32Array(1), [1]),
  }
  let outputs: ort.InferenceSession.ReturnType | undefined
  const temporary = `${request.outputPath}.tmp`
  try {
    outputs = await decoder!.run({ ...retained, ...tensors })
    const logits = outputs.mask_logits
    const scores = outputs.iou_scores
    if (
      logits?.type !== 'float32' ||
      logits.dims.join(',') !== '1,3,256,256' ||
      scores?.type !== 'float32' ||
      scores.dims.join(',') !== '1,3'
    )
      throw new Error('Object selection decoder returned unsupported output.')
    const ranking = scores.data as Float32Array
    if (!Array.from(ranking).every(Number.isFinite))
      throw new Error('Object selection scores are not finite.')
    let selectedCandidate = 0
    for (let index = 1; index < 3; index++)
      if (ranking[index] > ranking[selectedCandidate]) selectedCandidate = index
    const selected = (logits.data as Float32Array).subarray(
      selectedCandidate * 65536,
      (selectedCandidate + 1) * 65536,
    )
    if (!selected.every(Number.isFinite))
      throw new Error('Object selection logits are not finite. Retry GPU to start a new worker.')
    const coverage = await gpu!.reconstruct(selected, prepared.width, prepared.height)
    await sharp(coverage, { raw: { width: prepared.width, height: prepared.height, channels: 1 } })
      .toColourspace('b-w')
      .png()
      .toFile(temporary)
    const encoded = await readFile(temporary)
    await rename(temporary, request.outputPath)
    return {
      ...prepared,
      path: request.outputPath,
      sha256: sha256(encoded),
      encodedBytes: encoded.byteLength,
      selectedCandidate,
      predictedIou: ranking[selectedCandidate],
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
    Object.values(tensors).forEach((tensor) => tensor.dispose())
    Object.values(outputs ?? {}).forEach((tensor) => tensor.dispose())
  }
}

process.on('message', (request: ObjectSelectionWorkerRequest) => {
  void (async () => {
    if (busy) throw new Error('The object selection worker is busy.')
    busy = true
    try {
      let result
      if (request.operation === 'automatic') result = await automatic(request)
      else {
        await initialize(request.modelDirectory)
        result =
          request.operation === 'prepare' ? await prepare(request.source) : await refine(request)
      }
      process.send?.({ id: request.id, result } satisfies ObjectSelectionWorkerReply)
    } finally {
      busy = false
    }
  })().catch(async (error: unknown) => {
    process.send?.({
      id: request.id,
      error: error instanceof Error ? error.message : String(error),
    } satisfies ObjectSelectionWorkerReply)
    await close().catch(() => undefined)
    process.exit(1)
  })
})
process.on('disconnect', () => {
  void close().finally(() => process.exit(0))
})
