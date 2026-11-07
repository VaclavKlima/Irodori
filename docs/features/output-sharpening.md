# Output sharpening — TODO #48

## Behavior

Custom JPEG export offers **Off**, **Low**, **Standard** and **High** below Size.
Off is the default, including legacy settings and quick exports. Last custom
remembers the choice only when a Custom export is accepted. Proof generation
changes neither preferences nor photo history. Original-size, reduced and enlarged
outputs use the same setting.

Output preview shows the strength used by the displayed JPEG. Changing strength
retains that JPEG with **Preview out of date** until **Update preview**. At 100%,
one output pixel remains one CSS pixel. The ordinary edited photograph and its
saved detail-sharpening controls are independent of this export setting.

## Frozen operator

Reuse the existing protected luminance Gaussian unsharp GPU operator from the
[detail contract](detail-processing.md). Low, Standard and High map to Amount
25, 50 and 75, with Gaussian sigma 1 output pixel, Threshold 50, three-pixel
support and the existing 3% local-range halo limiter. Replicate actual image
edges; tile boundaries use real neighboring pixels. The asinh luminance domain,
stable reconstruction and signed-channel behavior remain unchanged.

The order is saved detail and geometry → point edits/output rendition → linear
Lanczos3 resize when needed → output sharpening → quantization/encoding → gain map.
The independent SDR primary uses sRGB luminance; HDR uses Rec.2020 luminance.
Each rendition is filtered exactly once. Filtering follows existing white
compositing, with opaque alpha; final SDR/HDR packing retains its existing range
and rounding rules. HDR headroom is recomputed after filtering.

Off retains the current native packed fast path and resize behavior. Enabled
native output uses the existing unpacked Float32 rendition, then the same bounded
GPU strip owner as resized output. No additional production processing backend
is introduced. Final-size scratch writes are awaited, allocations use frozen
RAM/VRAM admission, and GPU owners retire between stages. Cancellation and worker
cleanup retain existing source protection and discard only application scratch.

The output operator/preset mapping and stage have distinct frozen versions in
manifests and proof identity. Resize v2 and photo settings/history versions remain
unchanged. Unsupported active policies or GPU/resource failures report their
actual reason; they do not omit sharpening or restart equivalent CPU work.

## Console and compatibility

`ExportOptions.outputSharpening` is optional and accepts `off`, `low`, `standard`
or `high`. Absence resolves to Off; invalid values are refused. Existing version-1
preferences and requests remain readable without a catalog migration.

`irodori_get_export_capabilities` reports modes, default and policy versions.
`irodori_get_output_proof` and `irodori_start_export` accept the same settings.
Proof metadata and `irodori_get_export_results` identify the frozen effective
strength/version. Legacy results without an output policy report Off and a null
version. Existing request IDs, photo targets, preparation/task ownership and
authorized destinations apply unchanged.

The Console uses Standard when sharpening is requested without a strength and
uses export settings for export-only requests. Its proof image remains a bounded
SDR overview; native noise/halo and HDR visual judgments belong to Output preview
at 100%. Updated tools/instructions load through normal Console restart and
Resume/New. Print-paper profiles and advanced output parameters are separate work.

## Acceptance

Focused Bazzite acceptance is complete on November 7, 2026: **995 distinct cases
pass across the retained batches and exact reruns**, with no unresolved selected
failures or deferrals. Counts overlap between invocations and are not additive.
The [summary and receipts](../../artifacts/output-sharpening/2026-11-07-acceptance/summary.md)
preserve failed attempts, corrections, adapter identities and actual native captures.

- Both Radeon adapters pass bounded independent Decimal80, preset noise, halo/seam
  and post-resize/quantization checks. RX 7900 XTX additionally exports the complete
  Sony RAW as a 5422 × 3622 lens-corrected HDR JPEG with both renditions sharpened,
  unchanged original bytes and no resize. Integrated RADV RAPHAEL_MENDOCINO passes
  all eight bounded output-stage cases. Both record Mesa 26.2.6.
- Active raster, authored-HDR, bounded Sony RAW and genuine v4 merge proofs agree
  with independently decoded exports within the existing two SDR code values and
  0.02 linear HDR reconstruction limits. Actual 128- and 768-pixel photograph
  exports, mountain texture, sky boundaries and water/shore native crops retain
  useful detail without obvious objectionable halos in the reviewed examples.
- Managed and standalone SDK clients discover strengths, proof and export using
  the same setting, read back its frozen version and preserve photo history.
  Legacy preferences, interrupted results, Custom acceptance and Last custom
  restart remain covered without a schema migration.
- Native 1100 × 700 Console-open keyboard/pointer-lock checks and actual new
  picker choice/Escape/outside dismissal across refresh periods pass. Final popup
  opening uses native keyboard events; synthetic mouse opening repeatedly lost
  ownership on this host and is not represented as a passing mouse-opening check.
  Sharpened authored HDR/independent SDR presentation, actual GPU device loss/retry
  and retained Editor view pass. Setup stabilizes native geometry before input;
  focus assertions during gestures remain strict.

macOS, Windows, physical mouse/input-device acceptance, physical luminance/color
accuracy and a live signed-in Console model request remain unverified. SDK/gate
success does not establish live-model behavior. Print profiles, advanced controls,
strong-noise removal and comprehensive performance checkpoints remain separate.

The dedicated `export-output-sharpening-gpu` target covers output-stage processing.
Affected export model/resources/context and proof model/service/rendering/UI/MCP
targets retain their existing contracts; native checks require `--foreground`.
Preserve independent numerical tolerances, overshoot/undershoot ≤5%, flat-noise
RMS gain ≤1.10 and soft-edge slope gain ≥5%. Real-photo and SDR/HDR proof/export
comparisons, explicit failures, cancellation and resource cleanup remain required.

The primary [unsharp-mask guidance](https://docs.gimp.org/3.0/en/gimp-filter-unsharp-mask.html)
describes final-resolution sharpening and threshold protection. The preset
mapping and output-stage placement above are Irodori policy, not a claim of
matching another application's operator or photographic calibration.
