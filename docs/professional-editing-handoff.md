# Professional editing checkpoint — 2026-10-30

This checkpoint commits the current implementation for continued work from another
machine. It is not a completed milestone or a release acceptance claim. The
[phased plan](features/professional-editing.md) remains authoritative.

The app is **Irodori — Personal photo editing**. Source, native helpers, vendor
paths, debugging tools and tests use the renamed identity. Settings 11/catalog 21
currently persist inspector state, global Light and color controls, supported
Sony white balance, crop/straighten, eight-range mixer, three-way grading,
version 1 noise reduction, detail sharpening, selective copy/paste and bounded
batch edits. Standard Lanczos3 enlargement is explicit. The console is read-only.

Focused combined RAW/raster/ISO gain-map/genuine v4-merge edit-export-restart,
native keyboard/minimum-size, source/resource checks and selected SDR/HDR
responsiveness checks have retained local evidence. The pre-push reviewed-input
combined run passed 787 checks in 101.2 seconds; the selected HDR responsiveness
retry passed 48 trials in 191.27 seconds. These scopes overlap and are not a full
checkpoint. Detailed limits and dated evidence are recorded in
[the processing ledger](features/professional-editing-processing.md).

Goal 1 remains open for stronger photographic noise removal and remaining
sustained/native acceptance. Goal 2 curves, named presets, output-size proof/output
sharpening and optional FSR evaluation remain pending. Keep masking and separately
scoped backlog work outside this checkpoint's acceptance claims.

The current stronger-NR work is **research only**. The portable equations,
synthetic cases, frozen gates and independently checked Decimal80 reference are in
[scripts/research/strong-noise](../scripts/research/strong-noise/README.md).
Both remaining fixed-width C7 candidates subsequently failed the reserved sigma
.10 colored edge. The two C8 noise-scaled candidates passed the first screen and
old nominal/regression cohorts, then failed the mandatory fresh texture cohort.
**All executed candidates remain rejected under their declared quality protocols.**
Failures and original thresholds are preserved; passing numerical references do
not establish photographic quality. No candidate GPU port, public NR version 2,
settings/catalog migration or method selector is integrated. Existing v1 edits
must keep their original meaning and pixels.

The CPU source-wide noise-estimator foundation is committed with admission,
cancellation and independent Python agreement tests, but no production processing
path selects it. Its source identity/hash are supplied by a caller-owned verified
source lease; the estimator does not authenticate source bytes. Keep the complete
source estimate frozen across tiles, crops and zoom levels when integrating later.

The next research direction is a separately declared larger texture population:
the failed small C8 chart's entering noise already exceeds its clean-relative
amplitude ceiling. The optional population geometry helper in `cases.py` is an
unfinished foundation only. There is no C9 protocol, qualification receipt gate,
runner selection or executed C9 input/output. Before filtering, freeze a separate
protocol and qualify every fresh input without importing candidate code; retain
all accepted original small-chart regressions and every C8 failure. Do not change
noise, amplitudes or acceptance limits to obtain a pass.

Three privacy-reviewed fixture sets are committed unchanged: fog/dogs, a genuine
Sony exposure bracket, and ISO 400/6400/12800 carpet captures. Their manifests retain
hashes, privacy review and limited project-repository permission. Automatic lens
correction prepares the carpet sources at 5422 × 3622; the earlier 5496 × 3672 privacy
decode grid is before that correction. ISO 400 is a lower-noise companion, not
registered/calibrated clean truth. Regenerate working assets from the committed
originals on another machine; generated assets and local evidence are excluded.

Use Node 24 LTS and npm, preserving the lockfile:

```sh
npm ci
npm run setup:electron
npm run dev
```

`npm run dev` opens the normal app and enables development MCP only on
`127.0.0.1:9222`. Production debugging stays disabled. For verification choose
explicit registered targets through `npm run verify -- --target TARGET`, use
isolated hidden profiles by default, and coordinate foreground desktop checks.
Do not run automated imports against a personal library. Comprehensive checks
still require a separately agreed checkpoint.

Screenshots, benchmark outputs, working-image caches, private/excluded historical
photos and local diagnostics remain outside Git. Source-only research is
committed so an offsite feature does not depend on this workstation's artifacts.

The pre-push invocation on 2026-10-30 selected
`professional-editing-acceptance` in background mode: 787 passed, 0 failed, 0 skipped
in 101.2 seconds, including type checking, lint, formatting, build, fast Node
checks and the combined real-source cases. The portable research runner also
reproduced one prior synthetic source/output SHA exactly. No comprehensive
checkpoint was executed.

Subsequent focused verification selected `strong-noise-reference` plus
`strong-noise-scaled-reference`: 790 checks passed in 100.84 seconds, including
all 15 independent numeric recipes for fixed C .040 and both C8 factors. The
separate `strong-noise-estimate` selection passed 793 checks in 41.61 seconds,
including eight estimator cases. These selections overlap in their cheap checks.
They use CPU-only synthetic data and do not certify candidate GPU processing,
photographic quality, full-source estimator throughput or other platforms.

The final publication check combined all three targets in background mode:
**798 passed, 0 failed, 0 skipped in 100.20 seconds**, including type checking,
lint, formatting, build and fast Node checks. A separate source-only comparison
also preserved all 352 existing nominal/regression/fresh recipes exactly against
the earlier published checkpoint. No comprehensive, GPU or foreground check was
added to this publication scope.
