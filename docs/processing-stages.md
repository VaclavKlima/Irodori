# Processing stage inventory

This is the implementation/removal ledger for [backlog #32](features/README.md#workspace-feedback-backlog)
and the [GPU-first policy](gpu-processing.md). One backend means one production
algorithm/owner for a stage on macOS and Bazzite. Host language and execution
hardware are independent. Historical masters, recipes, caches and receipts remain
readable data; keeping them does not keep their retired executors available.

## Owners and removal checkpoints — 2026-11-03

| Stage                                       | Production owner and domains                                                                                             | Capability and resource contract                                                                                                                   | References and remaining checkpoint                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RAW decoding                                | Pinned LibRaw WASM; Linux native RAW source host for admitted sensor work                                                | Verified Sony modes, immutable originals, isolated workers, bounded source/pipe admission, child drainage                                          | Real compressed Sony embedded/decoder cases and native RAW lifecycle references remain. Extending the Linux host to macOS is **not adopted**: the bounded Mac profile spends 138 ms decoding/preparing sensor input versus 805 ms in GPU processing. It does not establish a worthwhile complete-workflow gain from a new native host. The platform split remains unfinished #32 work, not approval of a permanent exception.   |
| Raster / ISO gain-map decode                | sharp/libvips and Ultra HDR WASM in the isolated Node worker                                                             | Auto-orient once, ICC, straight alpha, authored HDR and independent SDR primary; 512 MiB floating-source bound                                     | Existing orientation, HDR JPEG and ISO reconstruction gates. WASM decoding has live consumers and stays bundled.                                                                                                                                                                                                                                                                                                                |
| RAW preparation and proof                   | Dawn `RawGpuRenderer`, then shared `gpu/point-renderer`                                                                  | Camera normalization, WB, lens plan, frozen RAM/VRAM admission; actual GPU faults propagate; a later request replaces a terminal device owner      | Production scalar preparation and proof recovery removed. Frozen CPU oracles live only under `tests/`, including the preview benchmark reference worker. Real RAW failure/retry, dimensions and placeholder identity remain checked.                                                                                                                                                                                            |
| Detail                                      | Shared `detail-bands` / Dawn spatial detail for raster and Rec.2020                                                      | Three strips, frozen admission, exact neutral copies; active alpha below `2^-20` refused                                                           | Explicit CPU overrides and automatic scalar filtering removed. Independent numerical/photo references retained. Source-wide sampled noise estimation stays CPU parameter preparation.                                                                                                                                                                                                                                           |
| Crop / straighten                           | Shared `crop-bands` / Dawn crop filter                                                                                   | Exact identity/integer copies, bounded windows, unchanged coverage floor and classification margin                                                 | Fractional CPU overrides and automatic restart removed. Independent coefficient/geometry references and exact alpha/copy checks remain.                                                                                                                                                                                                                                                                                         |
| HDR presentation                            | Renderer `HdrPresenter` WebGPU                                                                                           | Capability probe, source/target/revision, active authored HDR, drain-before-retry and valid draft flush                                            | Unused CPU presenter/client/worker, pair cache/sink and `preview:cpu-*` IPC removed. Live source capabilities are in `prepared-source.ts`; native mask leases and deletion/shutdown barriers remain.                                                                                                                                                                                                                            |
| Raster presentation                         | `PreviewPresenter` GPU, shared raster adjustment functions                                                               | Authored display semantics, ICC/alpha/orientation, Before/Split identity, bounded frame/canvas ownership                                           | JavaScript image-math presentation worker removed. GPU loss reports its reason and offers Retry GPU. Existing ready RGBA bitmap blits remain inexpensive presentation, not another renderer.                                                                                                                                                                                                                                    |
| Point adjustment / output                   | Shared Dawn `gpu/point-renderer`; shared numerical shader modules used by renderer presentation                          | Raster, authored HDR, scene-linear RAW/merge and prepared inputs; 64-row export/proof strips; separate SDR-primary upload accounted in admission   | Authored inputs bypass scene tone rendering. Raster/scene/authored export CPU renderers and runtime overrides removed. Preview and export retain their own source/presentation/streaming lifetimes. Independent scalar references remain test-only.                                                                                                                                                                             |
| Export resize                               | Dawn Lanczos3 row cache, frozen policy v2                                                                                | Bounded Float64 coefficient preparation, GPU convolution, host/VRAM phase accounting; prior policies refused                                       | Production CPU row resizer removed; exact identity copies and test-only independent resizer retained. Existing Radeon/full-size evidence keeps its original scope; current Bazzite rerun remains required.                                                                                                                                                                                                                      |
| Full HDR clipping masks                     | Common bounded Rust host and C++ Float64 arithmetic on macOS arm64 / Linux x64                                           | Confirmed history, source hash/lease, revision, comparison lineage, display target, receiver reservation, real child close and stream-pin drainage | One Float32 GPU candidate failed exact white/headroom classifications; stopped without changing predicates. Native Mac qualification passes 24 synthetic combinations and both full Sony photographs at every mask mip, including actual Electron primitive checks. Full-image JS mask recovery removed; unsupported hosts report unavailable. Linux recompilation and current Radeon integration remain open.                  |
| Histograms / other analysis                 | Existing GPU HDR interactive histogram; bounded CPU samples/pixel queries; current CPU raster and exact service analysis | Matching source/revision/domain/target; bounded samples and source validation                                                                      | LUT/sample/pixel work stays CPU-owned. Full raster and service analysis plus remaining scalar/native analysis overlap still need a measured consolidation decision. They were not silently replaced after the rejected Float32 candidate.                                                                                                                                                                                       |
| Merge alignment                             | Common OpenCV WASM and analytic CPU geometry                                                                             | Pinned alignment library/pool, cancellation, validated overlap and exact crop/masks                                                                | Accepted owner retained. Rejected camera/reference GPU candidates moved to `scripts/research/merge` and removed from production execution. Their exclusive integration suite was retired; independent candidate math stays outside production bundles.                                                                                                                                                                          |
| Merge source preparation                    | Adopted Dawn preparation, accepted CPU camera/reference preparation and existing WASM SIMD kernels                       | Normalization, source/hash leases, native sensor cache, bounded GPU bytes and CPU geometry                                                         | No GPU preparation failure restarts full CPU preparation. Accepted CPU stages remain. Scalar recovery inside the accepted CPU kernel providers is still a separate removal checkpoint; no new GPU camera/reference experiment was started.                                                                                                                                                                                      |
| Merge coverage / accumulation / composition | Analytic CPU coverage where exact; Dawn dense coverage, warp and accumulation; existing exact CPU mask/composition work  | Exact motion/crop/alpha, immutable reference and reviewed-master publication                                                                       | Adopted GPU stages no longer restart CPU processing. Failed partial accumulations/output are retired. Dense boundary repair, dilation/composition and remaining CPU kernel recovery need their own bounded qualification; they were not changed merely to delete another implementation.                                                                                                                                        |
| Merge review/output conversion              | Existing Dawn streaming converter using shared display math                                                              | One/two bounded slots, original error, drain maps before files/device, exact alpha                                                                 | CPU output conversion and late CPU replay removed. Historical masters stay intact. Retired GPU camera/reference and recorded retired CPU executors report unavailable recomputation; provenance consults the same availability policy. Old incomplete cache/recipe measurements remain a provenance-audit checkpoint.                                                                                                           |
| HDR encoding                                | Native pinned libultrahdr 2.0.2 / libjpeg-turbo 3.1.0; accepted macOS C++ and Linux Rust hosts                           | Immutable mapped inputs, primary identity, full gain geometry, child lifecycle, 2 GiB admission and helper RSS                                     | Backend selected before execution; failed native jobs do not restart WASM encoding. The attempted common Rust host on macOS passed small independent quality cases but failed exact full-size binary16 reconstruction at headrooms 2 and 4. It remains a research bundle, **not a replacement for the accepted Mac C++ host**. Keep that host, native packaging and WASM decode consumers. Common-host acceptance remains open. |

## Qualification and stopping decisions

The rejected GPU mask candidate used the existing Float32 presentation equations.
Three representable neighbours of reference white disagreed with the unchanged
Float64 classification. Evidence:
`artifacts/verification/2026-11-02T14-16-50.812Z-check-xGofq2/summary.md` and its
`qualification.json`. Do not repair pixels, relax the comparison or start another
GPU precision experiment under this checkpoint.

The native macOS mask build uses the same pinned LLVM/ACES sources and non-FMA
arithmetic as Linux. ARM adds the exact pinned `aarch64/nearest_integer.h`; build
receipts include its URL/hash and architecture flags. Actual Electron, not ordinary
Node's different `Math.atan2`, is the UI oracle. The first complete photographic
qualification records zero differing mask/mip bytes for the landscape and portrait:
`artifacts/verification/playwright-1793693999544-19c0e6d3-968c-49bf-b335-5be4ae18b282/playwright/results/` (`native-mask-portability` cases). Working planes, reports
and toolchains stay ignored; their unchanged original photographs are committed.

The common Rust codec-host candidate's retained full-size failure is
`artifacts/verification/2026-11-03T07-44-00.381Z-check-0kCilO/summary.md` and the
linked `fullsize-codec-parity/parity.json`. Native RSS was 895,254,528 bytes;
WASM heap capacity was 842,203,136 bytes. These are different memory measurements,
not combined application peaks. Headroom 1 reconstructed identically; 2 and 4 did
not. No codec algorithm, quality, gate or tolerance changed to admit the candidate.
The macOS Rust builder writes a candidate bundle under its unique ignored build
directory; the normal macOS build retains the accepted C++ host.

The bounded M4 Pro profile records cold import/opening 2,371 ms, a cached revisit
214 ms, merge source preparation 1,058 ms (138 ms decoder/sensor extraction,
920 ms preparation), and two actual 1200-pixel HDR publications at 4,898 / 4,891 ms
(-0.15% repeat change). Export uses identical frozen edits/options and includes
ExportJobs publication. Cold import/opening and cached revisit are different
workflows, not a before/after optimization comparison. The test-process RSS sample
was 615,841,792 bytes, not a family peak. OS file caches were uncontrolled; hidden
Electron completion does not establish physical scanout. This first profile used
WASM encoding while the rejected host was being evaluated, so it does not replace
the accepted native-encoder performance baseline or prove a new speedup.

The accepted native-host follow-up profile is retained under
`artifacts/verification/playwright-1793699622799-eae572ba-77f8-441b-8f25-3f03d9cfab5d/playwright/results/`.
It records 2,941 ms import/opening, 217 ms cached revisit and 4,906 / 3,882 ms
native-codec 1200-pixel publications (-20.88% repeat change). It is still one
observation, not an original-size, quality-100 p95 acceptance or a before/after
optimization claim. The unchanged saved performance gates remain separate.

Prepared HDR proof retry also renews a terminal Dawn owner, without replacing
healthy owners. A real device-destruction regression verifies explicit failure,
original source preservation and a later successful prepared proof. The point
factory checks the borrowed owner's terminal status before entering native Dawn.

## Completion

Focused numerical checks use the already established GPU gates (Float32
`2e-6 + 2e-5 * abs(reference)`, existing packed-output limits), exact copy/alpha
requirements and unchanged photographic references. Former CPU self-equality
checks now compare GPU output to those independent references; cache immutability
and same-backend repeat checks remain byte exact. New targets include
`shared-rendering`, `native-hdr-mask-lifecycle`, `native-mask-portability`,
`export-encoder-selection`, `raster-presentation-lifecycle` and the explicit
`processing-workflow-profile`. The two rejected qualification targets remain
explicit research gates, not routine product acceptance.

#32 remains open. Current Bazzite adapter checks, remaining analysis/CPU-kernel consolidation, decoder
ownership and codec-host qualification are separate evidence/removal checkpoints.
Unavailable hardware is incomplete verification. No comprehensive suite, benchmark
grid, scheduler redesign, new editing feature or denoising research is implied.

## Latest local verification

The final recovery/shared-rendering/provenance/package selection passes 868 cases,
zero failures, 34 platform cases skipped, in 92.16 seconds:
`artifacts/verification/2026-11-03T10-12-03.547Z-check-V5Z4Bq/summary.md`.
It is INCOMPLETE because the Linux-only cases cannot run on macOS. The unsigned
package passes real RAW import, actual SDR export, decoder fallback, restart,
security/runtime checks and absence of retired presentation assets; its minimum
Console-open screenshot was visually inspected.

The earlier 28-target integration invocation passes 992 cases and records two
integration failures (lost Electron page and a timed-out profile):
`artifacts/verification/2026-11-03T09-23-24.652Z-check-VXkUC3/summary.md`.
Both exact cases subsequently pass in an isolated two-case run (about one minute),
with every portrait mask/mip byte matching. Cleanup now drains all owners even if
an oracle page is already closed. The lost-page event was not reproduced; do not
claim a confirmed production cause or convert that invocation into a clean pass.

The committed macOS codec executable/checksum are preserved byte-for-byte. The
attempted Rust host and locally rebuilt C++ observations remain ignored evidence;
no replacement binary is part of this source change. No comprehensive suite,
performance grid or current Bazzite adapter acceptance was run.

The final check with the original committed macOS codec passes 836 cases, zero
failures, 37 platform cases skipped, in 57.44 seconds:
`artifacts/verification/2026-11-03T10-22-54.956Z-check-kOYt95/summary.md`.
Selected targets are `desktop-package`, `export-native` and
`export-encoder-selection`, including cheap checks. Native quality-100/90/80
reconstruction, explicit native selection/failure and packaged startup/import/SDR
export/restart pass. The skipped cases retain their Linux-only contracts. Native
test helpers and isolated Electron processes are closed; generated artifacts and
the rejected candidate bundles are outside version control.
