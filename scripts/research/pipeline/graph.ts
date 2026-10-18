import {
  canonical,
  digest,
  sameRegion,
  tiles,
  validateRegion,
  whole,
  type Assets,
  type Evaluation,
  type Frame,
  type Operation,
  type Recipe,
  type RecipeNode,
  type Region,
} from './contract.ts'

interface Entry {
  frame: Frame
  pins: number
}
interface Lease {
  frame: Frame
  key: string
  release(): void
}
export interface GraphStats {
  hits: number
  misses: number
  peakBytes: number
  allocatedBytes: number
  pooledBytes: number
  reusedBuffers: number
  sourceTiles: number
  fusedOperations: number
  reductions: number
}

/** CPU reference executor. No production imports, workers, rendering, or catalog writes. */
export class GraphExecutor {
  private operations = new Map<string, Operation>()
  private cache = new Map<string, Entry>()
  private pool: Float32Array[] = []
  private liveBytes = 0
  readonly stats: GraphStats = {
    hits: 0,
    misses: 0,
    peakBytes: 0,
    allocatedBytes: 0,
    pooledBytes: 0,
    reusedBuffers: 0,
    sourceTiles: 0,
    fusedOperations: 0,
    reductions: 0,
  }
  constructor(
    operations: Operation[],
    private assets: Assets,
    readonly budgetBytes = 32 * 1024 ** 2,
    readonly tileEdge = 64,
    readonly fusion = true,
  ) {
    if (
      !Number.isSafeInteger(budgetBytes) ||
      budgetBytes < 1024 ||
      !Number.isSafeInteger(tileEdge) ||
      tileEdge < 1
    )
      throw new Error('Invalid research allocation policy.')
    for (const op of operations) {
      const key = `${op.name}@${op.version}`
      if (this.operations.has(key)) throw new Error(`Duplicate operation: ${key}`)
      this.operations.set(key, op)
    }
  }
  private allocate(length: number) {
    const bytes = length * 4
    const index = this.pool.findIndex((buffer) => buffer.length === length)
    if (index >= 0) {
      const buffer = this.pool.splice(index, 1)[0]
      this.stats.pooledBytes -= buffer.byteLength
      this.liveBytes += bytes
      this.stats.reusedBuffers++
      return buffer.fill(0)
    }
    while (this.liveBytes + this.stats.pooledBytes + bytes > this.budgetBytes) {
      const pooled = this.pool.pop()
      if (pooled) {
        this.stats.pooledBytes -= pooled.byteLength
        continue
      }
      const victim = [...this.cache].find(([, entry]) => entry.pins === 0)
      if (!victim) throw new Error('Research graph memory budget exceeded by live dependencies.')
      this.cache.delete(victim[0])
      if (victim[1].frame.data.length === length) {
        this.stats.reusedBuffers++
        return victim[1].frame.data.fill(0)
      }
      this.liveBytes -= victim[1].frame.data.byteLength
    }
    this.liveBytes += bytes
    this.stats.allocatedBytes += bytes
    this.stats.peakBytes = Math.max(this.stats.peakBytes, this.liveBytes + this.stats.pooledBytes)
    return new Float32Array(length)
  }
  private recycle(buffer: Float32Array) {
    this.liveBytes -= buffer.byteLength
    this.pool.push(buffer)
    this.stats.pooledBytes += buffer.byteLength
  }
  clear() {
    if ([...this.cache.values()].some((entry) => entry.pins))
      throw new Error('Cannot clear leased tiles.')
    this.cache.clear()
    this.pool = []
    this.liveBytes = 0
    this.stats.pooledBytes = 0
  }
  private operation(node: RecipeNode) {
    const op = this.operations.get(`${node.operation}@${node.version}`)
    if (!op) throw new Error(`Unknown operation/version: ${node.operation}@${node.version}`)
    return op
  }
  validate(recipe: Recipe) {
    if (recipe.version !== 1 || !/^[a-f0-9]{64}$/.test(recipe.sourceHash))
      throw new Error('Invalid recipe version/source.')
    canonical(recipe)
    const nodes = new Map(recipe.nodes.map((n) => [n.id, n]))
    if (nodes.size !== recipe.nodes.length || !nodes.has(recipe.output))
      throw new Error('Invalid graph identities/output.')
    const visiting = new Set<string>(),
      visited = new Set<string>()
    const visit = (id: string) => {
      if (visiting.has(id)) throw new Error('Cyclic processing graph.')
      if (visited.has(id)) return
      const node = nodes.get(id)
      if (!node) throw new Error(`Missing graph input: ${id}`)
      visiting.add(id)
      Object.values(node.inputs).forEach(visit)
      const spec = node.output
      validateRegion(whole(spec), spec)
      if (
        !['reusable', 'transient'].includes(node.cache) ||
        ![1, 4].includes(spec.channels) ||
        spec.precision !== 'float32' ||
        !spec.coordinates
      )
        throw new Error('Invalid image contract.')
      const op = this.operation(node)
      if (op.assetReferences?.(node).some((hash) => !recipe.assets.includes(hash)))
        throw new Error('Recipe omits a durable history asset.')
      if (spec.domain !== op.requirements.domain || spec.alpha !== op.requirements.alpha)
        throw new Error('Operation output contract mismatch.')
      op.validate(
        node,
        Object.fromEntries(
          Object.entries(node.inputs).map(([name, input]) => [name, nodes.get(input)!.output]),
        ),
        this.assets,
      )
      visiting.delete(id)
      visited.add(id)
    }
    recipe.nodes.forEach((n) => visit(n.id))
    return nodes
  }
  render(recipe: Recipe, request: Evaluation): Frame & { revision: number; identity: string } {
    if (request.scale !== 1 || request.approximation !== 'exact')
      throw new Error('Reference graph requires native scale and exact policy.')
    if (!Number.isSafeInteger(request.revision) || request.revision < 0)
      throw new Error('Invalid revision.')
    request.signal?.throwIfAborted()
    const nodes = this.validate(recipe),
      target = nodes.get(recipe.output)!
    validateRegion(request.region, target.output)
    const consumers = new Map<string, number>()
    for (const n of recipe.nodes)
      for (const input of Object.values(n.inputs))
        consumers.set(input, (consumers.get(input) ?? 0) + 1)
    const policy = { scale: request.scale, approximation: request.approximation }
    const signature = (n: RecipeNode, r: Region) => ({
      op: [n.operation, n.version],
      output: n.output,
      region: r,
      policy,
      parameters: this.operation(n).fingerprint?.(n, r, this.assets) ?? n.parameters,
    })
    const descriptions = new Map<string, string>()
    const describe = (id: string, region: Region): string => {
      const memo = `${id}:${canonical(region)}`
      const found = descriptions.get(memo)
      if (found) return found
      const n = nodes.get(id)!,
        operation = this.operation(n)
      const specs = Object.fromEntries(
        Object.entries(n.inputs).map(([name, input]) => [name, nodes.get(input)!.output]),
      )
      const regions = operation.inputRegions(n, region, specs)
      const key = digest({
        signature: signature(n, region),
        inputs: Object.fromEntries(
          Object.entries(n.inputs).map(([name, input]) => [name, describe(input, regions[name])]),
        ),
      })
      descriptions.set(memo, key)
      return key
    }
    const get = (id: string, region: Region): Lease => {
      request.signal?.throwIfAborted()
      const node = nodes.get(id)!,
        op = this.operation(node)
      validateRegion(region, node.output)
      const chain = [node]
      let base = node
      if (this.fusion && op.point)
        while (Object.keys(base.inputs).length === 1 && base.inputs.image) {
          const previous = nodes.get(base.inputs.image)!
          if (
            !this.operation(previous).point ||
            previous.cache !== 'transient' ||
            consumers.get(previous.id) !== 1 ||
            canonical(previous.output) !== canonical(node.output)
          )
            break
          chain.unshift(previous)
          base = previous
        }
      const baseOp = this.operation(base)
      const inputSpecs = Object.fromEntries(
        Object.entries(base.inputs).map(([name, input]) => [name, nodes.get(input)!.output]),
      )
      const regions = baseOp.inputRegions(base, region, inputSpecs)
      if (canonical(Object.keys(regions).sort()) !== canonical(Object.keys(base.inputs).sort()))
        throw new Error('Incomplete operation dependencies.')
      const leases: Record<string, Lease> = {}
      let buffer: Float32Array | undefined
      try {
        if (op.reduction) {
          if (Object.keys(regions).length !== 1 || !sameRegion(region, whole(node.output)))
            throw new Error('Analysis requires its complete bounded result.')
          const key = describe(id, region)
          const hit = this.hit(key)
          if (hit) return hit
          const state = op.reduction.create()
          for (const part of tiles(regions.image, this.tileEdge)) {
            const input = get(base.inputs.image, part)
            try {
              op.reduction.add(state, input.frame)
            } finally {
              input.release()
            }
          }
          this.stats.misses++
          this.stats.reductions++
          buffer = this.allocate(region.width * region.height * node.output.channels)
          op.reduction.finish(state, buffer)
          return this.keep(key, { spec: node.output, region, data: buffer })
        }
        for (const [name, input] of Object.entries(base.inputs))
          leases[name] = get(input, regions[name])
        const key = digest({
          chain: chain.map((n) => signature(n, region)),
          inputs: Object.fromEntries(Object.entries(leases).map(([name, l]) => [name, l.key])),
        })
        const hit = this.hit(key)
        if (hit) return hit
        this.stats.misses++
        buffer = this.allocate(region.width * region.height * node.output.channels)
        if (chain.length > 1) {
          const input = leases.image.frame,
            pixel = new Array<number>(node.output.channels)
          for (let i = 0; i < buffer.length; i += pixel.length) {
            for (let c = 0; c < pixel.length; c++) pixel[c] = input.data[i + c]
            for (const step of chain) {
              this.operation(step).point!(pixel, step)
              for (let c = 0; c < pixel.length; c++) pixel[c] = Math.fround(pixel[c])
            }
            buffer.set(pixel, i)
          }
          this.stats.fusedOperations += chain.length
        } else
          op.cpu({
            node,
            region,
            output: buffer,
            assets: this.assets,
            signal: request.signal,
            inputs: Object.fromEntries(Object.entries(leases).map(([name, l]) => [name, l.frame])),
          })
        if (op.name === 'source') this.stats.sourceTiles++
        request.signal?.throwIfAborted()
        return this.keep(key, { spec: node.output, region, data: buffer })
      } catch (error) {
        if (buffer) this.recycle(buffer)
        throw error
      } finally {
        Object.values(leases).forEach((l) => l.release())
      }
    }
    const output = this.allocate(
      request.region.width * request.region.height * target.output.channels,
    )
    try {
      const identity: string[] = []
      const parts = this.operation(target).reduction
        ? [request.region]
        : tiles(request.region, this.tileEdge)
      for (const part of parts) {
        const lease = get(target.id, part)
        try {
          identity.push(lease.key)
          for (let row = 0; row < part.height; row++) {
            const start = row * part.width * target.output.channels
            const offset =
              ((part.y - request.region.y + row) * request.region.width +
                part.x -
                request.region.x) *
              target.output.channels
            output.set(
              lease.frame.data.subarray(start, start + part.width * target.output.channels),
              offset,
            )
          }
        } finally {
          lease.release()
        }
      }
      // Ownership transfers to the caller. It is never an evictable cached buffer.
      this.liveBytes -= output.byteLength
      return {
        spec: target.output,
        region: request.region,
        data: output,
        revision: request.revision,
        identity: digest(identity),
      }
    } catch (error) {
      this.recycle(output)
      throw error
    }
  }
  private hit(key: string): Lease | undefined {
    const entry = this.cache.get(key)
    if (!entry) return
    this.stats.hits++
    this.cache.delete(key)
    this.cache.set(key, entry)
    return this.lease(key, entry)
  }
  private keep(key: string, frame: Frame) {
    const entry = { frame, pins: 0 }
    this.cache.set(key, entry)
    return this.lease(key, entry)
  }
  private lease(key: string, entry: Entry): Lease {
    entry.pins++
    let released = false
    return {
      frame: entry.frame,
      key,
      release() {
        if (!released) {
          released = true
          entry.pins--
        }
      },
    }
  }
}
