# Agent editing workflow

[Issue #111](https://github.com/VaclavKlima/Irodori/issues/111) owns photographic
judgment and workflow. [#112](https://github.com/VaclavKlima/Irodori/issues/112)
owns photo-bound presentation context, and
[#113](https://github.com/VaclavKlima/Irodori/issues/113) owns existing-mask
inspection. Implementation and focused Bazzite technical checks are complete.
The midpoint taste review is complete. After comparing both palettes, the user
preferred and accepted the original bolder yellow forest for this creative case;
the reduced-yellow version felt washed out. Delivery status is recorded in #111.
The user also accepted the private guardian and Halloween group results;
their photographs and local evidence are excluded from publication.
Deterministic tests establish contracts; they do not establish photographic taste.
Other-device qualification is tracked in
[#114](https://github.com/VaclavKlima/Irodori/issues/114); Bazzite evidence does
not establish a macOS or Windows pass.

## Photographic decisions

For a fresh photograph and a broad request, the agent chooses and applies a
coherent natural or expressive direction. Strong changes and useful composition
edits are welcome when they serve the subject. Existing creative work and a
broad request require a choice between refining the current look and making a
new interpretation. An explicit style or precise follow-up supplies that choice.
Direction comes from conversation; there is no fixed style catalog or new mode UI.

The standing instructions prioritize subject, visual hierarchy, mood and intended
output. Tool choice follows that intent. Related global edits form coherent
partial patches; mask batches remain separate ordinary Undo steps. No exact
slider recipe, mandatory tool count or whole-turn transaction is imposed.

The initial edited photo preview is the historical comparison for the turn.
Neutral Before is a rendition of the confirmed revision with current geometry,
not a saved earlier grade. Confirmed results need appropriate visual review;
noise, detail and mask boundaries need native regions. An explicit SDR destination
needs an actual SDR output proof while preserving the HDR master and workspace
preference. SDR inspection never proves physical HDR output.

Missing capabilities are explained with a relevant in-conversation feature
request. Independent authorized work can proceed. A requested local effect must
not silently become a global substitute. Frozen targets, normal hook trust,
revision checks, resource refusal, cancellation and shared Undo/Redo remain the
application's existing owners.

## Read-only tools

`irodori_get_editing_guidance({topic})` returns versioned operator guidance,
limitations, related tools and valid templates for one of twelve topics: tone,
color, white balance, crop, brush/object/range/compound masks, detail, inspection,
export and presets. Detailed mechanics are retrieved on demand. Live capabilities
and complete tool schemas remain authoritative. Guidance still passes normal
managed-request validation.

`irodori_get_photo_presentation_context({photoId,expectedRevision})` reads live
display ownership without source decoding or changing the workspace. The target
includes requested preference, mode, generation, color space, headroom and reason.
A frame report is attributed only when primary preview and display presentation
both match this photo/revision and the current target generation. Otherwise its
status is `not-current`. Presented, loading and failed reports retain their actual
mode and backend. Physical output is unverified; HDR image-delivery qualification
is reported separately. Full HDR qualification remains
[#82](https://github.com/VaclavKlima/Irodori/issues/82).

`irodori_get_mask_preview({photoId,expectedRevision,maskId,view?,inspection?})`
inspects a confirmed existing root as coverage, SDR orange overlay, or a matched
pair (the default). It uses the current cropped photo grid, lens/flip mapping and
shared GPU mask program, including inversion, compounds, ranges and edge controls.
The stored shape remains inspectable when the root is disabled or its adjustments
are neutral; metadata explicitly reports both states. Disabled operands keep their
normal composition semantics. It never changes selection, drafts or edit history.

Mask inspection uses lossless PNG, a default 1024-pixel fit without enlargement,
optional grid-bound region/resolution, and photo-native 100%. The existing 8 MiB
image / 16 MiB pair limits apply without silent reduction. GPU/resource errors are
explicit. Jobs cancel on request interruption, removal and shutdown, and temporary
files retain their disk reservation until cleanup completes.

## Six-photo evaluation

The immutable baseline is commit
`5c7dc11b617ecb388f92309475d638873a20b058`, captured before implementation with
its compiled output, policy hash and MCP source. The baseline has 43 managed
tools and 12,193 UTF-8 production-instruction bytes. Bytes are not model tokens.

Both variants use the same installed CLI, model, effort, prompts, originals and
initial settings. A separate signed-in profile and isolated managed library
protect the user's normal library and conversation. Authentication stays in place
and is never copied into evidence. Each scenario starts a fresh conversation;
one precise follow-up also exercises explicit Resume. Model calls are opt-in and
never part of ordinary CI.

| Case                | Input and decision exercised                                                                                                        |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Forest HDR          | Tracked Sony DSC03277/78/79 bracket, reproducibly merged using v4; fresh broad direction, HDR master and SDR inspection distinction |
| Fog and dogs        | Tracked DSC03280 RAW; fresh broad interpretation, atmosphere, important subjects and composition                                    |
| Flamingo reflection | Tracked licensed raster; expressive color, local attention and feather/reflection preservation                                      |
| Bicycle             | Tracked licensed raster with a seeded creative grade; clarify refine/reinterpret and preserve unrelated work                        |
| Mug                 | Tracked licensed raster; natural product finish, actual SDR JPEG proof, precise warmth-only follow-up after Resume                  |
| High ISO            | Tracked DSC03489 RAW; native texture review and truthful unavailable local noise reduction                                          |

Private artifacts retain initial/confirmed settings, full-photo and native-region
proofs, requested/reported presentation context, outcomes, timings and actual
Codex usage when available. Usage extraction deduplicates cumulative records;
cached and uncached input remain separate. The evaluation records missing evidence
as incomplete. Exact slider values are not a quality score.

The midpoint gallery compares initial, baseline and candidate photos for user
taste feedback. That review led to the focused refinement and artistic selection
recorded below. Contract failures require correction, while visual preferences
guide refinement. Technical tests alone do not establish photographic acceptance.

## Bazzite midpoint checkpoint — November 12, 2026

The baseline and candidate each completed six fresh conversations and eight
editing turns using Codex CLI 0.167.2 and `gpt-6.1-sol`, with the same configured
CLI-default effort. Runtime effort metadata was absent, so no specific internal
reasoning effort is asserted. All six initial settings and encoded overview
images matched exactly across variants, including the independently recreated
v4 HDR master.

| Observed measurement                 | Baseline | Candidate |
| ------------------------------------ | -------: | --------: |
| Standing instruction UTF-8 bytes     |   12,193 |     5,758 |
| Managed tools                        |       43 |        46 |
| Input tokens, including cached input |  702,943 |   575,821 |
| Cached input tokens                  |  560,896 |   415,616 |
| Uncached input tokens                |  142,047 |   160,205 |
| Output tokens                        |    4,827 |     4,725 |
| Actual MCP calls                     |       46 |        69 |
| Failed MCP calls                     |        5 |         0 |
| Sum of eight observed turn durations | 223.61 s |  221.65 s |

These are one paired run, not a performance benchmark or a cost-saving claim.
Uncached input increased despite lower total input. All five baseline errors were
mask mutations in the bicycle case; the candidate chose a different editing
path without masks, so zero errors does not qualify every possible operator.
Native `exec` orchestration is counted separately from actual MCP calls. Internal
provider schema loading is not inferred from inventory size or wrapper counts.

The candidate asked before changing the bicycle's existing creative treatment;
the baseline changed that treatment immediately. Both used an actual SDR JPEG
proof for the mug and retained its precise warmth follow-up as RGB curve changes
without changing unrelated settings. The candidate inspected the high-ISO photo,
left it unchanged when background-only noise reduction was unavailable, and made
a concrete masked-noise-reduction request. No whole-image substitute was applied.
The candidate also inspected feather detail at native resolution. These recorded
behaviors support contract acceptance. The completed midpoint review identified
specific refinement needs; it did not establish photographic acceptance across
all six cases.

Focused evidence reconciles 1,104 distinct passing cases from the explicit agent,
presentation, guidance, session, preset and mask selections, using each case's
latest result. Initial failures and exact reruns remain retained. The real raster,
Sony RAW and production merged-HDR cases preserve edits, complete history and the
settled workspace during mask inspection. Their barriers wait for the exact
presented photo/revision and persisted view rather than ignoring pending changes.
Four additional small GPU cases pass on the integrated Radeon adapter, with
actual RADV Raphael-Mendocino execution metadata; the primary checks execute on
RX 7900 XTX, Mesa 26.2.6. Integrated Electron presentation and physical HDR are
not established by these compute checks.

A separate one-turn signed-in client probe completed the new mask-preview tool,
delivered both actual PNG images and preserved exact settings/history. The agent
correctly described coverage from the image despite a misleading mask name,
distinguished the orange overlay from the applied exposure, and explained that
the complete grade does not isolate the individual mask's contribution. Its
read-only single-mask bypass suggestion remains a future preview enhancement;
no temporary variant or bypass feature was added here. This probe is separate
from the paired eight-turn quality measurements above.

Local, ignored evidence:

- `artifacts/agent-evaluation/issue-111/verification-checkpoint/summary.md` and
  `reconciled.json` retain selected targets, counts, original failures/reruns,
  durations and source reports. Static checks, candidate build and final test
  type/lint/format checks pass; the required native HDR mask host was rebuilt.
- `artifacts/agent-evaluation/issue-111/baseline-run-3/` and
  `candidate-run-1/` retain actual private transcripts, usage, confirmed settings,
  native crops and Undo/Redo restoration. Earlier harness attempts made no model
  requests and are retained as incomplete.
- `artifacts/agent-evaluation/issue-111/midpoint-review-2/gallery.html` provides
  36 initial/baseline/candidate overview and native-region images. All image
  bytes are embedded unchanged so isolated HTML previews do not need access to
  sibling directories. An isolated-browser check reproduces 0/36 loaded images
  with the original relative links and verifies 36/36 with the portable page.
  The earlier gallery URL was also updated; its original HTML is retained as
  `midpoint-review-1/gallery.external-assets.html`. The gallery is SDR evidence,
  including HDR sources.
- `artifacts/agent-evaluation/issue-111/baseline-assessment-2/assessment.json`
  reprocesses retained metadata without another model call.
- `artifacts/agent-evaluation/issue-111/mask-probe-run-1794510090337/summary.md`
  retains the separate actual-client mask qualification. No credentials are
  copied into evidence or Git.

The midpoint review is complete and led to the focused work below. No general
photographic-quality pass, other-device acceptance or default-branch publication
is claimed.

## Focused refinement and artistic case — November 12, 2026

After the midpoint review, the user approved refining subject visibility in the
dogs and canopy emphasis in the autumn forest. The core now explicitly checks
important faces/features and subject separation at intended viewing size,
preserves lighting mood and naturally dark materials, justifies local edits and
crops, and compares the confirmed result before declaring it finished. Validation
rejections direct the agent to guidance instead of successive guessed payloads.
The focused live passes below used 6,406 UTF-8 production-instruction bytes.

The five earlier bicycle failures used invalid mask operation shapes. On-demand
guidance now supplies complete flat neutral-root creation followed by a separate
same-UUID update within one batch, including an executable radial/Light example.
Paint/Erase schema improvements remain in #107; this adds guidance without
changing those schemas or the processing backend.

The same broad requests were retried only on the dogs and autumn forest, after
ordinary Undo restored saved initial settings in the isolated library. Those
results stayed restrained. One precise follow-up per case then successfully
created and refined two local masks, inspecting actual coverage and native
detail. Only `maskStack` changed during each follow-up: crop and every global
setting were preserved. The dogs' faces become more visible, with source noise
and softness still apparent. Warm leaves separate more clearly from greens, but
the bright sky and foreground fence remain compositional influences. These are
modest SDR improvements, not recovered detail or universal autonomous judgment.

The user also requested a stronger artistic case and authorized choosing a
suitable source. The development debugging endpoint was not listening, so the
existing tracked `tests/fixtures/photos/forest-light.jpg` was used instead of
changing the user's library or downloading another image. It is Sebastian
Unrau's _Entering another dimension_, with original source and recorded Unsplash
permission in `tests/fixtures/photos/CREDITS.md`. Whole-image inspection found no
people, documents/screens, addresses or contact details; EXIF/XMP and sensitive
metadata tags were absent. SHA-256:
`50634536a3e64206123d631fb8c43d569cb6c78f89958fb53dc375e720a33fd9`.

An explicit artistic request let the agent choose its own mood and palette. It
selected an enchanted forest with three editable masks: warm shafts intersected
with luminance coverage, cooler woodland framing, and reflected forest-floor
light intersected with luminance coverage. It inspected coverage and native
boundaries and reduced excessive mist warmth. One conversational request to go
bolder strengthened the golden opening and cooler/deeper framing; the agent
then moderated electric yellow-green. Framing and original bytes were preserved,
and nothing was exported. The source already contains rays: these masks shape
existing light rather than synthesize new volumetric rays. The bolder glow reduces
separation in faint distant trunks. The user initially preferred the bolder light
and contrast structure while questioning its yellow warmth, which prompted the
color-only comparison below.

The final preference is the original confident light, contrast and warm palette
for this particular artistic forest. Natural photographs still follow their own
lighting, subject and user intent, without a fixed yellow, cinematic or other
palette.

Six controlled turns across these three conversations completed with zero
observed tool errors. All final-state Undo/Redo restoration checks passed. The
additional color-only feedback turn is separate from this six-turn checkpoint. The
affected `agent-policy`, `agent-guidance` and `agent-guidance-mcp` selection passed
1,067 cases in 58.97 seconds, including type/lint/format checks, build and actual
MCP-schema validation of the examples. Existing GPU/source qualification is
reused because no processing algorithm changed; the other four original quality
cases were not rerun and are not claimed as newly qualified.

One additional turn responded to the user's explicit feedback that the bolder
version was too yellowish. This was a user-directed correction, not an automatic
retry. The existing 6,406-byte production instructions handled it without another
policy calibration or prefix. Only local Color on the two warm masks changed,
using relative temperature, tint and saturation units:

| Mask         | Before: temperature / tint / saturation | After: temperature / tint / saturation |
| ------------ | --------------------------------------- | -------------------------------------- |
| Forest floor | 45 / 6 / -12                            | 20 / 4 / -18                           |
| Light shafts | 65 / 8 / 18                             | 25 / 5 / -8                            |

The cool framing mask, all mask Light values and geometry/coverage, crop, global
settings and grading luminance remained unchanged. Original bytes and Undo/Redo
restoration were preserved, with zero observed MCP errors. The agent checked
overviews, native regions and mask inspection images. These checks establish
technical preservation during the requested color-only correction. On review,
the user rejected the reduced-yellow version as washed out and preferred and
accepted the original bolder yellow result for this creative case. The rejected
attempt and its successful preservation checks remain retained.

The first candidate build is retained at
`artifacts/agent-evaluation/issue-111/candidate-v1-build/`. Exact prompts, settings,
histories, source provenance, private transcripts and actual mask images are in
the `refinement-fog-dogs-*`, `refinement-forest-hdr-*` and `artistic-*` directories.
The self-contained 30-image comparison is
`artifacts/agent-evaluation/issue-111/refinement-review-1/gallery.html`; an isolated
browser loaded all 30 embedded images with external requests blocked. It retains
the original six-turn comparison, before the color-only correction. Its
`summary.md` and `review.json` link the six source results and preserved-setting
checks. The midpoint feedback and preference for stronger light and contrast are
recorded. The additional correction is retained in
`artifacts/agent-evaluation/issue-111/artistic-color-feedback-1/`, including
`preservation-check.json`, actual client evidence and its self-contained gallery.
The accepted artistic checkpoint is
`artifacts/agent-evaluation/issue-111/artistic-followup-1794513475892/`.
The preferred state was restored through one ordinary Undo in the isolated
library, with an exact settings match and the rejected variation retained for
Redo. No additional model call or runtime-policy change was needed. Evidence:
`artifacts/agent-evaluation/issue-111/preferred-artistic-selection-1/summary.md`.
This also records a useful distinction: unchanged numeric Light controls do not
guarantee unchanged perceived richness after a color correction. Default-branch
delivery is tracked in #111. The user authorized the dogs
and autumn-forest refinements without a general photographic-quality sign-off;
the artistic selection does not establish universal quality or other-device
acceptance.

The focused less-yellow comparison is
`artifacts/agent-evaluation/issue-111/palette-review-1/gallery.html`: six embedded
images at overview and native light/foliage scales. All six load in an isolated
browser with external requests blocked. Its `review.json` links the unchanged
lighting/coverage proof and actual user-feedback result.

## Private object and group exercises — November 12, 2026

The user requested another scene with clear objects and a portrait/group example,
then explicitly authorized use of their own photographs. A read-only pass over
the development library selected a woodland stone guardian and a three-person
indoor Halloween group. Byte-identical copies were imported normally into the
existing isolated evaluation profile. These are private interactive exercises,
not new public fixtures or reproducible benchmark inputs; publication permission
is not assumed. Existing source-library edits are preserved.

Each case used one fresh artistic prompt with the unchanged production policy,
Codex CLI 0.167.2 and `gpt-6.1-sol`; effort metadata remains unavailable. The agent
chose its palette and local treatment rather than receiving a slider recipe.

- The guardian uses four masks: accepted object coverage for the stone, local
  face light, jade woodland depth and distant layers. It preserves framing and
  improves subject readability while retaining texture. The artistic change is
  moderate: face/chest lighting is fairly even, rather than strongly directional.
- The group uses four brush masks for the three faces and pumpkin, with a tighter
  nondestructive crop and amber/teal color relationships. Expressions and costumes
  read more clearly, though the vivid backdrop still competes with the people.
  This is a polished expressive portrait, not a radical lighting transformation.

The two turns made 51 actual MCP calls. One group-mask update was rejected with
`Invalid mask update.` The agent consulted guidance and successfully resubmitted
the batch; the rejection and recovery remain in the evidence. This is not a
zero-error result. Clearer typed validation remains separately owned by #107.
Both cases preserve source and managed-original hashes. Final-step Undo/Redo
restores settings, history cursor and snapshots exactly.

The agent requested native detail in both cases. Archived chat payloads contain
ellipsis-shortened JPEG data and cannot independently prove complete native-image
delivery. Those records and failed review-page decoding are retained. Fresh
read-only PNG inspections of the same final settings provide intact guardian
detail and all three faces, without another model prompt or edit. Exact byte
counts, decoded dimensions and unchanged history are verified. This evidence
limitation is not attributed to the production image encoder.

Private results are under
`artifacts/agent-evaluation/issue-111/private-shrine-guardian-1/` and
`private-halloween-group-1/`; fresh detail is in `private-final-detail-1/`.
The self-contained comparison is
`artifacts/agent-evaluation/issue-111/private-artistic-review-1/gallery.html`:
14 embedded images load with external requests blocked. It distinguishes the
fresh detail captures from archived model evidence. All inspection is SDR.
After reviewing both results, the user said "yes both look nice," accepting these
two artistic examples. This resolves their taste review without establishing
universal photographic quality, physical HDR or other-device acceptance.
Delivery is tracked in #111. No processing or policy change, additional model
retry or broad regression run is inferred from this feedback.

## Research basis

The workflow draws on Capture One's discussion of
[tonal hierarchy](https://www.captureone.com/blog/levels-the-most-underrated-tool-in-capture-one),
[intentional color relationships](https://www.captureone.com/blog/applying-color-harmonies-in-capture-one)
and [local Color Editor adjustments](https://support.captureone.com/hc/en-us/articles/360007944857-Making-local-adjustments-with-the-Color-Editor).
Adobe's [retouching guidance](https://helpx.adobe.com/lightroom-classic/desktop/process-and-develop-photos/retouch-photos.html)
and [Develop documentation](https://helpx.adobe.com/lightroom-classic/desktop/process-and-develop-photos/develop-module-options.html)
inform native detail review and destination proofing. These support intent and
inspection discipline, not a universal style or exposure formula.

Codex's [MCP configuration](https://learn.chatgpt.com/docs/extend/mcp),
[hook trust](https://learn.chatgpt.com/docs/hooks) and
[changelog](https://learn.chatgpt.com/docs/changelog) inform compatibility and
discovery. This change preserves the installed CLI's native discovery; it adds
neither a custom tool-search layer nor a provider migration.
