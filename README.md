# Irodori

_Personal photo editing_

A local desktop photo editor with an integrated agent console. The current milestone provides **photo import, a persistent local library, nondestructive exposure, contrast, highlights, shadows, whites, blacks, Saturation/Vibrance, and lens edits, shared Undo/Redo, camera-aware RAW white balance, RGB histograms, clipping overlays, Before/After comparison, MCP pixel inspection, experimental Sony RAW HDR/SDR preview, and individual/batch SDR/HDR JPEG export** in an Electron desktop workspace. The [professional editing milestone](docs/features/professional-editing.md) records the new color tools' acceptance progress and remaining phases.

The ongoing professional-editing work adds crop/straighten, eight-range HSL,
three-way grading and **Detail** controls for Luminance noise, Color noise,
Sharpening, Radius and Threshold. Detail updates the preview when a gesture is
committed and shares Undo/Redo, MCP and frozen export settings. Focused real
RAW/HDR edit/export/restart, whole-source CPU/GPU agreement, native keyboard and
minimum-size checks pass. Resource refusal/cancellation and full-size 1.25× SDR
export also pass. Strong-noise quality and remaining performance acceptance stay
open. Custom export now offers explicit Lanczos3
enlargement. Selective copy/paste and bounded batch edits share normal photo history,
conflict checks and retained task results; the clipboard clears on application restart.
Advanced curves and presets remain in Goal 2.

The **0.2.0 Bazzite milestone** adopts ordinary GPU editing feedback, exact completed-frame reuse, a dedicated catalog writer, native RAW preparation and recovery helpers, native HDR JPEG encoding, and Automatic or custom RAM/VRAM budgets. It verifies the eight enabled sliders, navigation and spatial input at the minimum Console-open, large and maximized ultrawide layouts, including actual import/export/merge contention. See the [0.2.0 release notes](CHANGELOG.md) and the [Bazzite implementation and acceptance ledger](docs/bazzite-native-engine.md) for measured scope and retained limitations. The native CPU helper uses a Rust process/protocol bridge with checked generated C++ numerical math. This release's performance acceptance is scoped to Bazzite; macOS testing and the separate whole-merge timing targets remain separate.

The full product direction, including RAW processing, persistent edits, HDR, and agent-driven editing, is described in [Irodori.md](Irodori.md).

The [rendering and full HDR roadmap](docs/features/README.md) contains planned implementation briefs, dependencies, and completion criteria for RAW brackets or HDR files → nondestructive HDR editing → HDR/SDR preview → HDR/SDR export. The bounded [Sony HDR merge and noise-stacking path](docs/merge-processing.md) remains experimental. The supplied handheld portrait pair/triple and fourteen observed Sony ZV-1A continuous BRK captures pass native Auto Align, exact reviewed-master publication and restart. These include aperture-changing, long-exposure and two-frame brackets; independent native crops verify sampled image quality. Final M4 Pro 2/3/5/9-source Sony noise measurements pass the 15-second cold publication gate. The stricter three-RAW five-second target remains unmet for both HDR and noise; [Mac workability](docs/mac-workability.md) records the unchanged gates, sharp-interaction results and remaining gaps. Controlled larger HDR brackets and 32-frame real RAW sequences remain unverified. SDR and ISO 21496-1 HDR JPEG export are implemented; ISO 21496-1 HDR JPEG reimport is supported within the bounds below; other HDR imports and export formats remain **Planned**. The [experimental Sony RAW HDR pipeline](docs/hdr-processing.md) adds HDR/SDR presentation and domain-aware analysis, with local Linux and built-in Mac Retina display evidence. Physical luminance, Windows and broader platform certification remain unverified.

An [isolated HDR display diagnostic](docs/hdr-diagnostic.md) is available with `npm run hdr:diagnostic`. It uses a temporary profile and synthetic patches; it is separate from photograph processing. Local Linux and macOS hardware canvas submissions are recorded; physical luminance remains unmeasured.

Supported Sony RAWs and merge masters use one [ACES 2 rendering pipeline](docs/display-rendering.md) after white balance and Light edits, in HDR and SDR. Capture scale stays fixed at 1, with no content-based exposure normalization. Already-rendered raster inputs remain color-managed display images. Existing RAWs adopt the current pipeline automatically; numeric history, originals and merge-master bytes remain intact. Measured camera calibration and physical display luminance remain unverified.

The [scrolling and recovery standard](docs/scrolling-design.md) covers continuous browsing in Editor Photos, Library, import review, and task errors. Mode, selection, focus, search/grouping/folds, list anchors, Console visibility, and active-photo zoom recover from committed workspace checkpoints after restart or a crash.

## Export photographs

Select photos in Editor or Library and click **Export**, or use the shared photo Actions/context menu. Export includes unloaded and filtered-out selections. With no selection it uses the active Editor or focused Library photo.

Choose a destination once; it is remembered across restarts. **Maximum quality**, **High quality** and **Smaller file** use JPEG quality 100, 90 and 80 at original size. Auto produces HDR JPEG for verified HDR RAWs, merge results and supported HDR JPEGs, and SDR JPEG for other raster inputs. Quality 100 remains lossy. **Custom…** configures output, dimensions, optional Lanczos3 enlargement, names, metadata and collision handling; **Last custom** reuses the last accepted Custom settings. Existing files are renamed or skipped and never replaced.

Background tasks retain exported/skipped/failed counts and **Show in folder**. You can continue editing or cancel; completed files remain. HDR JPEG carries a controlled SDR primary for ordinary readers and an ISO 21496-1 gain map for compatible HDR readers. ISO gain-map JPEGs reimport with HDR recognition; SDR mode retains their authored primary image. Other HDR formats and physical display brightness remain separate verification gates. See [JPEG export](docs/features/export.md) for privacy, recovery and compatibility details.

## Start developing

Use Node.js **24 or newer** and npm. Node.js **24 LTS** is the recommended development version, also recorded in `.nvmrc`. On Linux x64, prepare the [native helpers](#linux-x64-native-prerequisites) after installation and before launching development or building. Run these commands from the repository root:

```sh
npm ci
npm run dev
```

`npm ci` installs the exact versions in `package-lock.json`. Use `npm install` when intentionally adding or updating dependencies, and include the resulting lockfile changes.

The shared [camera MCP registration](.codex/config.toml) starts automatically after
trusting this checkout and refreshing Codex. Complete the per-machine
[camera prerequisites](docs/camera-control.md#one-time-prerequisites-per-machine)
first: run `npm run camera:setup` after `npm ci` on Apple Silicon macOS 14+ or
Linux x64/Bazzite. Linux USB permissions remain a host responsibility.
Camera control runs independently of Electron; it does not require `npm run dev`.

The renderer development server starts on port `5173` and automatically tries the next available port if it is occupied. Electron uses the selected port. Set `IRODORI_DEV_PORT` to choose a different starting port, for example `IRODORI_DEV_PORT=5180 npm run dev`.

`npm run dev` also enables Electron's Chrome DevTools Protocol endpoint at `http://127.0.0.1:9222` for the separate `irodori_ui` MCP server. `npm run dev:mcp` is an alias. Run one development instance at a time because the debugging port is fixed. Production launches keep debugging disabled.

Electron downloads its runtime on first use if it is not already installed. To download it explicitly after `npm ci`, run `npm run setup:electron`. Dependency installation and the first runtime download require network access; subsequent launches and photo imports work offline.

To build and launch the built application:

```sh
npm run build
npm start
```

Development and Electron test launches require a graphical session or a provisioned virtual display on Linux. Compatible automated tests use hidden windows by default; see [background testing](docs/background-testing.md). Installers, automated CI and broader platform verification remain separate work.

### Linux x64 native prerequisites

Development and production builds require the checked native CPU renderer, RAW source host and HDR encoder. `npm ci` does not create their ignored runtime directories. Supply the matching checked distributions, or build them from the pinned sources:

```sh
npm run build:cpu-native
npm run build:raw-native -- /absolute/path/LibRaw-0.22.1.tar.gz
IRODORI_CODEC_ARCHIVE_DIR=/absolute/path/to/verified-codec-archives npm run build:export-native
```

See the [CPU renderer](native/irodori-cpu-render/README.md#build-and-compare), [RAW source host](native/raw-source/README.md) and [HDR encoder](native/irodori-codec/README.md#build-and-package) for required tools, exact archive names and hashes, licenses and tool overrides. The Linux builders use pinned inputs without downloading dependencies. Native compilation alone does not establish image quality or application acceptance.

Keep each runtime's executable, checksums, build records and licenses together. The application build validates and copies the runtime directories beside its workers; missing or invalid required helpers fail the build. Preserve the matching checked merge WASM and manifest with their source as well. Installing JavaScript dependencies is insufficient to reconstruct these runtime assets.

## Import photographs

1. Click **Import**. **Files and folders** lets you choose individual photos or a folder. Folder scans include subfolders by default. **Import from device** lists mounted SD cards, USB disks, and mounted cameras, with their names, capacities, and availability. The list refreshes every three seconds while that tab is visible.
2. Photographs become selectable as they are discovered, before thumbnail or validity checks finish. All sources show the newest files first, using filesystem modification time; newly discovered photos join their sorted position while selection stays attached to each photo. Deselect photos, scroll through photos, or use Select/Deselect all while discovery continues; bulk selection also applies to later discoveries. Visible thumbnails take priority over resource-adapted lookahead. Files awaiting checks remain selectable, including when a thumbnail fails.
3. Click **Import N photos**. The review closes immediately and originals copy in the background. Keep browsing while imported photos appear in the library; your current selection stays in place.
4. The compact status-bar indicator shows resolved-file progress. Click it for the current filename, fixed photo and byte totals, copied/prepared counts, copying throughput, waiting reason, imported/duplicate/failed counts, **Skipped after deletion**, errors, and **Cancel task**. Clicking Import again during a transfer also opens these details.

Device review prefers a root-level `DCIM` folder (case insensitive), then Photos/Pictures/Images folders, and otherwise searches the mounted volume. All vendor subfolders are included. **Search entire device** restarts review across all its volumes while skipping hidden, Trash/recycle, system metadata directories, symlinks, and nested mounts. Empty photo folders offer the broader search. A confirmed disconnection invalidates review until you explicitly restart; reconnection cannot silently replace the selected device. Direct PTP/MTP transfer, mounting, and ejecting are deferred. Windows/macOS discovery adapters have fixture coverage; their hardware behavior is unverified locally.

Device review defaults to **Fast camera checks** and **Import only missing photos**. Recognized photos remain visible as **Already in library**, use managed thumbnails, and are excluded from transfer. Fast trusts a previously linked volume/path with unchanged size and timestamps, including exFAT cards after reinsertion or reader changes, and reads no recognized original contents during review or acceptance. Same-size edits with preserved timestamps can be missed. Choose **Full verification** to hash complete contents during review and again before exclusion at acceptance. Supported libraries can link previously imported originals through bounded samples without another complete card import; samples are not full-hash proof. Changing verification preserves review selection and scroll anchors. See [repeat device imports](docs/import-pipeline.md#repeat-device-imports).

Accepted imports overlap one sequential copy/hash lane with up to two preparation workers. At most four candidates and 512 MiB of reserved originals are staged; a larger supported file runs alone. Catalog and successfully published batch duplicates skip preparation. Complete metadata and browsing assets are generated from staged unique originals, then published transactionally. File identity, size, and timestamps are checked before and after copying and before resuming a paused copy; devices also revalidate volume identity and containment. A disconnected or replaced device stops further source work; validated staging may finish. The catalog includes persistent camera bindings and local sample caches; supported schema versions and migrations are described below.

One accepted import runs at a time. Local editing and renderer activity can overlap copying and preparation; publication waits for that activity to settle. Explicit processing requests, export, requested merges and confirmed deletion take priority at safe boundaries. A paused copy resumes after fresh source validation. Merge inspection, computation and publication share FIFO admission with deletion; completed idle merge reviews retain source protection while import resumes. Publication and OS Trash mutations remain exclusive. Successful deletion suppresses that content for the current import, while a later explicit import may reimport it. See [background import scheduling](docs/import-pipeline.md).

Successful import/deletion results disappear after five seconds; merge results remain until dismissed; cancelled imports and failures remain until dismissed, including when another import starts. Reloading the window reconnects to the active task. Closing or quitting during a transfer asks whether to keep importing or cancel and quit. Tasks are not resumed after the application exits.

JPEG, PNG, TIFF, and Sony ARW are supported. Sony ZV-1 12-bit compressed RAW is covered by a real camera fixture. Import review uses the RAW's embedded JPEG when available, otherwise LibRaw generates a quick SDR preview. Opening a photo also generates a full-resolution view from the internal original. RAW originals are preserved unchanged. Other camera/recording combinations require separate verification.

The application profile is named `Irodori`. The managed library is stored in Electron's user-data directory, under `library/` (normally `~/.config/Irodori/library` on Linux). It contains `catalog.sqlite`, `originals/<SHA-256>/` with original files and cached previews, and temporary `staging/` files. Imported photos survive restarts and removal of their source folder. Never edit catalog or managed files while Irodori is running.

This version uses catalog schema 21 and settings version 11. Catalogs 17–20 migrate transactionally: every current and historical edit receives the missing neutral color, crop and detail groups, including neutral Saturation/Vibrance for settings 7. Revisions, timestamps, cursors, redo branches, originals and durable masters are preserved. Other catalog/settings formats and malformed histories are rejected before migration or recovery writes. To start again with an unsupported library, close Irodori, retain the entire old library elsewhere, and reimport its originals into a fresh library. Do not delete the retained library or its managed originals. Publication journals and Trash recovery continue to work. Disposable old preview caches rebuild automatically; unsupported managed source masters remain retained and unavailable.

Cancel stops further work and preserves completed imports. Corrupt files, changed sources, unsupported formats, and write failures are shown individually. Interrupted staging files and unpublished original directories are cleaned at startup. RAW decoder inputs are limited to 512 MB; previews have a 90-second per-file timeout.

Exposure, contrast, highlights, shadows, whites, blacks, Saturation/Vibrance, eight-range mixer, three-way grading, supported white balance, crop/straighten, single-image noise reduction, detail sharpening and lens corrections share persistent edit history and Undo/Redo. Selective copy/paste and bounded batch edits use explicit setting groups and per-photo revision checks. Combined real Sony RAW, photographic raster, ISO gain-map and genuine HDR-merge edit/export/restart checks pass, as does the saved neutral-preview performance comparison. Photographic quality, full-size resources, native editing interaction and sustained responsiveness remain under verification; see [the acceptance record](docs/features/professional-editing-processing.md). Curves, named presets and final-output proof/sharpening remain planned. Broader HDR import, additional export formats and agent execution remain future milestones; metadata comes from the imported file and missing fields display a dash. The console remains read-only.

## Merge photographs

Select 2–32 compatible Sony RAWs, then choose **Actions → Merge selected photos to HDR…** or **Stack selected photos for noise reduction…**. Both actions also appear in the photo context menu. The review opens at Fit with native detail already prepared. Scroll or drag to pan a zoomed image; pinch or Ctrl-scroll to zoom around the pointer. The zoom toolbar provides Fit and 100%. With the image focused, use **+ / −**, **0**, **1**, and arrow keys; Shift pans farther. Zoom and framing survive settings and reference changes. Review alignment, reference choice, deghosting and shared-area crop, then choose **Merge**. The new editable master preserves its sources and appears through **Open result** in the task details. This is experimental; see [processing limits and verification gaps](docs/merge-processing.md).

A grouped photograph also offers **Merge K group originals to HDR…** and **Stack K group originals for noise reduction…** directly. These use the group's current originals in persisted order, including hidden or unloaded members, and exclude previous merge results. The menu shows both the full member count and original count. Groups outside the 2–32 original limit or containing known unsupported formats explain why merge is disabled; the existing review verifies camera and capture compatibility.

## Browse the Library

**Library**, with its Images icon beside **Editor**, shows every managed photograph individually, including originals in collapsed stacks and merged results. **Editor** opens the photograph editing workspace, with a compact **Photos** panel. In Library, scroll continuously, search filenames, camera, lens, format and capture dates with case-insensitive literal terms, and group by **Date**, **Month** or **Year**. Date is the default; newest recorded camera dates appear first. Invalid or missing dates appear under **Unknown date**. Merge results identify their reference date. Search updates after 200 ms; ISO text such as `2026-10` is supported.

Click a group heading to fold or expand its photos; **Collapse all groups** and **Expand all groups** make it easy to scan the dates. Folds are remembered separately for Date, Month and Year during the session, including across searches and visits to Editor. Section checkboxes select every matching photo, including folded and unloaded photos, while retaining selections elsewhere. Click selects one, Ctrl/Cmd-click toggles, Shift-click selects the inclusive search range, and Ctrl/Cmd+Shift adds it. These ranges select individuals without expanding stacks. The count includes selections outside current results; **Clear selection** clears the shared selection. Arrow keys move focus through expanded groups, Space toggles selection, and Enter or double-click opens the focused photo in Editor while retaining selection. Photo actions use the focused browser photo. Delete waits for pending selection and confirms all selected filenames before system Trash.

Search, grouping, scroll and focus survive workspace switches for the session. Grouping and catalog updates retain the first visible photo. The editor remains mounted and suspended, preserving same-photo zoom and pan. Console and background tasks remain available; a merge completed while browsing stays in Library until **Open result** opens Editor. The current catalog stores a transactional browsing index populated when originals or merged results are published; reopening does not run legacy index backfills. See [Library browsing](docs/all-photos.md).

## Select and delete photographs

The stack expansion, continuous scrolling and stack-aware ranges below apply to the Editor's Photos panel. Library browsing shows every photo individually and uses the individual ranges described above.

Photo stacks expand inline through a separate member-count button. Use **Actions → Group selected photos** for at least two ungrouped photographs. The shared menu follows the [menu design standard](docs/menu-design.md), with nonempty **Photo**, **Selection**, and **Photo group** sections plus a separate bottom **Trash** section. Headings show the focused filename, selection count, and group membership/original counts. Editor Actions uses the active photograph; Library Actions uses browser focus after pending selection resolves. **Set this photo as group cover** and **Remove this photo from group** affect that photograph. **Select entire group**, **Ungroup photos**, and **Move entire group to Trash (N photos)…** cover every current member, including hidden and unloaded members. Only Select entire group changes selection before an operation changes the library. Merge results become collapsed covers while retaining their sources and older results. Covers and members remain individually editable; hidden selections stay counted and named. Stacks and their expansion state persist across restarts. Continuous scrolling covers every visible row; Previous/Next photo navigation follows the same order.

Sony ZV-1A ARW captures in the observed continuous and continuous BRK modes group after successful import. BRK frames 1 and 2 group immediately, and frame 3 extends that group. **Actions → Group capture sequences** scans existing managed originals in a cancellable metadata-only background task, preserving manual organization. Missing or conflicting metadata and single-frame BRK presses stay available for manual grouping. The explicit scan refreshes older capture metadata; untouched automatic groups can combine while preserving their earliest group, cover and expansion. Additional cameras and recording modes remain unverified. See [stack behavior and capture acceptance](docs/photo-stacks.md).

- Click a thumbnail to select that individual photo, including when it is a stack cover. **Ctrl/Cmd-click** toggles an individual photo. **Shift-click** replaces selection with the inclusive gallery range; every cover in that range includes its entire current stack, including collapsed members and members across loaded and unloaded records. Ctrl/Cmd+Shift-click adds the resolved range. A range between expanded members includes only those members when their cover is outside the range. Hidden anchors use their cover's position; Shift-click without an anchor selects the clicked photo individually.
- Scrolling keeps your selection and preview. The library shows the selection count, including photos across loaded and unloaded records. Preview Previous/Next switches to a single selected photo.
- Press **Delete** or **Backspace** (the Mac Delete key), or choose **Move selected photo to Trash…** / **Move N selected photos to Trash…** in the bottom **Trash** section. These target selection even while the menu is open. **Move this photo to Trash…** appears when the clicked or active photograph differs from that target. **Move entire group to Trash (N photos)…** targets the full group, including previous results, without selecting its members first. Right-clicking a selected photo keeps the selection; right-clicking an unselected photo selects only that photo. Shift+F10 opens the same menu from the keyboard. Text fields, the console, open dialogs, and modifier shortcuts keep their own key handling.
- Confirm **Move to Trash** to remove Irodori’s internal copies, including originals and cached previews. Source files and SD cards stay untouched. The confirmation waits for preceding selection actions, freezes the exact targets, and shows the full count and every filename in a keyboard-scrollable list. Later stack changes cannot add targets. A failed range blocks deletion until another selection succeeds. The confirmation is titled **Move photo to Trash?** or **Move N photos to Trash?** and defaults to Cancel.
- Deletion runs in the background using the status-bar progress indicator. Cancel stops before the next photo after the current OS Trash operation finishes. Failed photos remain in the library with per-photo errors; there is no permanent-delete fallback.

A deletion journal reconciles interrupted moves on startup. Temporary removal bundles live under `library/removed/`, separately from disposable import staging. Bundles restored using the operating system are preserved there; copy their original files to a source folder and import them again to return them to Irodori. In-app Undo and Trash restoration are not implemented.

Menus hide invalid manual grouping, already-current covers, and merges outside 2–32 original ARWs. Equivalent Trash targets retain selection, and equivalent merges retain the selection command only when ordered inputs match. Applicable actions blocked by a task or source lease show one accessible explanation per reason. Arrows, Home/End, prefix typeahead, Enter/Space, Escape restoration and normal Tab traversal share one renderer. Unrelated imports refresh availability while keeping the menu open.

## Preview controls

- Scroll over the photo or merge preview to pan horizontally and vertically; **Shift + wheel** pans horizontally with a vertical wheel. Scrolling at Fit leaves the view unchanged. Pinch on a touchpad or hold **Ctrl** while scrolling to zoom around the pointer. Mouse zoom follows total wheel distance, so high-resolution fragments and coalesced events produce the same change: 120 normalized pixels zoom in by 10%, and the reverse movement undoes that step. Zooming out from a larger view stops at **Fit** and restores its resize behavior; a 2% mouse snap zone catches small high-resolution remainders. Explicit toolbar scales below Fit remain available. Pinch retains native sensitivity. These gestures apply when the preview is ready; panels and the console scroll independently. Use the [wheel recorder](docs/preview-wheel-debugging.md) to compare physical input with preview changes.
- Drag with the left mouse button to move a zoomed image; movement stops at the image edges. In both previews, dragging hides and locks the mouse cursor so panning continues beyond the window edges. Release restores the cursor immediately and adds a short, bounded glide. Escape, new input, resize or photo/edit changes stop the glide; reduced motion disables it.
- Use the compact toolbar for zoom steps, percentage presets from 10% to 3200%, and **Fit**. Double-click the preview to switch between Fit and 100%.
- With the preview focused, use **+ / −** to zoom, **0** for Fit, **1** for 100%, and **arrow keys** to pan. Hold Shift with an arrow for a larger step.
- A different photo starts in Fit. Import updates and selection changes on the same photo keep its view. Resizing the window or console recalculates Fit and preserves manual zoom where possible.

The photograph uses compact eight-pixel gutters, with its filename in the upper toolbar. One 48-pixel footer holds two lines of available camera/lens and exposure metadata on the left, navigation and zoom in the center, and resolution/loading or retry status on the right. Missing fields are omitted; when none are available it says **Metadata unavailable**. Long filenames and metadata are visually truncated and retain their full accessible text and tooltip. Derived photographs show available equipment and **Merged photo**, without exposure values. Dimensions, format and detailed metadata remain in the inspector; the resolution status describes authoritative decoded dimensions. Both side panels remain visible and scroll independently, including at 1100 × 700 with Console open.

The large preview always uses Irodori's full-resolution rendering. On first opening, a neutral loader appears until it is ready. Later openings can show a blurred, 96-pixel placeholder derived from that exact rendering while the full frame loads. Camera JPEGs remain useful in import review and the gallery, but never appear as a fallback in the large preview. Errors show **Retry**.

Sony ZV-1 and ZV-1A Bayer RAW processing uses native Dawn/WebGPU when a hardware adapter is available. LibRaw unpacks the sensor data; GPU compute passes perform AHD demosaicing, camera white balance, camera-color conversion into signed linear Rec.2020/D65. ACES 2 follows white balance and Light edits in the display stage. A floating-point linear result supports continuous exposure, contrast, highlights, shadows, whites, and blacks adjustment. Unsupported layouts and GPU failures use LibRaw's CPU renderer. Native GPU code runs only in the bundled Node worker; Electron's renderer remains sandboxed.

Raster full frames and on-demand SDR proofs are lossless **RGBA8 sRGB** at native decoded dimensions, displayed through a canvas without PNG compression or decoding. These are **8-bit SDR display images**, not editing masters. Exposure uses floating-point pixels derived from originals before display clipping. At **100%**, one decoded pixel occupies one CSS pixel; Fit never enlarges a small photo. Sony ZV-1/ZV-1A previews automatically apply verified embedded distortion, vignetting, and lateral chromatic-aberration corrections. **Lens corrections** appears below Light and Color, collapsed by default. Inspector section expansion persists across photo changes and restart, independently of each photo's edits. The histogram stays pinned above the scrolling controls; its disclosure can collapse the plot. Lens checkboxes persist independently per photo. Missing tables show a short explanation; existing imports load processing metadata without reimporting. The corrected crop has authoritative native dimensions and can be smaller than the uncorrected image. Import-review and gallery thumbnails retain their quick-preview behavior.

One foreground preview runs at a time, independently of imports. Versioned frames, matching placeholders, and prepared float assets share the **2 GiB LRU disk cache** under `library/cache/previews/`; uncompressed frames retain fewer photos than the previous PNG cache. SHA-256 checks detect damaged frame data. Active requests and streams are leased against eviction, and changing photos cancels obsolete work. A separate **256 MiB bitmap cache** keeps recently displayed frames ready for fast revisits; active bitmaps are pinned until deselected. A GPU worker stays warm for up to 30 seconds, releases photo textures when deselected, and bounds processing allocations to 1 GiB. Workers can retain bounded upstream linear data for nearby exposure, contrast, highlights, shadows, whites, blacks, and lens changes and release their process memory after the idle timeout. Old disposable cache versions rebuild automatically without reimporting originals.

Use `npm run gpu:check` to verify a real hardware computation and `npm run benchmark:preview -- --foreground` to compare CPU/RGBA fallback and the former CPU/PNG path against GPU/RGBA presentation in isolated Electron. `IRODORI_PREVIEW_BACKEND=cpu` forces the CPU renderer for troubleshooting; `IRODORI_PREVIEW_DIAGNOSTICS=1` logs backend and stage timings. Neither setting changes originals. Linux/Radeon and Mac M4 Pro have local backend evidence; [Mac workability](docs/mac-workability.md) records the remaining performance failures. Windows verification and installers remain outstanding. Native `webgpu` files must remain external to the JS bundle and be unpacked alongside the bundled Node runtime in future installers.

## Preview runtime

Preview generation runs in a separate process using a pinned, bundled Node 24 runtime. This avoids a [known Electron/GLib conflict on Linux](https://sharp.pixelplumbing.com/install/#electron-and-linux) that crashes sharp's native decoder inside Electron. No system Node executable, ExifTool installation, or online processing service is required by the running app. npm installs the optional runtime binary for the target OS and CPU; keep optional dependencies enabled.

The production build keeps processing dependencies external in `node_modules`. An installable distributable is a later milestone; packaging requirements and licenses are documented in [runtime dependencies](docs/runtime-dependencies.md).

## License and contributions

Irodori's original code and documentation are licensed under [Apache-2.0](LICENSE).
Commercial reuse and contributions are welcome under its terms. Contributions
to separately licensed files retain those files' applicable terms.

Dependencies, adapted source, and photographic fixtures retain their own
licenses and permissions. See [NOTICE](NOTICE) and the [licensing inventory](docs/licensing.md)
for attribution, fixture exceptions, and outstanding binary-distribution requirements.

## Stack and boundaries

| Layer        | Technology and responsibility                                        |
| ------------ | -------------------------------------------------------------------- |
| Desktop      | Electron; native window controls and application lifecycle           |
| Build        | electron-vite; separate main, preload, and renderer builds           |
| Interface    | React and TypeScript; CSS Modules, CSS variables, and Lucide icons   |
| Console      | xterm.js with the fit addon; read-only presentation                  |
| Verification | Playwright Electron tests and a locally pinned Playwright MCP server |

`src/main` owns privileged desktop operations. `src/preload` exposes typed library and import operations, with shared contracts in `src/shared`. Background-task snapshots and the reusable `TaskProgress` component support both measured progress and operations with unknown totals. `src/renderer` contains the library and import UI. The renderer is sandboxed, uses context isolation, and has no Node integration.

Manual exposure/contrast/highlights/shadows/whites/blacks/lens editing and the dedicated editing MCP server share the application API and history. The Playwright MCP server remains a separate development tool for testing the UI.

## Commands

| Command                                        | Purpose                                                                     |
| ---------------------------------------------- | --------------------------------------------------------------------------- |
| `npm run setup:electron`                       | Download the Electron runtime explicitly before the first launch            |
| `npm run dev`                                  | Launch Electron with live renderer updates and loopback debugging           |
| `npm run build`                                | Build main, preload, and renderer for production                            |
| `npm start`                                    | Launch the previously built application                                     |
| `npm run typecheck`                            | Check TypeScript without rewriting source                                   |
| `npm run lint`                                 | Check lint rules                                                            |
| `npm run format:check`                         | Check source and documentation formatting                                   |
| `npm run test:e2e`                             | Run functional tests quietly; defer native-only cases as incomplete         |
| `npm run check`                                | Run type checks, lint, formatting checks, and fast Node tests               |
| `npm run verify -- --target adjustment-wiring` | Cheap checks plus one explicit feature target                               |
| `npm run check:full -- --foreground`           | All functional tests and isolated MCP at an agreed checkpoint               |
| `npm run check:all -- --foreground`            | Functional tests, isolated MCP, and every benchmark family                  |
| `npm run benchmark:preview -- --foreground`    | Preview processing and Electron presentation only                           |
| `npm run benchmark:hdr -- --foreground`        | HDR edit and selection latency                                              |
| `npm run benchmark:merge -- --foreground`      | Isolated merge worker runtime, memory, and scratch measurements             |
| `npm run benchmark:export`                     | Quality-100 original-size HDR export through durable publication            |
| `npm run build:export-native`                  | Rebuild the Linux x64 or macOS arm64 HDR encoder from pinned sources        |
| `npm run build:cpu-native`                     | Build and stage the Linux x64 CPU renderer and clipping-mask helper         |
| `npm run build:raw-native -- <archive>`        | Build and stage the Linux x64 RAW host from the pinned LibRaw archive       |
| `npm run benchmark:all -- --foreground`        | Every benchmark family, including all named adjustments                     |
| `npm run dev:mcp`                              | Alias for `npm run dev`                                                     |
| `npm run mcp:ui`                               | Start the stdio Playwright MCP server for the running app                   |
| `npm run mcp:test`                             | Build and test photo import through MCP using an isolated temporary library |
| `npm run mcp:check`                            | Verify the MCP protocol, UI inspection, interaction, and screenshot capture |
| `npm run mcp:camera`                           | Start the development USB camera stdio MCP server                           |
| `npm run camera:setup`                         | Download and verify the pinned development camera runtime                   |
| `npm run camera:setup:macos`                   | macOS compatibility alias for camera:setup                                  |
| `npm run camera:build`                         | Explicit maintainer build of the platform camera runtime                    |
| `npm run camera:acceptance`                    | Discover cameras only; hardware capture requires explicit run flags         |

Use `npm run verify -- --target <id>` for routine feature verification; repeat `--target` to combine IDs from the suite registry. Broad scopes (`ui`, `adjustments`, `preview`, `library`, `mcp`) remain available for deliberate regression checks. Add `--plan` to preview selection without artifacts. Comprehensive commands require a user-requested or previously agreed checkpoint; completing a feature alone never triggers one. `benchmark:preview` deliberately covers preview measurements only; `benchmark:all` and `check:all` retain all existing performance gates. Supply a saved `IRODORI_PREVIEW_BASELINE` to enforce the 15% uncorrected-preview limit. Every invocation preserves `summary.md`, structured results, and detailed evidence in a separate ignored artifact directory. Read the compact report first. See the [verification workflow](docs/testing.md#choose-verification) for budgets, failure reruns, locking, and diagnostic tracing.

Automated Electron tests run hidden without taking native focus. Add `--foreground` explicitly for native focus, pointer lock, display checks and presentation benchmarks. A background selection with required native cases reports incomplete (exit 2) and provides foreground reruns. Normal development and manual inspection remain visible. See [background testing](docs/background-testing.md) for commands, test-author requirements and platform limits.

For step-by-step module registration, examples, and verification, see [Adding lens corrections and image processors](src/main/processing/README.md). The [RAW processing overview](docs/raw-processing.md) covers pipeline contracts and measured results.

For MCP startup, Codex registration, acceptance checks, and troubleshooting, see [docs/testing.md](docs/testing.md). Contributor instructions are in [AGENTS.md](AGENTS.md).

## Light adjustments and history

Use the Exposure slider or numeric value for −5 to +5 EV in 0.01 EV steps. Contrast uses the same slider and numeric value, from −100 to +100 in integer steps; 0 is neutral. It applies a smooth luminance curve after exposure, around fixed linear middle gray (0.18). Highlights uses integer steps from −100 to +100 after contrast: negative values compress bright tones and reveal retained detail above display white; positive values brighten them. Values at or below linear middle gray are unchanged. Shadows lifts or deepens dark detail while preserving pure black. Whites adjusts bright tones and the white endpoint; Blacks lifts or clips the black endpoint. These three controls also use integer steps from −100 to +100 with 0 as neutral, and run after Highlights in that order. Enter `0` to reset an adjustment. A drag or repeated arrow-key gesture commits one history entry on release; Escape cancels it. Photo changes and normal shutdown flush unfinished gestures. Exposure, contrast, highlights, shadows, whites, blacks, and independent lens toggles share the toolbar Undo/Redo buttons above the photograph and Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, or Ctrl+Y shortcuts. Text fields and the read-only console keep their own keyboard behavior. A new edit after Undo discards the redo branch. Edits persist across restarts and leave originals unchanged.

RAW and merge previews use WebGPU with SDR CPU fallback; raster previews use WebGL2 with Canvas2D fallback. Both use smooth reduction, nearest-pixel magnification, and a subtle pixel grid from 800%. The HDR renderer retains bounded Float32 content tiles after the fixed ACES rendition, letting pan, zoom and monitor changes reuse those pixels. GPU edits retain normal detail during interaction and coalesce pending inputs when rendering falls behind; commits retain the validated source upload. Histogram readback proceeds independently and converges to the displayed edit. See [the sampling and memory contract](docs/display-rendering.md#interactive-presentation). Merge review uses the same grid and combines its result and deghost overlay in one viewport-sized canvas, drawing wheel and pan changes once per animation frame. The main photo renderer pauses while the merge dialog is open and restores its view on close. Interactive float textures prepare after the first full-resolution frame. Exposure, contrast, highlights, shadows, whites, and blacks changes preserve zoom and pan. Gallery and import-review thumbnails keep their quick-preview behavior.

Agents can use the dedicated `npm run --silent mcp:editor` stdio server with a normally running application. It shares the application's edit service and history and requires expected revisions to prevent overwriting concurrent edits. See [editing MCP setup and tests](docs/testing.md#dedicated-editing-mcp-server). The console itself still does not execute commands.

A separate development-only `irodori_camera` server controls USB cameras without
Electron or a photo library. The tracked `.codex/config.toml` registers it portably
through `npm run --silent mcp:camera` from the checkout or its subdirectories.
Reuse suitable fixtures first; agents may take needed bounded captures once the
camera and scene are ready, asking for missing information or physical setup.
Sony ZV-1A settings, RAW/JPEG capture, three
separate software exposures and restoration have macOS MCP evidence through
ImageCaptureCore. Linux uses the pinned repository-managed gphoto2 runtime;
physical Bazzite acceptance remains
pending and Windows camera support is unavailable. See
[camera setup, complete recipes, recovery and evidence](docs/camera-control.md).

Use **Crop photo** in the toolbar, or **Crop → Crop and straighten** in the inspector.
Drag the uncropped source frame/corners, or set native-pixel center/size, aspect ratio,
quarter turns and Straighten. Angle, size and aspect changes fit the shown draft inside
the photograph. Apply crop creates one history entry and shows the leveled result;
Cancel crop restores the committed framing and previous zoom/pan. Arrow keys move a
focused handle by one native pixel, or ten with Shift. Other adjustments and photo-wide
history pause during framing. UI and MCP validate actual prepared dimensions, preserve
originals and freeze crop geometry in exports. Crop has focused small-PNG/component
evidence; real RAW/HDR, native visual/input and performance acceptance remain pending.
See [crop status and bounds](docs/features/crop-straighten.md).

The **Color Mixer** inspector offers red, orange, yellow, green, aqua, blue, purple
and magenta ranges, each with Hue/Saturation/Luminance. **Color Grading** offers
Shadows/Midtones/Highlights with a shared wheel and numeric controls, plus Blending
and Balance. Wheel arrows change hue or saturation; Shift uses larger steps and
Escape cancels. Section resets and gestures use the same photo-wide Undo/Redo as
Light. Selected ranges/tones and disclosures persist as workspace preferences.
Agents can read `irodori_get_edit_capabilities` and apply partial range/tone patches
with `irodori_update_edits`. These tools have focused independent processing,
small-raster export and hidden UI/MCP evidence; real-photo HDR, native visual/input
and performance acceptance remains pending. See the
[processing and adoption record](docs/features/color-mixer-grading-processing.md).

## Histogram, comparison, and RAW white balance

The collapsible, 112-pixel histogram describes fixed Rec.2020 HDR content for RAWs and merge masters, including in SDR preview and CPU fallback. Raster photographs retain their displayed SDR histogram. HDR adds an equal-width logarithmic extension through +4 stops; monitor changes move only the capability marker and warnings. GPU analysis uses 8,192 stable photo-wide samples while dragging and 65,536 after release. Zoom and pan do not change its bins. Hover the plot or focus it and use arrow keys, Home or End for numerical screen-reader descriptions. The visible panel keeps the plot, HDR ranges and clipping controls, with compact preparation/failure status when needed. Detailed numerical statistics remain available through MCP.

For HDR photographs, the histogram's **Show HDR ranges** eye button colors fixed content luminance before presentation: cyan through +1 stop, blue through +2, purple through +3, and magenta above +3. Red stripes take precedence above reported display headroom; unknown headroom remains unavailable. The ranges remain available in SDR preview and never change histogram statistics. The toggle starts off, resets on another photograph or restart, and creates no edits. Switching it off restores selected warning overlays.

Shadow clipping means all display channels reach 0; highlight clipping means any display channel reaches 255. Hover a clipping indicator to preview its overlay, or click to toggle it. Blue marks shadows and red marks highlights. These SDR endpoints do not establish loss of RAW sensor data. Focus the preview and press **J** to toggle both overlays.

Use **Before** or `\` for the neutral image, and the comparison button or **Y** for a vertical split. Drag the divider or focus it and use arrow keys, Home, or End. Before retains the current lens corrections and framing, with neutral light controls and As Shot white balance. Split overlays and its histogram describe After. Comparison, split position, and overlays are transient and reset on a different photo; starting an edit in full Before returns to After.

For verified Sony ZV-1/ZV-1A RAW profiles, Color offers Temperature (2000–25000 K, 50 K steps), Tint (−100…+100, positive toward magenta), and **As Shot**. As Shot preserves the original gains exactly; its Kelvin and Tint readouts are estimates. Editing either value selects Custom. As Shot restores both in one undoable edit. Raster images and unsupported cameras keep normal viewing with these controls unavailable. The Neutral white balance picker samples an evenly lit neutral midtone from a supported single RAW capture before creative edits. Choose a 7, 15 or 31 pixel area, click the photo or enter Sample X/Y percentages, inspect the proposal and click Apply white balance. Sampling is read-only; Apply creates one combined Temperature/Tint history entry. Escape or Cancel picker leaves edits unchanged. Invalid dark, clipped, uneven or unsupported areas cannot be applied. Actual Sony/photo and native visual acceptance are still pending; see the [picker brief](docs/features/white-balance-picker.md). Automatic balance, other presets and additional cameras remain future work.

MCP `irodori_get_photo_statistics` accepts `photoId` and `expectedRevision` and returns exact committed RGB bins, visible-pixel and clipping counts, revision, rendering identity and SDR sRGB information. White balance patches are atomic, for example `{ "whiteBalance": { "mode": "custom", "kelvin": 6500, "tint": 20 }, "exposureEv": 0.5 }`, or `{ "whiteBalance": { "mode": "as-shot" } }`. All edits share history.

MCP `irodori_get_photo_pixel` samples committed HDR edits, including merged masters, at integer native-image `x`/`y` coordinates. Supply `photoId`, `expectedRevision` and `domain` (`working-hdr`, `content-hdr` or `output`); output uses `target: "sdr"` or `"current"`, with the current `targetGeneration` from display state. It returns authoritative dimensions, revision/source identity, linear RGB, straight alpha, relative luminance and stops above reference white (`null` at nonpositive luminance). Unsupported processing and stale requests fail. Pixel readouts are available through this API; the preview has no inspection button or Alt-hover gesture.

New imports of verified Sony RAW modes now use experimental HDR processing with Auto/HDR/SDR workspace preferences. Click the presentation badge for the actual frame color space and precision, current monitor, headroom, adapter and fallback explanation. The compact SDR fallback badge keeps fallback visible without expanding the toolbar; loading or failed frames do not claim a presented color space. HDR working assets can display directly without waiting for an SDR proof; edits and display-mode changes reuse that source. ACES 2 renders fixed Rec.2020/D65 content using the official 1000-nit preset and a 100-nit reference (10×, approximately +3.32 stops). HDR presentation converts to supported P3/sRGB canvas primaries and clamps representational limits to active headroom. SDR preview and CPU fallback render the direct SDR ACES rendition from working pixels. These are software rendering parameters, not measured screen luminance. Existing RAWs and merge masters use this default automatically; raster images bypass scene rendering. The inspector presents a monitor-independent HDR content histogram. Working HDR, Content HDR and Output analysis remain available through MCP; content luminance above reported headroom, canvas channel clipping, gamut limitation and sensor saturation have separate meanings. Output statistics and pixel inspection follow the actual presentation mapping. See [the processing contract and verification gates](docs/hdr-processing.md).
