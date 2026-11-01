# C14: complete chroma patch estimation

C13 passed its first two edges but failed four other required edge cases. Its
larger matching patch does not qualify that operator. Preserve every previous
failure, original input, estimator and quality gate. Public NR v1 remains
unchanged.

## Evidence and one prospective change

The reviewed boundary-weight diagnostic reconstructs 1,024 method-owner pairs
from retained C12/C13 sources, without a denoiser import or new RGB frame. At
the failing row 0 right boundary, same-column mass increases from 66.1% to
98.2%; other same-side columns decrease from 32.0% to 0.86%. Cross-edge mass
also decreases. The corresponding target retains almost all of that column's
entering chroma error. In row 5, C12's clean cross-edge transport explains much
of its failure; C13 reduces that transport but retains column noise. This is
a measured trade in two examined sources, not a general statistical claim.

Clean geometry explains a possible limitation. With matching radius 2 and
target/gather radius 1, all centers contributing to the first edge column
straddle the clean step. The old radius 1/1 operator includes a flat-side
matching center that can average other columns. Increasing only the chroma
target/gather radius to 2 restores such a center while retaining C13's larger
matching patch. It restores only one of five horizontal center families, versus
one of three in C12. Improvement is a hypothesis; neither less residual noise
nor the 3% limit follows automatically.

The [primary patchwise NLM formulation](https://www.ipol.im/pub/art/2011/bcm_nlm/revisions/2011-09-13/bcm_nlm.htm#patchwise-implementation)
estimates all corresponding samples of each matched patch and aggregates its
overlapping estimates. It supports investigating complete patches. Our separate
channels, signed/HDR coordinates, variance inputs and strength policy differ;
the paper does not validate this authored operator. No third-party code is
imported.

## Fixed equations and stage contract

Relative to C13, change only chroma's estimated target and outer gathering
from 3x3 to 5x5. Keep chroma matching 5x5, uniform search radius 10, both
noise-corrected distances, .024 bandwidth base, k .40, frozen global estimator,
strength transfer, self/alpha rules and stable inverse. Do not add pilot
guidance, confidence weights, a self cap or a coefficient sweep.

Luminance retains its original matching radius 1, target/gather radius 1,
Gaussian search radius 3 and arithmetic. The CPU prototype may reuse the
unchanged C9 luminance-only computation with the same frozen estimator; use
its feature proposal and original stage words, never its rounded output RGB.
Nonzero chroma must not change those luminance proposals or published words.
C=0 dispatches the exact unchanged C9 route.

For each actual center c and valid target t=c+r, chroma r spans [-2,2]^2.
Use the existing chroma weight W(c,d) and target-specific alpha at
v=clamp(t+d). Independently normalize both opponent deltas for each target,
round each to Float32 and canonicalize stage zeros. Invalid or transparent
targets publish zero. Gather the published estimates from actual visible
centers c=p-r, weighted by alpha(c), with separate C and L denominators.
Apply the existing own-strength blend once after each component's gather.
Do not clamp an outside center into the image.

The active stage has 59 Float32 scalars per center: first nine luminance words
in row-major 3x3 order, then 25 A/B pairs in row-major 5x5 order. The C=0 bypass
may retain its physical legacy 27-word stage; reference checking maps its nine
L words into the new semantic layout and separately proves exact legacy words.
The neutral bypass may have no physical stage; do not fabricate legacy words.
Reference metadata uses `stageScalars: 59` and
`stageLayout: l9-row-major-c25-ab-row-major-v1`.
This is research layout metadata, not a public settings change.

Proposal samples still lie within L radius 3 / C radius 10 of their owner,
because v=clamp(p+d). Matching context expands the source halo to
10+2+2=14, or 23 combined with the existing maximum sharpening halo 9.
All storage/admission/cancellation and eventual GPU costs need fresh accounting;
this declaration establishes no performance result.

## Independent arithmetic before quality

The new direct Decimal80 reference must independently enumerate L3/C5 target
and gather supports, exact 59-word publication, alpha/global clamps, signed/HDR
and asymmetric controls. Retain all C13 recipes and add the 31x9 context scene
`full-target-context-halo14`:
owner (12,4), override (26,4), RGBA [.25,.125,.0625,1], exact words
3e800000/3e000000/3d800000/3f800000. The marker is 14 positions from the owner,
outside proposal radius 10 and the old halo 13. Use original frozen variance
and the same primary/control selections; groups are 144 core, 84 alpha,
12 asymmetric and 180 C=0 identity configurations.

Counterfeits using the old chroma target/gather extent or insufficient halo 13
must fail strict pre-final RGB or final RGB comparisons in the new context scene,
not merely metadata/import or stage-shape checks. Keep exact stage comparisons
as well. Retain wrong matching/search/spatial rejection and exact
all-grid luminance and C=0 properties. Existing numerical limits stay unchanged.
Reference generation requires separate source/plan review and approval.

## Unchanged examined screen and remaining gates

[comparison14.json](../../../../../scripts/research/strong-noise/comparison14.json)
retains all 44 exact input/estimator/required-metric records. Complete the two
worst C13 strength-75 regressions first (rows 0/2), then the other six edges
(including prior C12 failures), 24 flats and 12 textures. Every declared stage
must finish all its rows; any required failure stops later stages. Later stages
require exact complete passing receipts, immutable pins/copies and verified
outputs/cleanup. A full screen pass requires all 44 cases and all fixed gates.
The declaration binds C12/C13 rejections and both retained diagnoses, including
the weight ledger. No old failure is reinterpreted as a pass.

Leakage <=3%, unchanged noise/bias, texture 0.90..1.05 and every other existing
gate remain mandatory. Larger target aggregation can change fine texture and
alpha-boundary behavior. Even a complete examined pass still needs the original,
fresh, high-noise and dosage populations, photographs, equivalent GPU/CPU,
compatibility, full-source resources and performance before public adoption.
No C14 generation, quality filtering or adoption is recorded by this declaration.

Original equations and synthetic recipes follow the adjacent CC0-1.0 notice.
