// Research pre-inference guard. The caller must bind this complete map to its SAME live session.
const CPU = 'CPUExecutionProvider'
const GPU = 'WebGpuExecutionProvider'
const helpers = new Set([
  'Identity',
  'Gather',
  'Slice',
  'Add',
  'Sub',
  'Mul',
  'Div',
  'Cast',
  'Unsqueeze',
  'Squeeze',
  'Concat',
])
const transfers = new Set(['MemcpyFromHost', 'MemcpyToHost'])
const controlPorts = {
  Resize: [2, 3],
  Reshape: [1],
  Expand: [1],
  Tile: [1],
  ConstantOfShape: [0],
  Slice: [1, 2, 3, 4],
  Gather: [1],
  Pad: [1, 3],
  Unsqueeze: [1],
  Squeeze: [1],
}
const size = (value) =>
  Array.isArray(value?.shape) &&
  value.shape.length <= 2 &&
  value.shape.every((x) => Number.isSafeInteger(x) && x > 0)
    ? value.shape.reduce((a, b) => a * b, 1)
    : Infinity
const bounded = (value) => size(value) <= 16
const integer = (value) => ['int32', 'int64'].includes(value?.dtype)

export function validatePhotographicPrerequisite(receipt, component) {
  const measured = receipt?.components?.find((entry) => entry.component === component.component)
  if (
    receipt?.status !== 'passed' ||
    !Number.isSafeInteger(receipt.modelInferenceInvocations) ||
    receipt.modelInferenceInvocations < 1 ||
    receipt.cpuImageComputationForbidden !== true ||
    receipt.cpuRetryOnGpuError !== false ||
    measured?.stage !== 'passed' ||
    measured.metadataAudit?.status !== 'passed' ||
    measured.metadataAudit?.sourceGraphSha256 !== component.sha256 ||
    measured.metadataAudit?.originatingSessionStillAlive !== true ||
    measured.outputs?.length !== 3 ||
    measured.outputs.some(
      (entry) =>
        entry.outOfTolerance !== 0 ||
        !Number.isSafeInteger(entry.samples) ||
        entry.samples < 1 ||
        !Number.isSafeInteger(entry.maxR8Difference) ||
        entry.maxR8Difference < 0 ||
        entry.maxR8Difference > 1 ||
        !Number.isFinite(entry.maxAbsoluteError),
    )
  )
    throw new Error(
      'Photographic proposal requires a passed same-graph audited synthetic numerical receipt.',
    )
}

function constant(value, allowFloat = false) {
  if (!bounded(value) || !Array.isArray(value.data) || value.data.length !== size(value))
    return false
  if (allowFloat && value.dtype === 'float32')
    return value.data.every((x) => typeof x === 'number' && Number.isFinite(x))
  if (!integer(value)) return false
  const bits = value.dtype === 'int64' ? 64n : 32n
  return value.data.every((x) => {
    if (typeof x === 'number' && !Number.isSafeInteger(x)) return false
    if (typeof x !== 'number' && (typeof x !== 'string' || !/^-?(0|[1-9]\d*)$/.test(x)))
      return false
    const n = BigInt(x)
    return n >= -(1n << (bits - 1n)) && n < 1n << (bits - 1n)
  })
}

export function auditMetadataGraph(graph) {
  const errors = []
  const reject = (message) => errors.push(message)
  if (
    !graph ||
    graph.complete !== true ||
    graph.version !== 1 ||
    !Array.isArray(graph.nodes) ||
    !Array.isArray(graph.nodeIndices) ||
    graph.nodeCount !== graph.nodes.length ||
    graph.nodeIndices.length !== graph.nodeCount ||
    graph.nodeCount < 1 ||
    graph.nodeCount > 12000
  )
    return {
      status: 'rejected',
      errors: ['Incomplete finalized provider map.'],
      cpuMetadataNodes: [],
      gpuNodes: 0,
    }
  const ids = graph.nodes.map((node) => node.index)
  if (
    ids.some((x) => !Number.isSafeInteger(x) || x < 0) ||
    new Set(ids).size !== ids.length ||
    new Set(graph.nodeIndices).size !== ids.length ||
    graph.nodeIndices.some((x) => !ids.includes(x))
  )
    reject('Final node indices are incomplete or duplicated.')
  const tensors = graph.tensors ?? {},
    producers = new Map(),
    consumers = new Map()
  const inputs = new Set(graph.graphInputs ?? []),
    outputs = new Set(graph.graphOutputs ?? [])
  for (const node of graph.nodes) {
    if (![CPU, GPU].includes(node.provider)) reject(`Unknown provider: ${node.name}`)
    if (!Array.isArray(node.inputs) || !Array.isArray(node.outputs) || !node.outputs.length) {
      reject(`Missing graph edges: ${node.name}`)
      continue
    }
    for (const name of node.outputs) {
      if (!name || producers.has(name) || !tensors[name])
        reject(`Duplicate or undescribed tensor: ${name}`)
      producers.set(name, node)
    }
    node.inputs.forEach((name, port) => {
      if (name) consumers.set(name, [...(consumers.get(name) ?? []), { node, port }])
    })
  }
  for (const node of graph.nodes)
    for (const name of node.inputs ?? [])
      if (
        name &&
        (!tensors[name] ||
          (!producers.has(name) &&
            !inputs.has(name) &&
            !tensors[name]?.initializer &&
            !Array.isArray(tensors[name]?.data)))
      )
        reject(`Unaccounted input tensor: ${name}`)
  const roles = new Map()
  for (const [name, value] of Object.entries(tensors))
    if (
      value.initializer === true &&
      !inputs.has(name) &&
      !producers.has(name) &&
      constant(value, true)
    )
      roles.set(name, 'constant')
  for (let iteration = 0; iteration <= graph.nodeCount; iteration++) {
    let changed = false
    for (const node of graph.nodes) {
      const names = (node.inputs ?? []).filter(Boolean)
      let valid = false
      if (node.operator === 'Shape') {
        const source = tensors[names[0]]
        valid = names.length === 1 && Array.isArray(source?.shape) && source.shape.length <= 16
      } else if (
        helpers.has(node.operator) ||
        (node.provider === GPU && transfers.has(node.operator))
      ) {
        valid = names.length > 0 && names.every((name) => roles.has(name))
      } else if (node.operator === 'Constant') {
        valid = node.outputs.every((name) => constant(tensors[name], node.provider === GPU))
      }
      if (
        valid &&
        node.outputs.every(
          (name) =>
            bounded(tensors[name]) &&
            (integer(tensors[name]) ||
              (node.provider === GPU && tensors[name]?.dtype === 'float32')),
        )
      ) {
        const role =
          node.operator === 'Shape' || names.some((name) => roles.get(name) === 'metadata')
            ? 'metadata'
            : 'constant'
        for (const name of node.outputs)
          if (!roles.has(name)) {
            roles.set(name, role)
            changed = true
          }
      }
    }
    if (!changed) break
  }
  const cpu = graph.nodes.filter((node) => node.provider === CPU)
  const reachesControl = (name, visiting = new Set()) => {
    if (outputs.has(name) || visiting.has(name)) return false
    const uses = consumers.get(name) ?? []
    if (!uses.length) return false
    const next = new Set([...visiting, name])
    return uses.every(({ node, port }) => {
      if (node.provider === GPU && controlPorts[node.operator]?.includes(port)) return true
      if (
        node.operator === 'Shape' ||
        helpers.has(node.operator) ||
        (node.provider === GPU && transfers.has(node.operator))
      )
        return node.outputs.every((output) => roles.has(output) && reachesControl(output, next))
      return false
    })
  }
  for (const node of cpu) {
    if (
      (node.domain && node.domain !== 'ai.onnx') ||
      !['Shape', 'Constant', ...helpers].includes(node.operator)
    )
      reject(`CPU feature or unknown operator: ${node.name}/${node.operator}`)
    if (
      node.operator !== 'Shape' &&
      node.inputs.some(
        (name) => name && (!roles.has(name) || !integer(tensors[name]) || !bounded(tensors[name])),
      )
    )
      reject(`CPU input is not bounded integer metadata: ${node.name}`)
    if (
      !node.outputs.every(
        (name) =>
          roles.has(name) &&
          integer(tensors[name]) &&
          bounded(tensors[name]) &&
          reachesControl(name),
      )
    )
      reject(`CPU output escapes shape control or is unbounded: ${node.name}`)
  }
  return {
    status: errors.length ? 'rejected' : 'passed',
    errors: [...new Set(errors)],
    cpuMetadataNodes: cpu.map((node) => ({
      index: node.index,
      name: node.name,
      operator: node.operator,
    })),
    gpuNodes: graph.nodes.filter((node) => node.provider === GPU).length,
    nodeCount: graph.nodeCount,
    scope: 'Complete-map metadata audit only; SAME live session binding required before inference.',
  }
}
