# Native CPU preview renderer

The Linux x64 application CPU fallback uses this helper through typed main-process
source leases and bounded stdin/output streams. Numerical and service checks pass;
full application acceptance and end-to-end performance measurements remain
incomplete. It replaces per-pixel CPU fallback calculation, without decoding RAW,
encoding exports, creating windows, changing shader arithmetic or altering the
independent numerical reference adapter.

The Rust standard-library host owns bounded input/output strips and scoped worker
lifetimes. A C++ C ABI evaluates Float64 ACES and the current application Light,
white-balance, display-source and diagnostic-range policies. `generate_math.py`
reads the original ACES CTL directly, verifies all four pinned SHA-256 hashes and
generates a separate implementation. It imports neither application-generated
math nor `scripts/aces-reference.py`. The upstream ACES revision is
[`069b0bc3e1f6c62820f19fdae2fecec3f4fc0f80`](https://github.com/aces-aswf/aces-core/tree/069b0bc3e1f6c62820f19fdae2fecec3f4fc0f80),
Apache-2.0; preserve the [upstream license](../../third_party/aces-core/LICENSE).

The immutable context prepares sRGB SDR/100 and Rec.2020 content/1000 tables once.
Its input and sRGB matrices are supplied as exact Float64 application values.
Source normalization, camera processing, orientation and lens corrections are
already incorporated into the authenticated working asset; this helper does not
repeat them. Processing order is manual WB, Exposure, Contrast, Highlights,
Shadows, Whites, Blacks, Saturation/Vibrance, output transform, transfer encoding and RGBA8 rounding.
Before uses the unadjusted source. Display-referred HDR sources bypass the RAW
output transform. Range stripes retain original source coordinates. Alpha stays
straight and uses the existing `Math.round(alpha * 255)` behavior.

The only photographic acceptance criterion in this prototype is **zero differing
RGBA8 bytes** against the unchanged JavaScript CPU functions. The emergency
recovery one-code policy does not apply. Standard-library transcendental functions
and target preparation may still differ near byte thresholds; any such result is
a failure to retain and investigate, never an automatic tolerance change.

## Build and compare

The coordinator alone runs these commands sequentially. Dependencies are a Rust
toolchain, C++17 compiler, Python 3 and archiver. There are no Rust crate or network
dependencies. The committed lockfile supports `--locked --offline`.

```sh
IRODORI_CPU_RENDER_CARGO=/home/linuxbrew/.linuxbrew/bin/cargo \
  node scripts/research/build-native-cpu-render.mjs

./node_modules/.bin/esbuild scripts/research/compare-native-cpu-render.ts \
  --bundle --platform=node --format=esm --packages=external \
  --outfile=artifacts/native-cpu-render-parity.mjs

node artifacts/native-cpu-render-parity.mjs "$PWD" \
  /absolute/build-directory/irodori-cpu-render \
  /absolute/new-synthetic-evidence-directory - 1

node artifacts/native-cpu-render-parity.mjs "$PWD" \
  /absolute/build-directory/irodori-cpu-render \
  /absolute/new-managed-evidence-directory \
  /absolute/native-viewport-fixture/fixture.json 1,4,8
```

The parity TypeScript lives at `scripts/research/compare-native-cpu-render.ts`.
The build script records source hashes, compiler flags, commands, toolchain and
executable SHA-256 under a unique ignored `artifacts/native-cpu-render-build/`
directory. Build outputs use an explicit ignored `--target-dir`.
`npm run build:cpu-native` stages the verified Linux x64 helper and provenance in
`vendor/native-cpu-render/linux-x64`; the application build verifies and copies it
beside the main module. Runtime lookup uses that trusted location, never a
renderer-supplied path or the current working directory.

The synthetic experiment uses the retained ACES input corpus, signed channels,
fractional/zero alpha, odd and skinny geometry, source-display branching, individual
and combined Light controls, custom WB, HDR ranges, and the existing 1024-pixel
draft geometry. These are isolated numerical fixtures, never catalog photographs.
The managed experiment accepts the existing sensor-derived native-viewport bundle
and independently checks its F32 geometry and SHA-256 before and after trials.
It runs full-resolution neutral, combined and range cases, adding custom WB only
when the bundle has a real profile. Each generated request and paired binary output
is retained; large managed runs can consume substantial evidence disk space.

The first Bazzite comparison passed 140 synthetic/protocol checks across one,
four and eight threads, and 16 full-size Sony/protocol checks. All rendered RGB
and alpha bytes matched the unchanged JavaScript oracle exactly. On the
5422 × 3622 source, eight-thread neutral rendering took 2168 ms versus 33633 ms
for the oracle; combined Light edits took 4375 ms versus 71007 ms. These are
single observations including child launch, source reads, pipe transport and
saved output. OS caches were uncontrolled, and browser bitmap construction,
application cancellation and presentation are excluded. The complete evidence
and limitations are in [phase progress](../../artifacts/bazzite-native-20261019/progress.json).

## Protocol and ownership

Linux x86_64 CLI: `irodori-cpu-render ABS_REQUEST ABS_SOURCE THREADS`, with threads
restricted to 1, 4 or 8. Stdout is binary; stderr contains bounded error context.
File inputs must be regular files opened with `O_NOFOLLOW`, with exact declared
lengths. The source argument `-` instead reads F32 strips from stdin and
requires EOF after the declared source length. The offline build passed 48
file-input controls, then 88 synthetic and eight full-size Sony file/stdin replays
against the retained unchanged oracle. Both cohorts also passed five stdin
controls: short input, extra input, non-finite input, invalid alpha and cancellation
under actual pipe backpressure. These results do not establish application
integration or browser presentation performance.
The fixed 832-byte little-endian request is:

| Offset | Content                                                            |
| ------ | ------------------------------------------------------------------ |
| 0      | `IRODCPU3` (8 bytes), version u32=3 at 8, flags u32 at 12          |
| 16     | Source width/height and output width/height, four u32              |
| 32     | Generation, settings revision, policy revision, three u64          |
| 56     | Nonzero 32-byte source hash, then nonzero 32-byte request identity |
| 120    | Exact F32 source byte count u64                                    |
| 128    | Rec.2020-to-ACES matrix, nine f64 in CTL row-vector order          |
| 200    | Rec.2020-to-sRGB matrix, nine f64 in application row-major order   |
| 272    | Exposure, Contrast, Highlights, Shadows, Whites, Blacks, six f64   |
| 320    | WB matrix, nine f64; headroom f64 at 392                           |
| 400    | Saturation and Vibrance, two f64 in integer −100…+100              |
| 416    | Compiled mixer/intensity/grading packet, 52 f64 values             |

Version 3 retains every previous field offset and appends the complete color
packet. The native validator checks finite values, bounds, unit rotations, tone
strength, activity flags, positive-zero padding and equality with the legacy
intensity fields before context/image allocation or output. The packet becomes a
368-byte immutable C ABI structure; the complete CPU parameter structure is 520
bytes in C++ and Rust. Pixel rendering uses the independently checked fused operator.
Inactive creative controls delegate to the previous intensity function exactly.
These operators are internal until versioned history, UI and MCP adoption is ready.

Flags are WB=1, display source=2, HDR ranges=4, neutral adjustments=8 and present
headroom=16; unknown flags fail. Output dimensions must be exactly full size or the
existing aspect-preserving 1024-pixel draft. Source dimensions retain the existing
32768-per-axis and 512 MiB Float32 bounds. Every input pixel is checked for finite
channels and alpha in [0,1], including pixels skipped by draft sampling.

The response starts with `IRODRGB1`, request length u32=832, the exact request bytes
and requested thread count u32. Each ordered strip has `IRODROW1`, output row u32,
row count u32 (at most 64), per-plane byte count u32, reserved u32=0, then tight
After and Before RGBA8 planes. Completion is `IRODEND1`, bounded JSON length u32,
stage metrics JSON, EOF and successful child close. Partial output is never a
completed frame. The parity reader rejects reordered, oversized, incomplete,
identity-mismatched or trailing output.

One source strip is shared read-only across disjoint output worker slices. Threads
join before the strip is reused or context destroyed. Multi-thread mode creates
scoped workers per strip, with explicit 512 KiB stacks; its launch overhead is
included in render time. It is not a persistent pool or a proven optimum. The
reported `plannedStripAndWorkerBytes` covers the strip, paired output capacities,
worker-stack allowance and 64 KiB stdout buffer. It excludes prepared context,
allocator/runtime overhead, main thread stack, process mappings and receiver
buffers; it is neither measured RSS nor an application memory cap.

The caller authenticates input hashes. The child echoes their identities and
checks length and stable file metadata in file mode but **does not itself compute SHA-256**.
This research file contract assumes immutable caller-owned fixtures. Production
integration feeds stdin from a main-owned managed lease, verifies each strip
and the whole hash, and requires both source attestation and successful child
close before publication. Stdin success by itself authenticates no source.
An arbitrary path is never a renderer-facing application API.

## Application verification and remaining gates

Main source attestation, source leases, child drain, bounded pair capabilities,
renderer acknowledgement, supersession and frozen independent RAM/GPU admission
are implemented. The registered controller, pure protocol, executable and
FullPreviews targets passed 590 checks. The first hidden real-Sony device-loss
case passed native draft/full publication, current edits, nine canonical SDR
pixel checks, source samples, histogram, Before/Split and HDR ranges. These are
functional results, not an application speed or memory-peak acceptance.

The default-build registered UI/Settings invocation subsequently passed 569
checks with no failures and one foreground case deferred. Five native CPU UI
cases cover actual loss, current edits/analysis, stale replies, frozen policy,
reduced-detail editing and a held real bitmap receiver draining before new GPU
allocation. Three process snapshots include the active helper and complete
app-family PSS; they establish sampled ownership, not peaks or hard caps.

Four subsequent foreground cases passed with the same default build: the full
resized-window 100% memory case, maximized ultrawide SDR/HDR recovery and stale
readback reversal/photo switching. The measured client was 3440 × 1371 at DPR 1,
maximized with the desktop bar visible. Emergency SDR recovery met the accepted
one-code RGB limit with exact alpha; HDR was byte exact. These are functional
checks, not recovery speed, scanout or physical HDR acceptance.

The real gesture/clipping consumer subsequently exposed an expected cancellation
being rejected through Electron IPC. Controller-owned lifecycle cancellation
now returns a typed request/session/generation outcome after job drain; genuine
failures still reject. The strict fixture error policy is unchanged. Its exact
rerun passed, followed by 579 passing registered controller/UI checks, no
failures and one foreground-only case deferred. Actual 8192/65536 sample
consumers and the complete fourteen-level clipping pyramid were observed. The
existing JavaScript full-mask worker took about 34 seconds; native mask
migration remains separate work.

- Verify merge masters and display-source coverage; preserve the independent
  reference and normal color limits.
- Extend analysis coverage across targets and comparison modes; preserve the
  independently observed mask fingerprints and exact source-sample checks.
- Compare 1/4/8 threads including launch, table preparation, source reads, pipe
  transport, browser bitmap construction and complete recovery. The retained
  oracle evaluator is not an end-to-end browser fallback benchmark.
- Measure helper and complete application process memory separately from logical
  ownership plans. Conservative reservations do not establish RSS/VRAM hard caps.
- Measure foreground responsiveness when the test desktop is idle. Functional
  passes do not certify scanout, physical HDR or native input cadence. Other
  platforms require their separate follow-up work.
