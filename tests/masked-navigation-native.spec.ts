import { createHash, randomUUID } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, expect } from './electron.fixture'
import { foregroundTest } from './foreground'
import { focusPreviewWindow } from './preview-pan.helpers'
import { importPhotos } from './import.helpers'
import { activateButton } from './button.helpers'
import {
  navigationReady,
  navigationObserver,
  distribution,
  coverageRequestWitness,
} from './masked-navigation-native.helpers'
import type { DisplayPreview } from '../src/shared/contracts'

const raw = 'tests/fixtures/sony-zv1.ARW'
const bird =
  'assets/tests/images/raster/wikimedia/flamingo-reflection/originals/Flamant_rose_Salines_de_Thyna.jpg'
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

for (const configuration of ['raw-range', 'bird-texture-0', 'bird-texture-25'] as const) {
  for (const size of [
    { width: 1100, height: 700, console: true },
    { width: 1440, height: 900, console: false },
  ]) {
    test(
      `${configuration} at ${size.width} by ${size.height} preserves masked native navigation`,
      foregroundTest(
        'Owns native focus, middle-button pointer lock and foreground GPU presentation timing.',
      ),
      async ({ irodori }, info) => {
        test.setTimeout(180000)
        const { app, page } = irodori
        page.on('pageerror', (error) => {
          void writeFile(info.outputPath('renderer-stack.txt'), error.stack ?? error.message)
        })
        const source = configuration === 'raw-range' ? raw : bird
        const sourceSha256 = sha(await readFile(source))
        const native = await app.browserWindow(page)
        await native.evaluate((window, size) => {
          window.unmaximize()
          window.setContentSize(size.width, size.height)
        }, size)
        await expect
          .poll(() => page.evaluate(() => [innerWidth, innerHeight]))
          .toEqual([size.width, size.height])
        const toggle = page.getByTestId('console-toggle')
        if (((await toggle.getAttribute('aria-expanded')) === 'true') !== size.console)
          await activateButton(toggle)
        await expect(toggle).toHaveAttribute('aria-expanded', String(size.console))
        await page.evaluate(() => window.irodori.setPreviewPreference('sdr'))
        await importPhotos(app, page, [source], false, 'renderer')
        const photo = (await page.evaluate(() => window.irodori.listPhotos())).photos[0]
        expect(photo.id).toBe(sourceSha256)
        let model: unknown = null
        const root = randomUUID()
        if (configuration === 'raw-range') {
          await page.evaluate(
            ({ photoId, root }) =>
              window.irodori.mutateMasks(photoId, 0, {
                operations: [
                  {
                    kind: 'create',
                    id: root,
                    name: 'Prepared navigation coverage',
                    range: { version: 1, kind: 'luminance', lower: 10, upper: null, softness: 25 },
                  },
                  {
                    kind: 'update',
                    id: root,
                    edge: { featherPx: 3 },
                    light: { exposureEv: 0.5 },
                    color: { temperature: 8, saturation: 5 },
                  },
                ],
              }),
            { photoId: photo.id, root },
          )
        } else {
          model = await page.evaluate(async (photoId) => {
            const context = await window.irodori.getObjectSelectionContext(photoId, 0)
            const proposal = await window.irodori.createObjectSelection({
              photoId,
              expectedRevision: 0,
              gridIdentity: context.gridIdentity,
              prompts: {
                positivePoints: [
                  [0.43, 0.46],
                  [0.72, 0.1],
                  [0.435, 0.7],
                ],
                negativePoints: [
                  [0.18, 0.22],
                  [0.2, 0.8],
                ],
              },
            })
            await window.irodori.acceptObjectSelection({
              photoId,
              expectedRevision: 0,
              proposalId: proposal.id,
            })
            return {
              identity: proposal.modelIdentity,
              base: proposal.mask.base,
              id: proposal.mask.id,
            }
          }, photo.id)
          const selection = model as { id: string; identity: string; base: { hash: string } }
          expect(selection.identity).toBe('sam2.1-hiera-tiny-f32-labels-v1')
          expect(selection.base.hash).toMatch(/^[a-f0-9]{64}$/)
          await page.evaluate(
            async ({ photoId, selected, root, texture }) => {
              const range = crypto.randomUUID(),
                brush = crypto.randomUUID(),
                componentId = crypto.randomUUID()
              await window.irodori.mutateMasks(photoId, 1, {
                operations: [
                  {
                    kind: 'stroke',
                    id: selected,
                    strokeTarget: 'primary',
                    stroke: {
                      mode: 'add',
                      radius: 0.005,
                      feather: 0.3,
                      points: [
                        { x: 0.374, y: 0.635 },
                        { x: 0.356, y: 0.805 },
                      ],
                    },
                  },
                  {
                    kind: 'stroke',
                    id: selected,
                    strokeTarget: 'primary',
                    stroke: {
                      mode: 'add',
                      radius: 0.005,
                      feather: 0.3,
                      points: [
                        { x: 0.438, y: 0.635 },
                        { x: 0.427, y: 0.805 },
                      ],
                    },
                  },
                  {
                    kind: 'update',
                    id: selected,
                    edge: { featherPx: 3 },
                    texture,
                    light: { contrast: 10 },
                    color: { saturation: 9 },
                  },
                  {
                    kind: 'create',
                    id: range,
                    name: 'Water luminance',
                    range: { version: 1, kind: 'luminance', lower: 10, upper: 80, softness: 25 },
                  },
                  { kind: 'update', id: range, light: { exposureEv: -0.1 } },
                  {
                    kind: 'create',
                    id: root,
                    name: 'Protected gradient',
                    gradient: {
                      kind: 'linear',
                      start: { x: 0.15, y: 0.2 },
                      end: { x: 0.85, y: 0.8 },
                    },
                  },
                  {
                    kind: 'component-add',
                    id: root,
                    componentId,
                    name: 'Radial protection',
                    operator: 'subtract',
                    gradient: {
                      kind: 'radial',
                      center: { x: 0.5, y: 0.5 },
                      radiusX: 0.2,
                      radiusY: 0.25,
                      rotation: 20,
                      feather: 45,
                    },
                  },
                  { kind: 'update', id: root, light: { exposureEv: 0.2 } },
                  { kind: 'create', id: brush, name: 'Brush coverage' },
                  {
                    kind: 'stroke',
                    id: brush,
                    stroke: {
                      mode: 'add',
                      radius: 0.04,
                      feather: 0.5,
                      points: [
                        { x: 0.2, y: 0.5 },
                        { x: 0.4, y: 0.6 },
                      ],
                    },
                  },
                  { kind: 'update', id: brush, color: { saturation: 5 } },
                ],
              })
            },
            {
              photoId: photo.id,
              selected: selection.id,
              root,
              texture: configuration === 'bird-texture-25' ? 25 : 0,
            },
          )
        }
        const revision = configuration === 'raw-range' ? 1 : 2
        await navigationReady(page, photo.id, revision)
        const history = await page.evaluate((id) => window.irodori.getEditHistory(id), photo.id)
        expect(history.settings.maskStack).toHaveLength(configuration === 'raw-range' ? 1 : 4)
        const coverage = await page.evaluate(
          async ({ photoId, revision, maskIds }) => {
            const result = await window.irodori.prepareMaskCoverage({ photoId, revision, maskIds })
            const descriptors = (values: typeof result.coverages) =>
              Object.fromEntries(
                Object.entries(values).map(([id, value]) => [
                  id,
                  { key: value.key, hash: value.hash, width: value.width, height: value.height },
                ]),
              )
            return {
              sourceIdentity: result.sourceIdentity,
              coverages: descriptors(result.coverages),
              ranges: descriptors(result.rangeBases ?? {}),
            }
          },
          {
            photoId: photo.id,
            revision,
            maskIds: history.settings.maskStack.map((mask) => mask.id),
          },
        )
        expect(
          Object.keys(coverage.coverages).length + Object.keys(coverage.ranges).length,
        ).toBeGreaterThan(0)
        const resources = await page.evaluate(async (photoId) => {
          const request = crypto.randomUUID()
          try {
            const frame = (await window.irodori.requestFullPreview(
              photoId,
              request,
            )) as DisplayPreview
            return {
              photoId: frame.photoId,
              revision: frame.settingsRevision,
              sha256: frame.sha256,
              width: frame.width,
              height: frame.height,
              prepared: frame.preparedMaskStack ?? null,
              linear: frame.linear && {
                sha256: frame.linear.sha256,
                prepared: frame.linear.preparedMasks ?? null,
              },
            }
          } finally {
            await window.irodori.releaseFullPreview(request)
          }
        }, photo.id)
        expect(resources.photoId).toBe(photo.id)
        expect(resources.revision).toBe(revision)
        if (configuration === 'bird-texture-25')
          expect(resources.prepared?.key).toMatch(/^[a-f0-9]{64}$/)
        await navigationReady(page, photo.id, revision)
        await focusPreviewWindow(app, page)
        const canvas = page.getByTestId('main-preview'),
          viewport = page.getByTestId('preview-viewport')
        let observer = await navigationObserver(page)
        const coverageWitness = await coverageRequestWitness(app)
        const historyRead = () => page.evaluate((id) => window.irodori.getEditHistory(id), photo.id)
        const output: Record<string, unknown> = {
          configuration,
          size,
          source,
          sourceSha256,
          model,
          resources,
          revision,
          coverage,
        }
        const receipt = async () =>
          writeFile(
            info.outputPath('masked-navigation-native.json'),
            JSON.stringify(output, null, 2),
          )
        try {
          const initial = await observer.evaluate((control) => control.settle())
          expect(initial.pose.fit).toBe(true)
          output.initial = initial
          output.device = await app.evaluate(async ({ app, screen }) => ({
            versions: process.versions,
            platform: process.platform,
            arch: process.arch,
            gpu: await app.getGPUInfo('complete'),
            displays: screen.getAllDisplays(),
          }))
          output.geometry = await page.evaluate(() => {
            const c = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')!,
              v = document.querySelector<HTMLElement>('[data-testid="preview-viewport"]')!
            return {
              dpr: devicePixelRatio,
              content: [innerWidth, innerHeight],
              backing: [c.width, c.height],
              viewport: { width: v.clientWidth, height: v.clientHeight },
              image: [v.dataset.imageWidth, v.dataset.imageHeight],
              policy: {
                backend: c.dataset.backend,
                precision: c.dataset.interactivePolicy,
                tileBatch: c.dataset.tileBatch,
                cache: c.dataset.presentationCache,
                kernel: c.dataset.tileKernel,
              },
            }
          })
          await canvas.focus()
          await canvas.press('1')
          await observer.evaluate((control) => control.settle())
          expect((await observer.evaluate((control) => control.snapshot())).pose.scale).toBe(1)
          // Five round trips for both routes, including all intended warmed poses.
          await observer.evaluate((control) => control.warm())
          const profiler =
            process.env.IRODORI_MASK_NAVIGATION_PROFILE === '1'
              ? await page.context().newCDPSession(page)
              : null
          if (profiler) {
            await profiler.send('Profiler.enable')
            await profiler.send('Profiler.start')
          }
          const before = await observer.evaluate((control) => control.start())
          const preparationBefore = await coverageWitness.evaluate((control) => control.read())
          const batches = []
          for (let batch = 0; batch < 3; batch++) {
            batches.push({
              pan: await observer.evaluate((control) => control.batch('pan', 16)),
              zoom: await observer.evaluate((control) => control.batch('zoom', 16)),
            })
          }
          const warm = await observer.evaluate((control) => control.stop())
          if (profiler) {
            const profile = await profiler.send('Profiler.stop')
            await writeFile(
              info.outputPath('navigation.cpuprofile'),
              JSON.stringify(profile.profile),
            )
            await profiler.detach()
          }
          output.warm = { before, batches, ...warm }
          const samples = batches.flatMap((batch) => [...batch.pan, ...batch.zoom])
          output.timings = {
            observation: distribution(samples.map((s) => s.observedMs)),
            gpu: distribution(samples.map((s) => s.gpuMs)),
            completion: distribution(samples.map((s) => s.completionMs)),
            pan: distribution(batches.flatMap((b) => b.pan.map((s) => s.observedMs))),
            zoom: distribution(batches.flatMap((b) => b.zoom.map((s) => s.observedMs))),
          }
          await receipt()
          expect(warm.probe).toEqual({
            serializations: 0,
            bytes: 0,
            clones: 0,
            glUploads: 0,
            histogramReads: 0,
          })
          expect(warm.payloads).toBe(0)
          expect(await coverageWitness.evaluate((control) => control.read())).toBe(
            preparationBefore,
          )
          expect(warm.final.pose.scale).toBeCloseTo(before.pose.scale, 10)
          expect(warm.final.pose.x).toBeCloseTo(before.pose.x, 8)
          expect(warm.final.pose.y).toBeCloseTo(before.pose.y, 8)
          expect({
            ...warm.final,
            pose: before.pose,
            presented: before.presented,
            requestedSerial: before.requestedSerial,
            completedSerial: before.completedSerial,
            presentationSerial: before.presentationSerial,
          }).toEqual(before)
          for (const sample of samples) {
            expect(sample.after.pose).not.toEqual(sample.before.pose)
            expect(sample.after.quality).toBe('normal')
            expect(sample.after.policy).toBe('reference')
          }
          for (const batch of batches)
            for (const sample of batch.zoom) {
              const point = sample.point
              for (const axis of ['x', 'y'] as const)
                expect(
                  (point[axis] - sample.after.pose[axis]) / sample.after.pose.scale,
                ).toBeCloseTo(
                  (point[axis] - sample.before.pose[axis]) / sample.before.pose.scale,
                  4,
                )
            }
          // New tiles and burst coalescing are deliberately outside warmed distributions.
          await observer.evaluate((control) => control.start())
          const reversal = await observer.evaluate((control) => control.reversal())
          const burst = await observer.evaluate((control) => control.stop())
          output.reversal = {
            sample: reversal,
            ...burst,
            coalescedInputs:
              burst.inputs.length -
              (reversal.after.presentationSerial - reversal.before.presentationSerial),
            requestSerialGap: reversal.after.requestedSerial - reversal.before.requestedSerial,
          }
          expect(burst.probe.serializations + burst.probe.clones + burst.payloads).toBe(0)
          await canvas.press('1')
          await observer.evaluate((control) => control.settle())
          await observer.evaluate((control) => control.start())
          const large = await observer.evaluate((control) => control.batch('large', 4))
          output.newTiles = {
            samples: large,
            ...(await observer.evaluate((control) => control.stop())),
          }
          expect(
            large.every(
              (s) => s.after.uploads === before.uploads && s.after.analysis === before.analysis,
            ),
          ).toBe(true)
          if (configuration === 'raw-range')
            expect(large.some((s) => s.after.tiles > s.before.tiles)).toBe(true)
          else expect(large.every((s) => s.after.prepared === before.prepared)).toBe(true)
          const box = (await viewport.boundingBox())!,
            center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
          await focusPreviewWindow(app, page)
          await page.mouse.move(center.x, center.y)
          const nativeBefore = await observer.evaluate((control) => control.start())
          await page.mouse.down({ button: 'middle' })
          await expect
            .poll(() => viewport.evaluate((el) => document.pointerLockElement === el))
            .toBe(true)
          await page.mouse.move(center.x - 20, center.y - 10)
          const nativeFrame = await observer.evaluate(
            (control, before) => control.nativeFinish(before),
            nativeBefore,
          )
          await page.mouse.up({ button: 'middle' })
          await expect
            .poll(() => viewport.evaluate((el) => document.pointerLockElement === el))
            .toBe(false)
          await expect(viewport).toHaveAttribute('data-dragging', 'false')
          await expect(viewport).toHaveAttribute('data-gliding', 'false', { timeout: 5000 })
          const released = await observer.evaluate((control) => control.settle())
          await page.mouse.move(center.x + 20, center.y + 10)
          expect((await observer.evaluate((control) => control.snapshot())).pose).toEqual(
            released.pose,
          )
          expect(await viewport.evaluate((el) => el.hasPointerCapture(1))).toBe(false)
          output.native = {
            frame: nativeFrame,
            ...(await observer.evaluate((control) => control.stop())),
          }
          // Real Chromium wheel delivery also reaches the same production handler.
          const wheelBefore = await observer.evaluate((control) => control.start())
          await page.mouse.wheel(6, 0)
          output.nativeWheel = await observer.evaluate(
            (control, before) => control.nativeFinish(before),
            wheelBefore,
          )
          await observer.evaluate((control) => control.stop())
          await canvas.press('0')
          await observer.evaluate((control) => control.settle())
          expect((await observer.evaluate((control) => control.snapshot())).pose).toEqual(
            initial.pose,
          )
          expect(await historyRead()).toEqual(history)
          await navigationReady(page, photo.id, revision)
          await canvas.screenshot({ path: info.outputPath('restored-fit.png') })
          const pixels = () =>
            canvas.evaluate(async (element) => {
              const blob = await new Promise<Blob>((resolve, reject) =>
                (element as HTMLCanvasElement).toBlob((b) =>
                  b ? resolve(b) : reject(new Error('No displayed photograph')),
                ),
              )
              return Array.from(
                new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())),
                (b) => b.toString(16).padStart(2, '0'),
              ).join('')
            })
          const beforeEditPixels = await pixels()
          await observer.evaluate((control) => control.close())
          await observer.dispose()
          await page.evaluate(
            ({ photoId, revision, root }) =>
              window.irodori.mutateMasks(photoId, revision, {
                operations: [{ kind: 'update', id: root, light: { exposureEv: 0.65 } }],
              }),
            { photoId: photo.id, revision, root },
          )
          await navigationReady(page, photo.id, revision + 1)
          observer = await navigationObserver(page)
          const edited = await historyRead()
          expect(edited.snapshots).toHaveLength(history.snapshots.length + 1)
          expect(edited.settings.maskStack.find((mask) => mask.id === root)?.light.exposureEv).toBe(
            0.65,
          )
          output.edited = await observer.evaluate((control) => control.settle())
          const editedFrame = await observer.evaluate((control) => control.snapshot())
          expect(editedFrame.revision).toBe(String(revision + 1))
          expect(await pixels()).not.toBe(beforeEditPixels)
          if (configuration === 'raw-range') expect(editedFrame.analysis).not.toBe(initial.analysis)
          if (configuration === 'bird-texture-25')
            expect(editedFrame.prepared).not.toBe(initial.prepared)
          await canvas.press('1')
          await observer.evaluate((control) => control.settle())
          await observer.evaluate((control) => control.warm())
          await observer.evaluate((control) => control.start())
          const editedSamples = await observer.evaluate((control) => control.batch('pan', 16))
          const editedNavigation = await observer.evaluate((control) => control.stop())
          output.afterEdit = { samples: editedSamples, ...editedNavigation }
          expect(editedNavigation.probe).toEqual({
            serializations: 0,
            bytes: 0,
            clones: 0,
            glUploads: 0,
            histogramReads: 0,
          })
          expect(editedNavigation.payloads).toBe(0)
          expect(
            editedSamples.every(
              (s) =>
                s.after.prepared === editedFrame.prepared &&
                s.after.uploads === editedFrame.uploads &&
                s.after.analysis === editedFrame.analysis,
            ),
          ).toBe(true)
          await canvas.press('0')
          await observer.evaluate((control) => control.settle())
          expect(await historyRead()).toEqual(edited)
          expect(sha(await readFile(source))).toBe(sourceSha256)
          const originalDir = join(irodori.userDataDir, 'library', 'originals', photo.id)
          const originals = (await readdir(originalDir)).filter((name) =>
            name.startsWith('original.'),
          )
          expect(originals).toHaveLength(1)
          expect(sha(await readFile(join(originalDir, originals[0])))).toBe(sourceSha256)
          output.modelManifestSha256 = sha(
            await readFile('assets/app/object-selection/manifest.json'),
          )
          output.historyPreserved = true
          output.originalsPreserved = true
          await receipt()
          const timing = distribution(samples.map((s) => s.observedMs))
          expect
            .soft(timing.p95, 'Warmed input → presentation observation p95')
            .toBeLessThanOrEqual(33)
          expect
            .soft(timing.p99, 'Warmed input → presentation observation p99')
            .toBeLessThanOrEqual(50)
          expect.soft(timing.max, 'No warmed stall over 100 ms').toBeLessThanOrEqual(100)
          expect
            .soft(
              distribution(samples.map((s) => s.gpuMs)).p95,
              'Final full-quality completion p95',
            )
            .toBeLessThanOrEqual(200)
        } finally {
          await receipt()
          await page.mouse.up({ button: 'middle' })
          await observer.evaluate((control) => control.close())
          await observer.dispose()
          await coverageWitness.evaluate((control) => control.close())
          await coverageWitness.dispose()
        }
      },
    )
  }
}
