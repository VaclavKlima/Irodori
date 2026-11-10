# Bazzite masking qualification — November 10, 2026

## Status and scope

**Scoped masking checks pass on both Radeon adapters.** This shared record covers the user-selected
combined delivery of [object selection and the Masks workspace, issue #87](https://github.com/VaclavKlima/Irodori/issues/87)
and [whole-mask edge processing, issue #88](https://github.com/VaclavKlima/Irodori/issues/88).
The [reconciled evidence summary](../../artifacts/masking-bazzite/2026-11-10-acceptance/summary.md)
records **1037 distinct logical cases with final passing receipts**, including
shared checks counted once and no deferred cases. RX 7900 XTX has 1037 passing
case receipts and Radeon 610M has 1017, each including common checks; these are
not counts of GPU-only cases. The [structured reconciliation](../../artifacts/masking-bazzite/2026-11-10-acceptance/result.json)
retains the case-level mapping.

An intermittent packaged RAW decoder-close failure occurred before object
selection and was tracked separately in [issue #94](https://github.com/VaclavKlima/Irodori/issues/94).
The later [native startup investigation](../native-raw-startup.md) reproduces and
corrects its joined-thread accounting race. The original failed invocation
remains failed; the masking rerun alone did not establish that correction or
general startup reliability. GitHub owns delivery and completion state; this
ledger preserves the original masking evidence.

The implementation retains one common production backend per stage: pinned
native ONNX Runtime WebGPU SAM 2.1 Tiny inference, Dawn preprocessing and native
coverage reconstruction, and Dawn whole-mask Feather/Expand-Contract. Immutable
generated bases remain separate from ordered Paint/Erase corrections. The
[object-selection brief](object-selection.md), [edge brief](mask-edges.md) and
[local-adjustments brief](local-adjustments.md) retain their earlier Mac evidence
and technical contracts.

## Device and runtime

| Component           | Qualification environment                                     |
| ------------------- | ------------------------------------------------------------- |
| Operating system    | Bazzite 45.20261105, Linux 7.2.15, x64, Wayland               |
| Graphics stack      | RADV / Mesa 26.2.6                                            |
| Application runtime | Electron 44.3.0                                               |
| Inference runtime   | onnxruntime-node 1.31.1, bundled native WebGPU                |
| Worker runtime      | Bundled Node.js 24.20.0, outside Electron                     |
| Development runner  | Node.js 26.13.0 / npm 11.20.0                                 |
| Discrete adapter    | Radeon RX 7900 XTX, PCI 0000:03:00.0, vendor/device 1002:744c |
| Integrated adapter  | Radeon 610M, PCI 0000:18:00.0, vendor/device 1002:164e        |

Adapter qualification uses per-process Mesa selectors:

```sh
DRI_PRIME='pci-0000_03_00_0!' npm run verify -- --target object-selection-worker-gpu
DRI_PRIME='pci-0000_18_00_0!' npm run verify -- --target object-selection-worker-gpu
```

The exclamation mark exposes only the selected Vulkan device. The environment
reaches the owned bundled-Node workers; no desktop-wide GPU setting changes.
Each receipt must identify its actual executing device rather than assuming the
selector succeeded. Foreground cases additionally require an explicit
`--foreground` invocation.

## Delivery changes and verification

The Masks hook now retains the current resolved mask selection alongside its
workspace reference and publishes both synchronously before notifying the
workspace owner. An Adjustments-tab action waiting for a create operation can
therefore retain the accepted new mask instead of restoring an older selection.
The held-IPC regression checks that the subsequent local Exposure edit changes
only the newly created mask. Photo/enabled guards, shared mutation services and
photo-wide history remain in place.

Interaction tests wait for the committed frame geometry revision before sending
brush input. A catalog revision or a ready flag alone does not prove that the
requested frame has been submitted. The shared mask-creation helper also waits
for the new row to become selected before continuing.

Cases that depend on stable native resizing at 1100 × 700 with Console open carry
a reasoned foreground tag on Linux Wayland. Their assertions remain intact;
ordinary compatible cases still run hidden. The shared launcher never retries a
hidden failure visibly. A background selection with deferred foreground cases
remains incomplete under the [background-testing contract](../background-testing.md).

The existing `masks-native` case additionally exercises native edge-value input,
commit, cancellation and Undo while preserving the photograph and pinned
histogram at the minimum size. This uses Electron native event routing, not a
claim about physical input devices. Its native click helper now waits for
actionability and trusted pointer-down, mouse-down and click receipts before
continuing. The corrected exact native case passes; its earlier menu/input
failure remains in the original invocation.

An isolated ORT-only child loads the production pinned graphs and session policy,
profiles one encoder and decoder execution, and records its own Linux DRM
physical-device identity and cumulative GPU-engine counter changes. The
`WebGpuExecutionProvider` profiles establish operator ownership; positive DRM
activity identifies the executing PCI device independently of the separate Dawn
preprocessing owner. Both encoder/decoder profiles identify only
`WebGpuExecutionProvider`; their own DRM witnesses identify `0000:03:00.0` and
`0000:18:00.0` in the respective adapter runs. Both profiles and the bounded JSON report remain in the
invocation artifacts. Cleanup attempts every tensor/session release and retains
original and cleanup failures. These diagnostics do not measure peak physical
RAM/VRAM or establish photographic selection quality.

The extended `desktop-package` case checks the unsigned offline package with an
isolated library: bundled worker/model/runtime resources, a real Sony RAW object
proposal and explicit acceptance, nonneutral mask edges and local Light,
prepared coverage, export, and exact history recovery after restart. This scoped
workflow has passing receipts on both adapters. The integrated adapter's earlier
failure at initial RAW preview import precedes the new SAM step; the successful
exact rerun alone did not resolve that separate source failure; the later
[native startup record](../native-raw-startup.md) owns its correction.

## Focused target mapping

| Coverage                                                                | Registered targets                                                                                         |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Pinned model, geometry, service and durable bases                       | `object-selection-model`, `object-selection-geometry`, `object-selection-service`, `generated-mask-bases`  |
| Native inference, ORT provider/device witness and native base rendering | `object-selection-worker-gpu`, `generated-mask-bases-gpu`                                                  |
| Browser decoding, proposals and actual RAW/HDR presentation             | `generated-mask-bases-webgl`, `object-selection-ui`, `object-selection-presentation-ui`, `masks-rendering` |
| Edge model/migration, service and independent GPU numerics              | `mask-edge-model`, `mask-edge-service`, `mask-edge-gpu`                                                    |
| Edge controls, mask selection/menus/scrolling and shared photo menus    | `mask-edge-ui`, `masks-ui`, `photo-menu-ui`                                                                |
| Managed Console tools, history and frozen output                        | `object-selection-mcp`, `mask-edge-mcp`                                                                    |
| Native Wayland pointer/keyboard/edge input                              | `masks-native`, explicitly foreground                                                                      |
| Native Wayland picker behavior and approved layout fidelity             | `professional-dropdown-native`, explicitly foreground; `sunflower-fidelity`                                |
| Offline installed application workflow                                  | `desktop-package`, explicitly foreground                                                                   |

The [verification registry](../../scripts/verification-plan.ts) owns execution
groups and target selection. `object-selection-model` and `masks-native` require
explicit selection. Device-specific GPU receipts must cover each available
Radeon; portable checks and overlapping completed evidence need not be repeated
merely to increase counts. No comprehensive checkpoint or performance benchmark
is implied by this selection.

## Receipts and retained failures

| Receipt                                                                                                                                                   | Result and interpretation                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [RX 7900 XTX focused run](../../artifacts/verification/2026-11-10T08-33-10.108Z-check-jauVi0/summary.md)                                                  | 1017 passed, 1 native menu/input failure, 229.22 s. Foreground; original invocation remains failed.                                                                           |
| [Corrected exact native rerun](../../artifacts/verification/playwright-1794300174680-ddb7621d-ca2f-489d-9851-8f179c282683/playwright/summary.json)        | 1 case passed, 6.5 s invocation. Actionability and trusted event receipts address the native helper failure.                                                                  |
| [Radeon 610M focused run](../../artifacts/verification/2026-11-10T08-43-33.916Z-check-T9lhlB/summary.md)                                                  | 1016 passed, 1 packaged initial-RAW-preview failure, 213.68 s. Foreground; original invocation remains failed; the later #94 correction is separately recorded.               |
| [Exact packaged rerun on Radeon 610M](../../artifacts/verification/playwright-1794300490043-81fecce8-ba1a-4e25-9692-8d685b705bee/playwright/summary.json) | 1 case passed, 34.2 s invocation. Demonstrates the scoped packaged workflow on that run; does not establish a fix for the earlier RAW failure or general startup reliability. |
| [Earlier failed scoped run](../../artifacts/verification/2026-11-10T08-19-38.031Z-check-3NxKrE/summary.md)                                                | 1003 passed, 8 failed, 416.37 s. Later focused UI receipts resolve those cases; this invocation remains failed.                                                               |
| [Initial sandboxed batch](../../artifacts/verification/2026-11-10T08-11-33.005Z-check-x8EbE8/summary.md)                                                  | Retained sandbox/subprocess failure evidence; no product acceptance is inferred.                                                                                              |

Type checking, lint, formatting and build pass in both focused adapter runs.
Passing scoped receipts cover native Wayland minimum-size input and pickers,
masks/menus, actual RAW/HDR presentation, MCP tools, frozen proof/export, and the
offline packaged selection/edges/export/restart workflow. Counts above overlap;
the aggregate includes their distinct final case receipts without summing
repeated common checks. Verification ran from base revision `811e10e` with local
qualification changes; GitHub owns the subsequent default-branch delivery record.

Exact committed photographic paths and SHA-256 values are recorded in the
[fixture metadata](../../artifacts/masking-bazzite/2026-11-10-acceptance/metadata.json):
`tests/fixtures/sony-zv1.ARW`, `tests/fixtures/photos/forest-light.jpg` and
`assets/tests/images/raw/sony-zv-1a/fog-dogs/originals/DSC03280.ARW`.
Tests use isolated libraries and the shared launcher/profile cleanup owners.
Inspected captures include the [native Console-open minimum](../../artifacts/verification/playwright-1794300174680-ddb7621d-ca2f-489d-9851-8f179c282683/playwright/results/masks-native-native-brush--22b25-ith-Console-at-minimum-size-raw-gpu/masks-minimum-console.png)
and [Masks adjustment layout](../../artifacts/verification/2026-11-10T08-33-10.108Z-check-jauVi0/functional/electron-exclusive/results/masks-ui-mask-menus-readab-a4eec-Console-open-minimum-window-electron/1100-console-masks-adjustments.png),
alongside the retained selection and Sunflower captures. Generated screenshots
remain private and outside Git.

## Device measurements

| Measured phase                       | RX 7900 XTX cold / warm | Radeon 610M cold / warm |
| ------------------------------------ | ----------------------- | ----------------------- |
| 20 MP maximum edge kernel/readback   | 101.99 / 94.89 ms       | 3031.48 / 2987.99 ms    |
| Real-RAW coverage preparation phases | 194.2 / 19.3 ms         | 282.7 / 27.6 ms         |

The 20 MP case retains **14,445,205 explicit GPU bytes** on each adapter and
matching cold/warm R8 hashes. Its kernel/readback timings exclude worker startup
and PNG encoding. The real-RAW timings describe their recorded preparation
phases, not whole model inference or total editing completion. These explicit
allocations and phase timings are not peak physical RAM/VRAM measurements or
sustained performance acceptance. Exact receipts and device metrics are linked
from the [aggregate details](../../artifacts/masking-bazzite/2026-11-10-acceptance/details.md).

## Preserved limits

Model sources remain limited to 32 MP and 8192 pixels per side with six prompt
slots; a box consumes two. Generated bases retain their 8 MiB encoded limit,
32 MiB combined retained content bound and existing mask/stroke limits. Native
coverage atlases remain bounded to 256 MiB, and raster presentation retains its
512 MiB cap. Existing managed admission, cache budgets, numerical tolerances and
quality gates remain unchanged. GPU failures report their actual reason and
permit safe retry without equivalent CPU inference/filter fallback or automatic
quality reduction.

Feather and Expand/Contract shape complete selected coverage; they do not recover
hair, fur, feather or transparent-object detail. Known coarse-edge selection
failures remain documented. Image-guided Refine Edge/matting, new mask types and
local operators, strong-noise quality, sustained performance, physical HDR
luminance and Windows acceptance remain separate work. Digital HDR output and
histogram checks do not certify physical display brightness. The retained Mac
receipts keep their original scope; this Bazzite delivery does not establish
new macOS or Windows acceptance. Live signed-in model interpretation remains
unverified. The passing masking rerun and aggregate did not certify the separate
RAW startup defect as fixed; the subsequent reproduction, correction and focused
receipts are retained in the [native startup record](../native-raw-startup.md).
