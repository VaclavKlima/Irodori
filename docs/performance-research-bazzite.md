# Continue image-pipeline research on Bazzite

This is the historical October 16 research brief. Its production-preservation
instruction, commands, findings and migration status belong to that experiment.
The later authorized [Bazzite native-engine implementation goal](bazzite-native-engine.md)
records current adopted paths, selected feature decisions and unfinished
acceptance. It supersedes this brief as instructions for current implementation;
no old failed comparison or incomplete result is relabeled as passed.

This is the continuation brief for the Ryzen 9 7900X3D / Radeon RX 7900 XTX machine. The October 16 Linux continuation is recorded in [the report](performance-research.md#bazzite-component-observations--october-16-2026). Continue the existing research branch and draft PR; keep production behavior unchanged. Mac and Linux observations remain separate.

Read [AGENTS.md](../AGENTS.md), [the research report](performance-research.md), [background testing](background-testing.md), [testing](testing.md), [RAW contracts](raw-processing.md), and [HDR processing](hdr-processing.md) before making changes. The report records both machines' findings, exact tolerances, limitations, source archive hashes, and candidate ranking. Generated evidence is intentionally absent from Git.

## Completed Linux work and retained failures

The October 16 continuation started at `c69c40fa12c7936bfe6804820710d4238e7cbeb3`. The host is Bazzite GNOME 44.20261012.0, kernel 7.2.9, Ryzen 9 7900X3D, 32.68 GB usable RAM and RX 7900 XTX/RADV Mesa 26.2.4. Measurements used the performance power profile and native Wayland/Vulkan on the 3440 × 1440, scale-1, approximately 144 Hz HDR primary monitor. The report records complete identities, source/build hashes, variability and per-attempt evidence; these results do not certify physical luminance or scanout.

| Selection                      | Completed state and remaining limit                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Setup, graph and CPU protocols | Node/Electron, pinned native helpers and locked Rust helper prepared. Graph/protocol selection passed 273 cases in 21.84 s. C++/Rust ordered output remained byte-identical; transport/cancellation findings do not establish a service winner.                                                                                                                                                                                                           |
| Native/library components      | 277 passes and one retained ECC failure in 134.16 s. Linux LibRaw matched exactly; the small HDR codec reconstruction matched. OpenCV default dispatch differed by `0.0080963932`, failing the unchanged `1e-3` gate again on the exact rerun. A strict diagnostic with optional dispatch disabled matched; it does not replace the default helper or its failure.                                                                                        |
| Paired Dawn/wgpu               | Both backends agreed on compared original-pixel Float32 RGB, but both failed the independent exact CPU reference at maximum error/tolerance ratio `1.04022004675`, including the exact rerun. Similar large-batch timings do not justify migration.                                                                                                                                                                                                       |
| Foreground presentation        | The corrected four-case rerun completed in 246.13 s, following 273 fast/static cases in 16.69 s. Actual input averages were 59.9569–59.9599 Hz and 119.9077–119.9257 Hz. Normal 60 Hz retained every input; large-layout normal Fit at 120 Hz missed 95/240 inputs in each run. All 72 sustained runs retained 16,986/17,280 inputs. Five fresh isolated imports and shared-texture API inventory completed separately.                                   |
| Real background exports        | 275 passes in 297.30 s: thirty original-size quality-100 WASM exports, three heterogeneous batches and three actual Exposure trials with/without export. Individual export median/p95 was 6.536/6.809 s; concurrent jobs took 10.907–11.006 s. Input averages varied from 51.54–68.47 Hz without export and 58.13–58.82 Hz with export. Every counted interaction frame was draft; no matched idle-Electron export control or sharp 60 fps claim follows. |
| Existing application gates     | 276 passes and one failure in 46.17 s. Three navigation cases passed. Fit Exposure continuous progress failed at 23 frames/histograms against the unchanged 30/30 minimum; its exact rerun failed at 24/24. Later sliders and 100% were not reached.                                                                                                                                                                                                      |
| Real Sony noise sequences      | The first complete measurement passed all three cold 2/3/5-source runs but failed the distinct 9-source gate at 18.366 s; repeated-original 9-source calibration also failed at 15.076 s. The 15 s gate is unchanged. The exact rerun still failed real nine at 17.958–18.063 s, while repeated nine passed at a 14.948 s maximum. Retain the near-threshold variability and both initial failures; distinguish real sequences from calibration.          |
| Edited four-second export gate | Linux remains incomplete because production has no native encoder adapter. Building the isolated research codec does not satisfy that backend prerequisite. Preserve the Mac gate failures and unchanged threshold.                                                                                                                                                                                                                                       |
| Real HDR RAW and UI checks     | Both completed: RAW measured-exposure/preparation and foreground review/publication/open/source-deletion lifecycle passed. The combined selection recorded 276 passes, no failures and one export-backend skip in 110.07 s (exit 2/incomplete).                                                                                                                                                                                                           |

The Linux resource sampler collected whole-invocation CPU/I/O lower bounds and sampled summed RSS/thread counts for components, presentation and actual export/interference work. These are completed measurements with explicit scope limits, rather than per-job resource certification. Exact peaks, unique physical RAM, job-attributed VRAM, physical device traffic and complete short-lived-process CPU/I/O remain unmeasured. No comprehensive checkpoint ran, and no production migration or approximation is approved.

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
IRODORI_RESEARCH_PINNED_SOURCES=1 node scripts/research/build-native.mjs libraw
IRODORI_RESEARCH_PINNED_SOURCES=1 node scripts/research/build-native.mjs opencv

mkdir -p artifacts/ultrahdr-native-build
curl --fail --location https://codeload.github.com/google/libultrahdr/tar.gz/refs/tags/v2.0.2 --output artifacts/ultrahdr-native-build/source.tar.gz
curl --fail --location https://codeload.github.com/libjpeg-turbo/libjpeg-turbo/tar.gz/refs/tags/3.1.0 --output artifacts/ultrahdr-native-build/jpeg.tar.gz
node scripts/research/build-native.mjs hdr-1
```

The builder checks the pinned archive hashes before extraction and writes manifests beside the binaries. Cargo uses the committed lockfile. `IRODORI_RESEARCH_CARGO` selects a Cargo executable if needed. Explicit helper overrides are `IRODORI_RESEARCH_RUST_BINARY`, `IRODORI_RESEARCH_LIBRAW_BINARY`, `IRODORI_RESEARCH_OPENCV_BINARY` and `IRODORI_RESEARCH_HDR_1_BINARY`.

The host continuation used Node 26.7.0/npm 11.19.0 for setup, bundled Node 24.20.0 for the main npm verification commands and processing workers; direct focused Playwright and the final RAW/UI/export invocation used host Node 26.7.0, GCC 16.2.1, Rust 1.99.0, CMake 4.4.4 and NASM 3.02. Missing tools were installed through the existing Homebrew setup; dependency changes are recorded in ignored evidence. The Linux research HDR compile now explicitly supplies `<cstdint>` through compiler flags, without changing the production bridge. OpenCV's actual parallel framework was pthreads; optional CPU dispatch remains important to numerical equivalence.

Without `IRODORI_RESEARCH_PINNED_SOURCES=1`, the builder prefers pkg-config packages and records their versions. They must match WASM LibRaw 0.22.1 / OpenCV 4.13.0; a mismatch is rejected with instructions to use pinned sources. The commands above force the verified archives. The pinned fallback OpenCV disables independent LAPACK, Carotene, KleidiCV, IPP and OpenCL paths. Inspect its build manifest for additional Linux parallel backends. Begin with one compute thread; count internal library/runtime threads as well as the explicit worker budget.

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

`research:measure` contains deliberate experimental correctness gates. On the Mac, the native LibRaw output had a rare difference above the maximum two-code-unit tolerance; native OpenCV ECC exceeded the `1e-3` matrix tolerance. Linux LibRaw matched exactly, while native ECC failed again as recorded above. Preserve both machines' results when investigating the remaining numerical differences. **Do not relax the gates, suppress failed samples, or call a faster mismatching implementation equivalent.** Later independent benchmark files still run sequentially and retain their evidence. A skipped missing binary or missing hardware makes the selected verification incomplete (exit 2).

Presentation tests explicitly measure supported 60 Hz and 120 Hz cadence separately. They use 1100 × 700 with Console open and a 1440 × 900 workspace, Fit/100%/800%, three sustained runs of 240 inputs per quality/zoom and five fresh isolated application imports. If the display cannot supply one cadence, retain the report and mark it incomplete. Do not fake the refresh rate. The shader lab bypasses React/history; the unchanged slider benchmarks and actual Exposure-during-export workload measure application behavior separately.

The completeness rule now requires both measured native rAF frequency and every run's achieved input frequency to reach at least **99% of the requested rate**: 59.4 Hz for a 60 Hz request and 118.8 Hz for 120 Hz. This allowance covers clock rounding/jitter only; rendering latency, retained-detail and progress gates remain unchanged. Evidence is written before an under-driven case is deferred, and the verification runner reports incomplete (exit 2). A requested rate or low surviving-frame p95 alone cannot establish the input load or completed output cadence.

The native GPU component tests compare normal detail/draft, batch sizes 8/32/128, histogram readback on/off and valid sharp navigation tile reuse. They measure completed queue work. They do not measure physical scanout or luminance. Keep driver/OS caches honestly labeled; do not describe a fresh process as a cold filesystem.

The Linux desktop runs use a task-owned `TMPDIR` on the repository's NVMe/btrfs filesystem, because the host `/tmp` is tmpfs. Keep profiles temporary and shared-launcher validated. To collect whole-invocation sampled resources without changing production, for example:

```sh
mkdir -p artifacts/research-bazzite/tmp
node scripts/research/linux-resources.mjs --interval-ms 250 --output artifacts/research-bazzite/resources-unique.json -- env TMPDIR="$PWD/artifacts/research-bazzite/tmp" npm run research:presentation -- --foreground
```

Use a unique output filename per attempt. The sampler reports its own overhead, missing process/thread counters, lower-bound CPU/I/O and sampled summed RSS/threads. These are not per-job CPU, unique physical RAM, exact peaks or peak VRAM. Logical pipe/file traffic and kernel storage counters remain distinct.

The initial Linux pacing restarted the delay after each native frame and delivered only 48/72 Hz on a 144 Hz monitor. Preserve that evidence as under-driven. The corrected research scheduler accumulates absolute deadlines, limits delivery to one input per native frame, and records achieved Hz, interval distributions and deadline offsets. Uneven intervals are expected when 144 Hz is not an integer multiple of the requested rate; never claim uniform intervals or measured scanout.

`research-background` measures 30 real original-size quality-100 exports, three heterogeneous batches, and three 240-input foreground runs with/without export. On Linux it measures the existing WASM encoder baseline. Synthetic CPU service concurrency trials and repeated-fixture calibration remain separate from this real export evidence.

Read each invocation's `summary.md` first. Rerun failed cases using its exact case command before broadening coverage. Keep the original failed evidence. Never run a full/all checkpoint automatically; it requires a separately agreed checkpoint. No traces by default; use `IRODORI_TEST_TRACE=1` only for diagnostic reruns.

## Real sequences and existing performance gates

The user explicitly requested repository copies of all benchmark photographs for Linux/Mac repeatability. [The committed Sony research set](../tests/fixtures/research-sony/README.md) now contains fifteen unchanged SD-card originals: a twelve-frame fixed-exposure noise burst and a real three-frame HDR BRK capture. Its manifest records hashes, dimensions, capture facts and the specific repository/testing authorization; it does not invent an open-content license. Other private photographs retain their existing restrictions. Benchmark inputs must be available in the repository, with provenance, rather than depend on an unavailable local card path. Do not manufacture a sequence by repeating or transforming one RAW and call it real evidence.

The twelve-original burst selects distributed distinct subsets, including both endpoints, through the existing benchmark rule. These differ from historical first-nine-source trials. The research-only benchmark harness now supplies the built `out/main/preview-worker.js` through `PreviewProcess`; the previous source-module worker path failed before measurement. The change is confined to test setup and preserves preparation, publication, output/backend assertions, sample counts and the 15-second maximum.

Use the portable wrapper, which checks all fifteen source hashes before and after each command and preserves failure/incomplete status:

```sh
node scripts/research/sony-fixtures.mjs check
node scripts/research/sony-fixtures.mjs noise -- node scripts/verify.mjs --target merge-benchmark
node scripts/research/sony-fixtures.mjs hdr -- node scripts/verify.mjs --target merge-raw
node scripts/research/sony-fixtures.mjs hdr -- node scripts/verify.mjs --foreground --target merge-raw-ui
```

The existing `merge-benchmark` target accepts `IRODORI_MERGE_SONY_SEQUENCE` as a JSON array of distinct Sony original paths and `IRODORI_MERGE_SONY_MODE=noise` or `hdr`. It runs three cold repetitions at 2/3/5/9 sources. `IRODORI_MERGE_BRACKETS` supplies the separate RAW merge correctness/UI fixtures. Inspect the relevant test's selection and requirements first:

```sh
npm run verify -- --plan --target merge-benchmark
npm run verify -- --target merge-benchmark
npm run verify -- --target merge-raw
npm run verify -- --foreground --target merge-raw-ui
```

Set the environment variables in the local session before those commands; the portable wrapper supplies them automatically. Both current sequences are available in the repository. Larger controlled HDR brackets and a distinct 32-source sequence remain unavailable, and their required coverage stays incomplete. Keep synthetic scaling, repeated fixtures and actual heterogeneous sequences in separate tables. Overlap of preparation/encoding and foreground editing during real merges remain additional work; do not infer them from the pointwise scheduler proof.

The uncorrected-preview 15% gate requires an existing saved baseline on the same machine/configuration. Use `IRODORI_PREVIEW_BASELINE=/absolute/path/to/saved-baseline.json` with `npm run benchmark:preview -- --foreground` only when that baseline exists. Preserve every existing gate and failure. Do not create a baseline from the candidate and claim a regression pass. The prior Mac preview evidence already contains a GPU-versus-legacy-PNG failure; it is not erased by this research.

## Remaining research and deliverable

Continue from the completed Linux whole-invocation resource samples, known owned-byte/transfer measurements, CPU-service cancellation and actual export/Exposure trials. The remaining evidence is per-job CPU/I/O attribution, complete process/library thread accounting, exact peak RAM/VRAM, native full-export candidates, matched-cadence interference controls and real-merge cancellation/foreground interference. Keep logical traffic separate from physical device traffic, label sampling intervals/overhead and leave null metrics explicitly unmeasured.

The cooperative scheduler is a bounded admission/cancellation proof: at its two-job cap it can reject foreground admission. Reserve foreground capacity or implement resource-releasing preemption before any integration; keep the existing production scheduler during measurements. The mask store proves checksum/history retention across orderly restart, with crash-atomic publication/fsync still required for production persistence.

The shared-texture test inventories Electron support only. A separate Linux DMA-BUF producer still needs synchronization, color/alpha/format preservation, generation checks and all-reference release, including receiver crash and GPU loss. The Mac IOSurface producer is also unfinished. Do not treat API availability as a zero-copy performance result.

The isolated paired `research-wgpu` target now compares pinned wgpu 30.0.1 with Dawn on identical full-source tile inputs, shaders and completed fences. It excludes presentation, histogram and planner/cache behavior. Build/run it separately and sequentially:

```sh
node scripts/research/build-wgpu.mjs
IRODORI_RESEARCH_GPU_ADAPTER='Radeon RX 7900 XTX' npm run verify -- --target research-wgpu
```

On Mac, supply the actual shared Apple adapter name instead. Keep Cargo.lock; `IRODORI_RESEARCH_WGPU_BINARY` can select an explicit helper. Both Linux backends agreed on every compared original-pixel neutral Float32 RGB value but reproduced a shared exact CPU-reference failure (maximum error/tolerance ratio 1.04022004675). Preserve that failure and the unchanged tolerance. Similar large-batch timings and this narrow parity do not approve a backend migration.

Update [performance-research.md](performance-research.md) with Linux results, command selections, counts/durations, evidence paths, source/build/backend identities, retained failures and unmeasured requirements. Keep artifacts out of Git and arrange their local transfer/archive separately if results must be compared across machines. Continue the draft PR with a reviewable commit and concise evidence summary.

Rank correctness and retained detail, then extensibility, interaction, background completion, efficiency and maintenance. Recommend migration only for repeatable end-to-end gains larger than observed variability. LUT approximation requires its own numerical and human visual review; exact thresholds stay unchanged. No migration or production speedup is promised by this handoff.
