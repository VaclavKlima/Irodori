# Compound mask coverage

[Issue #85](https://github.com/VaclavKlima/Irodori/issues/85) owns this deliverable.
The [Sunflower study](../design/mask-compounds.html) was reviewed and approved on
November 10, 2026, including nested groups at 1100 × 700 with Console open.
Other-device acceptance is tracked in [#99](https://github.com/VaclavKlima/Irodori/issues/99).

## Coverage ownership and order

Each root mask owns its entire coverage tree. Its starting source is a brush,
generated object base or analytic linear/radial gradient, followed by its
primary brush chain. Ordered child operands combine their completed coverage
using Add `max(A, B)`, Subtract `A * (1 - B)` or Intersect `A * B`. Disabled
operands are skipped. A separate result brush chain follows composition; inversion,
Expand/Contract and Feather finish the node. A child contributes that completed
result, including its inversion and edges. Starting coverage stays fixed when
operands reorder; clearing it leaves an empty brush without changing child order.

Copying coverage retains internal grouping, sources, editable geometry, operations,
corrections, inversion and edges with fresh component IDs. Stroke chunks and
object-base bytes remain immutable and may be shared. Copies retain no source
mask dependency. Light and Color belong only to the destination root and blend
once using the completed coverage. Global copy/paste still preserves destination
spatial masks.

Limits include disabled nodes: 32 root masks, 32 nodes per root, 256 nodes per
photograph and depth 8 (the root is depth 1). Existing stroke, point, immutable
content, atlas, Float32 and image-memory budgets remain in force. A workload
that exceeds a limit is refused before execution; GPU failure reports its reason
without equivalent CPU processing.

## Application and Console contracts

`MaskOperation` adds `component-add`, `component-copy`, `component-update`,
`component-duplicate`, `component-remove` and `component-reorder`. All include the
destination root `id`. `componentId` addresses a node; optional `parentId` defaults
to the root. Reordering lists every operand of that parent exactly once.
Geometry, inversion and edges support explicit component targets. A stroke uses
`strokeTarget: 'primary' | 'result'`; omitted targets address the root result.
Each accepted mutation is one shared photo-wide Undo step.

Object selection freezes a `new-mask`, `new-component` or `replace-component`
target before source preparation and inference. The destination is revalidated
before generation, after inference and at acceptance. Proposals preview the
complete destination mask. Acceptance changes only that frozen object base or
inserts that new operand, preserving existing corrections, grouping and root
adjustments. The legacy `maskId` request still refines the root. Explicit starting-source
replacement adds `replacePrimary: true` to a `replace-component` target; this
allows a gradient source to become an object base atomically at acceptance.
Ordinary object refinement still refuses a gradient. Cancellation leaves the
original source and both correction chains untouched. MCP exposes
these explicit destinations through `selectionTarget`; acceptance supplies only
the proposal and expected photo revision, so it cannot retarget a proposal.

## Processing and compatibility

A bounded postfix coverage program is shared by WGSL and GLSL. Neutral-edge
geometry remains analytic. Edge-enabled nodes prepare in postorder using the
existing GPU edge stage; prepared coverage replaces the entire node subtree,
including its source, operands, corrections and inversion. Unchanged subtree
pixel identities reuse prepared content across label and unrelated sibling edits.
Admission accounts for the complete preparation workload before GPU execution.
Cancellation and source/revision checks retain their existing owners. Temporary
edge previews accept bounded mutations against the main-owned confirmed snapshot;
they resolve immutable content without publishing chunks, settings or history.
Stale or cancelled drafts cannot replace the confirmed preview or commit a part.

Settings 17 migrate to 18 and catalog 27 to 28. Every mask gains empty operands
and an empty result-correction head without moving the original primary strokes.
History branches, revisions, cursors, timestamps and immutable assets are
preserved. Settings-17 presets and frozen jobs remain readable. Rendering and
edge identities advance to distinguish compound coverage.

## Focused verification

The registered `mask-compound-model`, `mask-compound-gpu`,
`mask-compound-webgl`, `mask-compound-photographic` and `mask-compound-ui` targets
cover the feature alongside affected mask service/MCP, object-selection, migration
and gradient/edge regressions. Exact current-device receipts are recorded below
after acceptance. Work in progress is not an acceptance claim.

The photographic check uses the committed, hash-verified flamingo/water source,
actual object inference and editable manual corrections, then subtracts an
independent editable copy from radial darkening. Destination edges stay neutral
for protection inspection. Fit and 100% feather/leg/water crops remain private
verification artifacts. Node-edge boundary spreading is tested separately.
Automatic matting improvements remain in #78; range masks remain in #63.
No comprehensive checkpoint or benchmark is implied by focused passes.

### Retained implementation evidence

- Actual flamingo inference, independent copied protection, neutral destination
  edges, Fit/100% inspection and SDR proof/export, plus actual discrete GLSL:
  2 passed, 9.3 s,
  `artifacts/verification/playwright-1794334258716-bd0ce002-78f3-40a7-8bfd-ebbaae8f0856/`.
  Bird body/head/leg patches remain within two code values; water darkens by
  more than eight. The original dark feather outline and coarse SAM boundaries
  remain; these checks do not establish fine-edge matting quality.
- Real forest SDR and Sony RAW HDR frozen output/restart: 1 passed, 20.4 s,
  `artifacts/verification/playwright-1794334412047-482a8576-9f3e-4527-8dea-a8238a3e3950/`.
  Proof/export agreement retains the existing two-code and independent HDR
  reconstruction gates; later source edits do not change the frozen copy.
- Native edge/subtree replacement and independent parent-edge oracle, including
  a separate hard protection boundary that demonstrates later edge spreading:
  integrated RADV Raphael/Mendocino 2 passed, 1.74 s,
  `artifacts/verification/playwright-1794334580633-faef2351-4d9d-4d2e-8e15-ab2d32571e36/`;
  RX 7900 XTX/RADV Navi31 2 passed, 1.77 s,
  `artifacts/verification/playwright-1794334595295-c93ee7df-d8c9-48b8-a7bb-b2179d8e9faf/`.
  Adapter witnesses are retained in test annotations. GLSL/ANGLE remained on
  RX 7900 XTX even with process-local adapter selection; integrated WebGL is
  incomplete in #99.

Earlier sandbox GPU/localhost restrictions, formatting/lint failures, a legacy
fixture carrying new fields, a fixture's unbuilt worker path, and an unsuitable
soft-boundary amplitude witness remain preserved in their original artifact
folders. Fixes rerun the failed cases; none change established numerical gates.
These receipts cover their named targets only. Final scoped UI acceptance is
recorded separately.

### Final focused Bazzite acceptance — November 10, 2026

`artifacts/verification/2026-11-10T18-42-29.433Z-check-jjDF57/summary.md`:
**1,110 passed, zero failures/skips/incomplete cases, 220.02 seconds**. All eight
stages pass: type checking, lint, formatting, production build, Node, service,
foreground Electron and native GPU groups. The selection contains 25 explicit
targets (134 including cheap checks): all five compound targets; masks model,
service, MCP, rendering, crop and UI; object-selection service, MCP and UI;
edge model/service/GPU/UI; gradient model/GPU/WebGL/UI; catalog migration,
presets service and Sunflower fidelity. No benchmark or comprehensive scope ran.
The duration warning reflects this deliberate combined selection; its ten slowest
cases were reviewed, with frozen real SDR/HDR/restart at 17.66 seconds longest.
No assertions, quality gates or resource budgets were reduced.

The approved study matches the implemented hierarchy and independent scrolling.
Native 1100 × 700 Console-open acceptance includes nested expansion, both
keyboard and pointer reordering, overlay inspection, visible draft pixels through
active destination edges, cancellation and restart. Accepted object proposals
retain their explicit target. Numeric edge text drafts keep their original local
behavior until commit; new brush/gradient coverage drafts use the main-owned
transient preparation path. Same-photo foreground presentation cannot cancel a
revision-fenced native geometry admission read. Root navigation remains usable
while preview work settles and waits for pending valid edits.

Earlier failed reports remain preserved, including the final-batch React drag
marker lint, legacy contract expectations and four UI regressions in
`2026-11-10T18-30-11.884Z-check-OKosRa`,
`2026-11-10T18-31-14.292Z-check-0STnVq` and
`2026-11-10T18-33-59.033Z-check-6igqJC`. Each failed case was rerun after its
correction before the complete final focused selection passed. Test setup now
waits for authoritative frame revisions and scrolls to controls below the new
parts section; value, history and viewport assertions remain in force.

This receipt records local acceptance before publication, based on `bc238bf`.
Verified default-branch delivery and the published commit are recorded in
[issue #85](https://github.com/VaclavKlima/Irodori/issues/85). The separately
accepted desktop input work belongs to #98; this receipt covers only the selected
compound-mask targets.
macOS, Windows, integrated WebGL, live signed-in Console and physical HDR
luminance remain unverified; see #99. Existing automatic selection fine-edge
quality limits remain #78.
