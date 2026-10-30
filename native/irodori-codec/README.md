# Linux native HDR codec

This is a small, headless Rust host for the existing pinned libultrahdr 2.0.2 /
libjpeg-turbo 3.1.0 codec. It targets Linux x64 and has no Rust crate dependencies.
The original `scripts/ultrahdr/bridge.cpp` supplies the exact existing encoding
policy through its C ABI. A small C++ shim probes the live encoded stream and
reports Linux peak process RSS in bytes. No photographic math, rendition,
dimensions, gain-map channels, quality or metadata policy changes here.

One process handles one job. Rust maps immutable main-owned binary16 HDR and
JPEG-primary scratch inputs read-only, validates the existing allocation bounds,
keeps those mappings alive through encoding, probes full-size primary and gain
geometry, and writes the stream to a newly created scratch output. The export
worker remains outside Electron. Its existing process-group cancellation,
primary-byte identity validation, accepted frozen edits and durable publication
still govern the job. The shared C++ bridge has global encoder state; concurrent
requests in the same process are intentionally unsupported.

The inherited source bound is 512 MiB of Float32-equivalent pixels, the JPEG
input bound is 256 MiB, and admission retains the existing conservative 2 GiB
estimate. Measured helper peak RSS must also stay within 2 GiB. Linux
`getrusage().ru_maxrss` uses KiB, so the shim multiplies by 1024. A lower helper
RSS does not establish lower combined Node/helper memory or physical disk I/O.

## Build and package

Supply the same verified
archives already used by the existing native/WASM build; this helper never
downloads dependencies or discovers system codec libraries.

| Archive         | Pinned source                                                                                         | SHA-256                                                            |
| --------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `source.tar.gz` | [libultrahdr v2.0.2](https://codeload.github.com/google/libultrahdr/tar.gz/refs/tags/v2.0.2)          | `aa8d193bb887c348c419780511dd03b374f4e07af8812b6d3f80c8537cf1ef2c` |
| `jpeg.tar.gz`   | [libjpeg-turbo 3.1.0](https://codeload.github.com/libjpeg-turbo/libjpeg-turbo/tar.gz/refs/tags/3.1.0) | `35fec2e1ddfb05ecf6d93e50bc57c1e54bc81c16d611ddf6eff73fff266d8285` |

```sh
IRODORI_CODEC_ARCHIVE_DIR=/absolute/path/to/verified-archive-directory \
IRODORI_CODEC_CARGO=/home/linuxbrew/.linuxbrew/bin/cargo \
npm run build:export-native
```

Prerequisites are the existing Rust toolchain, C/C++ compiler, CMake, make, NASM
and tar. `CXX`, `CC`, `AR`, `IRODORI_CODEC_CMAKE` and `IRODORI_CODEC_CARGO` select
executables, never shell commands. The script uses Cargo's committed dependency
lockfile with `--locked --offline`. It extracts into a fresh ignored artifact
directory and preserves build commands, source/archive hashes, tool versions and
the executable hash. The original bridge and source archives are unchanged;
upstream's maximum four encoder threads, accurate integer DCT, best-quality
preset, full-resolution multichannel ISO map and existing license notices stay
in force. There is no fast-math flag or runtime codec download.

Linux x64 application builds require the checksummed executable; a missing helper
fails the build with the native-build command. Generated runtime files go to the ignored
`vendor/ultrahdr/native/linux-x64/` directory. The existing Electron build copies
that directory beside the isolated workers. Preserve executable permissions,
`SHA256SUMS`, `build-manifest.json` and all existing `vendor/ultrahdr/licenses/`
notices in packaging. The adapter checks the executable digest before launch.

## Acceptance status

Linux x64 Auto now selects the checksummed native encoder. Missing, corrupt,
non-executable or failed helpers produce an explicit capability/start/job error;
there is no automatic Linux WASM encoder retry. The explicit
`IRODORI_EXPORT_ENCODER=wasm` control remains for matched diagnostics. The WASM
runtime also remains the separate production ISO HDR JPEG import decoder.
Other-platform behavior is outside this Bazzite acceptance phase.

The registered `export-native` target covers unchanged independent HDR
reconstruction tolerances at quality 100/90/80, primary/ICC/EXIF identity,
checksums, allocation rejection, default Linux selection and helper failures.
`export-native-fullsize` checks one real 5422 × 3622 Sony rendition: both codecs
receive identical frozen binary16/JPEG inputs and content headroom. The complete
encoded JPEGs matched byte-for-byte; complete decoded binary16 images matched at
headrooms 1, 2 and 4. Independent sampled reconstruction retained its existing
0.02 limit. The native helper measured 981,585,920 bytes peak RSS; WASM measured
842,203,136 bytes linear-heap capacity. Those are different metrics, not evidence
of a combined-memory reduction.

The matched 40-export native cohort passed both unchanged benchmark cases.
Fresh/subsequent/warm-working p95 values were 3671/3731/3080 ms versus WASM
6705/6648/5857 ms; first-20 medians were 3663 versus 6377 ms. Retained retry p95
was 4209 versus 7130 ms; retry overhead has no under-four-second claim. Frozen
build proof, full-size parity, failed controls and invocation counts are retained
in the [phase ledger](../../docs/bazzite-native-engine.md).

The selected `export-native`, `export-context` and `hdr-presentation-cache`
invocation passed 448 checks with no failures/skips in 29.98 seconds, including
static/build checks. Existing process-group cancellation still owns descendants,
leases and scratch. Actual native background interaction, combined resource
measurement and the later corrected-rendering performance run remain separate
pending acceptance; the whole 0.2.0 objective is not complete.

Historical Linux evidence in [pipeline research](../../docs/performance-research.md)
identifies median 3640 ms HDR encoding within a 6536 ms neutral export. Its
256 × 192 codec study and separate LibRaw CPU study do not establish full-size
application gains for this candidate.

## Matched full-size application benchmark

The existing `export-benchmark` target now accepts one benchmark-only selector:
`IRODORI_EXPORT_BENCHMARK_ENCODER=native|wasm`. Unset selects native, preserving the
suite's existing encoder expectation; every other value, including an empty
value or `auto`, is rejected. Each test sets the existing `IRODORI_EXPORT_ENCODER`
worker override to the selected explicit mode and restores its previous value
afterward. Linux application Auto now requires native. This benchmark selector remains an
explicit control, and fallback cannot satisfy either selected series.

Run separate coordinator-owned invocations sequentially against the same frozen
source/build/settings. No reduced-size or shorter-sample profile is provided:

```sh
IRODORI_EXPORT_BENCHMARK_ENCODER=wasm npm run benchmark:export
IRODORI_EXPORT_BENCHMARK_ENCODER=native npm run benchmark:export
```

The two existing cases retain exactly 40 exports per complete invocation:

| Case                           | Unchanged sample series                                    | Existing latency gate                                        |
| ------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------ |
| Original decode                | 10 `fresh-workers` + 10 `subsequent`                       | Each series p95 ≤ 4,000 ms                                   |
| Working-source reuse and retry | 10 `warm-working-source` + 10 `retained-preparation-retry` | Warm-source p95 ≤ 4,000 ms; retry p95 is reported separately |

Both original-decode series still use fresh isolated workers for each output;
“subsequent” permits uncontrolled OS/driver cache benefits, not a persistent
encoder. Warm-source samples lease and validate the prepared working asset.
Retry samples still interrupt after completed preparation, discard the encoder
worker and require one retained-preparation retry; ordinary and warm-source
samples require zero retries. Quality 100, original 5422 × 3622 geometry,
non-progressive 4:4:4 JPEG, frozen edits, source integrity, durable publication,
scratch cleanup, 2 GiB encoder and 1 GiB GPU bounds remain unchanged. A baseline
that misses a four-second gate remains a failed baseline.

Native selection requires the actual compiled worker bundle's platform helper
and checksummed executable. Absence is an explicit platform/helper skip;
corrupted checksums fail. WASM selection requires only the verified common WASM
bundle and asserts actual `encoder: 'wasm'`, without requiring or inspecting a
native helper. Native selection asserts `encoder: 'native'`; neither permits an
encoder fallback. Both retain the GPU source/rendition assertions.

The JSON evidence retains the selector and inherited worker mode, expected and
actual encoder attribution, planned counts, input/source/compiled-worker and
codec hashes, hardware/runtime provenance, per-file diagnostics and completed
publication timings. Native `encoderMemory` is helper peak process RSS, whereas
WASM reports linear-heap capacity; the existing bound does not certify combined
Node/helper peak RSS, total app memory, foreground interaction or native decode
performance. Those remain separate acceptance measurements.

Primary contracts: [pinned Ultra HDR C API](https://github.com/google/libultrahdr/blob/v2.0.2/ultrahdr_api.h),
[bounded encoder threads](https://github.com/google/libultrahdr/blob/v2.0.2/lib/src/jpegr.cpp),
[JPEG DCT and SIMD behavior](https://github.com/libjpeg-turbo/libjpeg-turbo/blob/3.1.0/README.md),
[Linux resource units](https://man7.org/linux/man-pages/man2/getrusage.2.html), and
[Rust FFI ownership](https://doc.rust-lang.org/nomicon/ffi.html).
