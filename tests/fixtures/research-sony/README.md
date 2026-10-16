# Reproducible Sony research originals

These fifteen user-supplied Sony ZV-1A 12-bit compressed ARW photographs are
unchanged copies from SD card `BA61-2D83/DCIM/100MSDCF`, retained in Git at the
user's explicit request for repeatable Luma benchmarks on Linux and Mac. Their
combined size is 312,617,984 bytes (298.1 MiB). No source file is synthesized,
repeated, resized, or metadata-stripped.

The user authorized repository inclusion and project testing on multiple
devices. This is not a CC0 grant or another general open-content license, and
unrelated reuse is not authorized by this fixture notice. Earlier ignored local
fixture manifests described these photographs as private; the user's subsequent
instruction on October 16, 2026 authorizes this particular committed research
set. Other local photographs retain their existing restrictions.

[manifest.json](manifest.json) records every original's SHA-256, byte count,
selected numeric EXIF/capture facts, and LibRaw metadata dimensions. Hashes were
checked against both the SD-card originals before/after copying and the earlier
local fixture manifest. Camera RAW storage is 5504 × 3672; active sensor data is
5496 × 3672. The HDR triple has LibRaw flip 5 and is portrait after orientation;
the noise burst has flip 0. Final lens-corrected merge crops are determined by
processing, rather than assumed from catalog or EXIF JPEG dimensions.

| Sequence      | Distinct originals    | Capture facts                                                                                                                     | Intended coverage                                                                |
| ------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `hdr-brk`     | `DSC03243`–`DSC03245` | 2026-09-11, one continuous three-frame BRK trigger, f/4.5, 25.7 mm; shutter/ISO vary; effective EVs relative to first are 0/−2/+2 | Native RAW HDR preparation, automatic alignment, review, publication and restart |
| `noise-burst` | `DSC03246`–`DSC03257` | 2026-10-04, manual f/4, 1/125 s, ISO 400, 9.4 mm continuous burst                                                                 | Existing 2/3/5/9-source distinct-original cold noise-stack benchmarks            |

The twelve-frame noise burst does not establish larger HDR-bracket quality or
32-frame behavior. The three-frame HDR bracket cannot fill 5/9-source HDR cases.
Metadata exposure offsets alone do not establish recovered radiance or image
quality; preserve the existing measured-exposure, alignment and numerical gates.

Run these commands from the repository after the normal Node/Electron setup:

```sh
node scripts/research/sony-fixtures.mjs check
node scripts/research/sony-fixtures.mjs noise -- node scripts/verify.mjs --target merge-benchmark
node scripts/research/sony-fixtures.mjs hdr -- node scripts/verify.mjs --target merge-raw
node scripts/research/sony-fixtures.mjs hdr -- node scripts/verify.mjs --foreground --target merge-raw-ui
```

The wrapper resolves paths relative to the checkout, verifies all fifteen hashes
before and after each invocation, and supplies `LUMA_MERGE_SONY_SEQUENCE`,
`LUMA_MERGE_SONY_MODE` and the actual HDR `LUMA_MERGE_BRACKETS`. Existing test
harnesses create isolated libraries and profiles. The wrapper preserves command
exit status (including incomplete verification), records integrity evidence
under ignored `artifacts/fixture-integrity/`, and does not alter production
defaults or test thresholds. It also accepts existing focused rerun commands
after `--`; keep their original environment and read verification summaries
first. Use `noise` for the complete `merge-benchmark` target: `hdr` only has three
sources and cannot satisfy that target's required five/nine-source cases.

Distributed subsets from the full twelve-frame burst are:

| Count | Original numbers                                              |
| ----- | ------------------------------------------------------------- |
| 2     | 03246, 03257                                                  |
| 3     | 03246, 03252, 03257                                           |
| 5     | 03246, 03249, 03252, 03254, 03257                             |
| 9     | 03246, 03247, 03249, 03250, 03252, 03253, 03254, 03256, 03257 |

These selections differ from historical trials using only the first nine
originals. Preserve that distinction when comparing alignment and timing.
