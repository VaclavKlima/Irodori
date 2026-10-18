# GPU camera-evidence experiment

This is isolated research. Production imports none of these files and retains its
existing decoder, camera/lens preparation, registration, accumulation, fallback,
deghosting and publication behavior. No result here establishes a three-RAW merge
under five seconds.

The current pipeline already runs Bayer preparation, RGB/luminance reduction and
native accumulation on GPU. The missing stage studied here is the CPU
`cameraRegistrationWriter`: reconstructing native camera channels from prepared
linear Rec.2020 and producing three conservative reduced alignment planes. Native
camera evidence remains necessary for later registration validation; the prototype
therefore retains every native pixel rather than producing only thumbnails.
Camera-channel evidence is currently used for verified bracket registration; the
ordinary noise path does not pay this writer's cost. The wide-angle noise fixture
is additional lens/input coverage, not a claimed noise-pipeline optimization.
This experiment does not replace the separate CPU highlight-safe fallback
conversion or independent native registration validation.

`camera-study.ts` independently implements two WGSL passes through existing native
Dawn: inverse-camera projection into a resident RGBA32Float texture, followed by
area reduction. The fourth float stores three validity bits, never fusion alpha.
All channels retain signed values. Positive area footprints use integer rational
pixel edges; the strict signal threshold is rounded downward to preserve the CPU
comparison for representable Float32 samples. Arithmetic inside the matrix and
area sums is Float32 and can differ from the production Float64 evaluation.
Working, canonical-mask and native camera textures use 64-row array layers.
Shader coordinates remain global: reduction footprints can read across layers,
and only padded rows beyond the native height are excluded. Each upload supplies
a complete layer, including zero padding in the last layer, through an owned view
of at most 8 MiB. This bounds the subresource that Dawn may internally initialize;
a small source view alone did not bound its full-texture initialization staging.

Canonical sensor clipping, two-pixel dilation, orientation and lens/CA geometry
remain CPU inputs. `camera-oracle.ts` invokes the maintained production writer,
verifies its native strips, and extracts those masks. This deliberately isolates
the scalar writer by setting and restoring `LUMA_MERGE_CPU_KERNEL=scalar` around
the oracle's complete lifetime, independent of the optional WASM preparation.
The comparison isolates
the numerical work: there is no claim that clipping geometry has moved to GPU or
that the production writer's entire cost disappears. A matched CPU numerical
implementation excludes clipping geometry and file I/O as well.

The research suite covers all eight orientations, signed colors, nonidentity
distortion/CA, clipping at edges, fractional area footprints and partial strips.
Two native cases use the committed, unmodified Sony `DSC03245.ARW` and
`DSC03246.ARW`, with their real lens metadata and sensor thresholds. Existing GPU
RGB preparation supplies their input; the renderer is closed before experimental
GPU resources are allocated. Original hashes are verified before and after.

Every native RGB sample and every reduced channel is compared with the current
CPU writer at the unchanged `2e-6 + 2e-5 * abs(reference)` pixel tolerance.
Validity masks must match exactly. Nonfinite values and numeric/mask mismatches
remain failed research assertions, with evidence retained rather than a fallback
or relaxed bound. This tolerance is a pixel comparison, not proof of identical
preparation bytes, registration decisions or master output.

Each case records allocation, compile, bounded upload, one warm-up, three completed
resident runs, optional hardware projection/reduction timestamps, CPU numerical
runs, CPU oracle/mask extraction, and full proof readback/comparison separately.
Resident work excludes RAW decode, existing RGB/lens processing, canonical masks,
hashing, encoding, disk publication and proof readback. GPU timestamp resolve/copy
is included when supported; actual physical VRAM is not measured. The first-evidence
clock records point RSS and process-lifetime peak RSS, without attributing a separate
resident-kernel peak. A fixed 1 GiB logical GPU preflight includes both native textures, mask
texture, final-layer padding, reduced texture, one 64-row readback and optional
query resources. Array layers and readback are checked against requested device
limits. Driver-internal allocations remain outside that explicit logical count;
neither this count nor the transfer bound establishes a physical VRAM cap.
Evidence records requested device limits, layer geometry and maximum upload size.
Calls are single-flight. Cancellation covers allocation admission, upload layers,
post-submission completion and both readback streams. Submitted work drains before
resource release; device loss still releases owned resources. Lifecycle probes
re-prepare complete exact scalar camera evidence after each failure. They do not
establish complete merge recovery for this research candidate.

An additional uninterrupted first-evidence clock includes source integrity,
the complete scalar oracle/canonical-mask extraction, allocation/upload/compilation,
completed GPU work and full native/reduced readback and verification. Native cases
also retain the enclosing RAW inspection/decode/RGB-lens preparation clock. This
deliberately includes duplicate CPU oracle work. Contiguous phase spans, point RSS
and process-lifetime peak RSS remain separate from the warmed resident samples.
`productionSpeedEvidence` stays false: independent registration, fusion, motion
masks, final crop/master, publication and visible workflow gains remain unvalidated.
The candidate stays isolated until that complete path and its recovery are proven.

Run through the coordinator's registered research target, sequentially with other
GPU work:

```sh
npm run verify -- --target research-merge-gpu
```

Structured JSON is written to the invocation's artifact directory and attached
as family `research`. This target is excluded from functional checkpoints.

The architectural references are [Google HDR+](https://research.google/pubs/burst-photography-for-high-dynamic-range-and-low-light-imaging-on-mobile-cameras/),
[Burst Photo](https://github.com/martin-marek/hdr-plus-swift), and
[Google's online CFA reconstruction](https://research.google/pubs/handheld-multi-frame-super-resolution/).
No source code from those projects is copied. This experiment implements neither
HDR+ frequency-domain denoising nor multi-frame CFA reconstruction. Future GPU
clipping, resident alignment and CFA fusion need independent native-detail,
motion, exposure, noise and cross-platform validation before any integration.
