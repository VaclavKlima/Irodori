# Background testing

Automated Electron tests run in background mode by default. Luma uses real hidden, nonfocusable windows with normal GPU rendering and initial painting enabled. Background throttling is disabled. Context isolation and the renderer sandbox stay enabled; Node integration stays disabled. This is a quiet desktop workflow, not a browser headless mode or an offscreen renderer. Tests still consume CPU, GPU and memory, and Electron still needs a graphical session or a provisioned virtual display on Linux.

The explicit test entry installs a startup marker before importing Luma. An environment variable alone cannot hide a normal application. Normal application launches, `dev`, `dev:mcp`, manual MCP inspection and `hdr:diagnostic` remain visible. Node and service tests do not change. Worker limits, assertions, image dimensions, pixel checks and benchmark thresholds do not change with the UI mode.

## Running checks

```sh
# Quiet feature verification; --background is the explicit equivalent.
npm run verify -- --target adjustment-wiring

# Inspect the selected mode and targets without launching anything.
npm run verify -- --background --plan --target preview

# Explicitly allow native windows and desktop input for this target.
npm run verify -- --foreground --target preview

# Presentation benchmarks also require an explicit foreground request.
npm run benchmark:preview -- --foreground
```

`--background` and `--foreground` are mutually exclusive global flags, accepted by verification selectors and package aliases. Comprehensive commands still require an agreed checkpoint. Background execution never automatically retries visibly.

Native-only cases carry `@foreground` with a reason. They cover native keyboard focus, pointer lock and release, full screen and display integration. Renderer presentation benchmarks also stay foreground-only; hidden rendering has not established interchangeable timing baselines. These benchmarks measure renderer completion and presentation, not physical display scanout or luminance.

If a background selection includes required foreground cases, compatible cases run and the report lists the deferred checks with a foreground rerun command. The verification runner reports **incomplete (exit 2)** even if every executed case passes. Missing hardware, fixtures or required measurements also remain incomplete. A failed assertion remains a failure.

Read the invocation's `summary.md` first. Use its exact rerun command; direct Playwright reruns reuse the existing build and need the mode in the environment:

```sh
LUMA_TEST_UI_MODE=foreground npx playwright test tests/preview.spec.ts --project=electron
```

Direct Playwright commands retain normal Playwright exit semantics: deferred cases appear as skipped and may leave exit 0. Inspect the summary and skipped reasons; exit 0 alone does not establish complete coverage. Use the verification runner when an incomplete exit status is required.

Omitting `LUMA_TEST_UI_MODE` selects background mode. Its only accepted values are `background` and `foreground`. Do not rebuild while another invocation is using the output. `LUMA_TEST_TRACE=1` remains available for diagnostic functional reruns. Keep evidence under ignored `artifacts/verification/` directories.

## Writing and migrating tests

- Register each new suite's unique target and execution group in the shared verification plan. Declare whether it launches Electron and whether any cases need the desktop; execution exclusivity is a separate scheduling decision.
- Use `tests/electron.fixture.ts` for launches, restarts and crash recovery. Automated diagnostics and isolated MCP call the shared `launchTestElectron` helper in `scripts/electron-test-launch.mjs`. Create application and auxiliary windows through `createAppWindow` in `src/main/window-presentation.ts`; lint rejects direct `BrowserWindow` construction outside that factory. Apply the policy before application code creates windows. Do not add another direct Electron launcher, an ad hoc hidden-window switch, or a `NODE_OPTIONS` startup hook.
- Create a fresh temporary profile and verify Electron's actual user-data path before interaction. Use fixture imports and isolated Trash adapters. Close owned processes and remove profiles on success, failure and interruption.
- Keep DOM focus, accessibility, keyboard navigation, screenshots and real renderer assertions in background coverage when they do not require native desktop ownership. Never fake `document.hidden`, disable GPU acceleration, replace native dimensions with viewport emulation, or remove assertions to obtain a background pass.
- Capture native windows with the shared hidden-safe capture path (`capturePage` uses `stayHidden: true`). Supply native picker/confirmation responses through the existing test adapters. Unexpected native windows or unhandled dialogs must fail clearly instead of interrupting the desktop.
- Tag the smallest complete case that requires native focus, pointer lock, full screen or display behavior with `@foreground`, and explain why beside the tag. Preserve that case's assertions and include its explicit foreground command in acceptance evidence. A background helper must not show or focus the application to repair input delivery.
- Verify visibility, activation, rendering, cleanup and case counts when migrating a suite. Exercise error paths and restart behavior. Run affected targets in focused batches; a migration does not authorize a full checkpoint, benchmarks or manual desktop inspection.

A native case in `tests/` declares its requirement alongside its assertions:

```ts
import { test, expect } from './electron.fixture'
import { foregroundTest } from './foreground'
import { focusPreviewWindow } from './preview-pan.helpers'

test(
  'preview receives native window focus',
  foregroundTest('This case verifies native focus, which owns the desktop.'),
  async ({ luma: { app, page } }) => {
    await focusPreviewWindow(app, page)
    const window = await app.browserWindow(page)
    await expect.poll(() => window.evaluate((window) => window.isFocused())).toBe(true)
  },
)
```

`focusPreviewWindow` requires foreground mode and verifies native window and web-contents focus. Ordinary DOM navigation uses locator focus without this helper. Keep real pointer-lock and release assertions in their existing native cases.

## Evidence and limits

The October 15, 2026 macOS feasibility run used unchanged existing specs with an artifact-only guarded launcher. Six targets (`continuous-scroll-ui`, `workspace-recovery-ui`, `photo-menu-ui`, `progressive-review-ui`, `full-preview-ui` and `hdr-content-ui`) passed **20 cases across 24 Electron launches**. The run recorded no native window visibility or focus events and no Electron desktop activations, while retaining real imports, GPU HDR rendering, screenshots, normal restart and abrupt-exit recovery. Evidence is retained in `artifacts/verification/2026-10-15T05-31-10.223Z-hidden-original-targets-hn9O1R/`.

An earlier `NODE_OPTIONS` injection probe did not load its guard and briefly opened a window; that approach was rejected. The shared launcher must arm its guard before importing Luma. The feasibility evidence is separate from acceptance of the repository migration. Broader macOS target results belong in the invocation reports; Linux and Windows background behavior remain unverified until tested. Quiet execution does not establish native input correctness, physical HDR accuracy, hardware luminance or equivalent performance timings.

### Local migration acceptance — 2026-10-15

Focused macOS migration verification has **387 distinct passing cases** (240 fast Node and 147 UI), with no unresolved failures. Isolated MCP also passed in **49.24 seconds**. Coverage retains real imports, GPU/CPU rendering, native captures, keyboard behavior, diagnostics, restart/crash recovery and failure cleanup. The [consolidated evidence](../artifacts/verification/2026-10-15T06-54-08.619Z-background-migration-48hmyT/summary.md) links the individual invocations and retained earlier failures; successful focused reruns verify their fixes.

Across **283 guarded Electron launches**, there were no native show events, native focus events or guard violations. All **218 distinct temporary profiles** were removed. An independent AppKit witness covered 255 later launches and observed no Electron activations; earlier launches have in-process guard evidence only. Representative focused batches took 136.82 seconds for preview/import, 70.93 seconds for lifecycle and 63.27 seconds for MCP/deferral verification. The final RAW renderer GPU/CPU case passed in 72.69 seconds. These are test durations, not performance benchmark results.

The local launcher migration is accepted with **28 explicitly deferred or unavailable cases**: 11 native desktop cases, 15 presentation benchmark cases and two cases lacking private fixtures (`brk-ui` and `merge-raw-ui`). Their selected background runs remain incomplete. Native input, benchmark timings, missing private sequences and Linux/Windows background behavior are not certified by this evidence. No comprehensive checkpoint, performance benchmark or physical HDR certification was performed.

Electron documents [hidden painting, throttling, focusability and hidden-safe capture](https://www.electronjs.org/docs/latest/api/browser-window), [macOS activation policy](https://www.electronjs.org/docs/latest/api/app#appsetactivationpolicypolicy-macos), and [Linux virtual-display testing](https://www.electronjs.org/docs/latest/tutorial/testing-on-headless-ci). [Playwright's Electron API](https://playwright.dev/docs/api/class-electron) launches Electron rather than a headless browser. Offscreen rendering and separate desktop/VM execution remain separate future work.
