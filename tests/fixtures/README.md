# Photo fixtures

These files are used only by automated tests. Luma never loads them into a user's library automatically.

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
