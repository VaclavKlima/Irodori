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

async function close() {
  for (const tensor of Object.values(retained ?? {})) tensor.dispose()
  retained = undefined
  prepared = undefined
  await Promise.allSettled([encoder?.release(), decoder?.release()])
  encoder = decoder = undefined
  gpu?.close()
  gpu = undefined
}

async function initialize(directory: string) {
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
      await initialize(request.modelDirectory)
      const result =
        request.operation === 'prepare' ? await prepare(request.source) : await refine(request)
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
