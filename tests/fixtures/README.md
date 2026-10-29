# Photo fixtures

`tests/hdr-jpeg.helpers.ts` generates original synthetic gray, white, HDR and color reference charts at runtime. These generated reference pixels are dedicated to the public domain under CC0-1.0, like the export gain-map vectors. User photographs require explicit repository-inclusion permission; the research set below is the authorized exception.

These files are used only by automated tests. Luma never loads them into a user's library automatically.

## Sony research sequences

[research-sony](research-sony/README.md) contains fifteen unchanged Sony ZV-1A SD-card originals: one real three-frame HDR BRK capture and a twelve-frame noise burst. The user explicitly requested repository inclusion for reproducible benchmarks across Linux and Mac. Its manifest records provenance, per-file hashes, recording/capture facts and dimensions; its notice grants no general open-content license. This permission applies only to this set. Other private photographs and generated evidence remain outside Git.

## Sony portrait detail originals

[sony-detail](sony-detail/README.md) contains two unchanged Sony ZV-1A camera
originals selected from the user's SD card for skin, hair and texture checks at
recorded ISO 400 and ISO 6400. The user authorized repository inclusion and project
testing on 2026-10-29. The manifest pins original hashes, bytes, provenance and
capture facts; the photographs retain their separate rights and are not CC0.
Generated crops and measurements remain outside Git.

## Sony ZV-1

`sony-zv1.ARW` is the unmodified **Sony ZV-1, 12-bit compressed, 3:2** sample (original filename `DSC00056.ARW`) published by [raw.pixls.us](https://raw.pixls.us/), record 4000, uploaded July 10, 2020.

- [Download source](https://raw.pixls.us/getfile.php/4000/nice/Sony%20-%20ZV-1%20-%2012bit%2012bit%20compressed%20%283%3A2%29.ARW)
- [Metadata](https://raw.pixls.us/getfile.php/4000/exif/DSC00056.ARW.exif.txt)
- License: [CC0 1.0 / public domain](https://creativecommons.org/publicdomain/zero/1.0/), as recorded in the site's repository catalog.
- SHA-256: `14c9d2912584a3ccc5cf10f554fbe495fc960c36758a14d7d858b36ac5ca88e2`

The fixture is committed so tests run offline. Embedded extraction is deliberately replaced with a failing dependency in the fallback test; LibRaw still decodes the real, unchanged camera file.

## JPEG fixtures

The photographs in `photos/` were moved from the original visual scaffold. See [their retained credits](photos/CREDITS.md) for photographers, sources, and licenses.

## HDR+ engine fixtures

Three original mobile-camera DNG frames and their attribution are in [hdrplus](hdrplus/README.md). They are licensed CC BY-SA 4.0 and remain separate from supported Sony RAW acceptance.

## ACES synthetic reference vectors

`aces-reference.json` contains synthetic numeric results from unmodified ACES 2
CTL at revision `069b0bc3e1f6c62820f19fdae2fecec3f4fc0f80`, adapted independently
to C++ Float64 by `scripts/aces-reference.py`. It records revision and source
hashes, uses no photographs, and is reproducible with
`node scripts/generate-aces-reference.mjs`. The retained reference and license
are in `third_party/aces-core/` (Apache-2.0, Contributors to the ACES Project).

## JPEG gain-map reference vectors

`export-gain-vectors.json` contains original synthetic algebraic reference vectors for an independent Float64 ISO 21496-1 reconstruction oracle. The numeric vectors are dedicated to the public domain under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). They include black offsets, independent channel gains/gamma, partial display headroom and above-white values. No photographic or third-party code content is included. The oracle also reads actual encoded ISO packets and JPEGs independently of the bundled codec; see `tests/export-reference.ts` and `export-rendering.spec.ts`.
