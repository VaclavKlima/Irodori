# Sony ZV-1A night city — denoising evidence

The user selected the RAW open in Irodori on November 12, 2026 as a concrete
example of weak denoising for [issue #41](https://github.com/VaclavKlima/Irodori/issues/41).
The distant night scene contains sky, river, small illuminated windows and city
lights: useful regions for assessing colored speckling and blur of actual detail.

`originals/DSC02154.ARW` is the unchanged 20,751,360-byte Sony ZV-1A original: ISO
3200, f/2.8, 1/60 second, 19.6 mm. Its SHA-256 is
`130b212c1f449ae7cd1d9b8c466894b4dc7825bc67eec6129cd510bf97478478`.

The user explicitly requested publishing this exact file as evidence for the
denoising issue. It may be retained in the Irodori repository for that task's
reproducible investigation. This photograph is not Apache-2.0 or CC0, and this
notice grants no general open-content or unrelated-reuse license.

## Recorded editing passes

[editing-passes.json](editing-passes.json) retains the neutral imported settings
and both actual editing passes, captured through the read-only application API.
The first pass uses Luminance noise 22, Color noise 35 and Sharpening 15. The
second uses Luminance noise 38, Color noise 60 and Sharpening 5. Both use radius
0.7, threshold 65, exposure +0.9 EV, highlights -8, shadows +20, blacks -3, As Shot
white balance and the same crop/lens corrections. The reported problem is
persistent colored noise and soft detail after the second pass.

To investigate, import the unchanged original into an isolated profile, apply
the captured editable fields through the shared UI/API using that profile's
current revision, and compare the same native sky/river and building regions at
100%, then at intended output size. Captured local revisions and settings schema
versions are evidence, not IDs or API versions to assume in a fresh library.
Do not use a private user library for automated imports.

## Privacy review and limits

Before publication, the complete 5496 x 3672 sensor-derived LibRaw decode, an
additional building/river detail view, both embedded JPEG images and ExifTool
EXIF/XMP/IPTC/Sony metadata (including unknown tags) were inspected. No
identifiable people or personal documents, screens, addresses, vehicle plates
or private interior details were observed. No GPS, serial, private owner/name
or contact metadata was found; descriptive fields are empty. The original and
embedded images were not rewritten, redacted or stripped. Review details and
provenance are in [manifest.json](manifest.json).

The independent SDR privacy decode is not an Irodori rendering reference or an
accepted denoising result. Generated views and private metadata dumps stay out
of Git. This is one unpaired noisy photograph, with no clean ground truth or
claim that missed focus can be recovered. Existing numerical/texture/resource
gates and rejected research evidence remain unchanged.
