import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  realpath,
  rename,
  stat,
  lstat,
  unlink,
} from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import {
  agentQualityScenarios,
  aggregateAgentQualityUsage,
  escapeEvaluationHtml,
  parseAgentQualityTranscript,
  sanitizeAgentQualityTerminal,
  agentQualityTerminalReadiness,
  assertAgentQualityPathSeparation,
  assessAgentQualityScenario,
} from './agent-quality-evaluation-model.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const allowedArtifacts = join(root, 'artifacts/agent-evaluation')
const execute = promisify(execFile)
const json = (value) => JSON.stringify(value, null, 2) + '\n'
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const present = async (path) =>
  stat(path).then(
    () => true,
    () => false,
  )
const within = (parent, child) => child.startsWith(parent + sep)
const log = (phase, data = {}) => console.log(JSON.stringify({ phase, ...data }))

async function canonicalPlannedPath(path) {
  const missing = []
  let current = resolve(path)
  while (true) {
    try {
      return join(await realpath(current), ...missing)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      missing.unshift(basename(current))
      const parent = dirname(current)
      if (parent === current) throw error
      current = parent
    }
  }
}

async function guardEvaluationPaths(output, profile, compiledRoot, baselineReference) {
  assertAgentQualityPathSeparation({
    output: await canonicalPlannedPath(output),
    ...(profile ? { profile, library: await canonicalPlannedPath(join(profile, 'library')) } : {}),
    archival: await canonicalPlannedPath(join(output, 'prior-library')),
    compiledRoot,
    baselineReference,
  })
}

async function waitFor(read, description, timeout = 300_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value
    await delay(500)
  }
  throw new Error(`Timed out waiting for ${description}. No model retry was started.`)
}

export async function planAgentQualityEvaluation() {
  const paths = [
    ...new Set(agentQualityScenarios.flatMap((scenario) => [...scenario.inputs, scenario.notice])),
  ]
  await execute('git', ['ls-files', '--error-unmatch', '--', ...paths], { cwd: root })
  const files = await Promise.all(
    paths.map(async (path) => {
      const bytes = await readFile(join(root, path))
      return { path, bytes: bytes.length, sha256: sha256(bytes) }
    }),
  )
  return {
    version: 1,
    scenarios: agentQualityScenarios,
    files,
    maxModelTurns: agentQualityScenarios.reduce(
      (sum, scenario) => sum + scenario.prompts.length,
      0,
    ),
    reviewRequired: true,
    hdrLimit:
      'HDR sources are inspected through labelled SDR images; true HDR vision and physical luminance remain unqualified.',
  }
}

async function createOutput(path) {
  const output = resolve(path)
  await mkdir(allowedArtifacts, { recursive: true, mode: 0o700 })
  const allowed = await realpath(allowedArtifacts)
  if (!within(allowed, output))
    throw new Error('Evaluation output must be below artifacts/agent-evaluation.')
  await mkdir(dirname(output), { recursive: true, mode: 0o700 })
  if (!within(allowed, await realpath(dirname(output))))
    throw new Error('Evaluation output escapes its artifact root.')
  await mkdir(output, { mode: 0o700 })
  return output
}

async function requireEvaluationProfile(path) {
  const profile = await realpath(resolve(path))
  const allowed = await realpath(allowedArtifacts)
  if (!within(allowed, profile))
    throw new Error('The evaluation profile must be below artifacts/agent-evaluation.')
  if (
    await lstat(join(profile, 'SingletonLock')).then(
      () => true,
      () => false,
    )
  )
    throw new Error(
      'Close the evaluation application before running a variant; its profile is locked.',
    )
  if (!(await present(join(profile, 'agent/codex/config.toml'))))
    throw new Error(
      'Use the dedicated evaluation profile after normal Codex sign-in and hook trust.',
    )
  return profile
}

async function transcriptPath(home, sessionId) {
  if (!/^[a-f0-9-]{36}$/.test(sessionId)) throw new Error('Invalid evaluation conversation ID.')
  const pending = [join(home, 'sessions')]
  let visited = 0
  while (pending.length) {
    const directory = pending.pop()
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (++visited > 4000)
        throw new Error('Evaluation transcript search exceeded its bounded session inventory.')
      const path = join(directory, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile() && entry.name.endsWith(`${sessionId}.jsonl`)) return path
    }
  }
  return null
}

async function readTranscript(profile) {
  const conversation = JSON.parse(await readFile(join(profile, 'agent/conversation.json'), 'utf8'))
  if (!conversation.id) return null
  const path = await transcriptPath(join(profile, 'agent/codex'), conversation.id)
  if (!path) return null
  if ((await stat(path)).size > 128 * 1024 ** 2)
    throw new Error('Evaluation transcript exceeds 128 MiB.')
  const text = await readFile(path, 'utf8')
  return { path, text, metrics: parseAgentQualityTranscript(text) }
}

async function bridge(page, method, args = []) {
  return page.evaluate(({ method, args }) => globalThis.irodori[method](...args), { method, args })
}

async function terminalDiagnostic(page, path, phase) {
  const state = await bridge(page, 'getAgentSession')
  const terminal = sanitizeAgentQualityTerminal(
    (state.output ?? []).map((part) => part.data).join(''),
  )
  const rows = page.locator('.xterm-rows')
  const rendered = sanitizeAgentQualityTerminal(
    (await rows.count()) ? await rows.innerText({ timeout: 1000 }).catch(() => '') : '',
  )
  const snapshot = {
    phase,
    observedAt: new Date().toISOString(),
    status: state.status,
    message: sanitizeAgentQualityTerminal(state.message),
    signInAvailable: !!state.signInAvailable,
    rendered,
    terminal,
  }
  await writeFile(path, json(snapshot), { mode: 0o600 })
  return { state, snapshot, screen: rendered || terminal }
}

async function waitForTerminalReady(page, diagnosticPath) {
  const deadline = Date.now() + 30_000
  let previous = null,
    unchangedSince = 0
  while (Date.now() < deadline) {
    const value = await terminalDiagnostic(page, diagnosticPath, 'waiting-for-ready-prompt')
    if (value.state.status !== 'connected')
      throw new Error(
        `Codex startup ended with status ${value.state.status}. Review ${diagnosticPath}.`,
      )
    const readiness = agentQualityTerminalReadiness(value.screen)
    if (readiness.blocked) throw new Error(`${readiness.blocked} Review ${diagnosticPath}.`)
    if (value.screen !== previous) {
      previous = value.screen
      unchangedSince = Date.now()
    }
    if (readiness.ready && Date.now() - unchangedSince >= 750) return value.state
    await delay(250)
  }
  throw new Error(
    `Codex did not present a ready prompt within 30 seconds. Review ${diagnosticPath}.`,
  )
}

async function seedLibrary(app, page, plan) {
  const paths = [...new Set(plan.scenarios.flatMap((scenario) => scenario.inputs))]
  await app.evaluate(
    ({ dialog }, paths) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths })
    },
    paths.map((path) => join(root, path)),
  )
  const sessionId = await bridge(page, 'chooseSource', ['files', false])
  if (!sessionId) throw new Error('The isolated fixture import did not open.')
  const review = await waitFor(async () => {
    const value = await bridge(page, 'getReview', [sessionId])
    return value.phase === 'review' && value.total === paths.length ? value : null
  }, 'fixture validation')
  if (
    review.errors ||
    review.ready + review.unchecked !== paths.length ||
    review.selected !== paths.length
  )
    throw new Error('Not all tracked photographic fixtures passed import validation.')
  await bridge(page, 'importSelected', [sessionId])
  await waitFor(async () => {
    const tasks = await bridge(page, 'listTasks')
    const task = tasks.find((task) => task.id === sessionId)
    if (task?.status === 'failed' || task?.status === 'cancelled')
      throw new Error('Fixture import failed.')
    const photos = (await bridge(page, 'listPhotos')).photos
    return photos.length === paths.length && !tasks.some((task) => task.status === 'running')
      ? photos
      : null
  }, 'fixture import')
  const photos = (await bridge(page, 'listPhotos')).photos
  const scenarios = []
  for (const scenario of plan.scenarios) {
    let photo = photos.find((photo) => photo.filename === basename(scenario.inputs[0]))
    if (!photo) throw new Error(`Missing imported fixture: ${scenario.id}.`)
    if (scenario.merge) {
      const ids = scenario.inputs.map(
        (path) => photos.find((photo) => photo.filename === basename(path))?.id,
      )
      if (ids.some((id) => !id)) throw new Error('The forest bracket is incomplete.')
      const review = await bridge(page, 'createMergeReview', [ids, 'hdr'])
      await bridge(page, 'requestMergePreview', [review.id, review.revision])
      const taskId = await bridge(page, 'startMerge', [review.id, review.revision])
      const completed = await waitFor(
        async () => {
          const task = (await bridge(page, 'listTasks')).find((task) => task.id === taskId)
          if (task?.status === 'failed' || task?.status === 'cancelled')
            throw new Error(`Forest HDR merge ${task.status}.`)
          return task?.status === 'completed' ? task : null
        },
        'real v4 forest merge',
        600_000,
      )
      photo = (await bridge(page, 'listPhotos')).photos.find(
        (photo) => photo.id === completed.resultPhotoId,
      )
      if (!photo) throw new Error('The forest HDR master was not published.')
      const provenance = await bridge(page, 'getMergeProvenance', [photo.id])
      if (provenance.manifest.version !== 'sony-merge-v4')
        throw new Error('The forest master is not a v4 merge.')
    }
    if (scenario.seed) {
      const state = await bridge(page, 'getEdits', [photo.id])
      await bridge(page, 'updateEdits', [photo.id, scenario.seed, state.revision])
    }
    scenarios.push({ ...scenario, photo })
  }
  return scenarios
}

async function openExternalMcp(profile, compiledRoot) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
  const client = new Client({ name: 'irodori-private-quality-evidence', version: '1' })
  const env = { ...process.env, IRODORI_PROFILE: profile }
  delete env.IRODORI_AGENT_CONNECTION
  delete env.IRODORI_AGENT_REQUEST
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(compiledRoot, 'main/editor-mcp.js')],
    env,
    stderr: 'pipe',
  })
  await client.connect(transport)
  return {
    close: () => client.close(),
    call: async (name, args) => {
      const result = await client.callTool({ name, arguments: args })
      if (result.isError)
        throw new Error(
          (result.content ?? [])
            .filter((item) => item.type === 'text')
            .map((item) => item.text)
            .join('\n'),
        )
      return result
    },
  }
}

async function capturePhoto(mcp, page, photoId, directory, label) {
  const state = await bridge(page, 'getEdits', [photoId])
  const context = (
    await mcp.call('irodori_get_preview_context', { photoId, expectedRevision: state.revision })
  ).structuredContent
  const width = Math.min(512, context.width),
    height = Math.min(512, context.height)
  const region = {
    units: 'pixels',
    gridIdentity: context.gridIdentity,
    x: Math.floor((context.width - width) / 2),
    y: Math.floor((context.height - height) / 2),
    width,
    height,
  }
  const images = {}
  for (const [extent, inspection] of [
    ['overview', { encoding: { format: 'jpeg', quality: 90 } }],
    ['native-center', { region, resolutionPercent: 100, encoding: { format: 'png' } }],
  ]) {
    const result = await mcp.call('irodori_get_photo_preview', {
      photoId,
      expectedRevision: state.revision,
      inspection,
    })
    const image = result.content.find((item) => item.type === 'image')
    if (!image) throw new Error('Photographic evidence did not contain an image.')
    const path = `${label}-${extent}.${image.mimeType === 'image/png' ? 'png' : 'jpg'}`
    await writeFile(join(directory, path), Buffer.from(image.data, 'base64'), { mode: 0o600 })
    images[extent] = path
    await writeFile(join(directory, `${label}-${extent}.json`), json(result.structuredContent), {
      mode: 0o600,
    })
  }
  await writeFile(join(directory, `${label}-edits.json`), json(state), { mode: 0o600 })
  return {
    revision: state.revision,
    settings: state.settings,
    images,
    region,
    sourceDynamicRange: context.sourceDynamicRange,
  }
}

async function runTurn(page, profile, prompt, completedBefore, timeout, diagnosticPath) {
  const state = await waitForTerminalReady(page, diagnosticPath)
  const startedAt = Date.now()
  await bridge(page, 'writeAgentInput', [state.sessionId, prompt])
  await delay(500)
  await bridge(page, 'writeAgentInput', [state.sessionId, '\r'])
  try {
    await waitFor(
      async () => {
        if (await present(join(profile, 'agent/workspace/request.json'))) return true
        const value = await readTranscript(profile)
        return value && value.metrics.completedTurns > completedBefore
      },
      'the trusted prompt hook to start a request',
      15_000,
    )
  } catch {
    const value = await terminalDiagnostic(page, diagnosticPath, 'prompt-did-not-start')
    const readiness = agentQualityTerminalReadiness(value.screen)
    throw new Error(
      `${readiness.blocked ?? 'No trusted photo request started within 15 seconds.'} Review ${diagnosticPath}. No prompt retry was sent.`,
    )
  }
  let transcript
  try {
    transcript = await waitFor(
      async () => {
        const value = await readTranscript(profile)
        if (!value || value.metrics.completedTurns <= completedBefore) return null
        if (await present(join(profile, 'agent/workspace/request.json'))) return null
        return value
      },
      'one authenticated Codex turn',
      timeout,
    )
  } catch (error) {
    await terminalDiagnostic(page, diagnosticPath, 'turn-did-not-complete')
    throw new Error(`${error.message} Review ${diagnosticPath}.`, { cause: error })
  }
  await terminalDiagnostic(page, diagnosticPath, 'turn-complete')
  const completedAt = Date.now()
  const firstEdit = transcript.metrics.toolCalls.find(
    (call) =>
      call.startedAt >= startedAt &&
      /irodori_(update_edits|mutate_masks|accept_object_selection)$/.test(call.name),
  )
  return {
    prompt,
    startedAt,
    completedAt,
    elapsedMs: completedAt - startedAt,
    firstEditMs: firstEdit ? firstEdit.startedAt - startedAt : null,
    transcript,
  }
}

function galleryHtml(
  report,
  imagePath = (scenario, key) => `${scenario.id}/${scenario.final.images[key]}`,
) {
  const escape = escapeEvaluationHtml
  const rows = report.scenarios
    .map(
      (scenario) =>
        `<section><h2>${escape(scenario.title)}</h2><p>${escape(scenario.notice)}</p><div class="photos"><figure><img src="${escape(`${scenario.id}/${scenario.initial.images.overview}`)}"><figcaption>Initial</figcaption></figure><figure><img src="${escape(imagePath(scenario, 'overview'))}"><figcaption>${escape(report.variant)}</figcaption></figure><figure><img src="${escape(imagePath(scenario, 'native-center'))}"><figcaption>100% center crop; SDR</figcaption></figure></div><p>${escape(scenario.session.finalMessage)}</p></section>`,
    )
    .join('\n')
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Photo agent evaluation — review required</title><style>body{margin:2rem;background:#181818;color:#ddd;font:15px system-ui}section{margin:3rem 0}.photos{display:flex;gap:1rem;align-items:start}figure{margin:0;flex:1;min-width:0}img{max-width:100%;max-height:65vh;object-fit:contain}figcaption{padding:.5rem 0;color:#aaa}p{white-space:pre-wrap;overflow-wrap:anywhere}</style><h1>Photo agent evaluation: human review required</h1><p>All evidence is SDR, including HDR sources. Native crops are independently centered in each confirmed current geometry. No photographic-quality pass is inferred.</p>${rows}</html>`
}

export async function runAgentQualityEvaluation(options) {
  if (!options.allowModelCalls)
    throw new Error(
      'Live evaluation requires explicit --allow-model-calls; routine checks must use --plan.',
    )
  if (!['baseline', 'candidate'].includes(options.variant))
    throw new Error('Choose --variant baseline or candidate.')
  const plan = await planAgentQualityEvaluation()
  const profile = await requireEvaluationProfile(options.profile)
  const compiledRoot = await realpath(resolve(options.compiledRoot ?? join(root, 'out')))
  const baselineReference = options.baselineReference
    ? await realpath(resolve(options.baselineReference))
    : null
  const compiledFiles = await Promise.all(
    ['main/index.js', 'main/editor-mcp.js', 'main/agent-hook.mjs'].map(async (path) => {
      const hash = sha256(await readFile(join(compiledRoot, path)))
      const baselineSha256 = baselineReference
        ? sha256(await readFile(join(baselineReference, path)))
        : undefined
      if (baselineSha256 !== undefined && baselineSha256 !== hash)
        throw new Error(`Compiled baseline differs from its immutable reference: ${path}.`)
      return { path, sha256: hash, ...(baselineSha256 ? { baselineSha256 } : {}) }
    }),
  )
  await guardEvaluationPaths(options.output, profile, compiledRoot, baselineReference)
  const output = await createOutput(options.output)
  const lock = join(profile, '.agent-quality-evaluation.lock')
  const entrySha256 = compiledFiles.find((file) => file.path === 'main/index.js').sha256
  await writeFile(lock, json({ pid: process.pid, output }), { flag: 'wx', mode: 0o600 })
  const report = {
    version: 1,
    variant: options.variant,
    status: 'incomplete',
    startedAt: new Date().toISOString(),
    compiledRoot,
    profile,
    baselineReference,
    compiledFiles,
    entrySha256,
    plan,
    scenarios: [],
    limitations: [
      plan.hdrLimit,
      'Creative quality and photographic suitability require human review.',
    ],
  }
  let running, mcp
  try {
    if (await present(join(profile, 'library')))
      await rename(join(profile, 'library'), join(output, 'prior-library'))
    await writeFile(join(output, 'plan.json'), json(plan), { mode: 0o600 })
    const { launchTestElectron } = await import('./electron-test-launch.mjs')
    running = await launchTestElectron({
      userDataDir: profile,
      artifacts: join(output, 'launch'),
      compiledRoot,
      offline: false,
      env: {
        ...process.env,
        IRODORI_TEST_UI_MODE: options.foreground ? 'foreground' : 'background',
      },
    })
    const page = await running.app.firstWindow()
    await page.getByTestId('console-toggle').waitFor()
    if ((await page.getByTestId('console-toggle').getAttribute('aria-expanded')) !== 'true')
      await page.getByTestId('console-toggle').click()
    if (
      (await realpath(await running.app.evaluate(({ app }) => app.getPath('userData')))) !== profile
    )
      throw new Error('Evaluation profile isolation failed.')
    log('seed-library', { variant: options.variant })
    const scenarios = await seedLibrary(running.app, page, plan)
    mcp = await openExternalMcp(profile, compiledRoot)
    await page.getByRole('button', { name: 'Editor', exact: true }).click()
    for (const scenario of scenarios) {
      log('scenario-start', { id: scenario.id })
      const directory = join(output, scenario.id)
      await mkdir(directory, { mode: 0o700 })
      await page
        .getByRole('button', { name: `Select ${scenario.photo.filename}`, exact: true })
        .click()
      const initial = await capturePhoto(mcp, page, scenario.photo.id, directory, 'initial')
      const result = {
        ...scenario,
        initial,
        turns: [],
        turnStates: [],
        taskIdsBefore: (await bridge(page, 'listTasks')).map((task) => task.id),
      }
      report.scenarios.push(result)
      await bridge(page, 'connectAgent', ['new'])
      const policy = await readFile(join(profile, 'agent/codex/photo-agent.md'))
      result.policy = { sha256: sha256(policy), utf8Bytes: policy.length }
      for (const [index, prompt] of scenario.prompts.entries()) {
        if (index && scenario.resumeBeforeFollowup) await bridge(page, 'connectAgent', ['resume'])
        log('turn-start', { id: scenario.id, turn: index + 1 })
        const turn = await runTurn(
          page,
          profile,
          prompt,
          index,
          options.timeoutMs ?? 300_000,
          join(directory, `turn-${index + 1}-terminal.json`),
        )
        const { transcript, ...metrics } = turn
        await writeFile(join(directory, `turn-${index + 1}.jsonl`), transcript.text, {
          mode: 0o600,
        })
        result.turns.push({ ...metrics, finalMessage: transcript.metrics.finalMessage })
        result.session = transcript.metrics
        result.intermediateState = await bridge(page, 'getEdits', [scenario.photo.id])
        result.turnStates.push(result.intermediateState)
        await writeFile(
          join(directory, `turn-${index + 1}-edits.json`),
          json(result.intermediateState),
          { mode: 0o600 },
        )
        log('turn-complete', { id: scenario.id, turn: index + 1, elapsedMs: metrics.elapsedMs })
      }
      result.history = await bridge(page, 'getEditHistory', [scenario.photo.id])
      const final = await bridge(page, 'getEdits', [scenario.photo.id])
      if (final.canUndo && final.revision !== initial.revision) {
        const undone = await bridge(page, 'undoEdit', [scenario.photo.id, final.revision])
        const redone = await bridge(page, 'redoEdit', [scenario.photo.id, undone.revision])
        result.undoRedo = {
          undoRevision: undone.revision,
          redoRevision: redone.revision,
          restored: JSON.stringify(final.settings) === JSON.stringify(redone.settings),
        }
        if (!result.undoRedo.restored)
          throw new Error('Undo/Redo did not restore the confirmed edited photograph.')
      }
      result.final = await capturePhoto(mcp, page, scenario.photo.id, directory, 'final')
      result.exportTasksAfter = (await bridge(page, 'listTasks'))
        .filter((task) => task.kind === 'export')
        .map((task) => ({ id: task.id, status: task.status }))
      result.contracts = assessAgentQualityScenario(result)
      await writeFile(join(directory, 'result.json'), json(result), { mode: 0o600 })
      await writeFile(join(output, 'report.json'), json(report), { mode: 0o600 })
    }
    report.usage = aggregateAgentQualityUsage(report.scenarios.map((scenario) => scenario.session))
    report.status = 'review-required'
    await writeFile(join(output, 'gallery.html'), galleryHtml(report), { mode: 0o600 })
    log('review-required', { output, scenarios: report.scenarios.length, usage: report.usage })
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error)
    log('incomplete', { output, error: report.error })
  } finally {
    report.finishedAt = new Date().toISOString()
    await writeFile(join(output, 'report.json'), json(report), { mode: 0o600 })
    await writeFile(
      join(output, 'summary.md'),
      `# Photo agent evaluation: ${report.status}\n\nVariant: ${report.variant}. Scenarios completed: ${report.scenarios.filter((scenario) => scenario.final).length}/6.\n\n${report.error ?? 'Human review of gallery.html and confirmed edits is required; no creative-quality pass is claimed.'}\n\nReal usage and tool metrics: [report.json](report.json). Generated evidence and transcripts remain private artifacts.\n`,
      { mode: 0o600 },
    )
    await mcp?.close().catch(() => undefined)
    await running?.app.close().catch(() => undefined)
    await unlink(lock).catch(() => undefined)
  }
  return { output, report }
}

export async function compareAgentQualityEvaluations(baselinePath, candidatePath, outputPath) {
  const baseline = JSON.parse(await readFile(baselinePath, 'utf8'))
  const candidate = JSON.parse(await readFile(candidatePath, 'utf8'))
  if (
    baseline.variant !== 'baseline' ||
    candidate.variant !== 'candidate' ||
    baseline.status !== 'review-required' ||
    candidate.status !== 'review-required'
  )
    throw new Error(
      'Comparison needs complete baseline and candidate reports awaiting human review.',
    )
  if (JSON.stringify(baseline.plan) !== JSON.stringify(candidate.plan))
    throw new Error('Evaluation plans or fixture hashes differ.')
  for (const report of [baseline, candidate])
    await guardEvaluationPaths(
      outputPath,
      report.profile,
      report.compiledRoot,
      report.baselineReference,
    )
  const output = await createOutput(outputPath)
  const escape = escapeEvaluationHtml
  const imagePath = (reportPath, scenario, stage, extent) =>
    join(dirname(resolve(reportPath)), scenario.id, scenario[stage].images[extent])
  const imagePaths = new Set()
  for (const before of baseline.scenarios) {
    const after = candidate.scenarios.find((scenario) => scenario.id === before.id)
    if (!after) throw new Error('Candidate scenario inventory differs.')
    for (const extent of ['overview', 'native-center'])
      for (const [path, scenario, stage] of [
        [baselinePath, before, 'initial'],
        [baselinePath, before, 'final'],
        [candidatePath, after, 'final'],
      ])
        imagePaths.add(imagePath(path, scenario, stage, extent))
  }
  // HTML previews may isolate the document from sibling files. Retain exact image bytes inline.
  const embeddedImages = new Map(
    await Promise.all(
      [...imagePaths].map(async (path) => {
        const bytes = await readFile(path)
        const mime = path.endsWith('.png') ? 'image/png' : 'image/jpeg'
        return [path, `data:${mime};base64,${bytes.toString('base64')}`]
      }),
    ),
  )
  const image = (reportPath, scenario, stage, extent) =>
    embeddedImages.get(imagePath(reportPath, scenario, stage, extent))
  const sections = baseline.scenarios
    .map((before) => {
      const after = candidate.scenarios.find((scenario) => scenario.id === before.id)
      if (!after) throw new Error('Candidate scenario inventory differs.')
      return `<section><h2>${escape(before.title)}</h2><p>${escape(before.notice)}</p>${[
        'overview',
        'native-center',
      ]
        .map(
          (extent) =>
            `<div class="photos">${[
              [baselinePath, before, 'initial', 'Initial'],
              [baselinePath, before, 'final', 'Baseline'],
              [candidatePath, after, 'final', 'Candidate'],
            ]
              .map(
                ([path, scenario, stage, label]) =>
                  `<figure><img src="${image(path, scenario, stage, extent)}"><figcaption>${label}: ${extent}; SDR</figcaption></figure>`,
              )
              .join('')}</div>`,
        )
        .join(
          '',
        )}<details><summary>Actual usage and tool selection</summary><pre>${escape(json({ baseline: before.session, candidate: after.session }))}</pre></details></section>`
    })
    .join('\n')
  await writeFile(
    join(output, 'gallery.html'),
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>Initial / baseline / candidate — review required</title><style>body{margin:2rem;background:#181818;color:#ddd;font:15px system-ui}section{margin:3rem 0}.photos{display:flex;gap:1rem}figure{margin:1rem 0;flex:1;min-width:0}img{max-width:100%;max-height:65vh;object-fit:contain}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><h1>Initial / baseline / candidate: review required</h1><p>SDR evidence only. Native crops are centered in each current geometry. Review artistic suitability, constraints, preservation and visible artifacts.</p>${sections}</html>`,
    { mode: 0o600 },
  )
  await writeFile(
    join(output, 'comparison.json'),
    json({
      status: 'review-required',
      baseline: resolve(baselinePath),
      candidate: resolve(candidatePath),
      baselineUsage: baseline.usage,
      candidateUsage: candidate.usage,
    }),
    { mode: 0o600 },
  )
  return output
}

/** Assess retained transcripts and edit states in a new artifact directory without launching anything. */
export async function assessAgentQualityEvaluation(reportPath, outputPath) {
  const source = resolve(reportPath)
  const report = JSON.parse(await readFile(source, 'utf8'))
  await guardEvaluationPaths(
    outputPath,
    report.profile,
    report.compiledRoot,
    report.baselineReference,
  )
  const output = await createOutput(outputPath)
  const scenarios = []
  for (const scenario of report.scenarios) {
    const directory = join(dirname(source), scenario.id)
    const value = { ...scenario, turnStates: [] }
    for (let index = 1; index <= scenario.prompts.length; index++) {
      const state = join(directory, `turn-${index}-edits.json`)
      if (await present(state)) value.turnStates.push(JSON.parse(await readFile(state, 'utf8')))
      const transcript = join(directory, `turn-${index}.jsonl`)
      if (await present(transcript))
        value.session = parseAgentQualityTranscript(await readFile(transcript, 'utf8'))
    }
    scenarios.push({
      id: value.id,
      session: value.session,
      contracts: assessAgentQualityScenario(value),
    })
  }
  await writeFile(
    join(output, 'assessment.json'),
    json({
      source,
      sourceStatus: report.status,
      status: 'review-required',
      scenarios,
      usage: aggregateAgentQualityUsage(
        scenarios.map((scenario) => scenario.session).filter(Boolean),
      ),
    }),
    { mode: 0o600 },
  )
  return output
}

async function main() {
  const { values } = parseArgs({
    options: {
      plan: { type: 'boolean' },
      run: { type: 'boolean' },
      'allow-model-calls': { type: 'boolean' },
      variant: { type: 'string' },
      profile: { type: 'string' },
      output: { type: 'string' },
      'compiled-root': { type: 'string' },
      'baseline-reference': { type: 'string' },
      foreground: { type: 'boolean' },
      'timeout-ms': { type: 'string' },
      compare: { type: 'string' },
      assess: { type: 'string' },
      candidate: { type: 'string' },
    },
  })
  if (values.assess) {
    if (!values.output) throw new Error('--assess requires a new --output directory.')
    log('assessment', { output: await assessAgentQualityEvaluation(values.assess, values.output) })
    process.exitCode = 2
  } else if (values.compare) {
    if (!values.candidate || !values.output)
      throw new Error('--compare requires --candidate and a new --output directory.')
    log('comparison', {
      output: await compareAgentQualityEvaluations(values.compare, values.candidate, values.output),
    })
    process.exitCode = 2
  } else if (values.run) {
    if (!values.profile || !values.output)
      throw new Error('--run requires an isolated --profile and new --output directory.')
    const timeoutMs = Number(values['timeout-ms'] ?? 300_000)
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 900_000)
      throw new Error('Turn timeout must be 1000–900000 milliseconds.')
    const result = await runAgentQualityEvaluation({
      variant: values.variant,
      profile: values.profile,
      output: values.output,
      compiledRoot: values['compiled-root'],
      baselineReference: values['baseline-reference'],
      foreground: values.foreground,
      allowModelCalls: values['allow-model-calls'],
      timeoutMs,
    })
    process.exitCode = result.report.status === 'review-required' ? 2 : 1
  } else {
    const plan = await planAgentQualityEvaluation()
    log('plan', {
      scenarios: plan.scenarios.map(({ id, prompts }) => ({ id, turns: prompts.length })),
      trackedFiles: plan.files.length,
      maxModelTurns: plan.maxModelTurns,
      modelCalls: 0,
    })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
