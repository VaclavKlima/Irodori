# Repository assets

`assets/` is the single root for committed application resources and test or
benchmark assets. Organize files by consumer, then asset type, camera, dataset or
reference domain. Tests and benchmarks share the same photographic inputs.

**Migration pending:** [backlog item #35](../docs/features/README.md#workspace-feedback-backlog)
tracks moving existing assets here and updating their consumers together.
Current fixtures still resolve from `tests/fixtures/`; this document defines
their destination. Create subfolders when they contain assets.

## Directory structure

```text
assets/
├── README.md
├── app/
│   ├── icons/                         Application and platform icons
│   ├── camera-runtime/                Development runtime pins and provenance
│   └── images/                        Bundled interface artwork
└── tests/
    ├── images/
    │   ├── raw/
    │   │   ├── sony-zv-1/              Public Sony ARW sample
    │   │   ├── sony-zv-1a/
    │   │   │   └── research-sequences/ HDR bracket and noise-burst dataset
    │   │   │       ├── README.md
    │   │   │       ├── manifest.json
    │   │   │       └── originals/
    │   │   └── hdrplus/
    │   │       └── 0006_20160722_115157_431/
    │   └── raster/
    │       └── unsplash/              Licensed JPEG photographs and credits
    └── references/
        ├── color/                     Color models, mixer, grading and curves
        ├── geometry/                  Crop geometry and filter references
        ├── detail/                    Denoise, sharpening and quality references
        ├── hdr/                       ACES and HDR mask references
        └── export/                    Gain-map and resize references
```

Use lowercase, hyphenated names for new directories and descriptive asset names.
Preserve original capture filenames, dataset identifiers and complete sequence
membership. Keep manifests, credits, permission notices and licenses beside
their assets. Add a descriptive type folder for future resources, such as
`app/fonts/`, when needed.

Only `app/` assets belong in application packages. Keep all `tests/` assets out
of production bundles and automatic user-library imports. Generators remain
with test or research code; generated charts may be recreated from committed
generators. Screenshots, proof crops, caches and benchmark reports remain under
ignored `artifacts/` directories.

## Photographic inputs

Every real image used for testing or benchmarking must be retained in Git under
`assets/tests/images/`, with exact original bytes, SHA-256 and provenance or
repository-inclusion permission. Verify that the actual inputs are tracked and
included in the benchmark's commit. Local copies, removable cards and private
archives cannot be their only source.

Before adding images to Git or uploading them to GitHub, follow the
[fixture privacy review](../tests/fixtures/README.md#privacy-review-before-committing):
visually inspect every image and embedded preview, inspect EXIF/XMP/IPTC metadata,
and check filenames and provenance notices for personal information. Replace
unsafe inputs with safe, appropriately licensed images and rerun affected
benchmarks. Record the review without copying sensitive details into the notice.
Preserve existing source originals unchanged.

## Obtaining missing photographic inputs

Reuse suitable committed fixtures before acquiring new inputs. When they do not
exercise the required behavior, prefer bounded capture through the
[development camera MCP](../docs/camera-control.md) if the camera and scene are
ready. Otherwise request the missing physical setup or user captures, or obtain
suitable online photographs with the photographer's documented consent. Choose
the smallest useful set that meets the declared test or benchmark requirements.
All sources must pass the same privacy and inclusion-permission review and be
retained under `assets/tests/images/` with hashes and provenance notices.

### Capturing through MCP

The tracked [camera registration](../.codex/config.toml) starts automatically after
trusting the checkout and refreshing Codex. Complete the guide's per-machine
`npm ci` and `npm run camera:setup` first on Apple Silicon macOS 14+ or Linux x64;
Linux USB permissions remain a host prerequisite. The [runtime manifest and
provenance](app/camera-runtime/README.md) are committed; binaries stay under ignored
`artifacts/camera/runtime/` and are not bundled into Electron. No Electron window
or managed photo library is involved. Discover the exact camera, inspect its
current capabilities, open a session, configure supported choices, capture and
poll to completion, then close and inspect restoration. The guide includes
[the complete call sequence](../docs/camera-control.md#discovery-through-restoration),
[one RAW/JPEG pair](../docs/camera-control.md#discovery-through-restoration),
[three software exposures](../docs/camera-control.md#three-exposure-software-sequence)
and [controlled high-ISO texture comparisons](../docs/camera-control.md#controlled-high-iso-texture-comparison).

Agents may execute needed bounded captures once the camera, scene and validation
requirements are ready, without another confirmation. Ask only for missing
information or physical assistance, including camera connection/positioning,
lighting, focus or unsupported menu settings. Missing capabilities are explicit;
do not replace software sequences with claims of verified native bracketing.
Physical Bazzite acceptance and Windows support remain unverified.

Downloads and manifests stay private under ignored `artifacts/camera/` until
promotion. Before Git inclusion, inspect every original, embedded preview and
EXIF/XMP/IPTC record and confirm permission covers testing/benchmarking and GitHub
redistribution. A camera session does not establish inclusion permission. Copy
only approved originals unchanged into a named dataset in the shared asset tree;
retain original filenames, hashes, provenance/permission evidence, validation
goal, camera/recording mode, requested/read-back settings and complete sequence
order/frame count. Verify those exact files are tracked in the benchmark's commit.
Do not promote private serials or other personal metadata from operation manifests;
choose a safe replacement when an original is unsuitable, preserving original
bytes rather than sanitizing or re-encoding them.

### Requesting new captures

Before asking the user to take photographs, always research online the exact
camera model's supported settings and setup steps, plus tutorials explaining
what and how to shoot for the validation goal. Use manufacturer manuals/help
guides for camera settings and menu paths, and suitable tutorials from the
manufacturer or photographer for scene and shooting technique. Check firmware,
lens and recording-mode differences when relevant; ask for missing equipment
details when they affect the instructions. Include direct links to the sources.

Give the user a concise capture brief covering:

- The behavior being verified and the subject, lighting, framing and motion or
  camera support needed to exercise it. Choose a scene free of personal details.
- The exact settings needed by the test, such as RAW format, exposure mode,
  aperture, shutter speed, ISO, white balance, focus and drive/bracketing mode,
  with model-specific menu/button steps and a linked setup tutorial.
- The number and order of distinct frames, bracket spacing or comparison pairs,
  and which settings and scene conditions to keep fixed or deliberately vary.
- Which unchanged original files to retain and provide, how to identify each
  sequence, and that the selected images are intended for the GitHub fixtures.

Require only settings and captures needed for the declared validation. Keep the
relevant acceptance incomplete until the files arrive and their actual format,
metadata and sequence are verified. Record the capture brief and source links
alongside the accepted dataset without exposing personal information.

### Using online photographs

Use online photographs only with documented consent from the photographer. A
photographer-issued license can supply that consent when it clearly permits the
required testing/benchmarking and redistribution of the files in the GitHub
repository, including derived fixtures when needed. Verify the photographer and
the applicable permission before repository inclusion, and preserve any required
credit, license terms and descriptions of changes. If permission is missing or
unclear, ask the user to obtain it or choose another suitable source.

Record the original source URL, photographer credit, license or consent evidence,
permitted use, access date and exact file SHA-256 beside the images. Keep private
correspondence and personal contact details out of Git; retain a suitable public
permission statement or reference. Verify that the downloaded files actually
meet the declared format, camera and sequence requirements, and apply the
privacy review to their pixels, embedded previews and metadata before adding
them to Git or uploading them to GitHub.

## Migration requirements

- Inventory all existing application resources and test/benchmark assets, including
  image datasets, numeric reference files, manifests and attribution documents.
- Move the Sony sample, Sony research sequences, HDR+ burst and Unsplash JPEGs into
  the corresponding image branches above. Move JSON reference fixtures into
  their named reference domains. Move application resources into `app/` by type.
- Update every source import, test/helper/script path, fixture manifest, build or
  packaging rule and documentation link in the same migration. Keep fixture
  licenses and privacy guidance discoverable alongside the relocated files.
- Review photographic inputs for privacy before migration, preserve original
  bytes and verify before/after hashes. Resolve unsafe inputs with reviewed
  replacements and rerun any measurements that used them.
- Verify affected registered targets, offline fixture resolution from a fresh
  checkout and exclusion of test assets from production bundles. Complete the
  migration when all assets use this root and no consumer depends on legacy paths.
