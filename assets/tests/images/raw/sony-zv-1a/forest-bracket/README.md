# Sony ZV-1A tree-covered outdoor exposure bracket

These three distinct, unchanged camera originals show a tree-covered fenced
outdoor scene with partial building exteriors/roofs, paths and an unlabeled
post/lamp. They form one genuine continuous exposure bracket, rather than
repeated copies of one file. The camera recorded ISO 400, f/4 and 19.18 mm for
all three, with 1/80 s, 1/320 s and 1/20 s exposures respectively.

## Provenance and permitted use

The user supplied these photographs on a camera SD card and, on 2026-10-29,
explicitly requested repository retention of photographic test and benchmark
inputs. This selected, privacy-reviewed bracket may be included in the Irodori
GitHub repository and used for repeatable project testing and benchmarks.
The photographs are not covered by the project's Apache-2.0 code license and
are not CC0. This notice grants no general open-content or unrelated-reuse
license. The exact original bytes and capture facts are in [manifest.json](manifest.json).

| Original                 | Exposure | Metadata EV | Bytes      | SHA-256                                                            |
| ------------------------ | -------- | ----------- | ---------- | ------------------------------------------------------------------ |
| `originals/DSC03277.ARW` | 1/80 s   | 0           | 21,533,696 | `159e5461fceddede2dc9903cb080caf63dcd2e4dc9ef70881b35f1fc65bd91db` |
| `originals/DSC03278.ARW` | 1/320 s  | −2          | 21,242,880 | `d3f8954afbe5f9d1d61ca5bea39d25a04a18143eb8fa1f6360960c4e0cbb1578` |
| `originals/DSC03279.ARW` | 1/20 s   | +2          | 21,242,880 | `e17e3c0ab859945212e031e35e13c241224ed1ccb0f1335de4c0f1fc4dc90f3c` |

The complete set is 64,019,456 bytes. Release-mode and sequence metadata identify
continuous exposure bracketing with indices 1–3 and length 3. The EV labels are
derived from recorded shutter ratios; they are not a radiometric calibration.

## Privacy review

On 2026-10-29, each complete native CPU-decoded scene, both embedded image types
(`PreviewImage` and `ThumbnailImage`), and native-pixel crops of background
openings, walls/fences and the white post/lamp were visually inspected. A second
reviewer independently inspected all three oriented previews and all nine
background crops. No identifiable people, private interiors, readable addresses
or labels, documents/screens, vehicle plates or other personal information were
observed. Scene ownership and exact location are not inferred.

Read-only ExifTool 13.59 inspection included interpreted and unknown EXIF,
XMP/IPTC and maker-note tags (`-n -a -u -G1 -s`). No camera/lens/internal serial,
GPS, private owner-name or contact tags were found. Filenames and this notice
were also reviewed. Originals and embedded previews were not rewritten,
redacted or metadata-stripped; source hashes matched before and after inventory.

## Intended checks and limits

This set supports future native three-source HDR preparation, current-v4 merge
publication/export/restart, foliage/branch detail and merge-boundary checks. Its
presence does not certify those checks or photographic quality. It supplies no
high-ISO noise-reduction proof, noiseless ground truth, calibrated radiance,
portrait-skin coverage, larger five/nine-source group or noise burst.

Storage metadata reports 5504 × 3672 with Orientation 8. The read-only LibRaw
0.22.1-Release privacy decode applied that orientation once and produced
3672 × 5496 before application lens correction, alignment and crop. Consumers
must use authoritative decoded dimensions and must not apply orientation twice.

Keep the originals byte-for-byte unchanged. Keep generated privacy views,
proof crops, caches and benchmark outputs outside Git, and exclude these test
assets from application packages and automatic user-library imports.
