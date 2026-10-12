# Luma

A local desktop photo editor with an integrated agent console. The current milestone provides **photo import, a persistent local library, nondestructive exposure, contrast, highlights, shadows, whites, blacks, and lens edits, shared Undo/Redo, camera-aware RAW white balance, RGB histograms, clipping overlays, Before/After comparison, MCP pixel inspection, and experimental Sony RAW HDR/SDR preview** in an Electron desktop workspace.

The full product direction, including RAW processing, persistent edits, HDR, and agent-driven editing, is described in [Luma.md](Luma.md).

The [rendering and full HDR roadmap](docs/features/README.md) contains planned implementation briefs, dependencies, and completion criteria for RAW brackets or HDR files → nondestructive HDR editing → HDR/SDR preview → HDR/SDR export. The bounded [Sony HDR merge and noise-stacking path](docs/merge-processing.md) remains experimental. The supplied handheld portrait pair/triple and fourteen observed Sony ZV-1A continuous BRK captures pass native Auto Align, exact reviewed-master publication and restart. These include aperture-changing, long-exposure and two-frame brackets; independent native crops verify sampled image quality. Local 2/3/5/9-frame Sony noise stacks pass the 15-second cold publication gate. Controlled larger HDR brackets and 32-frame real RAW sequences remain unverified. HDR file import and export remain **Planned**. The [experimental Sony RAW HDR pipeline](docs/hdr-processing.md) adds HDR/SDR presentation and domain-aware analysis, with local Linux and built-in Mac Retina display evidence. Physical luminance, Windows and broader platform certification remain unverified.

An [isolated HDR display diagnostic](docs/hdr-diagnostic.md) is available with `npm run hdr:diagnostic`. It uses a temporary profile and synthetic patches; it is separate from photograph processing. Local Linux and macOS hardware canvas submissions are recorded; physical luminance remains unmeasured.

Supported Sony RAWs and merge masters use one [ACES 2 rendering pipeline](docs/display-rendering.md) after white balance and Light edits, in HDR and SDR. Capture scale stays fixed at 1, with no content-based exposure normalization. Already-rendered raster inputs remain color-managed display images. Existing RAWs adopt the current pipeline automatically; numeric history, originals and merge-master bytes remain intact. Measured camera calibration and physical display luminance remain unverified.

## Start developing

Use Node.js **24 or newer** and npm. Node.js **24 LTS** is the recommended development version, also recorded in `.nvmrc`. Run these commands from the repository root:

```sh
npm ci
npm run dev
```

`npm ci` installs the exact versions in `package-lock.json`. Use `npm install` when intentionally adding or updating dependencies, and include the resulting lockfile changes.

Electron downloads its runtime on first use if it is not already installed. To download it explicitly after `npm ci`, run `npm run setup:electron`. Dependency installation and the first runtime download require network access; subsequent launches and photo imports work offline.

To build and launch the built application:

```sh
npm run build
npm start
```

Development and test launches require a graphical desktop session on Linux. Installers, automated CI, and Windows/macOS verification are deferred to a later milestone.

## Import photographs

1. Click **Import**. **Files and folders** lets you choose individual photos or a folder. Folder scans include subfolders by default. **Import from device** lists mounted SD cards, USB disks, and mounted cameras, with their names, capacities, and availability. The list refreshes every three seconds while that tab is visible.
2. Photographs become selectable as they are discovered, before thumbnail or validity checks finish. All sources show the newest files first, using filesystem modification time; newly discovered photos join their sorted position while selection stays attached to each photo. Deselect photos, change pages, or use Select/Deselect all while discovery continues; bulk selection also applies to later discoveries. Only visible thumbnails are requested. Files awaiting checks remain selectable, including when a thumbnail fails.
3. Click **Import N photos**. The review closes immediately and originals copy in the background. Keep browsing while imported photos appear in the library; your current selection stays in place.
4. The compact status-bar indicator shows resolved-file progress. Click it for the current filename, fixed photo and byte totals, copied/prepared counts, copying throughput, waiting reason, imported/duplicate/failed counts, **Skipped after deletion**, errors, and **Cancel task**. Clicking Import again during a transfer also opens these details.

Device review prefers a root-level `DCIM` folder (case insensitive), then Photos/Pictures/Images folders, and otherwise searches the mounted volume. All vendor subfolders are included. **Search entire device** restarts review across all its volumes while skipping hidden, Trash/recycle, system metadata directories, symlinks, and nested mounts. Empty photo folders offer the broader search. A confirmed disconnection invalidates review until you explicitly restart; reconnection cannot silently replace the selected device. Direct PTP/MTP transfer, mounting, and ejecting are deferred. Windows/macOS discovery adapters have fixture coverage; their hardware behavior is unverified locally.

Device review defaults to **Fast camera checks** and **Import only missing photos**. Recognized photos remain visible as **Already in library**, use managed thumbnails, and are excluded from transfer. Fast trusts a previously linked volume/path with unchanged size and timestamps, including exFAT cards after reinsertion or reader changes, and reads no recognized original contents during review or acceptance. Same-size edits with preserved timestamps can be missed. Choose **Full verification** to hash complete contents during review and again before exclusion at acceptance. Older libraries can link unchanged originals through bounded samples without another complete card import; samples are not full-hash proof. Changing verification preserves review selection and pages. See [repeat device imports](docs/import-pipeline.md#repeat-device-imports).

Accepted imports overlap one sequential copy/hash lane with up to two preparation workers. At most four candidates and 512 MiB of reserved originals are staged; a larger supported file runs alone. Catalog and successfully published batch duplicates skip preparation. Complete metadata and browsing assets are generated from staged unique originals, then published transactionally. File identity, size, and timestamps are checked before and after copying and before resuming a paused copy; devices also revalidate volume identity and containment. A disconnected or replaced device stops further source work; validated staging may finish. Catalog version 14 preserves existing records and adds persistent camera bindings and local sample caches without changing existing photos, edits or rendering.

One accepted import runs at a time. Active editing, preview rendering and visible analysis take priority; requested merges and confirmed deletion run ahead of background import. Copying pauses at chunk boundaries and resumes automatically when foreground work becomes idle. Merge inspection, computation and publication share FIFO admission with deletion; completed idle merge reviews retain source protection while import resumes. Publication and OS Trash mutations remain exclusive. Successful deletion suppresses that content for the current import, while a later explicit import may reimport it. See [background import scheduling](docs/import-pipeline.md).

Successful import/deletion results disappear after five seconds; merge results remain until dismissed; cancelled imports and failures remain until dismissed, including when another import starts. Reloading the window reconnects to the active task. Closing or quitting during a transfer asks whether to keep importing or cancel and quit. Tasks are not resumed after the application exits.

JPEG, PNG, TIFF, and Sony ARW are supported. Sony ZV-1 12-bit compressed RAW is covered by a real camera fixture. Import review uses the RAW's embedded JPEG when available, otherwise LibRaw generates a quick SDR preview. Opening a photo also generates a full-resolution view from the internal original. RAW originals are preserved unchanged. Other camera/recording combinations require separate verification.

The managed library is stored in Electron's user-data directory, under `library/` (normally `~/.config/Luma/library` on Linux). It contains `catalog.sqlite`, `originals/<SHA-256>/` with original files and cached previews, and temporary `staging/` files. Imported photos survive restarts and removal of their source folder. Never edit catalog or managed files while Luma is running.

Cancel stops further work and preserves completed imports. Corrupt files, changed sources, unsupported formats, and write failures are shown individually. Interrupted staging files and unpublished original directories are cleaned at startup. RAW decoder inputs are limited to 512 MB; previews have a 90-second per-file timeout.

Exposure, contrast, highlights, shadows, whites, blacks, and lens corrections share persistent edit history and Undo/Redo. Export, crop, additional light/color adjustments, HDR export, and agent execution remain future milestones; metadata comes from the imported file and missing fields display a dash. The console remains read-only.

## Merge photographs

Select 2–32 compatible Sony RAWs, then choose **Actions → Merge to HDR…** or **Stack for noise reduction…**. Both actions also appear in the photo context menu. The review opens at Fit with native detail already prepared. Scroll or drag to pan a zoomed image; pinch or Ctrl-scroll to zoom around the pointer. The zoom toolbar provides Fit and 100%. With the image focused, use **+ / −**, **0**, **1**, and arrow keys; Shift pans farther. Zoom and framing survive settings and reference changes. Review alignment, reference choice, deghosting and shared-area crop, then choose **Merge**. The new editable master preserves its sources and appears through **Open result** in the task details. This is experimental; see [processing limits and verification gaps](docs/merge-processing.md).

A grouped photograph also offers **Merge K group originals to HDR…** and **Stack K group originals for noise reduction…** directly. These use the group's current originals in persisted order, including hidden or paginated members, and exclude previous merge results. The menu shows both the full member count and original count. Groups outside the 2–32 original limit or containing known unsupported formats explain why merge is disabled; the existing review verifies camera and capture compatibility.

## Select and delete photographs

Photo stacks expand inline through a separate member-count button. Use **Actions → Group selected photos** for at least two ungrouped photographs. The shared menu labels **Photo**, **Selected photos (N)**, and **Group (N photos)** actions; Actions uses the active photograph's group. **Set this photo as group cover** and **Remove this photo from group** affect that photograph. **Select group (N photos)**, **Ungroup (N photos)**, and **Delete group (N photos)…** cover every current member, including hidden and paginated members. Only Select group changes selection before an operation changes the library. Merge results become collapsed covers while retaining their sources and older results. Covers and members remain individually editable; hidden selections stay counted and named. Stacks and their expansion state persist across restarts. Pages and Previous/Next follow 60 visible photo rows.

Sony ZV-1A ARW captures in the observed continuous and continuous BRK modes group after successful import. BRK frames 1 and 2 group immediately, and frame 3 extends that group. **Actions → Group capture sequences…** scans existing managed originals in a cancellable metadata-only background task, preserving manual organization. Missing or conflicting metadata and single-frame BRK presses stay available for manual grouping. The explicit scan refreshes older capture metadata; untouched automatic groups can combine while preserving their earliest group, cover and expansion. Additional cameras and recording modes remain unverified. See [stack behavior and capture acceptance](docs/photo-stacks.md).

- Click a thumbnail to select that individual photo, including when it is a stack cover. **Ctrl/Cmd-click** toggles an individual photo. **Shift-click** replaces selection with the inclusive gallery range; every cover in that range includes its entire current stack, including collapsed members and members on other pages. Ctrl/Cmd+Shift-click adds the resolved range. A range between expanded members includes only those members when their cover is outside the range. Hidden anchors use their cover's position; Shift-click without an anchor selects the clicked photo individually.
- Paging keeps your selection and preview. The library shows the selection count, including photos on other pages. Preview Previous/Next switches to a single selected photo.
- Press **Delete** or **Backspace** (the Mac Delete key), or choose Delete in the **Selected photos** section. These target selection even while the menu is open. **Delete this photo…** appears when the clicked or active photograph differs from that target. **Delete group (N photos)…** targets the full group, including previous results, without selecting its members first. Right-clicking a selected photo keeps the selection; right-clicking an unselected photo selects only that photo. Shift+F10 opens the same menu from the keyboard. Text fields, the console, open dialogs, and modifier shortcuts keep their own key handling.
- Confirm **Move to Trash** to remove Luma’s internal copies, including originals and cached previews. Source files and SD cards stay untouched. The confirmation waits for preceding selection actions, freezes the exact targets, and shows the full count and every filename in a keyboard-scrollable list. Later stack changes cannot add targets. A failed range blocks deletion until another selection succeeds. The confirmation defaults to Cancel.
- Deletion runs in the background using the status-bar progress indicator. Cancel stops before the next photo after the current OS Trash operation finishes. Failed photos remain in the library with per-photo errors; there is no permanent-delete fallback.

A deletion journal reconciles interrupted moves on startup. Temporary removal bundles live under `library/removed/`, separately from disposable import staging. Bundles restored using the operating system are preserved there; copy their original files to a source folder and import them again to return them to Luma. In-app Undo and Trash restoration are not implemented.

## Preview controls

- Scroll over the photo or merge preview to pan horizontally and vertically; **Shift + wheel** pans horizontally with a vertical wheel. Scrolling at Fit leaves the view unchanged. Pinch on a touchpad or hold **Ctrl** while scrolling to zoom around the pointer; Ctrl-wheel uses gentler increments and pinch retains native sensitivity. These gestures apply when the preview is ready; panels and the console scroll independently.
- Drag with the left mouse button to move a zoomed image; movement stops at the image edges. In both previews, dragging hides and locks the mouse cursor so panning continues beyond the window edges. Release restores the cursor immediately and adds a short, bounded glide. Escape, new input, resize or photo/edit changes stop the glide; reduced motion disables it.
- Use the compact toolbar for zoom steps, percentage presets from 10% to 3200%, and **Fit**. Double-click the preview to switch between Fit and 100%.
- With the preview focused, use **+ / −** to zoom, **0** for Fit, **1** for 100%, and **arrow keys** to pan. Hold Shift with an arrow for a larger step.
- A different photo starts in Fit. Import updates and selection changes on the same photo keep its view. Resizing the window or console recalculates Fit and preserves manual zoom where possible.

Two compact lines above the navigation/zoom toolbar show available camera and lens names, then shutter speed, aperture and ISO. Missing fields are omitted; when none are available the strip says **Metadata unavailable**. Long equipment names are visually truncated and retain their full accessible text and tooltip. Derived photographs show available equipment and **Merged photo**, without exposure values. The detailed Metadata section remains in the inspector.

The large preview always uses Luma's full-resolution rendering. On first opening, a neutral loader appears until it is ready. Later openings can show a blurred, 96-pixel placeholder derived from that exact rendering while the full frame loads. Camera JPEGs remain useful in import review and the gallery, but never appear as a fallback in the large preview. Errors show **Retry**.

Sony ZV-1 and ZV-1A Bayer RAW processing uses native Dawn/WebGPU when a hardware adapter is available. LibRaw unpacks the sensor data; GPU compute passes perform AHD demosaicing, camera white balance, camera-color conversion into signed linear Rec.2020/D65. ACES 2 follows white balance and Light edits in the display stage. A floating-point linear result supports continuous exposure, contrast, highlights, shadows, whites, and blacks adjustment. Unsupported layouts and GPU failures use LibRaw's CPU renderer. Native GPU code runs only in the bundled Node worker; Electron's renderer remains sandboxed.

Raster full frames and on-demand SDR proofs are lossless **RGBA8 sRGB** at native decoded dimensions, displayed through a canvas without PNG compression or decoding. These are **8-bit SDR display images**, not editing masters. Exposure uses floating-point pixels derived from originals before display clipping. At **100%**, one decoded pixel occupies one CSS pixel; Fit never enlarges a small photo. Sony ZV-1/ZV-1A previews automatically apply verified embedded distortion, vignetting, and lateral chromatic-aberration corrections. **Lens corrections** appears below Light and Color, collapsed by default. Its expansion lasts across photo changes for the current session and resets on reload/restart; the checkboxes persist independently per photo. Missing tables show a short explanation; existing imports load processing metadata without reimporting. The corrected crop has authoritative native dimensions and can be smaller than the uncorrected image. Import-review and gallery thumbnails retain their quick-preview behavior.

One foreground preview runs at a time, independently of imports. Versioned frames, matching placeholders, and prepared float assets share the **2 GiB LRU disk cache** under `library/cache/previews/`; uncompressed frames retain fewer photos than the previous PNG cache. SHA-256 checks detect damaged frame data. Active requests and streams are leased against eviction, and changing photos cancels obsolete work. A separate **256 MiB bitmap cache** keeps recently displayed frames ready for fast revisits; active bitmaps are pinned until deselected. A GPU worker stays warm for up to 30 seconds, releases photo textures when deselected, and bounds processing allocations to 1 GiB. Workers can retain bounded upstream linear data for nearby exposure, contrast, highlights, shadows, whites, blacks, and lens changes and release their process memory after the idle timeout. Old disposable cache versions rebuild automatically without reimporting originals.

Use `npm run gpu:check` to verify a real hardware computation and `npm run benchmark:preview` to compare CPU/RGBA fallback and the former CPU/PNG path against GPU/RGBA presentation in isolated Electron. `LUMA_PREVIEW_BACKEND=cpu` forces the CPU renderer for troubleshooting; `LUMA_PREVIEW_DIAGNOSTICS=1` logs backend and stage timings. Neither setting changes originals. Linux/Radeon is tested locally; Windows/macOS backend verification and installers remain outstanding. Native `webgpu` files must remain external to the JS bundle and be unpacked alongside the bundled Node runtime in future installers.

## Preview runtime

Preview generation runs in a separate process using a pinned, bundled Node 24 runtime. This avoids a [known Electron/GLib conflict on Linux](https://sharp.pixelplumbing.com/install/#electron-and-linux) that crashes sharp's native decoder inside Electron. No system Node executable, ExifTool installation, or online processing service is required by the running app. npm installs the optional runtime binary for the target OS and CPU; keep optional dependencies enabled.

The production build keeps processing dependencies external in `node_modules`. An installable distributable is a later milestone; packaging requirements and licenses are documented in [runtime dependencies](docs/runtime-dependencies.md).

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
| `npm run dev`                                  | Launch Electron with live renderer updates                                  |
| `npm run build`                                | Build main, preload, and renderer for production                            |
| `npm start`                                    | Launch the previously built application                                     |
| `npm run typecheck`                            | Check TypeScript without rewriting source                                   |
| `npm run lint`                                 | Check lint rules                                                            |
| `npm run format:check`                         | Check source and documentation formatting                                   |
| `npm run test:e2e`                             | Run the real Electron smoke and interaction tests                           |
| `npm run check`                                | Run type checks, lint, formatting checks, and fast Node tests               |
| `npm run verify -- --target adjustment-wiring` | Cheap checks plus one explicit feature target                               |
| `npm run check:full`                           | All functional tests and isolated MCP at an agreed checkpoint               |
| `npm run check:all`                            | Functional tests, isolated MCP, and every benchmark family                  |
| `npm run benchmark:preview`                    | Preview processing and Electron presentation only                           |
| `npm run benchmark:hdr`                        | HDR edit and selection latency                                              |
| `npm run benchmark:merge`                      | Isolated merge worker runtime, memory, and scratch measurements             |
| `npm run benchmark:all`                        | Every benchmark family, including all named adjustments                     |
| `npm run dev:mcp`                              | Launch development Electron with local debugging enabled                    |
| `npm run mcp:ui`                               | Start the stdio Playwright MCP server for the running app                   |
| `npm run mcp:test`                             | Build and test photo import through MCP using an isolated temporary library |
| `npm run mcp:check`                            | Verify the MCP protocol, UI inspection, interaction, and screenshot capture |

Use `npm run verify -- --target <id>` for routine feature verification; repeat `--target` to combine IDs from the suite registry. Broad scopes (`ui`, `adjustments`, `preview`, `library`, `mcp`) remain available for deliberate regression checks. Add `--plan` to preview selection without artifacts. Comprehensive commands require a user-requested or previously agreed checkpoint; completing a feature alone never triggers one. `benchmark:preview` deliberately covers preview measurements only; `benchmark:all` and `check:all` retain all existing performance gates. Supply a saved `LUMA_PREVIEW_BASELINE` to enforce the 15% uncorrected-preview limit. Every invocation preserves `summary.md`, structured results, and detailed evidence in a separate ignored artifact directory. Read the compact report first. See the [verification workflow](docs/testing.md#choose-verification) for budgets, failure reruns, locking, and diagnostic tracing.

For step-by-step module registration, examples, and verification, see [Adding lens corrections and image processors](src/main/processing/README.md). The [RAW processing overview](docs/raw-processing.md) covers pipeline contracts and measured results.

For MCP startup, Codex registration, acceptance checks, and troubleshooting, see [docs/testing.md](docs/testing.md). Contributor instructions are in [AGENTS.md](AGENTS.md).

## Light adjustments and history

Use the Exposure slider or numeric value for −5 to +5 EV in 0.01 EV steps. Contrast uses the same slider and numeric value, from −100 to +100 in integer steps; 0 is neutral. It applies a smooth luminance curve after exposure, around fixed linear middle gray (0.18). Highlights uses integer steps from −100 to +100 after contrast: negative values compress bright tones and reveal retained detail above display white; positive values brighten them. Values at or below linear middle gray are unchanged. Shadows lifts or deepens dark detail while preserving pure black. Whites adjusts bright tones and the white endpoint; Blacks lifts or clips the black endpoint. These three controls also use integer steps from −100 to +100 with 0 as neutral, and run after Highlights in that order. Enter `0` to reset an adjustment. A drag or repeated arrow-key gesture commits one history entry on release; Escape cancels it. Photo changes and normal shutdown flush unfinished gestures. Exposure, contrast, highlights, shadows, whites, blacks, and independent lens toggles share the toolbar Undo/Redo buttons above the photograph and Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, or Ctrl+Y shortcuts. Text fields and the read-only console keep their own keyboard behavior. A new edit after Undo discards the redo branch. Edits persist across restarts and leave originals unchanged.

RAW and merge previews use WebGPU with SDR CPU fallback; raster previews use WebGL2 with Canvas2D fallback. Both use smooth reduction, nearest-pixel magnification, and a subtle pixel grid from 800%. The HDR renderer retains bounded Float32 content tiles after the fixed ACES rendition, letting pan, zoom and monitor changes reuse those pixels. Edits use adaptive drafts and restore normal detail on release; commits retain the validated source upload. See [the sampling and memory contract](docs/display-rendering.md#interactive-presentation). Merge review uses the same grid and combines its result and deghost overlay in one viewport-sized canvas, drawing wheel and pan changes once per animation frame. The main photo renderer pauses while the merge dialog is open and restores its view on close. Interactive float textures prepare after the first full-resolution frame. Exposure, contrast, highlights, shadows, whites, and blacks changes preserve zoom and pan. Gallery and import-review thumbnails keep their quick-preview behavior.

Agents can use the dedicated `npm run --silent mcp:editor` stdio server with a normally running application. It shares the application's edit service and history and requires expected revisions to prevent overwriting concurrent edits. See [editing MCP setup and tests](docs/testing.md#dedicated-editing-mcp-server). The console itself still does not execute commands.

## Histogram, comparison, and RAW white balance

The collapsible, 112-pixel histogram describes fixed Rec.2020 HDR content for RAWs and merge masters, including in SDR preview and CPU fallback. Raster photographs retain their displayed SDR histogram. HDR adds an equal-width logarithmic extension through +4 stops; monitor changes move only the capability marker and warnings. GPU analysis uses 8,192 stable photo-wide samples while dragging and 65,536 after release. Zoom and pan do not change its bins. Hover the plot or focus it and use arrow keys, Home or End for numerical screen-reader descriptions. The visible panel keeps the plot, HDR ranges and clipping controls, with compact preparation/failure status when needed. Detailed numerical statistics remain available through MCP.

For HDR photographs, the histogram's **Show HDR ranges** eye button colors fixed content luminance before presentation: cyan through +1 stop, blue through +2, purple through +3, and magenta above +3. Red stripes take precedence above reported display headroom; unknown headroom remains unavailable. The ranges remain available in SDR preview and never change histogram statistics. The toggle starts off, resets on another photograph or restart, and creates no edits. Switching it off restores selected warning overlays.

Shadow clipping means all display channels reach 0; highlight clipping means any display channel reaches 255. Hover a clipping indicator to preview its overlay, or click to toggle it. Blue marks shadows and red marks highlights. These SDR endpoints do not establish loss of RAW sensor data. Focus the preview and press **J** to toggle both overlays.

Use **Before** or `\` for the neutral image, and the comparison button or **Y** for a vertical split. Drag the divider or focus it and use arrow keys, Home, or End. Before retains the current lens corrections and framing, with neutral light controls and As Shot white balance. Split overlays and its histogram describe After. Comparison, split position, and overlays are transient and reset on a different photo; starting an edit in full Before returns to After.

For verified Sony ZV-1/ZV-1A RAW profiles, Color offers Temperature (2000–25000 K, 50 K steps), Tint (−100…+100, positive toward magenta), and **As Shot**. As Shot preserves the original gains exactly; its Kelvin and Tint readouts are estimates. Editing either value selects Custom. As Shot restores both in one undoable edit. Raster images and unsupported cameras keep normal viewing with these controls unavailable. Automatic balance, eyedropper, other presets and additional cameras remain future work.

MCP `luma_get_photo_statistics` accepts `photoId` and `expectedRevision` and returns exact committed RGB bins, visible-pixel and clipping counts, revision, rendering identity and SDR sRGB information. White balance patches are atomic, for example `{ "whiteBalance": { "mode": "custom", "kelvin": 6500, "tint": 20 }, "exposureEv": 0.5 }`, or `{ "whiteBalance": { "mode": "as-shot" } }`. All edits share history.

MCP `luma_get_photo_pixel` samples committed HDR edits, including merged masters, at integer native-image `x`/`y` coordinates. Supply `photoId`, `expectedRevision` and `domain` (`working-hdr`, `content-hdr` or `output`); output uses `target: "sdr"` or `"current"`, with the current `targetGeneration` from display state. It returns authoritative dimensions, revision/source identity, linear RGB, straight alpha, relative luminance and stops above reference white (`null` at nonpositive luminance). Unsupported processing and stale requests fail. Pixel readouts are available through this API; the preview has no inspection button or Alt-hover gesture.

New imports of verified Sony RAW modes now use experimental HDR processing with Auto/HDR/SDR workspace preferences. Click the presentation badge for the current monitor, headroom, adapter and fallback explanation. HDR working assets can display directly without waiting for an SDR proof; edits and display-mode changes reuse that source. ACES 2 renders fixed Rec.2020/D65 content using the official 1000-nit preset and a 100-nit reference (10×, approximately +3.32 stops). HDR presentation converts to supported P3/sRGB canvas primaries and clamps representational limits to active headroom. SDR preview and CPU fallback render the direct SDR ACES rendition from working pixels. These are software rendering parameters, not measured screen luminance. Existing RAWs and merge masters use this default automatically; raster images bypass scene rendering. The inspector presents a monitor-independent HDR content histogram. Working HDR, Content HDR and Output analysis remain available through MCP; content luminance above reported headroom, canvas channel clipping, gamut limitation and sensor saturation have separate meanings. Output statistics and pixel inspection follow the actual presentation mapping. See [the processing contract and verification gates](docs/hdr-processing.md).
