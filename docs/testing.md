# Testing Luma

Use explicit suite targets for routine feature verification. Comprehensive testing requires a user-requested or previously agreed checkpoint; completing a feature alone never triggers one. This workflow remains local to Linux and extends the existing Playwright runner.

## Choose verification

| Command                                               | Coverage                                                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `npm run check`                                       | Static checks and fast Node tests; aim for under 15 seconds; no build, Electron, RAW decoding, GPU, or benchmarks  |
| `npm run verify -- --target adjustment-wiring`        | Cheap checks plus one explicit feature target; repeat `--target` to combine targets; aim for under 60 seconds      |
| `npm run verify -- ui`                                | Deliberate broad UI regression scope; `adjustments`, `preview`, `library`, and `mcp` remain available              |
| `npm run verify -- --plan --target adjustment-wiring` | Print deduplicated selection without executing, locking, or creating artifacts                                     |
| `npm run check:full`                                  | All functional regressions and isolated MCP protocol verification                                                  |
| `npm run check:all`                                   | All functional regressions, isolated MCP, and all benchmark families                                               |
| `npm run benchmark:adjustments -- highlights`         | Only the named warmed RAW adjustment; accepts exposure, contrast, highlights, shadows, whites, blacks, temperature |
| `npm run benchmark:preview`                           | Preview processing and actual Electron presentation only                                                           |
| `npm run benchmark:hdr`                               | HDR edit, cold selection, and cached native-resolution presentation                                                |
| `npm run benchmark:merge`                             | Existing 2/9/32 prepared cases plus three cold native RAW/publication runs at 2/3/5/9 sources                      |
| `npm run benchmark:all`                               | All preview, adjustment, HDR, and merge measurements and existing regression gates                                 |

Target IDs are defined in [verification-plan.ts](../scripts/verification-plan.ts), including `mcp-import` for the separate isolated import script. Every new spec must register one unique target and execution group. Unknown IDs and mixed target/scope selections are rejected. Target selections always include cheap checks; broad scopes form a deduplicated union (`npm run verify -- ui library`). Neither mode examines the dirty working tree.

For merge viewport performance work, `npm run verify -- --target merge-preview-benchmark` measures warmed wheel and drag presentation on a textured 3672 × 5496 native image at 100% and 800%, with deghost overlay off and on. Each of eight cases retains 60 samples after five warmups, dispatching four events per frame and measuring through the next animation frame and posted paint task; every p95 must remain at or below 33 ms. The isolated run records the WebGL renderer and verifies main-preview suspension. It measures browser presentation, excluding physical input delivery and RAW preparation. The merge benchmark family also includes this suite.

`benchmark:preview` deliberately no longer bundles adjustment, HDR, or merge measurements. Use `benchmark:all` for the previous combined coverage, or `check:all` for the comprehensive checkpoint. Thresholds and sample counts are unchanged. Set `LUMA_PREVIEW_BASELINE=/absolute/path/to/saved/benchmark.json` to enforce the existing 15% uncorrected CPU/GPU gates. The runner snapshots the baseline for stable assertions and records its original path, snapshot, content hash, sample, and medians. Missing/invalid baselines, missing reports, and selected tests skipped for required hardware or unsupplied real merge sequences mean **incomplete** verification (exit 2), never a complete checkpoint pass. Actual command failure exit codes are preserved; SIGINT/SIGTERM return 130/143.

Merge timing separates repeated-original calibration from distinct Sony sequences. Supply `LUMA_MERGE_SONY_SEQUENCE` as a JSON array of unmodified compatible Sony RAW paths (at least nine to select all workloads), and optionally `LUMA_MERGE_SONY_MODE=hdr` (default `noise`). Each 2/3/5/9 case selects distributed subsets and creates three fresh isolated libraries, with no preparation reuse before publication. RAW preparation, alignment, native review accumulation/comparison output and durable publication are timed; import copying/metadata inspection and human review are excluded. Every run must finish within 15 seconds. Reports separate native review preparation from publication; rendering before acceptance remains part of the cold total. The first published master and per-run diagnostics are retained. Repeated-file calibration never substitutes for distinct-sequence acceptance. Libraries and prepared synthetic scratch reside under the invocation's project-filesystem output, so publication uses the SSD rather than this machine's RAM-backed `/tmp`. Cold means fresh workers and preparation, not flushed OS file caches. Use `LUMA_MERGE_BENCHMARK_NATIVE=1` for the separate 2/9/32 native prepared-input scaling measurements. Avoid competing GPU workloads during performance measurements and retain any earlier failures.

1. Select the relevant target IDs and implement the change.
2. Run that verification command when ready.
3. Read `summary.md` first. On failure, open the linked diagnostic evidence and rerun the exact failed case command from the report. Reuse the build unless application code changed; prefix a functional rerun with `LUMA_TEST_TRACE=1` for diagnostic tracing.
4. Stop when relevant checks pass. Broader coverage repeats only when subsequent changes justify it. Extra GPU smoke checks, manual inspection, and MCP inspection remain purpose-driven.

Routine verification warns after 60 seconds, listing the ten slowest tests in the report; fast checks also warn above the 15 second target. Budgets never remove assertions or stop tests early. The compact report includes selected targets, stage outcomes, timings, failures, exact reruns, skipped/blocked work, benchmark measurements, worker counts, runtime/hardware, Git revision/dirty state, and baseline provenance. Detailed logs and successful screenshots stay in artifacts.

The runner builds once and shares that output across functional, isolated MCP, and benchmark phases, with separate flags and artifact directories. Comprehensive runs continue independent suites after failures. A failed build blocks only work needing its output; Node tests still run. Interruptions stop new stages, clean up process groups, release the invocation lock, and retain a partial report. The lock at `artifacts/verification/.invocation-lock/owner.json` reports the active run's PID and location to a second invocation before it executes commands. After an uncatchable crash, check that the owner and its workers have exited before removing a stale lock. Direct Playwright case reruns reuse existing output; do not run them while another invocation rebuilds it.

Execution groups run sequentially. Files in `node`, `service`, and ordinary `electron` use two workers; tests inside each file stay sequential without retries. Desktop-sensitive suites carry an explicit exclusive flag. `preview` and `merge-preview-ui` run exclusively because native pointer lock owns the desktop cursor. RAW/GPU, isolated MCP, and benchmarks use one worker and run exclusively. All automated Electron launches use fresh harness-created profiles, verify the actual user-data path before interaction, close their processes, and remove profiles. No mutable profiles or test results are reused across invocations. Manual renderer inspection is reserved for visual changes or unresolved UI problems. `test:e2e` remains all functional groups without static checks or the separate UI MCP script.

General MCP protocol, authentication, revision, light-edit, statistics, and restart checks use JPEG fixtures. Dedicated RAW cases retain combined white-balance/lens/light patches, shared history, RAW statistics, and processing upgrades. Broad light-history/restart coverage uses JPEG; mixed light/lens history and checkbox restoration retain the real RAW. Only two read-only HDR correction checks share one immutable GPU preparation within a worker invocation; their CPU reference is independently prepared and the shared assets are cleaned up. Cold decoding, corruption/recovery, cancellation, import compatibility, and benchmark preparation stay fresh. Fixture licensing is unchanged.

### October 2, 2026 workflow acceptance

Local Linux verification used Node 24.20, Electron 44.3, Ryzen 9 7900X3D, and Radeon RX 7900 XTX. The existing merge work, fixtures, assertions, benchmark thresholds, and sample counts were preserved.

| Selection                                                           | Result                                                                             | Duration |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------: |
| Runner target plus cheap checks                                     | 60 passed, no failures/skips                                                       |    7.8 s |
| Concurrent library / preview service files                          | 20 passed with two workers                                                         |    6.8 s |
| Concurrent workspace, preview, inputs, JPEG history and editing MCP | 20 passed with two workers                                                         |   32.3 s |
| RAW history / editing MCP / shared HDR preparation                  | 7 passed with one worker                                                           |   73.9 s |
| Agreed `check:all` checkpoint                                       | 207 assertions passed, 2 external-sequence cases skipped; reporter errors retained |  865.1 s |
| Four affected helper targets after reporter repair                  | 68 passed, no failures/skips; includes new reporter regression                     |   75.1 s |
| Final `npm run check`                                               | 61 passed with type, lint and formatting checks; no failures/skips                 |    7.8 s |

The first comprehensive run exposed reporter failures for tests declared in shared helper files. The reporter now resolves the owning file suite while retaining the actual declaration location and exact nested-case rerun. The first affected JPEG case passed before the four affected helper targets were repeated. The original checkpoint remains failed in its immutable `result.json`; its `summary.md` links the successful focused follow-up. No second comprehensive run was performed. Two real Sony bracket cases require explicitly supplied external sequences, so the checkpoint remains incomplete coverage rather than a complete pass.

All 13 benchmarks and isolated MCP passed. Uncorrected CPU/GPU presentation changed **−1.87% / +2.28%** against the saved passing Sony baseline, inside the unchanged 15% limits. The baseline path/hash and invocation snapshot are in the result. Warmed HDR edit p95 was **7.1 ms**; cold native HDR selection median **1723 ms**, cached revisit p95 **679.5 ms**. Merge measurements retain 2/9/32 frames and fresh preparation; the 32-frame case took **159.5 s** and remains a comprehensive benchmark cost.

Compared with the September 30 functional checkpoint, the service stage changed **40.7 → 49.9 s**, ordinary Electron **152.6 → 80.2 s**, and RAW/GPU **371.9 → 335.0 s**. Service coverage now includes additional native merge alignment cases, and two external bracket cases were unavailable; these are stage observations across changed coverage, not a controlled speedup claim. The functional/MCP portion took about **514 s**; all benchmark families added about **351 s**. Routine verification avoids those comprehensive costs through explicit targets.

Runner acceptance covers selection, deduplication, artifact-free plans, one shared build, independent failure collection, build blocking, reports and exact reruns, baseline validation/snapshots, benchmark isolation, budget warnings, invocation locking, interruption, and descendant cleanup. A second real CLI invocation was rejected with the active checkpoint location. Concurrent Electron validation retained keyboard focus, pointer capture/release, minimum console layout, restart, and profile cleanup; no ordinary file demonstrated a need for exclusive execution. The RAW-focused follow-up exceeded 60 seconds and emitted the required warning without cutting work short. Production behavior and physical HDR/platform limitations are unchanged.

Evidence remains under `artifacts/verification/`: checkpoint `2026-10-02T06-58-59.780Z-checkpoint-Ccfx1u/`, focused repair `2026-10-02T07-14-51.229Z-check-kDFUO9/`, final fast checks `2026-10-02T14-52-54.130Z-check-ToZW7Y/`, runner acceptance `2026-10-02T06-56-35.761Z-check-bOXwur/`, concurrent service `playwright-1790923772576-b19f6155-bf72-4f11-89b0-6c1b52ede23c/`, concurrent Electron `playwright-1790923878082-8d30cdf0-f55b-401d-ada5-5c298faf07f7/`, and RAW hotspots `playwright-1790923954410-a9296a96-1a75-43dc-9522-5e9d9610bb01/`. First-run failures and diagnostic reruns are preserved. Final cleanup found no invocation lock, recent test profiles, shared HDR preparations, or merge scratch directories; the checkpoint produced no trace archives.

### Earlier local refactor measurements

September 18, 2026, on the development Linux machine (Node 26.7 test runner, bundled Node 24.20 preview runtime):

| Command                                       | Result                                                   | Elapsed |
| --------------------------------------------- | -------------------------------------------------------- | ------- |
| `npm run check`                               | 23 tests plus type, lint, and formatting checks passed   | 3.2 s   |
| `npm run verify -- ui`                        | 40 tests and all static checks passed                    | 49.0 s  |
| `npm run check:full`                          | 104 tests plus isolated UI MCP passed; no skips          | 299.0 s |
| `npm run benchmark:adjustments -- highlights` | Exactly one benchmark passed                             | 8.2 s   |
| `npm run benchmark:preview`                   | All four benchmarks passed with the saved baseline gates | 77.5 s  |

The complete benchmark used `artifacts/verification/highlights/benchmark.json` as its baseline. Uncorrected CPU/GPU medians changed by +1.4%/+7.5%, inside the 15% limits. Exposure, contrast, highlights, shadows, whites, and blacks each measured about 7.1 ms p95. These are local measurements, not cross-platform guarantees. The CLI's dry-run selection was also verified with Node 24.20.

Acceptance checks cover exact spec assignment, scope unions, invalid inputs, dry runs without artifacts, shared builds, nonzero command and test-stage propagation, retained logs, unique artifact directories, occupied-port rejection, profile isolation/removal, and child-process cleanup. Disabling routine traces exposed two existing test timing assumptions: workspace bounds now wait for xterm's asynchronous fit, and photo-switch gestures wait for the control to finish saving and display the draft. Both retained their assertions and passed focused reruns and the complete suite.

Generated evidence remains under `artifacts/verification/`: the successful fast run is `2026-09-18T16-17-22.152Z-check-VJP8FD`, UI run `2026-09-18T16-25-21.971Z-check-RuxluE`, milestone run `2026-09-18T16-17-43.201Z-check-1DE8ND`, named benchmark `2026-09-18T16-23-14.330Z-benchmark-2poipj`, and complete benchmark `2026-09-18T16-23-41.163Z-benchmark-PS2B5y`. Later commands preserved earlier reports, and routine/benchmark runs produced no trace archives.

## Automated Electron coverage

Electron downloads its runtime on first use if needed. Run `npm run setup:electron` after `npm ci` to complete this download explicitly before an offline test run.

The tests use [Playwright's Electron API](https://playwright.dev/docs/api/class-electron) to launch the built application, inspect the desktop window and preload bridge, and close their Electron process. Files use the selected worker policy without retries and need a desktop display or a provisioned virtual display; tests within each file remain sequential. No separate browser download is needed. Each test runs with its browser context offline; test user data is isolated from normal launches and removed after cleanup.

The suite checks empty startup, the isolated bridge, source selection, recursive folders, review/deselection, duplicate detection, exact original copies, persistence after restart and source removal, real Sony ZV-1 ARW import, keyboard access, and layout at 1280 × 800 and 1920 × 1080 (including the minimum 1100 × 700 console layout). Background-import tests slow the real copy stream after review and cover immediate dialog closure, byte progress, browsing during copying, renderer reload, cancellation, retained errors, success dismissal, quit choices, reduced motion, and the compact loader at 1100 × 700. The test harness supplies native confirmation responses; the real quit and cleanup paths run. Library tests also cover fixed task totals, paginated error retention after staging disposal, selection navigation after page shifts, failed writes, changed/missing sources, interrupted staging recovery, orientation, corrupt files, and the real RAW decoder fallback.

Slow-copy instrumentation runs through Playwright’s main-process debugger and is absent from the application API. Photo-action tests cover modifier selection, ranges across pages, keyboard and context menus, modal focus, deletion through the background task UI, failures, cancellation, and quit handling. Deletion-service tests cover byte preservation, v1 schema migration, and recovery before/after a Trash move. Automated deletion uses an injected move into each test profile’s `test-trash/` directory, never the user’s normal Trash.

Native picker return values are supplied using Playwright's Electron main-process API. The renderer, preload, scanner, preview process, filesystem copies, and database remain real. Native OS picker interaction itself requires a manual check. No test-only filesystem access is exposed by the production preload bridge.

Each invocation creates a unique directory under `artifacts/verification/`. It contains `summary.md`, `result.json`, stage logs, and group `summary.json`, `results/`, and `report/` directories under `functional/` or `benchmarks/`. Failures retain `failure.png` and Electron diagnostics. Tracing is disabled normally and always disabled for benchmarks; `LUMA_TEST_TRACE=1` records `electron-N.zip` traces for diagnostic failures. Open a report with `npx playwright show-report <run>/functional/<project>/report`. Later runs never erase earlier artifacts; remove obsolete runs explicitly when no longer needed. All artifacts are ignored by Git.

The real Electron Trash API was also checked separately on the Linux home filesystem with a uniquely named disposable bundle; contents were verified and the fixture restored and cleaned up. The host's `/tmp` uses tmpfs, where that native Trash check failed. The failure leaves the library photo intact; see Electron's [tmpfs Trash issue](https://github.com/electron/electron/issues/28045).

Preview tests cover pointer-centered wheel zoom, native image sizing, bounded drag and capture cleanup, Ctrl-wheel without page zoom, keyboard controls, context menus and deletion, photo switching, resize behavior, small/portrait images, and the compact toolbar with the console at 1100 × 700. Both preview suites verify native mouse locking, relative motion beyond cursor boundaries, hidden cursor state, and release on mouse up, Escape and blur. The `pan-drag` Node target covers delayed grants after cancellation or disposal, denied locks, touch/pen capture, and cleanup. Geometry tests check fit, zoom limits, pointer anchoring, pan bounds, and wheel delta normalization. Test gates delay full-frame requests and invalidate frame metadata to verify neutral loading, disabled controls, errors, and retry states.

Full-resolution checks decode the real Sony RAW to 5496 × 3672 pixels and compare the CPU RGBA output against LibRaw. GPU checks compare AHD output to that CPU reference and exercise synthetic neutral bars, black levels, highlights, stripe boundaries, all flip orientations, and device loss. A simulated GPU failure verifies CPU fallback and a matching placeholder. Raster checks cover orientation, profiles, native dimensions, and alpha. Cache tests cover restart, LRU, stream leases, version cleanup, interrupted writes, cancellation, removal, and shutdown. Electron tests verify neutral first loading, matching blurred placeholders, native canvas dimensions, rapid navigation, imports during loading, and repair of corrupted RGBA frames. GPU tests skip only when no hardware adapter is available; this is reported separately from a hardware pass.

Lens-correction module contracts, schema migration, independent-table coverage, and the extended correction benchmark are documented in [RAW processing](raw-processing.md). Lens UI tests cover default availability, rapid independent changes, cached variants, native zoom, restart persistence, and the minimum console layout. MCP additionally imports the real Sony RAW, changes distortion, reloads the renderer to verify persistence, captures the correction controls, and deletes the photo through isolated Trash.

Run `npm run gpu:check` for a native compute/readback smoke check. Run `npm run benchmark:preview` for four measurements each of CPU/PNG, CPU/RGBA fallback, and GPU/RGBA using the same Sony fixture, bundled Node worker, streamed files, and real Electron canvas presentation. The benchmark requires a hardware GPU, includes integrity checking and two animation frames, aligns presentation starts to a frame boundary, samples eight cached revisits per rendered frame, reports generation/presentation separately, and fails if first display is slower or cached presentation regresses by more than 15%. It is opt-in rather than a timing-sensitive ordinary test. Reports go to the unique benchmark run directory under `artifacts/verification/`; later checks preserve them. Set `LUMA_PREVIEW_DIAGNOSTICS=1` to log per-frame backend and stage timings; `LUMA_PREVIEW_BACKEND=cpu` forces fallback. The local Sony fixture benchmark on Radeon RX 7900 XTX measured median first presentation at 3449 ms for CPU/PNG and 749 ms for GPU/RGBA; warm presentation was 12 ms and 8 ms respectively. Four samples include cold GPU initialization once. These are fixture measurements, not a guarantee for other cameras or hardware. The renderer bitmap cache is bounded to 256 MiB and has LRU/lease/identity tests. The tested renderer remains SDR. Windows/macOS hardware and packaging are not covered by the local Linux run.

### Additional camera samples

The GPU eligibility regression covers the **ZV-1A** model name as well as ZV-1. Ten local ZV-1A ARWs were separately compared against LibRaw at full resolution, including portrait orientation and different white balances. All passed the same pixel tolerances as the checked-in ZV-1 fixture. These local photographs are not repository fixtures. On the same Radeon RX 7900 XTX, a ZV-1A sample measured 2586 ms median for CPU/RGBA fallback versus 717 ms for GPU/RGBA, including worker generation, streamed loading, integrity validation, and Electron canvas presentation. Cached GPU presentation measured 14 ms across 32 revisits. These isolated measurements exclude React selection handling and are not a guarantee for every photograph.

To repeat comparisons using local files, set `LUMA_RAW_TEST_FILES` to a JSON array of absolute paths and run `npx playwright test tests/gpu-preview.spec.ts`. To benchmark one of those files through the bundled worker and Electron presentation, set `LUMA_RAW_BENCHMARK_FILE` to its absolute path and run `npm run benchmark:preview`. Both commands read source files and write only isolated test output; the benchmark does not touch the existing library. Comparison images and reports appear in that invocation’s `artifacts/verification/` directory.

## Test through MCP

For repeatable import testing, run:

```sh
npm run mcp:test
```

This builds and launches an isolated Electron instance with a temporary library and an ephemeral loopback debugging port, then uses actual MCP tools to import fixtures, verify a neutral loading state, wait for full resolution, then zoom and drag the native-resolution canvas, reset Fit, detect duplicates, select multiple photos, confirm deletion into isolated test Trash, open the console, and capture screenshots. The full-resolution zoomed preview is saved as `<run>/mcp/preview-zoom.png`. It closes its processes and removes the temporary library afterwards. It does not modify your normal library.

For an isolated development inspection, pass Electron's profile argument through the launcher:

```sh
npm run dev:mcp -- -- --user-data-dir=/absolute/temporary/profile
```

The first `--` belongs to npm; the second forwards the profile argument to Electron through electron-vite. Do not rely on `ELECTRON_CLI_ARGS`: the electron-vite CLI replaces that environment variable while parsing arguments.

For intentional manual inspection of the isolated development window:

1. Start the application and keep it running:

   ```sh
   npm run dev:mcp -- -- --user-data-dir=/absolute/temporary/profile
   ```

2. In another terminal, verify the actual MCP connection:

   ```sh
   npm run mcp:check
   ```

The check starts the locally installed MCP server over stdio, initializes the protocol, discovers tools, and uses those tools to inspect the app, select a photo (or open the empty-library import dialog), open the console, and capture a screenshot. A successful check establishes that the server can operate the renderer even if the current Codex session has not loaded its tools yet.

`dev:mcp` exposes Electron's Chrome DevTools Protocol endpoint at `http://127.0.0.1:9222`. The local, version-pinned Playwright MCP server connects to that endpoint using `npm run mcp:ui`. This follows [Playwright MCP's support for Electron over CDP](https://playwright.dev/mcp/configuration/browser-extension). Neither a browser extension nor a separately installed Chrome is needed for this connection.

Ordinary `npm run dev` and production launches do not enable the debug endpoint. Stop the `dev:mcp` process when finished. Run one Luma debugging instance at a time because the port is fixed.

If the renderer development server's port 5173 is occupied, use `LUMA_DEV_PORT=5174 npm run dev:mcp`. This changes only the Vite port; the MCP debugging endpoint remains bound to `127.0.0.1:9222`.

### Register the server in Codex

Merge [mcp-config.example.toml](mcp-config.example.toml) into the trusted project's `.codex/config.toml` and replace `cwd` with the absolute checkout path. In this workspace the path is `/var/home/KolegaDragan/Development/Luma`. Preserve any existing settings. The project configuration directory may require a separately permitted write in managed environments.

The `luma_ui` server runs `npm run --silent mcp:ui` from that directory. Codex supports project-scoped MCP configuration for trusted projects, including an explicit working directory. See the [official Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

Restart or reload the Codex client's MCP connection after registration. A server added during a conversation may not appear in that conversation's tool catalog until the client reconnects. Use the client's MCP settings or `/mcp` where available to confirm that `luma_ui` is connected.

Once connected, ask the agent to inspect the Luma window, select an imported photograph, open the console, and take a screenshot. Use fresh accessibility snapshots to identify controls before interacting with them. The MCP connection can inspect rendered controls, screenshots, and renderer console messages; native operating-system dialogs are outside this renderer connection and need separate verification.

Do not use MCP `browser_resize` or Playwright `page.setViewportSize()` for Electron layout checks. They emulate the web viewport without resizing the native window, which can leave flickering empty areas outside the content. In direct MCP inspection, evaluate `window.resizeTo(1100, 700)` and wait for `innerWidth` and `innerHeight` to settle; verify that the OS frame also changed. Automated tests use Electron's `BrowserWindow.setContentSize(1100, 700)`. If viewport emulation was already enabled, restart the isolated development window before native resizing.

### Troubleshooting

| Symptom                                        | Check                                                                                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP cannot connect to port 9222                | Start `npm run dev:mcp`, wait for the window, and confirm no other application owns port 9222.                                                    |
| Server starts but no tools appear in Codex     | Verify the trusted project's configuration, its absolute `cwd`, and reload the client's MCP connection.                                           |
| `mcp:ui` waits without displaying an interface | This is a stdio server intended for an MCP client. Use `mcp:check` to exercise it from a terminal.                                                |
| Electron cannot open a window                  | Run from a graphical Linux session and check the reported missing display or system library. A browser-only run does not verify Electron startup. |
| First launch cannot download Electron          | Allow the required network access, then run `npm run setup:electron`. Keep the committed dependency versions.                                     |

## Platform and milestone limits

This milestone targets local Linux verification. Windows/macOS execution, manual native-picker interaction, distribution installers, and CI remain separate checks. Additional adjustments, HDR output, and native terminal execution are not implemented. Exposure, contrast, highlights, shadows, whites, blacks, shared history, and the dedicated editing MCP API are covered below.

The RAW fixture is a Sony ZV-1 12-bit compressed ARW. See [fixture provenance](../tests/fixtures/README.md). The fallback test disables embedded extraction through dependency injection while running the real LibRaw decoder. Native decoding must run with the bundled Node process, because Electron's Linux GLib exports conflict with sharp; see [runtime dependencies](runtime-dependencies.md).

Report automated checks and MCP protocol checks separately from direct Codex tool invocation. A passed MCP script does not establish that a particular Codex conversation has loaded the registered server.

## Dedicated editing MCP server

Start Luma normally with `npm start` or `npm run dev`. Run `npm run --silent mcp:editor` as a stdio MCP server; this interface does not need CDP or `dev:mcp`. It uses the installed [MCP SDK stdio transport](https://ts.sdk.modelcontextprotocol.io/server#stdio).

The server offers `luma_list_photos`, `luma_get_edits`, `luma_update_edits`, `luma_get_edit_history`, `luma_undo_edit`, `luma_redo_edit`, `luma_get_photo_statistics` and `luma_get_photo_pixel`, alongside stack, merge, task and display operations. Use photo IDs from the list operation, then read the current revision before committing a patch or navigating history. An exposure patch looks like `{ "exposureEv": 1.25 }`; contrast accepts integers from −100 to +100, for example `{ "contrast": 35 }`. Shadows, Whites, Blacks, and Highlights accept integers from −100 to +100, for example `{ "highlights": -60 }`. A combined `{ "exposureEv": 1.25, "contrast": 35, "highlights": -60, "shadows": 65, "whites": -35, "blacks": 20, "lens": { "distortion": false } }` patch makes one history entry. Lens patches use `{ "lens": { "distortion": false } }`. Revision conflicts require another read. Each update creates one entry in the same history used by the UI.

For a committed HDR pixel, call `luma_get_photo_pixel` with `{ "photoId": "<id>", "expectedRevision": 4, "x": 100, "y": 100, "domain": "working-hdr" }`. Coordinates are integer native-image positions, independent of zoom/pan; the result reports authoritative decoded/corrected dimensions. Output sampling additionally selects `target: "sdr"` or `"current"`; current requires `targetGeneration` from display state and follows SDR presentation fallback. Linear channels, alpha, relative luminance and stops are returned; stops are `null` at zero/negative luminance. Raster and legacy processing are unsupported. The `hdr-pixel` service target covers independent samples, strip/coordinate boundaries, alpha, corruption/truncation, committed revisions, target conflicts, cancellation and merged masters. Lens UI automation must expand **Lens corrections** before interacting with checkboxes, including after reload/restart; collapsing the section keeps edits and subscriptions mounted.

The application listens on an ephemeral port bound only to `127.0.0.1`. A random authentication token and port are published atomically at `<profile>/editor/connection.json`, with directory mode 0700 and file mode 0600 on Unix, and removed during shutdown. Requests with browser origins, incorrect hosts, missing authentication, or unknown operations are rejected. Only the application opens SQLite. The stdio server reads the connection file again per request, so it reconnects after a normal application restart.

For an isolated profile, launch Electron with `--user-data-dir=/absolute/test/profile` and set `LUMA_PROFILE=/absolute/test/profile` in the MCP server environment. The default profile follows Electron's Luma configuration directory. Register a server named `luma_editor` using command `npm`, arguments `["run", "--silent", "mcp:editor"]`, and this repository as its working directory. Set `LUMA_PROFILE` when using a nondefault profile. Keep `luma_ui` registered separately for development renderer inspection.

Run `npm run mcp:editor:test` to exercise the real stdio protocol against an isolated Electron profile, including shared UI Undo/Redo, conflicts, authentication, file permissions, and restart. `npm run verify -- adjustments`, `npm run verify -- mcp`, and `npm run check:full` include the editing protocol tests. Run `npm run benchmark:adjustments -- <name>` or `benchmark:all` separately from other GPU workloads; `exposure-latency.json`, `contrast-latency.json`, and `highlights-latency.json`, `shadows-latency.json`, `whites-latency.json`, and `blacks-latency.json` report warmed RAW slider presentation, targeting p95 ≤33 ms on the verified Radeon setup. Set `LUMA_PREVIEW_BASELINE` to a saved pre-change benchmark JSON to enforce the 15% uncorrected regression gate.

Adjustment coverage is shared where behavior is shared: `adjustment-input-decimal.spec.ts` and `adjustment-input-integer.spec.ts` exercise shared input gestures, cancellation, control switching, conflicts, shutdown, and minimum layout; `adjustment-wiring.spec.ts` checks each adjustment's connection to history and the preview. Curve and validation tests stay in `contrast.spec.ts`, `highlights.spec.ts`, `tonal-adjustments.spec.ts`, and `edits.spec.ts`. Curve sweeps report the first failing sample instead of thousands of separate assertions.

Transactional legacy migration, rollback, redo, and revision coverage remains distinct in `contrast-migration.spec.ts`, `highlights-migration.spec.ts`, `tonal-migration.spec.ts`, and `edit-history.spec.ts`. Shared parameterized engine and renderer tests use small synthetic/raster cases and separate representative Sony RAW cases, preserving CPU/native/WebGL agreement, neutral output, combined edits, alpha, texture reuse, and stale fallback coalescing. Lens corrections, original-byte preservation, cancellation, deletion recovery, and real embedded/decoder-fallback compatibility retain their own tests. Editing MCP still checks combined patches, draft replacement, invalid values, and revision conflicts.

## White balance and analysis verification

Choose explicit white-balance/analysis targets from the registry. Use `npm run verify -- ui adjustments preview mcp` only for a deliberate broader regression; Sony import and embedded-preview-failure targets are `import-raw` and `library-raw`. New coverage includes `white-balance.spec.ts`, `white-balance-migration.spec.ts`, `white-balance-raw.spec.ts`, `white-balance-ui.spec.ts`, `statistics.spec.ts`, comparison interaction and statistics scheduling/cancellation in the existing preview service suite.

`luma_get_photo_statistics` takes `{ "photoId": "<id>", "expectedRevision": 4 }`. Its `rgb` arrays contain exact integer counts, excluding alpha-zero pixels; the UI histogram is sampled. A stale revision returns a conflict. A new foreground preview can interrupt background statistics, in which case request them again after presentation settles. The MCP timeout accommodates full RAW generation. Combined editing patches may include `{ "whiteBalance": { "mode": "custom", "kelvin": 8000, "tint": 25 }, "highlights": -50 }`; `{ "whiteBalance": { "mode": "as-shot" } }` resets both controls in one history entry.

Capture `npm run benchmark:preview` before implementation, then set `LUMA_PREVIEW_BASELINE` to its `benchmark.json` for the post-change run. The 15% uncorrected-preview gate is unchanged. `npm run benchmark:adjustments -- temperature` measures warmed white-balance gestures with the histogram and both clipping overlays enabled, retaining the 33 ms p95 target. Keep evidence under ignored `artifacts/verification/` and report the actual hardware and platform limitations.
