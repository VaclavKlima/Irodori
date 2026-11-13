# Sky selection photographs

These unchanged published originals exercise [issue #86](https://github.com/VaclavKlima/Irodori/issues/86).
They are test inputs, excluded from production bundles and automatic library imports.
Their inclusion does not establish successful selection or photographic quality.
[manifest.json](manifest.json) records exact bytes, SHA-256, original downloads,
photographer-issued permission, retained page revisions and the intake review.

| Photograph                                                                     | Coverage                                                                                         | Photographer and permission                                                                                                                                          |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Treesky.jpg](originals/Treesky.jpg)                                           | Blue daylight sky, oak branches/leaves, pine needles and many disconnected openings; 2298 × 3456 | Psydeffects, public-domain dedication on the [source page](https://commons.wikimedia.org/wiki/File:Treesky.jpg)                                                      |
| [Sunset through branches 0528.jpg](originals/Sunset_through_branches_0528.jpg) | Intense orange sunset, bright sun and silhouetted fine branches; 5184 × 3888                     | Victor Glassmov, [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/), [source](https://commons.wikimedia.org/wiki/File:Sunset_through_branches_0528.jpg) |
| [Storm clouds over a field.jpg](originals/Storm_clouds_over_a_field.jpg)       | Dark textured clouds, open horizon and tree edges; 1280 × 720                                    | Casimir Kromkowski, [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/), [source](https://commons.wikimedia.org/wiki/File:Storm_clouds_over_a_field.jpg)   |
| [Sky bridge.jpg](originals/Sky_bridge.jpg)                                     | Building/bridge skyline and blue glazing; 4608 × 3456                                            | Arlo Barnes, [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/), [source](https://commons.wikimedia.org/wiki/File:Sky_bridge.jpg)                         |

Use the existing `tests/fixtures/photos/mountain-ridge.jpg` for a simpler golden-hour
skyline, `quiet-valley.jpg` for diffuse light and shoreline pine, and the permitted
[Sony forest bracket](../../../raw/sony-zv-1a/forest-bracket/README.md) for actual
single-RAW and genuine merged-HDR source checks. Repeated exposures count as one
scene. Existing indoor object fixtures supply no-sky negative cases. These sources
do not establish coverage of every weather condition or a dense architectural
truss/opening cohort. The bridge is an architectural-outline and blue-surface
case, not a claim of recovered transparency through glass.

On November 13, 2026, the complete once-oriented images and all embedded previews
were visually inspected. Read-only ExifTool inspection included EXIF/XMP/IPTC,
unknown fields and MakerNotes. No identifiable people, readable private content,
personal location coordinates, nonempty owner/contact names or device serial
identifiers were found. The sunset's empty OwnerName and GPS version tag contain
no owner or coordinates. Neither metadata nor pixels were stripped or rewritten.
Private metadata dumps and extracted previews remain outside Git.

Keep originals unchanged. Generated masks, native crops, overlays and edited
comparisons remain outside Git. Distributed adaptations of Victor Glassmov's
photograph must retain attribution, source/license links, a description of changes
and the applicable ShareAlike terms. See [LICENSE.md](LICENSE.md). This photographic
permission is separate from Irodori's Apache-2.0 code license.
