# Sony ZV-1A photographs for high-noise verification

The current denoising work needs a privacy-safe high-ISO example with fine texture.
This three-frame sequence supplements the existing native ISO 400 animal-fur
fixture. Photographic acceptance stays open until the originals are reviewed and
published with their hashes and repository-inclusion notice.

Please take **three RAW photographs of one stationary, privacy-safe still life**
with the Sony **ZV-1A**, in order: **ISO 400, ISO 6400, ISO 12800**.
A piece of dark wool/faux fur or a plush toy beside a smooth matte gray area and
a small colored fabric patch would work. Fill the frame with the objects and a
plain backdrop; include no people/reflections, readable labels, pet tags,
documents, screens, addresses or private room details. This lets us compare real
high-ISO noise reduction with fine texture and a quieter reference.

Use a tripod or stable support, steady dim lighting and no subject movement.
Keep camera position, zoom, aperture, focus, white balance and lighting unchanged
through all three frames. Avoid a flickering/dimmed LED, moving daylight or an
actively moving animal. The scene and its original files are intended for the
public GitHub test assets after their privacy/metadata review.

1. Set still-photo **Manual Exposure**: `MODE → Manual Exposure → center`.
   Press the down side of the control wheel to select shutter/aperture and turn
   the wheel to adjust. Set **f/4**, ordinary manual **ISO 400** (not ISO AUTO or
   Multi Frame NR). Adjust shutter speed until **MM is near 0** and important
   detail is not clipped. Use steady dim light so the later high-ISO frames
   contain visible noise; keep that lighting unchanged for all three captures.
2. Set `MENU → Camera Settings1 → File Format → RAW` (RAW & JPEG also works,
   but only the untouched `.ARW` files are needed). RAW already excludes Multi
   Frame NR and the JPEG High ISO NR setting does not denoise RAW data.
3. Select a fixed appropriate white-balance preset at
   `MENU → Camera Settings1 → White Balance`; avoid Auto WB for this sequence.
   Focus on the fine fabric, then hold that focus in Manual Focus:
   `MENU → Camera Settings1 → Focus Mode → Manual Focus`, then `Set Focus`.
   Left/right or rotation of the control wheel adjusts focus; center returns
   to shooting. Check the magnified detail and do not touch focus/zoom afterward.
4. Use the **2-second self-timer** via the control wheel's Drive Mode, or
   `MENU → Camera Settings1 → Drive Mode → Self-timer → 2 Sec`.
   On a tripod set `MENU → Camera Settings2 → SteadyShot → Off`, as Sony
   recommends. Do not use exposure bracketing, Auto HDR or a multi-frame mode.
5. Take frame **A at ISO 400**. Set **ISO 6400**, adjust **only shutter speed**
   until MM is near 0 again, then take frame **B**. Set **ISO 12800**, adjust
   only shutter speed until MM is near 0, then take frame **C**. Keep f/4, zoom,
   focus, white balance, framing and lighting fixed throughout. These are three
   distinct single photographs, not a camera noise-stack output.

Preserve and provide the **three original ARW files with their original names**
and their A/B/C order. Do not export through an editor, strip metadata, resize,
rotate/rewrite or overwrite the originals. Keep the originals on the card until
copy/hash/privacy verification is complete. We will inspect the actual images,
embedded previews and metadata before repository inclusion. A low-ISO capture
is a quieter reference, not mathematically noiseless ground truth; tiny exposure
rounding differences and any movement must be measured before paired analysis.

## Verified camera instructions and tutorials

The exact model is **ZV-1A**, not ZV-1 II, ZV-1F or an interchangeable-lens Sony.
The official ZV-1A manual confirms compressed Sony RAW, still-photo M mode and
ordinary manual ISO through 12800; **ISO 25600 in Multi Frame NR is not a usable
single-camera-RAW setting**. The following sources were checked on 2026-10-29:

- [ZV-1A Manual Exposure](https://helpguide.sony.net/dc/2410/v1/en/contents/0302C_manual_exposure.html)
  and [ISO](https://helpguide.sony.net/dc/2410/v1/en/contents/0408C_iso.html):
  exact mode, wheel controls and manual-ISO restrictions.
- [File Format](https://helpguide.sony.net/dc/2410/v1/en/contents/0404M_file_format.html)
  and [High ISO NR](https://helpguide.sony.net/dc/2410/v1/en/contents/0414C_high_iso_nr.html):
  RAW/RAW & JPEG and what noise reduction does not apply to RAW.
- [Manual Focus / Set Focus](https://helpguide.sony.net/dc/2410/v1/en/contents/0405Q_manualfocus_setfocus.html)
  and [White Balance](https://helpguide.sony.net/dc/2410/v1/en/contents/0410C_white_balance.html):
  fixed focus and appearance across the sequence. The ZV-1A uses wheel controls;
  do not instruct the user to turn a nonexistent interchangeable-lens focus ring.
- [Self-timer](https://helpguide.sony.net/dc/2410/v1/en/contents/0407_drivemode_selftimer.html)
  and [SteadyShot](https://helpguide.sony.net/dc/2410/v1/en/contents/0414_still_image_steadyshot.html):
  2-second camera-shake reduction and Sony's tripod recommendation.
- [Sony's Setting the ISO tutorial](https://support.d-imaging.sony.co.jp/support/tutorial/dc/zv-1/en/06.php):
  manufacturer guidance on ISO and noise. This tutorial is for the earlier
  **ZV-1**; menu/setup details above are verified independently in the exact
  **ZV-1A** manual. The controlled still-life/three-frame design is this project's
  proposed validation setup, not a quotation or promise from Sony.
