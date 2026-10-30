# Licensing and distribution obligations

**Decision: Apache-2.0 for Irodori's original code and documentation.** Selected by
the project owner on 2026-10-28. This establishes the project's source license;
installer and bundled-binary compliance still require the checks below.

## Project license and contributions

Copyright 2026 Václav Klíma and contributors. The root [LICENSE](../LICENSE)
contains the unmodified [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0.html).
The root [NOTICE](../NOTICE) identifies the project and retained attribution.
The default covers original source, scripts, documentation, and configuration
unless a more specific notice or the exceptions below apply. It does not
relicense upstream material, photographs, or separately licensed data.

Apache-2.0 permits commercial use, modification, and redistribution, including
closed-source derivatives, subject to its conditions. It includes an express
contributor patent grant. Redistributors must retain the license and applicable
notices and identify modified files. The license grants no general trademark
permission. The license text controls these terms.

Contributions intentionally submitted for inclusion are accepted under
Apache-2.0, as described in section 5, unless separate applicable terms are
explicitly identified. Contributors retain their copyright and must have the
rights to submit the work. Contributions to a file already governed by CDDL,
MIT, or other separate terms must preserve that file's terms. No copyright
assignment or additional contributor agreement is introduced.

Apache-2.0 was selected over MIT for its explicit patent provisions and over
project-wide copyleft for the owner's preference to allow commercial reuse and
closed forks. Existing copyleft component obligations continue to apply to
those components.

## Source and asset exceptions

The most specific existing notice takes precedence over the default. In
particular, the root SPDX field describes Irodori's default license, not every byte
in the repository or a combined application distribution.

| Material                                      | Applicable terms and retained evidence                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| LibRaw-derived GPU code                       | `src/main/gpu/ahd-shader.ts`, `raw-renderer.ts`, `raw-source.ts`, and `sensor-blend.ts` retain CDDL-1.0 coverage. Preserve the source notices, [LibRaw attribution](../third_party/libraw/README.md), and [license](../third_party/libraw/LICENSE.CDDL). New covered modifications remain under CDDL.                                                                                                                                            |
| Sony ARW2 row arithmetic and linked LibRaw    | `native/raw-source/src/rows.rs` retains CDDL-1.0. Preserve [native RAW notices](../native/raw-source/licenses/COPYRIGHT), both upstream license texts, exact modified source, and the dispatch patch described in the [RAW host documentation](../native/raw-source/README.md). Irodori uses the CDDL route for its adapted code; this does not remove LibRaw's upstream LGPL/CDDL alternatives.                                                 |
| ACES source, ports, and reference values      | [Pinned ACES 2 source](../third_party/aces-core/README.md), generated `src/shared/aces-*.ts`, and ACES reference vectors retain Apache-2.0 and Contributors to the ACES Project attribution. Preserve the upstream license and generated-file headers.                                                                                                                                                                                           |
| Native numerical support                      | LLVM libc is Apache-2.0 WITH LLVM-exception. Preserve its [license](../native/irodori-cpu-render/upstream/electron-llvm/llvm-libc/LICENSE.TXT), the `sources.json` provenance inventory, and the Electron MIT, Chromium BSD, V8 BSD/additional notices and Sun Microsystems notice under `provenance/`. Do not replace these with Irodori's root license.                                                                                        |
| Merge preparation kernels                     | `src/main/merge/kernels/prepare.c` already declares MIT. Its WASM distribution retains that license; the complete [MIT notice](../vendor/merge-kernels/LICENSE) accompanies the binary. The renamed WASM distribution was rebuilt from the recorded source; preserve the matching source and runtime checksums.                                                                                                                                  |
| Sony ZV-1 public sample                       | `tests/fixtures/sony-zv1.ARW` retains the CC0-1.0 provenance recorded in the [fixture index](../tests/fixtures/README.md).                                                                                                                                                                                                                                                                                                                       |
| Fifteen user-supplied Sony research originals | [Research fixture permission](../tests/fixtures/research-sony/README.md) authorizes this set's repository inclusion and project testing. It grants no general open-content license or unrelated reuse. Preserve the originals, manifest and notice; exclude them from application bundles.                                                                                                                                                       |
| Privacy-reviewed Sony test originals          | [Fog/animal fur](../assets/tests/images/raw/sony-zv-1a/fog-dogs/README.md), [outdoor bracket](../assets/tests/images/raw/sony-zv-1a/forest-bracket/README.md) and [carpet ISO sequence](../assets/tests/images/raw/sony-zv-1a/carpet-high-iso/README.md) each retain their own repository-inclusion and project-testing notice. No general open-content or unrelated-reuse license is granted; exclude the photographs from production packages. |
| HDR+ DNGs and derived test imagery            | [HDR+ attribution](../tests/fixtures/hdrplus/README.md), CC BY-SA 4.0. Preserve credit, license links and change descriptions; distributed adaptations retain ShareAlike terms.                                                                                                                                                                                                                                                                  |
| Unsplash JPEG test fixtures                   | [Existing photographer credits](../tests/fixtures/photos/CREDITS.md) and the Unsplash License. Preserve provenance and its restrictions on standalone sales and competing image collections. The historical scaffold description in that credit file does not enable an application demo.                                                                                                                                                        |
| Separately dedicated synthetic vectors        | Existing CC0-1.0 declarations remain effective, including the HDR JPEG charts and export gain-map reference values. Unmarked original test code uses the project default; third-party ACES values retain their own attribution.                                                                                                                                                                                                                  |

The independently written lens-correction provider does not bundle a Lensfun
database or upstream lens module; see the [RAW processing provenance](raw-processing.md).
An upstream algorithm citation alone is not a blanket license for copying code.

The earlier Sony portrait research originals retain their separate rights and
historical inclusion notice. The updated privacy policy excludes them from new
repository acceptance inputs; their unchanged local copies, manifest and notice
are preserved in ignored evidence rather than the active asset tree. Prior Git
publication does not establish compliance with that newer policy.

The [observed starfield fixture](../assets/tests/images/raster/eso/observed-starfield/README.md),
ESO image `eso0106a`, retains **AURA** credit and CC BY 4.0 under the linked ESO
image policy. Preserve visible credit, source/license links and descriptions of
changes with distributed derivatives. This published telescope JPEG is separate
from Sony photography and the project's Apache-2.0 code license.

## Dependency audit: 2026-10-28

Baseline: committed revision `0b8098f71f30cc1dd65740a43b9d36e226da297a`.
The audit read the complete npm lockfile and existing installed package metadata
without installing packages or changing the concurrent checkout. There are
**402 dependency entries: 344 marked development and 58 not marked development**;
117 entries are optional. These flags overlap and are not a shipped-file count.
All 402 declare licenses. Of these, 295 were installed locally and every inspected
version matched the lockfile; the remaining 107, including other-platform
packages, were inspected through locked metadata only.

| Lockfile license expression              | Entries |
| ---------------------------------------- | ------: |
| MIT                                      |     317 |
| Apache-2.0                               |      35 |
| ISC                                      |      19 |
| LGPL-3.0-or-later                        |      10 |
| BSD-2-Clause                             |       8 |
| BSD-3-Clause                             |       5 |
| Apache-2.0 AND LGPL-3.0-or-later         |       3 |
| Apache-2.0 AND LGPL-3.0-or-later AND MIT |       1 |
| CC0-1.0                                  |       1 |
| CC-BY-4.0                                |       1 |
| BlueOak-1.0.0                            |       1 |
| 0BSD                                     |       1 |

This counts package declarations, not licenses embedded inside native programs.
For example, both the LibRaw wrapper and ExifTool wrapper declare MIT while the
wrapped implementations have additional terms. The installed `webgpu` package
declares MIT, but its `LICENSE.md` is a Dawn/Tint BSD-3-Clause notice. The combined
runtime must retain the actual bundled notices rather than rely on the package
label alone. The ignored audit evidence is
`artifacts/project-setup-20261028/licenses/npm-license-inventory.json`.

### Runtime and native components

| Component at the baseline                                  | Terms and distribution requirements                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| React / React DOM 19.3.0; xterm.js 6.0.0; fit addon 0.11.0 | MIT. Preserve package copyright and license notices in distributions containing the bundled code.                                                                                                                                                                                                                                        |
| Lucide React 1.46.0                                        | ISC plus MIT notices for Feather-derived icons in the package's `LICENSE`. Retain the complete file, including when renderer bundling removes the original package layout.                                                                                                                                                               |
| Electron 44.3.0                                            | MIT for Electron plus Chromium and other bundled notices. Retain the runtime's license and full third-party notices; the npm package's MIT field is not the complete inventory.                                                                                                                                                          |
| Bundled Node.js 24.20.0                                    | MIT plus embedded third-party notices in each matching `node-*` runtime's `LICENSE`. Audit the binary actually shipped for each target.                                                                                                                                                                                                  |
| sharp 0.35.4 / `@img/*` binaries 1.3.3                     | sharp is Apache-2.0. The prebuilt libvips packages declare LGPL-3.0-or-later, while Windows/WASM sharp packages declare combined expressions. Local Linux x64 uses libvips 8.18.6 and the codecs listed in its `versions.json`. Preserve all codec notices and satisfy applicable source/replacement requirements for the actual binary. |
| `@colorhythm/libraw-wasm` 1.1.1 / LibRaw 0.22.1            | MIT wrapper; LibRaw offers LGPL-2.1 or CDDL-1.0. Retain the wrapper license, `LibRaw/COPYRIGHT`, both license texts, and corresponding source/build information. Keep an explicit route for each modified native/WASM distribution.                                                                                                      |
| ExifTool wrapper 38.0.1; `.pl` / `.exe` packages 13.59.2   | MIT wrapper/packaging; actual ExifTool is under the same terms as Perl. Preserve the executable's license, documentation, and bundled Perl/component notices. Child-process separation does not remove redistribution obligations.                                                                                                       |
| `webgpu` 0.6.1 / Dawn and Tint                             | Preserve package and native binary notices, including the observed BSD-3-Clause Dawn/Tint `LICENSE.md`, plus any other linked components. Keep the native binary external as documented.                                                                                                                                                 |
| OpenCV 4.13.0 WASM                                         | Apache-2.0 plus the retained legacy OpenCV, FLANN, SoftFloat, zlib and zlib-ng notices in [the vendor directory](../vendor/opencv/README.md). Ship the whole license directory alongside the checked runtime.                                                                                                                            |
| Ultra HDR 2.0.2 / libjpeg-turbo 3.1.0                      | Preserve the complete MIT/Apache texts, Adobe gain-map technology notice and libjpeg-turbo/IJG notices in [the codec directory](../vendor/ultrahdr/README.md). This applies to both WASM and linked native encoders.                                                                                                                     |
| Linux native RAW, CPU renderer and HDR codec               | These hosts have no third-party Rust crate dependencies at the baseline. Linked LibRaw, ACES, LLVM and codec terms still apply. Retain each staged `licenses/` directory, checksums, source/build manifests and source availability described by its builder.                                                                            |

The npm development tree also includes CC-BY-4.0 `caniuse-lite`
1.0.30001810 and permissive BSD/ISC/BlueOak/0BSD tooling. Retain their applicable
terms when redistributing the tools or data; a development flag does not prove
that no part enters a renderer bundle.

## Requirements before distributing an application binary

1. Inventory the actual output per OS/architecture, including bundled renderer
   code, native helpers, optional runtime packages and linked codec components.
   Record the matching source revision, build recipe and full license texts.
2. Include Irodori's license and notice and the complete upstream notices for every
   shipped component. Renderer bundling must preserve React, Lucide/Feather,
   xterm and other included-code attribution even when `node_modules` is absent.
3. Make the CDDL-covered source and modifications available and tell recipients
   how to obtain the exact version. Preserve contributor/change notices. An
   ignored local build directory is not a recipient-accessible source offer.
4. For LGPL components, supply the required license texts (including GPL text
   where LGPL-3.0 incorporates it), matching library source, build information
   and a compliant replacement/relinking route. Preserve the permissions needed
   for debugging modified library versions. Check static and dynamic bundles
   separately against the applicable license version.
5. Preserve ExifTool/Perl and codec-specific terms, including the Adobe notice.
   Audit embedded component terms beyond the npm SPDX labels.
6. Exclude photographic test fixtures from application bundles. Source archives
   that include fixtures must preserve their separate notices; the fifteen
   research photographs remain limited to the recorded project permission.

The existing build copies several vendor license directories, but no installer
or final packaged notice/source-delivery path was exercised by this audit. The
installed Linux `@img/sharp-libvips-linux-x64` package has no top-level license
file despite its LGPL declaration; a distributor must obtain the complete
library/codec texts and corresponding source rather than assume `npm ci` has
fulfilled those obligations. Other-platform binary contents remain unverified.
These are outstanding distribution requirements, not an additional restriction
on Irodori's Apache-licensed original work.

## Maintaining the decision

Re-audit dependencies and adapted source before merging concurrent processing
work and whenever pinned components change. Preserve more specific existing
notices and source hashes; do not mass-replace source headers with Apache tags.
The source-license setup can be complete while application packaging acceptance
remains open. The [runtime packaging contract](runtime-dependencies.md) and
fixture provenance continue to apply.

Primary references checked on 2026-10-28:
[Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0.html),
[LibRaw licensing](https://www.libraw.org/#licensing),
[CDDL-1.0 sections 3.1–3.6](https://opensource.org/license/CDDL-1.0),
[LGPL-3.0](https://opensource.org/license/lgpl-3-0),
[Perl licensing](https://dev.perl.org/licenses/),
[Unsplash License](https://unsplash.com/license), and
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
