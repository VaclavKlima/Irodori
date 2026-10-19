# Editor responsiveness: Bazzite handoff

The user paused the Mac goal on October 19, 2026 and requested continuation on
the Bazzite machine. This is an implementation checkpoint, not completed
acceptance. No editor candidate has been enabled by default or merged into
production. Start a new goal on Bazzite using the objective below.

## Repository and checkpoint

- Repository: `https://github.com/VaclavKlima/Luma.git`.
- Working branch: `perf/editor-responsiveness`; use its latest handoff commit.
- Production base: `bef6a6146ad6ab451e5abeac7dcf9b9b77fd4f4d`.
- Latest implementation candidate: `06f68ba`, adding final-input feedback before
  canonical refinement. Source/test checkpoint
  `3c9111b05dd24f4e7d52dd45b63f4d90856b97ff` also corrects its native test's IPC
  reply gate; that correction has type/lint checks but no native rerun. Later
  handoff documentation commits do not change that implementation.
- Both selectors remain opt-in:
  `VITE_LUMA_HDR_INTERACTIVE_PRECISION=f32` and
  `VITE_LUMA_HDR_PRESENTATION_CACHE=1`. Set the same values during build and run.
  An unset precision selector is the canonical reference. Keep cache selection
  fixed when comparing arithmetic/release policies.

Read `AGENTS.md`, `README.md`, `Luma.md`,
[editor responsiveness](editor-responsiveness.md),
[display rendering](display-rendering.md), and
[the Linux editor checklist](mac-workability.md#everyday-editor-continuation).
The original goal no longer needs the Mac-only attachment path; its complete
working objective is preserved below.

## Objective for the new goal

Make Luma feel immediate during everyday photo editing on the available Bazzite
machine, without perceptible preview-quality degradation. Continue the existing
implementation and research rather than restarting from scratch. Preserve Mac
results as separate historical evidence; establish new Linux evidence.

- Prioritize all eight enabled sliders, switching photographs, zooming and
  panning. Research documented behavior and maintained source from established
  editors, distinguishing proprietary assumptions from inspected facts. Review
  existing measurements and rejected experiments before proposing alternatives.
- Evaluate display-sized previews, adaptive resolution, pyramids, visible-region
  processing, retained GPU data, caches/prefetch, cancellation, progressive
  refinement and foreground scheduling. Compare the tiled renderer with
  alternatives; refactor where measured application evidence supports it.
- Warm input-to-visible response: p95 ≤33 ms, p99 ≤50 ms, and no interaction
  stalls above 100 ms. Aim for 60 completed changed visible updates per second.
  Retain every dispatched input, dropped/coalesced request, actual visible
  update, maximum gap and tail. Evaluate 120 Hz input separately and report
  actual native-frame and presentation cadence.
- Cached/prefetched selection: first useful correctly edited frame ≤100 ms p95.
  Cold selection: target ≤500 ms p95, with native/full-quality readiness measured
  separately. Canonical refinement after gesture completion: ≤200 ms p95.
- Temporary preview precision/resolution reductions require controlled
  numerical, perceptual and visual comparisons at actual physical display
  dimensions, Fit and 100%. Cover fine detail, foliage/hair, noise, gradients,
  highlights, shadows and strong edits. Reject blur, shifts, aliasing, shimmer
  and distracting refinement. Record human visual review still required.
- Preserve canonical settled/native/export rendering, originals, Float32
  masters, numeric history, versioned policies/cache identities, cancellation,
  source/revision ownership, device-loss recovery and full CPU fallback.
  Preserve existing memory/cache bounds, including 768 MiB preview presentation,
  2 GiB preview disk cache, separate 1 GiB merge GPU and 512 MiB aggregate WASM
  bounds where applicable.
- Verify small Console-open, large and fullscreen layouts; Console open/closed,
  Fit/100%, pointer-centered zoom, native drag, rapid reversals/navigation and
  import/individual-export/batch-export/merge interference. Establish matched
  local baselines, test promising candidates sequentially, and adopt repeatable
  complete-interaction gains without quality or tail regressions.
- Deliver tested implementation, rendering decisions, before/after evidence,
  rejected experiments and explicit remaining misses. Merge validated changes
  through the repository workflow; keep insufficiently verified experiments
  disabled. Do not automatically run a comprehensive checkpoint.

## What is implemented

The versioned `aces2-f32-interactive-v1` shader retains the same source, sampling,
adjustment equations and alpha, with ordinary Float32 arithmetic for transient
feedback. Canonical compensated math is unchanged. Settled frames and export
remain canonical. Previous reduced-resolution and small LUT experiments failed
quality checks and remain rejected.

The exact completed-presentation cache reserves 96 MiB inside the existing
768 MiB aggregate cap. Full identity includes source, confirmed edit revision,
target, viewport, view and policy. Leases remain charged through their GPU fence;
headroom pressure drains/bypasses the cache. Cached pixels never confer native
editing readiness. Fresh edit confirmation, stale replies, scope changes,
Undo/Redo, CPU source replacement and device loss have explicit ownership guards.

Exact readback and strip-writing candidates preserve Float32 bytes. Their stage
gains do not establish a repeatable complete cold-selection improvement.

The final-input handoff tracks one pending local write before IPC and accepts it
only after its own successful reply. A matching broadcast refresh cannot invent
acceptance. One final F32 publication may precede freshly confirmed canonical
refinement. Per-stage request serials prevent old cleanup from resetting a
replacement or publishing twice. Private metadata adds no public API or GPU
surface. Cancellation, conflicts, history, scope/source/view/target changes and
device loss retire ownership. Original request epochs remain in diagnostics.

## Mac evidence and limits

- `06f68ba` passed targeted type/lint/format and **405 Node checks in 20.02 s**,
  including 43 new commit/handoff lifecycle cases. Its F32/cache build passed
  in 1.98 s. Later test-only IPC correction passed type checking and file lint.
- Earlier all-eight-slider, 1440 × 900, 60 Hz evidence has worst p95 **26 ms**.
  Reanalysis including first-only final feedback exposes **three 107.8–109.1 ms
  maximum misses**. The new handoff has no measured latency result yet. The
  earlier reference/candidate HDR headroom differed, preventing a controlled
  same-target speedup claim.
- Warm cached fullscreen revisits measured about **52.5–59 ms** with the 96 MiB
  cache. A first warm small-layout miss remains around **396 ms** after a target
  change. Cold selections remain roughly **1.25–1.35 s**, above target.
- Synthetic, street and deer/fur quality comparisons passed their recorded
  preview bounds; canonical math/reference identities remain unchanged. Human
  physical Retina/HDR review remains pending.
- On resume, the formerly interrupted stale-null navigation and real-device-loss
  cases passed **2/2 in 48.27 s** (6.57 s and 41.34 s). Earlier interrupted
  invocations remain failed evidence; macOS logs confirmed long sleep intervals.
- The new held-reply native case failed during test setup because it attempted
  to replace the protected renderer bridge. The handoff correction instead
  holds the existing main-process `edits:update` handler's real reply after
  persistence/broadcast. **This corrected case is unrun.** No production failure
  or native handoff success is inferred from that setup failure.

Generated artifacts are ignored and are not transferred by Git. Historical paths
in the research documents may therefore be unavailable on Bazzite. An optional
handoff archive preserves selected compact reports and raw slider/navigation
measurements; extract it at the repository root. It excludes large quality
buffers, screenshots and originals. Reproduce current Linux evidence locally.

## First actions on Bazzite

1. Fetch/check out `perf/editor-responsiveness` at its handoff tip. Use a fresh
   Linux `npm ci` and `npm run setup:electron` with Node 24+, preserving the lock
   file. Do not copy Mac `node_modules` or `out`. Confirm the committed licensed
   RAW fixtures with `node scripts/research/sony-fixtures.mjs check`. The 15-file
   research set is authorized for project/device testing, not an open-content
   license. Private portrait/other bracket assets under ignored artifacts do not
   follow Git and must not be replaced with fabricated fixtures.
2. Record Bazzite, kernel, Node/Electron/Dawn, GPU/driver, Wayland/X11, power,
   display dimensions/DPR, color/headroom and actual refresh. Use the existing
   Linux launch/display guidance. Keep native processing outside Electron.
   Quality proofs need Python 3 and a C++17 compiler such as `clang++`. Retain
   optional dependencies for the Linux bundled Node runtime. Native presentation
   requires a hardware GPU; Xvfb/software adapters do not establish acceptance.
   Linux export uses the verified WASM codec; the native encoder build is Mac
   arm64 only, so record the actual Linux export backend separately.
3. Run the focused Node targets, then the corrected held-reply native case on an
   explicit candidate build. Follow affected UI/cache/cancellation/device-loss
   and complete CPU-recovery checks before performance adoption. Keep every
   library/profile isolated and native cases foreground.
4. Fix the remaining harness gaps before claiming matched acceptance: verify
   actual SDR target and completed target generation, add per-frame
   `presentedPolicy` checks to contention, and retain selected CLI case counts.
   `matrixPartial` alone does not describe layout/frequency filters. Several
   Mac suites require DPR 2; preserve that profile and add an explicit Linux
   physical-resolution profile rather than treating skips or forced DPR as a
   real-display pass. The SDR selector currently affects only the slider suite.
5. Start bounded: Exposure, 1440 × 900, 60 Hz, Fit/100%, three repetitions. Compare
   F32/cache1 → reference/cache1 → F32/cache1 on the same source revision and
   actual SDR target. This compares preview arithmetic plus release handoff,
   holding cache capacity fixed. Compare cache0/cache1 separately at fixed
   precision for navigation. Stop broader work to investigate genuine failures.
6. Expand to all eight sliders and other layouts/120 Hz, spatial gestures,
   navigation and contention. Current contention starts with Exposure at
   1440/Fit/60 and nine-source noise merge; it does not prove every layout/rate.
   Cold-path and first-warm misses remain real work, not excluded samples.

Useful focused commands, after validating local display/profile requirements:

```sh
npm run verify -- --target edit-gesture-commit --target hdr-gesture-handoff --target hdr-presentation-cache --target hdr-readback --target write-hdr-strip
VITE_LUMA_HDR_INTERACTIVE_PRECISION=f32 VITE_LUMA_HDR_PRESENTATION_CACHE=1 npm run build
VITE_LUMA_HDR_INTERACTIVE_PRECISION=f32 VITE_LUMA_HDR_PRESENTATION_CACHE=1 LUMA_TEST_UI_MODE=foreground npx playwright test --project=raw-gpu tests/interactive-preview-lifecycle.spec.ts --grep 'the last local input receives Float32 feedback' --workers=1
VITE_LUMA_HDR_INTERACTIVE_PRECISION=f32 VITE_LUMA_HDR_PRESENTATION_CACHE=1 LUMA_TEST_UI_MODE=foreground LUMA_PREVIEW_BENCHMARK=1 LUMA_RESPONSIVENESS_DISPLAY=sdr LUMA_RESPONSIVENESS_SLIDERS=Exposure npx playwright test --project=benchmark tests/editor-responsiveness-benchmark.spec.ts --grep '^editor responsiveness 1440x900 60Hz:' --workers=1
```

Filtered direct Playwright runs reuse the prepared build; rebuild whenever source
or selectors change. `verify --target` does not accept Playwright `--grep`.
Run all builds/hardware measurements sequentially through one coordinator. Read
each compact report first, rerun failures first, retain every sample and cleanup.
Keep the separate older GPU-merge continuation under TODO #29; editor work does
not erase its unmet 10/12-second workflow or five-second stretch targets.
