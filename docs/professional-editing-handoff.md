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
synthetic cases, frozen gates and unexecuted direct Decimal80 draft are in
[scripts/research/strong-noise](../scripts/research/strong-noise/README.md).
Two narrow patchwise candidates passed the declared nominal/regression/fresh
cohorts; C.040 also passed the selectedσ .08 high-noise cohort. Reserved high-noise
levels/seeds, independent references, candidate GPU/native photographic quality,
versioned integration, resources and performance are still required. Existing
v1 edits must keep their original meaning and pixels.

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
checkpoint or unfinished independent denoiser reference was executed.
