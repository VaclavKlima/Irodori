# Sony ZV-1A carpet and paper at three ISO settings

These three distinct, unchanged camera RAW originals show carpet fibers beside
blank paper. A narrow defocused dark strip at the upper edge contains generic,
unidentifiable shapes. The set provides real high-ISO texture and flat-region
coverage without identifiable people or personal information.

The user supplied these requested captures on 2026-10-29 for Irodori testing
and benchmarks, having explicitly requested repository retention of the
photographic inputs. These privacy-reviewed originals may be included in the
Irodori GitHub repository and used for repeatable project testing and benchmarks.
They are not Apache-2.0 or CC0 photographs. This notice grants no general
open-content or unrelated-reuse license.

| Original                 | ISO   | Exposure | Bytes      | SHA-256                                                            |
| ------------------------ | ----- | -------- | ---------- | ------------------------------------------------------------------ |
| `originals/DSC03483.ARW` | 400   | 1/15 s   | 20,898,816 | `7e6e048962eacf890ef8bfb04fcadb5ac42e578bc5b67aa7912f08281975569f` |
| `originals/DSC03489.ARW` | 6400  | 1/250 s  | 20,902,912 | `d825bcd7c121e2998f8506bdb6ac02f6992c604443c4d0ecf4dde0c96b66be64` |
| `originals/DSC03490.ARW` | 12800 | 1/500 s  | 20,952,064 | `89e121a64b47c1e0ce04192dea6da19db0827f89ebca8971a4dfccd020a7011d` |

The complete set is 62,753,792 bytes. All three record f/4, 9.4 mm, Orientation
1, Program AE, AF-S and Auto white balance. ISO times exposure differs by about
0.059 EV between the ISO400 and higher-ISO images. The ISO400 white-balance gains
differ slightly from the matching gains of the two higher-ISO images. The
metadata does not establish unchanged focus, registration or illumination.
The lower-ISO shot is an approximately exposure-matched comparison, not a
calibrated clean or noiseless reference. These are not an exposure bracket or
an interchangeable burst. Exact capture facts are in [manifest.json](manifest.json).

On 2026-10-29, every embedded PreviewImage and ThumbnailImage and each complete
native 5496 × 3672 CPU-decoded scene were visually inspected. A second reviewer
independently inspected all three complete native scenes, including the dark
upper edge. No identifiable person, readable address/label/plate, private
document or screen content, or identifying room detail was observed. ExifTool
13.59 read-only inspection included unknown tags (`-j -n -a -u -G1 -s`; 2139
tags per file). No camera/lens/internal serial, GPS, private name or contact
tags were found; descriptive comment fields are empty and XMP Rating is numeric.
No original or embedded image was cropped, rewritten, redacted or stripped.

Storage metadata reports 5504 × 3672; the full sensor-derived LibRaw
0.22.1-Release privacy decode produced 5496 × 3672. Use authoritative prepared
native pixels for subsequent noise/detail assessment. Embedded JPEG previews,
fit-scale images and privacy-view gamma mapping cannot establish RAW detail
quality, numerical denoising accuracy or photographic acceptance.

The intended checks concern residual high-ISO noise, carpet-fiber/edge
preservation and blank-paper bias. Inclusion does not accept a denoiser. This
set provides no portrait-skin, moving-subject, starfield, HDR bracket or temporal
denoising coverage. The original capture brief is recorded in the repository at
`docs/sony-high-iso-test-captures.md`; actual recorded settings above take
precedence over requested settings.

Keep originals byte-for-byte unchanged and tracked in the benchmark's commit.
Keep generated proofs, privacy views, caches and outputs outside Git. Exclude
these test assets from application packages and automatic user-library imports.
