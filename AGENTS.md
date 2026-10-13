# Working on Luma

## Language and scope

- Write all application UI, source code, comments, documentation, and project instructions in English.
- Read [Luma.md](Luma.md) for the product direction and [README.md](README.md) for the current milestone. The current implementation imports photographs into a persistent managed library and generates review and browsing previews.
- Keep unfinished behavior explicit. Exposure, contrast, highlights, shadows, whites, blacks, verified Sony RAW white balance, and verified lens corrections share persisted history; other light and color controls remain disabled. The console is disconnected and does not execute commands. Never reintroduce demo photographs or fabricated metadata into the application.
- Keep the interface dark, neutral, compact, keyboard-accessible, and usable at a minimum content size of 1100 × 700. Preserve independent panel scrolling and the central photograph as the main visual focus.
- Follow [input design](docs/input-design.md) for new controls. Numeric slider adjustments use the shared `AdjustmentInput` component; keep persistence and photo-wide Undo/Redo outside individual inputs.
- Follow [menu design](docs/menu-design.md) for photo commands in both workspaces. Extend the shared menu model and renderer; declare every command's target, availability, execution behavior, and tests.

## Architecture

- `src/main` owns Electron lifecycle, windows, and privileged operations. Keep context isolation and the renderer sandbox enabled, and Node integration disabled.
- `src/preload` exposes a small, typed bridge through `contextBridge`. Expose specific operations; never expose raw Electron APIs, arbitrary IPC channels, filesystem access, or a command runner to the renderer.
- `src/shared` holds contracts shared by main, preload, and renderer. The bridge exposes typed library and import-session operations plus progress events. Renderer requests refer to photo/session IDs, never arbitrary filesystem paths.
- `src/renderer` owns React components, CSS Modules, shared design tokens, library presentation and import review state. Use existing Lucide icons and avoid unnecessary routing or state libraries.
- Photo processing runs in a separate process with a bundled Node runtime, sharp, ExifTool, and LibRaw WASM. Do not load sharp into Electron: Linux GLib symbol collisions crash native decoding. Future manual controls and agent MCP access must use the same application API and edit history.
- xterm.js and its fit addon currently provide a read-only console presentation. Add native terminal execution with `node-pty` in a later milestone.
- Keep development MCP debugging bound to `127.0.0.1:9222` and enabled only through `npm run dev:mcp`. Production launches must not expose the debug endpoint.

## Verification

- Use npm and preserve `package-lock.json`. The project requires Node.js 24 or newer; Node.js 24 LTS is the recommended development version. Use `npm run setup:electron` after installation to download the runtime ahead of its automatic download on first use.
- Default to explicit feature targets: implement the affected behavior, then run `npm run verify -- --target adjustment-wiring` (replace the ID with the relevant registered target); repeat `--target` to combine selections. Target IDs and execution groups come from `scripts/verification-plan.ts`. Every new suite needs a unique target and group. Use `--plan` for artifact-free selection previews; never infer selection from the entire dirty working tree. Broad scopes (`ui`, `adjustments`, `preview`, `library`, `mcp`) remain deliberate regression selections.
- `npm run check` runs type checking, lint, formatting, and fast Node tests, targeting under 15 seconds. Fast coverage excludes Electron, RAW decoding, GPU workloads, and benchmarks. Routine target verification aims for under 60 seconds and warns when exceeded, with slow-test evidence; budgets never remove assertions or terminate tests early.
- Comprehensive checks require a user-requested or previously agreed checkpoint; finishing a feature alone never triggers one. `npm run check:full` retains all functional regressions and isolated MCP; `npm run check:all` adds every benchmark family. Run `benchmark:preview`, `benchmark:hdr`, `benchmark:merge`, or `benchmark:adjustments -- highlights` independently for purposeful performance work. `benchmark:preview` now measures preview processing/presentation only; `benchmark:all` retains every performance gate. Supply an existing saved `LUMA_PREVIEW_BASELINE` for the 15% uncorrected-preview gate. Missing baselines or required hardware are incomplete verification, not a complete checkpoint pass.
- On failure, read the relevant log excerpt and rerun the failing test first. Repeat broader coverage only when the fix affects it. Stop when relevant checks pass; full suites, benchmarks, GPU smoke checks, and manual MCP inspection are not automatic additions.
- Reserve manual renderer inspection with `npm run dev:mcp` and `luma_ui` for visual changes or unresolved UI problems. Use harness-created temporary profiles for automated launches and verify profile isolation before interaction. Never run automated imports against a user library.
- Keep screenshots, logs, and build artifacts out of version control. Each verification invocation has a unique directory under `artifacts/verification/`; preserve benchmark evidence. Routine checks and benchmarks disable tracing; use `LUMA_TEST_TRACE=1` for diagnostic reruns. Close test processes and remove temporary profiles.
- Read each invocation's compact `summary.md` first and open detailed evidence only for failures or unresolved concerns. Report selected targets/scopes, counts, duration, artifact paths, and limitations briefly. Keep successful logs, screenshots, and accessibility snapshots out of the conversation. A repository invocation lock prevents simultaneous verification builds; a second invocation reports the active run location. Groups and tests within each file remain sequential; Node, service, and ordinary Electron files use two workers, while documented desktop-sensitive files, RAW/GPU, isolated MCP, and benchmarks use one.
- Follow [docs/testing.md](docs/testing.md) for startup, MCP registration, acceptance checks, and troubleshooting. Report checks that ran, their results, and any unverified platform or client integration honestly.
- Preserve fixture licensing and attribution in `tests/fixtures`. Keep test imports and MCP automation isolated from user libraries.

## Selection and deletion

- Keep the active preview separate from the selected ID set and range anchor. Selection spans library pages and survives import updates. Await pending range selection before freezing deletion targets.
- Delete only internal managed photo bundles after confirmation, using system Trash. Never permanently delete as a fallback. Keep removal journals and recoverable bundles outside disposable staging; preserve bundles restored by the OS.
- Admit confirmed deletion and requested merges during background import through the foreground scheduler. Serialize publication and Trash mutations, and wait for an in-flight Trash call before cancelling or quitting. Use isolated Trash adapters for automated tests.

## Preview interaction

- Follow [docs/raw-processing.md](docs/raw-processing.md) for decoder, camera, and lens-provider contracts. Keep model aliases out of GPU algorithms. Verify independent correction tables, linear CPU/GPU agreement, cache variants, persisted revisions, when changing processing; apply the 15% uncorrected benchmark gate at milestones or during performance work.

- Full-preview zoom uses actual full-resolution decoded dimensions, with catalog dimensions provisional before a frame is available. 100% means one decoded image pixel per CSS pixel. Preserve the normalized center when dimensions become authoritative. Fit never enlarges beyond native size.
- Keep quick import previews separate from full-resolution RGBA frames. RAW detail must decode sensor data, never upscale an embedded JPEG. The RGBA cache is 8-bit sRGB display output; future edits must render from originals. Bump the rendering-version identifier when pixel output policy changes.
- The large preview must never display a camera JPEG, including on cache misses or errors. Use a neutral loader before the first render; a blurred placeholder must share the exact frame revision and rendering identity. Validate dimensions, byte counts, and frame hashes before displaying RGBA8 sRGB in the canvas.
- Full previews use a separate worker, one active request, and a 2 GiB LRU disk cache covering RGBA frames and matching placeholders. Keep native Dawn external to the bundle and outside Electron. Verify GPU/CPU pixel agreement and CPU fallback for GPU changes. Measure hardware computation and actual Electron presentation timings at milestones or during performance work. GPU processing retains a bounded floating-point intermediate; additional adjustments and HDR export remain separate milestones. The experimental `hdr-v1` path follows [docs/hdr-processing.md](docs/hdr-processing.md); its Float32 Rec.2020 assets remain separate from legacy SDR assets. Cancel stale work, protect active and streaming entries from eviction, and coordinate cancellation with deletion and shutdown. Preview jobs do not participate in the import/deletion task lock or quit confirmation.
- Keep zoom and pan local to the active photo ID. Reset on a different photo, preserve the view across same-photo catalog updates, and constrain pan after zoom or resize. Scope shortcuts and wheel handling to the preview so gallery, forms, menus, and console remain independent.
- Verify pointer anchoring, capture cleanup, loading/retry states, and the minimum window size with the console open when changing preview controls. Keep production filesystem access in the main process.

## Managed library

- Background imports belong to the main-process task registry. Close review after import acceptance, keep progress totals fixed, preserve the selected photo while the catalog grows, and retain cancelled/error results until dismissed. Keep the status-bar progress component reusable for tasks with known or unknown totals. Confirm close/quit while an import is active and finish cancellation cleanup before exit.
- Preserve originals byte-for-byte under the user-data library. Content hashes identify duplicates; SQLite publishes only complete imports. Keep staging recovery limited to application-owned files.
- Test the real Sony ZV-1 compressed ARW fixture through both embedded and decoder fallback paths when changing preview processing.
- `npm run verify -- mcp` and `npm run check:full` include an isolated end-to-end import through MCP. `npm run mcp:test` runs it independently; `npm run mcp:check` is reserved for intentional inspection of an already running development window.
