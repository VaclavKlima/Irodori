# Select Sky and Select Background

[Issue #86](https://github.com/VaclavKlima/Irodori/issues/86) adds dedicated automatic
choices to **Masks → Create mask**, generated-base refinement and compound
Add/Subtract/Intersect/replace menus. The same application API and
`irodori_create_object_selection` MCP command accept `selection: "sky"` or
`"background"` without points or boxes. Guided Select object remains available.

## Editable proposals

Generation uses the confirmed canonical source before creative local edits. Sky
keeps all predicted sky regions, including disconnected openings, without a
largest-component filter. Background separates the salient foreground subject
from its surroundings; it is not depth selection, sky replacement or measured
transparent alpha. Model labels are predictions and may need correction.

Every result is a proposal with a visible overlay. **Use mask** waits for actual
coverage presentation and publishes one photo-wide Undo step. Inspect at Fit and
100% before accepting. Normal pan/zoom remains available during automatic
inspection, including middle-button panning. The action stays visible at the
1100 × 700 minimum with Console open. No automatic acceptance or new shortcuts
are introduced.

Accepted coverage becomes a normal immutable native-size R8 base. Inversion,
Paint/Erase, Feather, Expand/Contract, local Light/Color and compound operations
use existing mask processing. Refining sky/background replaces only the selected
generated base: manual corrections, operators, adjustments, name and order remain
independent. Existing masks do not require inference after restart or for frozen
export. No catalog/settings migration is needed.

The service preserves frozen photo/revision/grid/destination checks. Selection
changes, deletion, shutdown and cancellation drain the owned worker and discard
unpublished files. No-sky, unseparated foreground/background, corrupt model bytes,
unsupported dimensions, resource refusal and GPU failures explain the result and
preserve accepted settings. Retry uses a new GPU worker; CPU fallback is disabled.

## Common processing and resources

The existing native ONNX Runtime Node **1.31.1 WebGPU** worker owns both pinned
FP32 models. Sky uses Mask2Former Swin Tiny ADE20K (512² input, 128² semantic grid).
The **same model** processes color and luminance views sequentially; the union of
their sky labels avoids missing strongly orange sky. Background uses unchanged
BiRefNet Lite (1024² input/logits), inverted after sigmoid. ImageNet normalization
and antialiased bilinear preparation run on the common GPU path. Model buffers
are released on accept/cancel or before switching model kinds.

RGB guided reconstruction estimates local linear coefficients on the model grid,
using radius 8 and epsilon 0.001, then evaluates them against native RGB. This
improves branches and thin boundaries without enlarging a coarse binary mask.
It is an internal automatic-selection stage. The general user-operated Refine
Edge study/implementation [#77](https://github.com/VaclavKlima/Irodori/issues/77) /
[#78](https://github.com/VaclavKlima/Irodori/issues/78) remain separate.

Source bounds remain 32 MP and 8192 pixels per side. Admission includes the
existing source reservation, a 1 GiB opaque model allowance, actual preprocessing
and guided-filter buffers, and a 2 GiB host allowance. Sequential phases use their
maximum, not their sum; there is no automatic resolution reduction. The actual
20 MP RAW case estimates about 2456 MiB GPU memory and is refused at a 2 GiB
budget. Qualification uses a **4 GiB custom GPU budget** on the 24 GiB RX 7900 XTX,
under the user's higher-memory allowance. Global budget policy is unchanged.

Detailed soft coverage needs more encoded space than binary SAM masks: the
per-base transfer cap increases from 8 to **16 MiB**, under that same allowance.
The 32 MiB combined retained photo-content and 256 MiB coverage-atlas bounds stay
fixed. Oversized results are refused before publication. Existing mask-stack
admission still accounts for decoded coverage and the raster presentation cap.

Both MIT licenses, source revisions, official checkpoint digests, compatibility
changes and every chunk/graph hash ship in the [model bundle](../../assets/app/object-selection/automatic/README.md).
The additional offline payload is 353,762,781 compressed bytes. Setup never
downloads models or runs Python. The [research recipe](../../scripts/research/sky-selection/README.md)
reproduces the qualified sky graph and documents independent references.

## Photographic coverage and acceptance limits

The [licensed, privacy-reviewed sample set](../../assets/tests/images/raster/wikimedia/sky-selection/README.md)
contains unchanged originals for sunny blue sky through needles/leaves, orange
sunset through branches, storm clouds/trees and an architectural skybridge outline.
Existing mountain-ridge golden-hour horizon, no-sky mug and bird foreground cases
provide simple-sky and background controls. The original red-sunset color-only
failure is retained in ignored research evidence; both color/luminance views are
required by the delivered sky policy. Explicit orange-sky and tree-interior probes
guard that regression.

These cases do not certify every weather, architecture or tree. Native review
still shows partial coverage on some fine branches/foliage and flare-adjacent
foreground. Blue glazing/reflections are ambiguous; physical transparency and
dense open-truss architecture remain unqualified. Use the editable overlay and
Paint/Erase when needed; whole-mask softness is not recovered fine detail.

Official PyTorch weights versus native WebGPU pass the fixed absolute + relative
`1e-3` gate on 7,372,800 sky and 1,048,576 background values, with zero class/threshold
flips. Original versus compatible sky graph also passes. Frozen independent Torch
sampling retains `1e-6` RGB error, and RGB guided reconstruction retains a one-byte
OpenCV/Float64 gate. These numerical checks do not establish photographic quality.

Registered targets are `automatic-selection-model`, `automatic-selection-gpu`,
`automatic-selection-ui`, `automatic-selection-presentation-ui` (foreground), and
`automatic-selection-raw-hdr`. Affected legacy object-selection and mask-store
checks remain required. The RAW/HDR target uses actual Sony forest-bracket originals
and a genuine three-RAW master, local controls/corrections/crop, frozen SDR/HDR
exports and restart. The original independent HDR decoder check failed at 0.042
versus the unchanged 0.02 bound on the merged-master export.
That failure is fixed: upstream's exact inverse-transfer and gain formulas replace
coarse decoder lookup tables, while encoding stays unchanged. The identical
retained JPEG now has maximum error 0.00353. HDR JPEG source identity v2 invalidates
old decoded caches. A separate exact-alpha check exposed half-byte rounding in
Float32 SDR proof packing; integer mantissa arithmetic now matches the independent
Float64 byte oracle exactly, including Float32(0.7) and boundary probes. HDR output
identity v7 invalidates affected proofs. Both Radeon adapters pass that exact-alpha
case. The complete actual RAW/three-RAW-master workflow subsequently passes,
including unchanged frozen output gates and restart. Failed inputs, exported bytes
and decoder diagnostics remain in ignored evidence.

Focused local evidence (November 13, Bazzite Linux x64 / RX 7900 XTX and Radeon 610M):

| Selection                                                                         | Result                                                                 | Evidence                                                                               |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Automatic model/GPU/UI, legacy object service/worker/MCP, mask model/store/edges  | 1101 passed, 0 failed/skipped; 150.61 s, including shared cheap checks | `artifacts/verification/2026-11-13T12-56-42.741Z-check-9fsNzp/summary.md`              |
| Foreground automatic Fit/100%/pan with Console, legacy guides and Sunflower       | 1072 passed, 0 failed/skipped; 99.69 s, including shared cheap checks  | `artifacts/verification/2026-11-13T12-59-32.170Z-check-N1riJE/summary.md`              |
| Integrated Radeon automatic GPU pixels, native outputs, provider and cancellation | 4 passed; 54.1 s; ORT independently witnesses PCI `0000:18:00.0`       | `artifacts/sky-selection/integrated-gpu.log` and `integrated-official-comparison.json` |
| Native encoder, HDR JPEG roundtrip and HDR content GPU after precision fixes      | 16 passed; 6.7 s; shared cheap checks also pass                        | `artifacts/verification/2026-11-13T13-07-50.154Z-check-dM4gQX/raw-gpu.log`             |
| Exact actual RAW/HDR rerun after revision-fenced preview-cancellation handling    | 1 passed; approximately 96 s                                           | `artifacts/sky-selection/raw-hdr-final-exact-rerun.log`                                |

The final registered `automatic-selection-raw-hdr` invocation passes **1069 tests,
0 failed/skipped in 159.00 s**, including shared cheap checks:
`artifacts/verification/2026-11-13T13-16-36.540Z-check-b4RyiB/summary.md`.

The combined HDR invocation above remains a failed record because its subsequent
RAW/HDR case encountered expected cross-photo preview cancellation. The exact
rerun waits for the foreground view and retries only that cancellation while
retaining the frozen revision; expected context errors now cross IPC without
fatal main-process console logging. Final registered RAW/HDR evidence is recorded
on issue #86. No failed invocation is promoted to a pass. Routine invocations
exceeded 60 seconds; slow-case details remain linked, with no assertions removed.

The normal development window was reopened through orderly shutdown and reports
the new automatic capabilities, the 16 MiB base cap and a ready photo. Its existing
6144 MiB GPU setting was preserved. Console retains its explicit Resume/New choice;
no test imports or mask edits were made in the user's library.

Current-device receipts and final target counts are recorded with issue #86.
macOS qualification is tracked in
[#118](https://github.com/VaclavKlima/Irodori/issues/118), with Windows x64 retained
in [#125](https://github.com/VaclavKlima/Irodori/issues/125); local Radeon evidence
does not imply cross-platform acceptance.

## macOS qualification — November 16, 2026

[#118](https://github.com/VaclavKlima/Irodori/issues/118) records local acceptance
on macOS 26.7 (25G229), Apple M4 Pro and 24 GiB unified memory. Work started from
clean main `148e1fc6b50c71b3d024100747a64e09f299a361`. This revision includes the
qualification tooling, tests and this record. The verified default-branch
publication receipt is maintained on #118. Windows x64 remains with
[#125](https://github.com/VaclavKlima/Irodori/issues/125).

The common bundled Node 24.20.0 / ONNX Runtime 1.31.1 native WebGPU path passes
both models. Node profiles contain only `WebGpuExecutionProvider`, with CPU
inference fallback disabled. The system identifies Apple M4 Pro hardware; native
ORT physical-adapter activity is not independently observable through the
Linux-only DRM witness on Mac. A separate Dawn adapter does not prove that
physical identity. No platform-specific processing backend was added.

The native mask host was rebuilt using the retained Rust 1.90.0 toolchain. The
accepted C++ HDR codec remains unchanged. The RAW/HDR test profile records
automatic RAM/GPU settings before selecting a **4096 MiB custom GPU budget**;
automatic RAM remains selected at **6 GiB**. The automatic GPU policy starts at
its **2 GiB unknown-capacity fallback** (`adapter-unverified`); the custom 4 GiB
setting is a managed budget, not measured dedicated GPU capacity. The user's
library and resource preferences are untouched. Admission still reserves the
automatic model/host allowances and uses the maximum sequential phase. Source
limits, 16 MiB encoded bases, 32 MiB
photo content and the 256 MiB atlas bound are unchanged. New tests verify exact
memory boundaries, refusal before decoding/inference and oversized-result refusal
without publishing history or replacing accepted coverage.

### Numerical and functional evidence

The [reproducible official-weight harness](../../scripts/research/sky-selection/README.md#reproducible-mac-official-weight-qualification)
uses authenticated official weights in isolated Python 3.12.16, CPU FP32/eval,
and the identical GPU-prepared input tensors. It covers Treesky, orange sunset
and storm clouds in both color and luminance, plus robin foreground/background
separation. This is a newly identified seven-input cohort; it does not relabel
the historical Radeon comparison tensors. Every one of **15,794,176 values**
passes `1e-3 + 1e-3 * abs(reference)`, with **zero sky/foreground label flips**.
Maximum sky absolute error is `6.68e-6`; the background maximum is `0.0014191`,
within its relative gate (maximum gate ratio `0.14379`). Independent preprocessing
retains `1e-6` RGB, and guided reconstruction retains its one-byte reference bound.

Reconciled local acceptance contains **104 distinct selected passing cases** and
**1,009 distinct shared cheap checks**, with no unresolved Mac failure. **37
Linux-only cases remain unavailable**: 34 native RAW executable checks and three
native codec checks. Original registered invocations retain their failed or
incomplete status; exact successful reruns resolve the applicable failures rather
than changing those receipts into clean passes.

| Selection / receipt                                                         | Result and duration                                                                    |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Initial model/service/mask/UI registered batch                              | 1,081 passed, one new Background test setup failure, 34 Linux-only skips; 112.59 s     |
| Exact corrected Background UI                                               | 1 passed, no skips; 16.72 s                                                            |
| Automatic GPU/reference, RAW/HDR, legacy worker/MCP and HDR precision batch | 1,092 passed, two fixture/prerequisite failures, 37 Linux-only skips; 127.70 s         |
| Exact corrected Background MCP                                              | 1 passed, no skips; 4.06 s                                                             |
| Exact RAW/HDR with the independent JPEG prerequisite                        | 1 passed, no skips; 93.98 s                                                            |
| Foreground automatic presentation, legacy object UI and Sunflower           | 1,073 passed, no failures, 34 Linux-only skips; 84.62 s; invocation remains incomplete |

Sky and Background both have explicit proposal inspection, root acceptance,
independent corrections/refinement, history/restart and native Fit/100%/pan
coverage. Shared service cases exercise both automatic modes through
Add/Subtract/Intersect, nested destinations and starting-source replacement,
preserving manual chains, controls, inversion, names, Texture and unrelated mask
order. Real Background compound insertion/replacement and the managed MCP
intersection use the existing owners. Deterministic model cases cover
unseparated predictions, inversion, disconnected sky and first-label ties.

The genuine Sony single-RAW/three-RAW HDR-master case exercises **Sky**, crop,
local Light/Color/edges, manual corrections, frozen SDR/HDR exports and restart.
Original bytes are unchanged. HDR JPEG/content/native codec cases pass the
unchanged **0.02** independent reconstruction bound and exact alpha assertions.
The JPEG acceptance reader requires actual `pkg-config` discovery of
`libturbojpeg 3.2.0` and Python 3 ctypes; missing prerequisites are not substituted
with the application decoder. This Mac used the existing 3.2.0 library and an
isolated pkgconf tool. Test fixture errors (Coverage-tab ownership, explicit
`replacePrimary`, and the managed `.jpeg` filename) were corrected without
changing product behavior. The only production edit extracts the unchanged
logit-to-coverage reduction for deterministic tests; pixel policy, public API,
persisted settings and rendering identities remain unchanged.

### Native photographic review and limits

Native compositor captures at **1100 × 700**, DPR 2, with Console open were
reviewed for both actions at Fit and 100%, after middle-button pan and with local
Light applied. Coverage remains registered and Use mask stays visible. The
canonical six-scene cohort also has reviewed Fit overlays and unresampled native
crops: golden horizon, blue needles, orange branches, storm treeline,
architectural outline and robin background. Sky openings and the background
orientation are useful and editable; fine needles/branches, textured foreground
and flare-adjacent areas retain partial coverage and can need Paint/Erase.
Architectural/glazing ambiguity, fine-edge matting, physical transparency and
physical HDR/color calibration are not certified.

Bounded local index:
`artifacts/sky-selection/2026-11-16-macos-qualification/{summary.md,details.md,result.json}`.
It links the exact registered runs, corrected reruns, retained failures,
environment/resource/provider records, reference tensors and native review.
Routine selections exceeded 60 seconds; slow-case details remain in the original
reports, without removed assertions or performance claims. No comprehensive
checkpoint, Windows qualification or live installed-Codex client acceptance was
performed. The verified default-branch delivery and issue completion are recorded
in #118.
