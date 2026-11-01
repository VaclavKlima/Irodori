# Published denoising methods: decision review

## Status — 2026-10-31

The user requested a review of professional research before further denoising
work. C16 remains unaccepted: its GPU prototype passes the small RGB references,
fails the retained edge limit, and gives little visible improvement on the
reviewed ISO 6400 paper/fiber crops at strengths 75 and 100. See the
[review evidence](../professional-editing-handoff.md#real-iso-6400-visual-tradeoff-review).
An isolated trial of an existing Vulkan BM3D implementation now shows materially
stronger grain removal. It is not integrated or accepted; texture, reproducibility
and full-source/domain requirements remain open. See the trial record below.

## Relevant primary research

| Work                                                                                                                                                                                                                                             | What it contributes                                                                                                                                   | Relevance to Irodori                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dabov et al., **BM3D**, IEEE Transactions on Image Processing, 2007: [paper](https://webpages.tuni.fi/foi/GCF-BM3D/BM3D_TIP_2007.pdf)                                                                                                            | Groups similar patches, filters them jointly with transform shrinkage, aggregates overlapping estimates and uses a second collaborative Wiener stage. | A complete classical baseline. C16 uses patch similarities and pilot guidance; it does not implement BM3D's collaborative transform filtering. Borrowing those ideas does not inherit BM3D's quality evidence.                                           |
| Foi et al., **Practical Poissonian-Gaussian noise modeling and fitting for single-image raw-data**, IEEE Transactions on Image Processing, 2008: [paper](https://webpages.tuni.fi/foi/papers/Foi-PoissonianGaussianClippedRaw-2007-IEEE_TIP.pdf) | Models signal-dependent photon noise, stationary sensor disturbances and clipping; estimates parameters from a noisy RAW image.                       | Establishes why realistic noise modelling matters. A single global variance in Irodori's prepared feature space is a different assumption. This is a plausible mismatch to investigate, not a proven diagnosis of C16's failure.                         |
| Zhang et al., **Practical Blind Image Denoising via Swin-Conv-UNet and Data Synthesis**, Machine Intelligence Research, 2023: [paper](https://arxiv.org/abs/2203.13278) and [authors' code](https://github.com/cszn/SCUNet)                      | Learns restoration using a mixed-noise synthesis process that includes sensor/Poisson and other degradations.                                         | A concrete learned-method candidate for a separate decision. Its published RGB results do not prove scene-linear HDR, RAW or AMD/Bazzite compatibility. The authors provide real-image PSNR and GAN variants; their output behavior requires evaluation. |

## Integration and reuse constraints

The [BM3D authors' software page](https://webpages.tuni.fi/foi/GCF-BM3D/) restricts
its supplied software to nonprofit education/scientific research. Do not bundle
that reference implementation as if it were Apache-licensed application code.
An implementation decision must identify appropriate reusable code/terms, its
GPU backend and supported image domain before porting or integration.

SCUNet's repository declares [Apache-2.0](https://github.com/cszn/SCUNet/blob/main/LICENSE).
Individual model-weight redistribution has not been checked here. Its
[example inference script](https://github.com/cszn/SCUNet/blob/main/main_test_scunet_real_application.py)
reads conventional RGB images, converts to a tensor and writes an integer image;
this does not validate an adapter for signed, above-white working pixels. No
SCUNet weights, dependencies or third-party photographs were downloaded or adopted.

The RAW noise paper concerns sensor RAW data. Demosaicing, white balance and lens
resampling change the domain; its equations need a documented placement and
noise-propagation decision before use in the existing prepared-source pipeline.

## Recommended next decision

Select one complete published method with a practical existing implementation
and a feasible GPU route. Compare its expected image domain, licensing and
integration cost first. Use one representative committed RAW crop early, then
expand verification only if the result materially improves the current problem.
Retain independent references and all existing quality gates. Do not launch
another sequence of custom NLM variants or a full CPU implementation.

The optional effort preference remains unanswered. Under the existing editing
goal, the agent stated a bounded working assumption for one small, reversible
trial, with no application integration or costly repair. This is not explicit
approval for a larger rewrite or learned restoration, and does not promise a
one-hour integration. Apply [GPU-only development](../gpu-processing.md) and
[performance/credit tradeoffs](../performance-decisions.md).

## Existing GPU implementation feasibility

Primary-source review on 2026-10-31 found a practical candidate for a bounded
trial. That initial source inspection installed nothing. The subsequent isolated
hardware/photo trial is recorded separately below; neither stage establishes
application acceptance.

| Implementation                                                                                                                                               | Verified reuse route                                                                                                                                                                                                                                                          | Unresolved adoption requirements                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [HolyWu/VapourSynth-bm3dvk2](https://github.com/HolyWu/VapourSynth-bm3dvk2)                                                                                  | Existing Vulkan BM3D with float32 RGB/opponent processing and basic plus reference-guided Wiener estimates. Spatial mode uses `radius=0`. GPL-3.0 family; [PyPI distribution](https://pypi.org/project/vapoursynth-bm3dvk2/) provides Linux x64 wheels; trial pins are below. | Trial below verifies discrete Radeon execution. Full-domain HDR/alpha accuracy, full-source allocations/cancellation and frozen-export reproducibility remain open. Current source and the released wheel must not be treated as the same revision.                                                                             |
| [WolframRhodium/VapourSynth-BM3DCUDA](https://github.com/WolframRhodium/VapourSynth-BM3DCUDA/tree/b28d362665a3eac755b84534650c85795414d50e)                  | Despite its name, the pinned source has a [Linux HIP build targeting gfx1100](https://github.com/WolframRhodium/VapourSynth-BM3DCUDA/blob/b28d362665a3eac755b84534650c85795414d50e/.github/workflows/linux.yml), float32 CBM3D and a Wiener stage. GPL-2.0-or-later source.   | Adds ROCm/HIP and VapourSynth setup. Actual Radeon/Bazzite operation and image-domain correctness remain unverified. It does not justify another handwritten implementation.                                                                                                                                                    |
| [SCUNet with PyTorch](https://github.com/cszn/SCUNet/blob/main/main_test_scunet_real_application.py), or [vs-mlrt](https://github.com/AmusementClub/vs-mlrt) | The authors supply real-image PSNR weights/inference code; ROCm uses [PyTorch's CUDA-facing API](https://docs.pytorch.org/docs/main/notes/hip.html). The existing vs-mlrt wrapper also lists SCUNet and an ncnn/Vulkan backend.                                               | Learned restoration still needs a separate decision. Stock code/default wrappers can choose CPU, and [ncnn permits CPU fallback for unsupported Vulkan layers](https://github.com/Tencent/ncnn/blob/master/docs/how-to-use-and-FAQ/FAQ-ncnn-vulkan.md). GPU-only execution, weight terms and HDR suitability remain unverified. |

The maintained Vulkan candidate is preferred for the first small feasibility
trial because it reuses a complete classical method and could avoid a ROCm
installation. That is an integration assessment, not a measured quality or
development-time claim. Treat it as a separate GPL component under its actual
terms; Irodori's Apache default does not relicense it. Do not bundle anything
before the reuse/distribution decision is concrete.

The older [myrsloik Vulkan fork](https://github.com/myrsloik/Vapoursynth-BM3Dvk)
was archived on 2026-10-28 and directs users to HolyWu's successor. The MIT
[Sampas OpenCL implementation](https://github.com/Sampas/bm3dcl) targets grayscale
8-bit input and documents NVIDIA/CUDA-oriented setup; it is not a ready color/HDR
alternative for this pipeline.

### Pin and first stopping condition

The successor's observed remote HEAD is
`e7899007e1de1ee3e55bc3d14731d87ba6fdaa9c`. Its exact README, package metadata and
license were fetched read-only, hashed and retained in
`artifacts/detail-research/strong-noise/published-method-feasibility-k31bqupd/`.
The pinned package metadata requires VapourSynth 81 or newer. Fresh PyPI metadata
selected distribution 3.0 and VapourSynth 81 for the trial; the earlier source
inspection's reference to release 1.0 is superseded. Distribution files and
dependencies were pinned separately; source HEAD is not assumed to identify the
released binary.

The [pinned README](https://github.com/HolyWu/VapourSynth-bm3dvk2/blob/e7899007e1de1ee3e55bc3d14731d87ba6fdaa9c/README.md)
documents precision/range limits and varying floating-point accumulation;
near-tied matches can amplify variation in the final stage. Reproducibility of
frozen exports is therefore an early eligibility check, alongside the real RAW
crop result. A successful import, a float32 input type or Vulkan support alone
does not establish suitability. If a required property needs a substantial
repair/port, stop and report the cost before expanding the trial.

## Isolated Radeon trial

Evidence: `artifacts/professional-editing/bm3d-vulkan-evaluation-kING07/`.
`review-summary.html` places Before, C16 at 75/100 and both BM3D points together
at native resolution with optional CSS magnification. It references ten unchanged
PNGs; matching Before bytes and 128 × 128 dimensions were verified. Its separate
manifest pins those files without altering either original trial's evidence.
Binary-only, hash-required installation into its private virtual environment
downloaded two wheels totaling 6,624,118 bytes: `vapoursynth-bm3dvk2==3.0`
(GPL-3.0-or-later) and `VapourSynth==81` (LGPL-2.1-or-later). Exact wheels,
metadata, license texts, scripts, logs, binary hashes and outputs are retained.
No source build, global installation, repository dependency or app change was
made. No model weights or new photograph were needed.

The device probe found the RX 7900 XTX and Ryzen integrated Radeon usable, and
also enumerated llvmpipe. Filtering explicitly selected device 0, the RX 7900 XTX
with RADV/Vulkan 1.4.354; llvmpipe was excluded. Upload, basic and Wiener nodes
reported GPU residency, followed by an explicit output download. The integrated
GPU was enumerated only, not tested. CPU orchestration, input/output and display
encoding do not constitute a second denoiser. CPU cache was capped at 64 MiB;
the observed GPU cache limit was 256 MiB. These limits do not prove bounded
full-source operation. Processes exited after each trial.

The committed ISO 6400 `DSC03489.ARW` and its existing verified scene-linear
Rec.2020 preparation supplied two 224 × 224 contexts around the same central
128 × 128 paper/fiber views used for C16. Original/prepared identities, context
hashes and extraction coordinates are recorded. Input RGB was passed unclipped,
including negative fiber values. The 48-pixel diagnostic context is not a proof
of sufficient support or identical block-grid alignment for a full image.
Display uses the existing ACES 2 SDR render and one sRGB encoding; PNG pixels
remain native resolution with optional CSS magnification.

### Fixed baseline and repeat

Spatial `radius=0`, `profile='np'`, opponent-plane sigma `[10,10,10]`, basic
estimate then reference-guided Wiener estimate: two contexts and one fresh-graph
repeat per context. Sigma is the implementation's 8-bit-scale parameter, not the
existing Irodori percentage. An initial callback keyword mismatch was retained
and corrected in the wrapper; no filter code or algorithm was repaired.

Both stages ran on the discrete GPU and all four outputs were finite. Grain
removal is visibly stronger than C16, with substantial fine-fiber softening at
this point. Fresh-graph outputs are **not byte-identical**: maximum observed RGB
differences were 0.000209018588 for paper and 0.000045597533 for fibers. One repeat
does not bound all match-tie/atomic variation. The audit hash is
`e13c16cd6cd12312d9184596c3385f15c92673088ed6051f929b8595f82c3789`;
`comparison.html` contains before/result/repeat views.

### One targeted split check

`split-opp4-10-10-QLASD2/comparison.html` compares before, baseline and
`sigma=[4,10,10]`. Basic/final matching thresholds stayed explicitly at
1200/300, avoiding their automatic change with the first sigma. Exactly two
outputs ran, without further repeats or parameter search. Less filtering on the
first opponent axis retains more visible texture and grain while substantially
reducing colored grain. Smoothing and residual noise remain. This first axis is
a brightness proxy, not certified preservation of scene-linear Rec.2020 Y or an
accepted independent luminance/chroma control contract. Its audit hash is
`0afb2696a80d7dbb2fea5b1d90ce5222dc5887502e3eac01a6b018761696fe4e`.

The user was playing Witcher and permitted hidden GPU work. The 0.838-second
baseline and 1.350-second split wrapper runs are diagnostic observations under
possible contention, not performance acceptance. No foreground check ran.

### Eligibility remains open

The read-only export audit distinguishes reuse from recomputation. Existing
`src/main/export/detail.ts:49–70,112–128` accepts validated immutable filtered
assets and can avoid another filter pass. However, job preparation is scoped to
the job and deleted (`export/jobs.ts:292–298,466–469,640`), merge masters do not
acquire preview-cache leases (`full-previews.ts:2473–2480`), and the acceptance
restart deliberately clears preview caches. The tests require identical JPEG
bytes from separate jobs (`tests/professional-editing-acceptance.spec.ts:247`)
and a new cold master export after restart (`:619–629`), while preserving every
original/master-bundle file. Current cache reuse therefore does not settle the
BM3D cold-rerender requirement. A durable processed asset would be additional
integration work, with regeneration still needing a decision. The observed float
differences alone do not prove those encoded JPEG assertions fail; those app
tests have not run with BM3D. Existing exact cache-regeneration tests cover the
old NR version, not this trial.

### Two-edge eligibility result: failed

`edge-eligibility-dV6MXW/` applies exactly that fixed split point once to each
existing 136 × 136 sRGB/Rec.2020 isoluminant-edge input. Inputs and independent
metric sources were hashed before/after. The evaluator adapter is byte-extracted
from the existing quality test; no metric, limit or input was changed. RGB was
not clamped or converted between primaries. GPU filtering completed and the
process exited, but both cases fail:

| Input    | Color leakage, maximum 0.03 | Width growth, maximum 0.5 pixel | Finite / exact alpha |
| -------- | --------------------------: | ------------------------------: | -------------------- |
| sRGB     |                0.2042834373 |                    1.3719490206 | Pass / pass          |
| Rec.2020 |                0.2106181300 |                    1.4838039893 | Pass / pass          |

Chroma residual RMS is approximately 14.2% of entering noise, accompanied by
excessive boundary smoothing; low residual noise alone is not quality acceptance.
The audit hash is
`f700d40ad78eae36c1b82f7e581bd56206e6e13a13786e6fd1b49898295e9b91`.
Exactly two outputs ran without repeats, parameter search or algorithm repair
(1.61 seconds for the diagnostic wrapper, not performance acceptance).
Recipe strength 75 identifies the old input recipe, not a BM3D control mapping.

The follow-up source audit confirms this is **not a calibrated noise-domain
comparison**. `scripts/research/strong-noise/cases.py:30–39` injects independent
Gaussian noise into the asinh L/A/B features before decoding RGB. The decode
(`scripts/research/detail-candidates.py:31`) uses `Y=.18*sinh(L)` and chroma
scales involving `hypot(Y,.18)*sinh(A/B)`, making RGB noise signal-dependent and
correlated. Plugin sigma denotes OPP-plane strength in an 8-bit scale; passing
RGB unchanged with `[4,10,10]` does not map that feature covariance or primaries.
A local linearization would itself depend on signal and the decode Jacobian.
This missing mapping does not prove the cause of the failed boundaries; it
prevents interpreting the trial as a calibrated general BM3D rejection.

**Decision:** this configuration is ineligible for integration. The bounded
trial is complete and stopped before its one-hour reassessment bound. The result
does not reject every BM3D configuration or the published method. Further work
would need a concrete noise/domain/control mapping and reproducibility decision,
then renewed quality evidence; another blind sigma search is not selected.
Existing photographs suffice for that decision. Keep the main goal active and
strong-noise acceptance open. Photographic protocol closure, full-source
support/resources/cancellation, HDR/signed-range accuracy, general alpha and
dependency distribution also remain unverified. Do not relax existing gates or
start another custom filter research cycle to conceal these limits.

The user selected GPU-only cleanup and remaining Goal 1 checks. Further
denoising research is deferred while that work proceeds; strong-noise acceptance
and the full accepted feature scope remain open. No further parameter point or
replacement integration is selected by this decision.
