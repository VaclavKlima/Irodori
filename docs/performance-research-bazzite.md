# Continue image-pipeline research on Bazzite

This is the continuation brief for the Ryzen 9 7900X3D / Radeon RX 7900 XTX machine. The machine was unavailable during the Mac work. **No Linux result is implied by the Mac measurements.** Continue the existing research branch and draft PR; keep production behavior unchanged.

Read [AGENTS.md](../AGENTS.md), [the research report](performance-research.md), [background testing](background-testing.md), [testing](testing.md), [RAW contracts](raw-processing.md), and [HDR processing](hdr-processing.md) before making changes. The report records the Mac findings, exact tolerances, limitations, source archive hashes, and candidate ranking. Generated evidence is intentionally absent from Git.

## Checkout and environment

```sh
git fetch origin
git switch research/image-pipeline-performance
git pull --ff-only
node --version
npm ci
npm run setup:electron
npm run verify -- --plan --target research-pipeline --target research-native
```

Use Node 24 or newer and npm. Record the checked-out revision and any changes before each measurement. Do not replace the branch with `main` or recreate the research from scratch. If the local worktree contains unrelated changes, preserve them and use a separate checkout.

Use the actual desktop session for foreground measurements, with the intended monitor connected. Record Bazzite image/release, kernel, CPU, total RAM, GPU PCI ID, Mesa/driver/Vulkan versions, Electron/Chromium/Dawn, renderer backend, session type (Wayland/X11/XWayland), monitor dimensions, refresh rate, scale, HDR state, VRR state, power profile and window content dimensions. Record whether a container/toolbox is involved; its graphics/runtime environment is part of the experiment. A software adapter or missing native cadence is incomplete hardware verification.

Use the shared isolated Electron launcher. It checks its temporary profile before imports and cleans up owned processes/profiles. Never point automation at the user's library. Do not disable Chromium sandboxing or expose paths, commands, shaders or native handles through the application bridge to make a test work. Use the machine's established development workflow for prerequisites. Record package/driver changes and re-establish comparable baselines if the graphics configuration changes.

## Build the isolated helpers

Prerequisites are a C++17 compiler, make, CMake, pkg-config, zlib development files, the libjpeg-turbo build prerequisites including NASM on x86, and a Rust toolchain with Cargo. Record toolchain versions. These helpers write only under ignored `artifacts/` and do not install application binaries.

```sh
node scripts/research/build-native.mjs pointwise
node scripts/research/build-rust.mjs

mkdir -p artifacts/research-build
curl --fail --location https://www.libraw.org/data/LibRaw-0.22.1.tar.gz --output artifacts/research-build/LibRaw-0.22.1.tar.gz
curl --fail --location https://codeload.github.com/opencv/opencv/tar.gz/refs/tags/4.13.0 --output artifacts/research-build/opencv-4.13.0.tar.gz
LUMA_RESEARCH_PINNED_SOURCES=1 node scripts/research/build-native.mjs libraw
LUMA_RESEARCH_PINNED_SOURCES=1 node scripts/research/build-native.mjs opencv

mkdir -p artifacts/ultrahdr-native-build
curl --fail --location https://codeload.github.com/google/libultrahdr/tar.gz/refs/tags/v2.0.2 --output artifacts/ultrahdr-native-build/source.tar.gz
curl --fail --location https://codeload.github.com/libjpeg-turbo/libjpeg-turbo/tar.gz/refs/tags/3.1.0 --output artifacts/ultrahdr-native-build/jpeg.tar.gz
node scripts/research/build-native.mjs hdr-1
```

The builder checks the pinned archive hashes before extraction and writes manifests beside the binaries. Cargo uses the committed lockfile. `LUMA_RESEARCH_CARGO` selects a Cargo executable if needed. Explicit helper overrides are `LUMA_RESEARCH_RUST_BINARY`, `LUMA_RESEARCH_LIBRAW_BINARY`, `LUMA_RESEARCH_OPENCV_BINARY` and `LUMA_RESEARCH_HDR_1_BINARY`.

Without `LUMA_RESEARCH_PINNED_SOURCES=1`, the builder prefers pkg-config packages and records their versions. They must match WASM LibRaw 0.22.1 / OpenCV 4.13.0; a mismatch is rejected with instructions to use pinned sources. The commands above force the verified archives. The pinned fallback OpenCV disables independent LAPACK, Carotene, KleidiCV, IPP and OpenCL paths. Inspect its build manifest for additional Linux parallel backends. Begin with one compute thread; count internal library/runtime threads as well as the explicit worker budget.

Do not run `build:export-native` on Linux: that existing production build supports macOS arm64. The research `hdr-1` helper builds the same unchanged bridge on Linux, with a research-only copy of the codec capped at one thread. `hdr-2` and `hdr-4` are available for a subsequent bounded-thread study. They do not activate native encoding in the application. A full Linux native-export candidate still needs an isolated worker adapter, dimensions/HDR reconstruction/fallback/cancellation checks and end-to-end measurements before any production proposal.

If a Linux build fails, retain the failed command, compiler output and source/build hashes under `artifacts/`. Fix the isolated build rather than changing production packaging. Never silently substitute a different library version or arithmetic policy.

## Run sequentially

Run one verification invocation at a time. All research benchmarks use the `research` family and one worker. The invocation lock protects shared builds. First run graph/native correctness, then component measurements, then native desktop work:

```sh
npm run research:pipeline
npm run research:measure
npm run research:presentation -- --foreground
npm run verify -- --foreground --target research-background

# Existing application input/history and navigation gates remain separate.
npm run verify -- --foreground --target hdr-slider-benchmark --target hdr-interaction-benchmark
```

`research:measure` contains deliberate experimental correctness gates. On the Mac, the native LibRaw output had a rare difference above the maximum two-code-unit tolerance; native OpenCV ECC exceeded the `1e-3` matrix tolerance. Investigate and report those failures on Linux. **Do not relax the gates, suppress failed samples, or call a faster mismatching implementation equivalent.** Later independent benchmark files still run sequentially and retain their evidence. A skipped missing binary or missing hardware makes the selected verification incomplete (exit 2).

Presentation tests explicitly measure supported 60 Hz and 120 Hz cadence separately. They use 1100 × 700 with Console open and a 1440 × 900 workspace, Fit/100%/800%, three sustained runs of 240 inputs per quality/zoom and five fresh isolated application imports. If the display cannot supply one cadence, retain the report and mark it incomplete. Do not fake the refresh rate. The shader lab bypasses React/history; the unchanged slider benchmarks and actual Exposure-during-export workload measure application behavior separately.

The native GPU component tests compare normal detail/draft, batch sizes 8/32/128, histogram readback on/off and valid sharp navigation tile reuse. They measure completed queue work. They do not measure physical scanout or luminance. Keep driver/OS caches honestly labeled; do not describe a fresh process as a cold filesystem.

`research-background` measures 30 real original-size quality-100 exports, three heterogeneous batches, and three 240-input foreground runs with/without export. On Linux it measures the existing WASM encoder baseline. Synthetic CPU service concurrency trials and repeated-fixture calibration remain separate from this real export evidence.

Read each invocation's `summary.md` first. Rerun failed cases using its exact case command before broadening coverage. Keep the original failed evidence. Never run a full/all checkpoint automatically; it requires a separately agreed checkpoint. No traces by default; use `LUMA_TEST_TRACE=1` only for diagnostic reruns.

## Real sequences and existing performance gates

Ask the user for read-only local source paths if real Sony sequences are available. Do not upload or commit private images. Record their hashes, camera/recording modes and dimensions; verify hashes again after the experiment. Do not manufacture a sequence by repeating or transforming one RAW and call it real evidence.

The existing `merge-benchmark` target accepts `LUMA_MERGE_SONY_SEQUENCE` as a JSON array of distinct Sony original paths and `LUMA_MERGE_SONY_MODE=noise` or `hdr`. It runs three cold repetitions at 2/3/5/9 sources. `LUMA_MERGE_BRACKETS` supplies the separate RAW merge correctness/UI fixtures. Inspect the relevant test's selection and requirements first:

```sh
npm run verify -- --plan --target merge-benchmark
npm run verify -- --target merge-benchmark
npm run verify -- --target merge-raw
npm run verify -- --foreground --target merge-raw-ui
```

Set the environment variables in the local session before those commands. Missing private sources remain incomplete. Keep synthetic scaling, repeated fixtures and actual heterogeneous sequences in separate tables. Larger brackets, 32-source behavior, overlap of preparation/encoding and foreground editing during real merges remain additional work; do not infer them from the pointwise scheduler proof.

The uncorrected-preview 15% gate requires an existing saved baseline on the same machine/configuration. Use `LUMA_PREVIEW_BASELINE=/absolute/path/to/saved-baseline.json` with `npm run benchmark:preview -- --foreground` only when that baseline exists. Preserve every existing gate and failure. Do not create a baseline from the candidate and claim a regression pass. The prior Mac preview evidence already contains a GPU-versus-legacy-PNG failure; it is not erased by this research.

## Remaining research and deliverable

Collect aggregate CPU time, process/library thread use, peak RAM/VRAM, transfers, logical disk traffic, cancellation latency and foreground interference. Current probes expose known owned bytes, transfer counts and point-in-time process RSS/thread samples; they do not yet provide all required peaks or per-job CPU/disk totals. Add platform instrumentation in isolated tools and label sampling intervals/overhead. Keep null measurements explicitly unmeasured.

The cooperative scheduler is a bounded admission/cancellation proof: at its two-job cap it can reject foreground admission. Reserve foreground capacity or implement resource-releasing preemption before any integration; keep the existing production scheduler during measurements. The mask store proves checksum/history retention across orderly restart, with crash-atomic publication/fsync still required for production persistence.

The shared-texture test inventories Electron support only. A separate Linux DMA-BUF producer still needs synchronization, color/alpha/format preservation, generation checks and all-reference release, including receiver crash and GPU loss. The Mac IOSurface producer is also unfinished. Keep Dawn; evaluate `wgpu` independently with the same shaders, arithmetic and completed-work boundaries. Do not treat API availability as a zero-copy performance result.

Update [performance-research.md](performance-research.md) with Linux results, command selections, counts/durations, evidence paths, source/build/backend identities, retained failures and unmeasured requirements. Keep artifacts out of Git and arrange their local transfer/archive separately if results must be compared across machines. Continue the draft PR with a reviewable commit and concise evidence summary.

Rank correctness and retained detail, then extensibility, interaction, background completion, efficiency and maintenance. Recommend migration only for repeatable end-to-end gains larger than observed variability. LUT approximation requires its own numerical and human visual review; exact thresholds stay unchanged. No migration or production speedup is promised by this handoff.
