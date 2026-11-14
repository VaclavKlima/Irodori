import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import protocol from '../assets/tests/references/refine-edge/metadata-followup.json' with { type: 'json' }

const { auditMetadataGraph, validatePhotographicPrerequisite } = (await import(
  pathToFileURL(resolve('scripts/research/refine-edge/metadata-audit.mjs')).href
)) as {
  auditMetadataGraph: (value: unknown) => {
    status: string
    errors: string[]
    cpuMetadataNodes: unknown[]
    gpuNodes: number
  }
  validatePhotographicPrerequisite: (
    receipt: unknown,
    component: { component: string; sha256: string },
  ) => void
}
const GPU = 'WebGpuExecutionProvider',
  CPU = 'CPUExecutionProvider'
const fixture = () => ({
  version: 1,
  complete: true,
  nodeCount: 4,
  nodeIndices: [1, 4, 7, 12],
  graphInputs: ['image'],
  graphOutputs: ['result'],
  tensors: {
    image: { dtype: 'float32', shape: [1, 3, 8, 9] },
    features: { dtype: 'float32', shape: [1, 3, 8, 9] },
    shape: { dtype: 'int64', shape: [4] },
    indices: { dtype: 'int64', shape: [4], data: ['0', '1', '2', '3'], initializer: true },
    sizes: { dtype: 'int64', shape: [4] },
    result: { dtype: 'float32', shape: [1, 3, 8, 9] },
  } as Record<
    string,
    { dtype: string; shape: (number | null)[]; data?: (number | string)[]; initializer?: boolean }
  >,
  nodes: [
    {
      index: 1,
      name: 'feature',
      operator: 'Relu',
      provider: GPU,
      inputs: ['image'],
      outputs: ['features'],
    },
    {
      index: 4,
      name: 'dimensions',
      operator: 'Shape',
      provider: GPU,
      inputs: ['features'],
      outputs: ['shape'],
    },
    {
      index: 7,
      name: 'metadata',
      operator: 'Gather',
      provider: CPU,
      inputs: ['shape', 'indices'],
      outputs: ['sizes'],
    },
    {
      index: 12,
      name: 'resize',
      operator: 'Resize',
      provider: GPU,
      inputs: ['features', '', '', 'sizes'],
      outputs: ['result'],
    },
  ],
})

test('new contract preserves prior refusal and admits CPU EP honestly only for bounded metadata', async () => {
  const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
  expect(hash(await readFile('assets/tests/references/refine-edge/metadata-followup.json'))).toBe(
    '3524c3530833b9e23b5bd9b400bf81a57d1f4ebc10fc11b5418728d76748a076',
  )
  expect(hash(await readFile(protocol.preserved.poolingProtocol))).toBe(
    protocol.preserved.poolingProtocolSha256,
  )
  expect(protocol.providerPolicy.cpuEpEnabledForAuditedMetadata).toBe(true)
  expect(protocol.providerPolicy.globalCpuFallbackDisabledClaimAllowed).toBe(false)
  expect(protocol.preInferenceProof.bindToSameLiveSession).toBe(true)
  expect(protocol.preInferenceProof.reloadSnapshotAsProof).toBe(false)
  expect(protocol.numerical).toMatchObject({
    absoluteTolerance: 0.001,
    relativeTolerance: 0.001,
    maximumR8Difference: 1,
  })
})

test('complete noncontiguous final map permits dimension gathering before GPU resize', () => {
  expect(auditMetadataGraph(fixture())).toMatchObject({ status: 'passed', gpuNodes: 3 })
  const value = fixture()
  value.nodes[1].provider = CPU
  expect(auditMetadataGraph(value).status).toBe('passed')
})

test('same CPU operator names cannot gather or slice feature data, even when small', () => {
  for (const operator of ['Gather', 'Slice']) {
    const value = fixture()
    value.nodes[2].operator = operator
    value.nodes[2].inputs[0] = 'features'
    expect(auditMetadataGraph(value).status).toBe('rejected')
    value.tensors.features = { dtype: 'int64', shape: [4] }
    value.nodes[2].inputs[0] = 'image'
    value.tensors.image = { dtype: 'int64', shape: [4] }
    expect(auditMetadataGraph(value).status).toBe('rejected')
  }
})

test('CPU feature operators, unknown providers and omitted final nodes fail closed', () => {
  const cpu = fixture()
  cpu.nodes[0].provider = CPU
  expect(auditMetadataGraph(cpu).status).toBe('rejected')
  const unknown = fixture()
  unknown.nodes[0].provider = 'OtherProvider'
  expect(auditMetadataGraph(unknown).status).toBe('rejected')
  const omitted = fixture()
  omitted.nodes.splice(2, 1)
  expect(auditMetadataGraph(omitted).status).toBe('rejected')
  const duplicated = fixture()
  duplicated.nodes[2].index = 4
  expect(auditMetadataGraph(duplicated).status).toBe('rejected')
  expect(auditMetadataGraph({ ...fixture(), complete: false }).status).toBe('rejected')
})

test('overridable graph inputs cannot masquerade as immutable dimension constants', () => {
  const value = fixture()
  value.graphInputs.push('indices')
  expect(auditMetadataGraph(value).status).toBe('rejected')
})

test('metadata may not escape into feature operands, model outputs or unbounded tensors', () => {
  const feature = fixture()
  feature.nodes[3].operator = 'Add'
  feature.nodes[3].inputs = ['features', 'sizes']
  expect(auditMetadataGraph(feature).status).toBe('rejected')
  const exposed = fixture()
  exposed.graphOutputs.push('sizes')
  expect(auditMetadataGraph(exposed).status).toBe('rejected')
  for (const shape of [[null], [17], [1, 1, 1]]) {
    const value = fixture()
    value.tensors.sizes.shape = shape
    expect(auditMetadataGraph(value).status).toBe('rejected')
  }
  const floating = fixture()
  floating.tensors.sizes.dtype = 'float32'
  expect(auditMetadataGraph(floating).status).toBe('rejected')
})

test('exact int64 metadata constants survive without unsafe number conversion', () => {
  const value = fixture()
  value.nodes[2].operator = 'Slice'
  value.nodes[2].inputs = ['shape', 'start', 'end', 'axes']
  for (const [name, data] of [
    ['start', '0'],
    ['end', '9223372036854775807'],
    ['axes', '0'],
  ])
    value.tensors[name] = { dtype: 'int64', shape: [1], data: [data], initializer: true }
  expect(auditMetadataGraph(value).status).toBe('passed')
  value.tensors.end.data = [Number('9223372036854775807')]
  expect(auditMetadataGraph(value).status).toBe('rejected')
})

test('photographic calls require same-graph completed synthetic checks and cannot promote a photo receipt', () => {
  const component = { component: 'global', sha256: 'a'.repeat(64) }
  const complete = () => ({
    status: 'passed',
    modelInferenceInvocations: 1,
    cpuImageComputationForbidden: true,
    cpuRetryOnGpuError: false,
    components: [
      {
        component: 'global',
        stage: 'passed',
        metadataAudit: {
          status: 'passed',
          sourceGraphSha256: component.sha256,
          originatingSessionStillAlive: true,
        },
        outputs: Array.from({ length: 3 }, () => ({
          samples: 4,
          outOfTolerance: 0,
          maxR8Difference: 1,
          maxAbsoluteError: 0.000001,
        })),
      },
    ],
  })
  expect(() => validatePhotographicPrerequisite(complete(), component)).not.toThrow()
  const wrongGraph = complete()
  wrongGraph.components[0].metadataAudit.sourceGraphSha256 = 'b'.repeat(64)
  expect(() => validatePhotographicPrerequisite(wrongGraph, component)).toThrow('same-graph')
  for (const count of [undefined, NaN, '1', 0, -1, 0.5, Infinity]) {
    const invalidCount = { ...complete(), modelInferenceInvocations: count }
    expect(() => validatePhotographicPrerequisite(invalidCount, component)).toThrow()
  }
  const failedNumerics = complete()
  failedNumerics.components[0].outputs[0].outOfTolerance = 1
  expect(() => validatePhotographicPrerequisite(failedNumerics, component)).toThrow()
  const missingR8 = complete()
  delete (missingR8.components[0].outputs[0] as { maxR8Difference?: number }).maxR8Difference
  expect(() => validatePhotographicPrerequisite(missingR8, component)).toThrow()
  const photo = complete()
  photo.components[0].outputs = []
  expect(() => validatePhotographicPrerequisite(photo, component)).toThrow()
})
