# HDR file interoperability

## Status

**Bounded ISO 21496-1 HDR JPEG import and JPEG export are implemented.** Other JPEG gain-map variants and HDR PNG/TIFF/HEIF/AVIF interpretations remain planned; the candidates below remain a research queue. [Shared requirements](README.md#shared-implementation-requirements) apply.

## Enabled export variants

| Variant               | Source and writer                                                                                                   | Color and metadata                                                                                                                                                                                                                                 | Reader behavior                                                                                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SDR JPEG              | Managed raster, verified Sony RAW or durable merge; sharp 0.35.4                                                    | Baseline 8-bit sRGB ICC, 4:4:4, normalized orientation, white alpha flattening, linear Lanczos3 resize                                                                                                                                             | Ordinary JPEG readers display the controlled direct SDR rendition.                                                                                                                                                                   |
| HDR JPEG, ISO 21496-1 | Verified HDR Sony RAW, durable merge or supported HDR JPEG; libultrahdr 2.0.2 / libjpeg-turbo 3.1.0, Node-only WASM | Supplied SDR primary plus full-resolution multichannel gain map, alternate Rec.2020, linear half-float input relative to SDR white, actual content headroom up to 10× (203 × headroom codec argument); ISO metadata enabled, gain-map XMP disabled | ISO-aware readers reconstruct HDR. Older or XMP-only readers display the SDR primary. Independent numerical/JPEG reader evidence is tracked in the testing guide; operating-system gallery/browser compatibility remains unverified. |

Every metadata policy preserves required ICC and reconstruction information. Broader HDR import, additional export formats and display-brightness certification remain separate work. Supported ISO gain-map JPEGs reimport as authored HDR, with their SDR primary used in SDR mode. See the [export implementation](export.md), [runtime notices](../runtime-dependencies.md#jpeg-export-runtime) and [verification limits](../testing.md#jpeg-export).

## Enabled ISO JPEG import

The preview worker recognizes the ISO marker and validates the gain-map container with the pinned libultrahdr decoder. Tested input is Irodori's sRGB primary plus multichannel Rec.2020 gain map, including odd sizes and EXIF orientation. Decompression is bounded to 256 MiB compressed input, 512 MiB Float32 working data, auxiliary dimensions no larger than the primary, and headroom from 1× to 10×. Recognition scans at most 1 MiB of primary metadata. Other variants remain unverified.

The full gain map is reconstructed independently of the monitor. Its descriptor identifies authored, display-referred HDR without fabricated sensor normalization or camera calibration. HDR presentation and content analysis bypass the RAW ACES output transform. SDR mode uses the preserved primary with ordinary raster edits. Export regenerates both renditions from these sources. Existing JPEGs are inspected when processing metadata refreshes to version 4; numeric edits, revisions and history order are retained. Originals stay unchanged. Malformed recognized maps retain an explicit SDR fallback reason in Display details.

HDR pixel/statistics APIs support working/content and current HDR output. SDR output analysis for imported HDR JPEGs is explicitly unavailable; use the ordinary SDR histogram. Other import formats, interpretation-choice UI and broader interoperability fixtures remain open.

## Native macOS reader follow-up

On macOS 26.7, ImageIO recognizes Irodori's ISO auxiliary image and decodes HDR. Core Image with explicitly requested full gain-map headroom reconstructs neutral reference patches within 1.2%. Default native decoding also applies headroom adaptation, so appearance can differ from Irodori's fixed HDR rendition.

The tested native path does not preserve the alternate Rec.2020 gamut faithfully: a saturated reference patch `[3, 0.2, 0.05]` reconstructed approximately `[1.97, 0.39, 0.11]` in linear Rec.2020, while the pinned decoder and Float64 oracle retain the intended channels. The result is consistent with gains applied in the base gamut; this is an inference from decoded pixels. Do not claim pixel-matched macOS Preview compatibility or physical luminance certification. Preserve the ISO alternate-gamut metadata rather than silently reducing the file's gamut to accommodate one reader. Other operating-system readers remain unverified. Apple's [Adaptive HDR APIs](https://developer.apple.com/videos/play/wwdc2024/10177/) describe separate file reconstruction and display-headroom adaptation.

Rendering version `jpeg-linear-lanczos3-v1` used the earlier `100/203` brightness reduction. Version 2 corrected brightness but still advertised nominal 10× headroom. Version `jpeg-linear-lanczos3-v3-content-headroom` also signals the actual resized content headroom so readers do not blend toward SDR unnecessarily. Older exports stay intact and can be recognized as HDR, but should be re-exported from the RAW/master for both corrections. Import never guesses an exposure correction from filenames or encoder comments.

## Goal

Import HDR files without losing their brightness range or color meaning, preserve originals, and define an evidence-based compatibility matrix for import and export.

## User workflow

Choose files through the normal import review, see detected HDR type and limitations, then edit their reconstructed float content. When only an SDR rendition can be decoded, label that limitation explicitly before acceptance and preserve the untouched original for future support.

## Controls

Show container/encoding, primaries/profile, transfer function, bit depth, and gain-map availability when known. Ambiguous metadata requires an explicit supported interpretation choice or rejection, not a filename-based HDR assumption. Advanced interpretation choices use named profiles/encodings, with preview and undoable re-interpretation after import.

## Processing approach

Register lightweight format declarations with worker decoder implementations. Decode transfer functions into the master adapter while retaining whether the source is scene- or display-referred. Validate ICC and container color metadata together, including conflicting/missing metadata, orientation, alpha, bit depth, and brightness references. PQ absolute luminance and HLG's reference/display assumptions need distinct explicit adapters and normative conformance vectors; select libraries only after these are demonstrated.

Ultra HDR's documented JPEG representation combines an SDR primary image, a secondary gain map, and interpretation metadata. Its reconstruction depends on gain parameters and display capacity; malformed metadata calls for SDR fallback. Irodori's importer must retain the reconstruction metadata and derive an editable HDR rendition independently of the current monitor, while preserving the primary SDR rendition for compatibility testing. [Ultra HDR specification](https://developer.android.com/media/platform/hdr-image-format).

Research the specification's single/per-channel gains, offsets, gamma, headroom limits, metadata defaults, gain-map resampling, and orientation with reference files and independent decoders. Do not apply those rules indiscriminately to every vendor gain-map container. Irodori must label a valid primary-only fallback as SDR and never call it preserved HDR. A processed SDR rendition of an imported base image is subject to the normal large-preview contract; RAW embedded camera JPEGs remain prohibited there.

The matrix below is a research queue. For each enabled row, record exact container/profile/transfer variants, codec version/license, architecture support, decoder/encoder availability, independent reader, metadata policy, and fixture evidence. Pin normative specifications and conformance vectors in the format decision record; extension or bit depth alone is insufficient evidence.

| Candidate                          | Import research                                                    | Export research                                    | Compatibility/fallback gate                                                                |
| ---------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| JPEG Ultra HDR gain map            | Primary/map discovery, reconstruction, ICC/XMP validation          | SDR base plus regenerated map/metadata             | Independent HDR reconstruction and ordinary SDR reader appearance; invalid-map fallback.   |
| AVIF with PQ or HLG                | Supported bit depths, color metadata, transfer/reference handling  | HDR encoder and correct color/brightness signaling | Independent reader on each claimed platform; no assumed SDR compatibility.                 |
| HEIF/HEIC HDR or gain-map variants | Codec/container and vendor-specific auxiliary-image semantics      | Encoder availability, licensing, exact variant     | Test each variant separately; unsupported codec/map is explicit.                           |
| JPEG XL HDR                        | Float/high-depth interpretation and color metadata                 | HDR encoding and metadata round trip               | Reader availability and packaging verified per platform.                                   |
| OpenEXR                            | Scene-linear channels, chromaticities, alpha and supported layouts | Float interchange and metadata preservation        | Limit supported channels/layouts explicitly; preview through controlled output transforms. |
| Floating-point TIFF                | Sample format, profiles, range and brightness convention           | Explicit float interchange variant                 | Reject ambiguous interpretation; distinguish existing integer SDR TIFF support.            |
| Radiance HDR/RGBE                  | Dynamic range, primaries/exposure conventions and metadata limits  | Optional interchange writer                        | Document precision/color/alpha limitations and verify independently.                       |

Initial release research must choose at least one interoperable HDR import/export path plus the SDR path. Unsupported candidates remain marked Planned or rejected with reasons; full support does not mean every HDR format is implemented.

## API/MCP implications

Expose typed format capabilities and detected source interpretation through library/import APIs. Unsupported reasons name the encoding or metadata issue. Source-interpretation changes require expected revisions; import requests keep session IDs and main-owned picker access. Export consumes the same format capability registry.

## Persistence

Preserve original bytes, content hash, color/transfer/gain metadata, selected interpretation, and decoder version. Rebuild disposable masters from originals using the saved interpretation. Migrate current SDR assets without reclassifying them from extensions. Changed decoder semantics require explicit rendering compatibility and history handling.

## Dependencies

Requires [HDR processing](hdr-processing.md), [tone mapping](tone-mapping.md), and existing import/provider declarations. Research can begin in stage 1; final import integration is stage 5. [Export](export.md) depends on these decisions; display hardware is not needed for numerical decoder conformance.

## Failure handling

Bound decompressed dimensions, auxiliary images, metadata, time, and memory. Reject malformed or unsupported inputs per file without aborting other accepted imports. Primary-only fallback must be labeled SDR; corrupt primaries fail. Preserve source files, cancellation behavior, and interrupted-import recovery.

## Acceptance criteria

- Every advertised matrix variant has licensed real files and independent reference vectors covering dark values, above-white values, saturated colors, orientation, alpha where supported, and metadata.
- Compare decoded linear values and color/brightness descriptors against an independent implementation within fixed codec-specific tolerances.
- Gain-map fixtures include varying headroom, per-channel parameters, reduced-resolution maps, absent optional fields, invalid required fields, and unsupported variants; verify HDR and SDR outcomes separately.
- Import, duplicate detection, cancellation, restart, interpretation history, cache rebuild, CPU fallback, and malformed-file limits pass without changing originals.
- Export/reimport and an independent viewer validate each enabled writer; publish Linux/Windows/macOS codec/reader results and unsupported reasons, separate from display capability.

## References

- [Ultra HDR specification](https://developer.android.com/media/platform/hdr-image-format), reviewed September 20, 2026; research must record the version/variant actually implemented.
- [Format declarations](../../src/main/processing/formats.ts), [decoder registration](../../src/main/processing/decoders.ts), and [runtime packaging/licenses](../runtime-dependencies.md).
