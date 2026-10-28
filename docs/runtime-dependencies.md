# Preview runtime and distribution

The image worker is built as `out/main/preview-worker.js` and started with `child_process.fork` using a pinned Node 24.20.0 binary from the matching optional `node-{platform}-{arch}` package. Supported package targets are Linux, macOS, and Windows on x64 and arm64. Windows package names use `win`. This avoids Electron's [Linux GLib symbol conflict with sharp](https://sharp.pixelplumbing.com/install/#electron-and-linux).

`npm ci` must include optional dependencies for the target platform. The runtime packages contain their binaries directly and do not need a second download at application launch. No installed system Node runtime is used by the photo worker. Keep `package-lock.json` committed; installing native dependencies for a different target requires that target's npm platform/architecture settings.

## Full-resolution display rendering

Import review keeps its fast JPEG path. A separate instance of the bundled worker renders the active photo at full decoded dimensions: RAW uses LibRaw with half-size disabled, AHD demosaicing, camera white balance, explicit sRGB primaries/gamma, and 8-bit output; raster originals use sharp orientation and ICC conversion. Both produce true-color sRGB PNG with lossless compression level 3 and no resize. The full worker does not extract embedded JPEGs or start ExifTool. It exits after each render so retained WASM memory is released.

The main process owns a versioned, 2 GiB LRU cache under `library/cache/previews/`, publishes entries atomically, and streams assets through the secured photo protocol. Request tokens cancel superseded work without affecting imports. The active image and open streams pin cache entries; temporary excess is removed after their release. Cache versions and interrupted writes are cleaned at startup. RAW inputs retain the 512 MB limit and full renders have a 90-second timeout. Failures preserve quick viewing and offer explicit regeneration.

These PNGs are disposable SDR display assets, not high-bit-depth editing intermediates. Future editing must decode originals and version its rendering policy. The Sony fixture's decoded visible image is 5496 × 3672, slightly smaller than its metadata dimensions.

## Packaging contract

This repository currently builds an unpacked development application, not installers. When adding a packager:

- Ship `out/` and all production and matching optional dependencies, including `sharp`, `@img/*`, `exiftool-vendored`, `exiftool-vendored.pl` or `exiftool-vendored.exe`, `@colorhythm/libraw-wasm`, `typed-cstruct`, and the matching `node-*` runtime.
- Keep the worker and its dependency tree outside ASAR. A plain Node child cannot load Electron's ASAR filesystem. Preserve relative package layout and executable permissions.
- The LibRaw package resolves its adjacent `dist/libraw.wasm`; retain its generated module and WASM file together. Preserve ExifTool's vendored executable/Perl files and sharp's native libvips libraries.
- Run import and RAW fallback tests against the packaged artifact on every supported platform before claiming distributable support.

## Third-party notices

Irodori's default source license is Apache-2.0. The [licensing inventory](licensing.md)
records component and fixture exceptions, source-availability obligations, and
the remaining checks for distributing application binaries.

Retain complete license/notice files for each shipped package and its embedded
components. Package metadata alone is insufficient; obtain any missing texts
and corresponding source before distributing the binaries.

| Component           | License / notice source                                                                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| sharp               | Apache-2.0; its `LICENSE` and native `@img` notices cover libvips and bundled codecs                                                                     |
| Prebuilt libvips    | The locked `@img/sharp-libvips-*` packages declare LGPL-3.0-or-later; obtain complete codec notices and satisfy matching source/replacement requirements |
| ExifTool wrapper    | MIT; `exiftool-vendored/LICENSE`                                                                                                                         |
| ExifTool executable | Perl licensing; retain vendored package licenses and documentation                                                                                       |
| LibRaw WASM wrapper | MIT; retain the package's license files                                                                                                                  |
| LibRaw              | CDDL-1.0 or LGPL-2.1; retain `LibRaw/COPYRIGHT`, `LibRaw/LICENSE.CDDL`, and `LibRaw/LICENSE.LGPL` from the WASM package                                  |
| typed-cstruct       | MIT; retain its package license                                                                                                                          |
| Node.js             | MIT and bundled third-party notices in the runtime package's `LICENSE`                                                                                   |

Test photographs are never part of the application bundle. Their provenance is in [fixture documentation](../tests/fixtures/README.md).

## HDR merge alignment

The merge worker bundles OpenCV 4.13.0 WASM from `vendor/opencv`. Copy this directory beside `merge-worker.js` (outside `app.asar` in future packaged distributions); it contains the Node module, WASM bytes, SHA-256 manifest and licenses. No system OpenCV or runtime network access is used. See [the reproducible build instructions](../vendor/opencv/README.md). The development and production build already copy these files; installer verification remains deferred.

## JPEG export runtime

The build emits `out/main/export-worker.js` and copies `vendor/ultrahdr` beside it. Export uses the same bundled Node 24 runtime family as preview. RAW/lens preparation completes in a separate process, which exits before the export encoder loads. Export does not run sharp, LibRaw or Ultra HDR inside Electron and does not consume foreground preview caches.

Ship the complete `ultrahdr` directory outside ASAR with the worker. Its pinned libultrahdr **2.0.2** / libjpeg-turbo **3.1.0** WASM module is Node-only, single-threaded and checksummed. The macOS arm64 native helper under `native/darwin-arm64/` has its own checksum manifest and executable mode; preserve both. Native encoding uses ARM NEON and up to four threads, with the same accurate integer DCT, best-quality preset and full-resolution multichannel map. Both variants enable ISO 21496-1 and disable gain-map XMP. Other platforms and native-helper failures retain WASM encoding. `npm run build:export-native` reproducibly builds the helper from the same verified source archives; no runtime download or system codec is used. Emscripten **4.0.20** build/link scripts, source archive hashes, the 2 GiB heap cap and licenses are retained in [vendor/ultrahdr](../vendor/ultrahdr/README.md). Retain its `LICENSE`, MIT/Apache licenses, Adobe gain-map technology notice and libjpeg-turbo/IJG notices in every distribution.

JPEG primary encoding uses sharp 0.35.4 / its bundled libvips codecs with baseline sRGB 4:4:4 settings. SDR source metadata is allowlisted before HDR packaging. Required ICC/ISO reconstruction metadata is never stripped by the privacy choices. [File compatibility](features/hdr-file-support.md#enabled-export-variants) remains distinct from display hardware, broader HDR import and installer certification. The preview worker also uses the pinned WASM decoder for bounded ISO gain-map JPEG import; it remains outside Electron.

Export GPU rendering uses the existing external native `webgpu`/Dawn dependency in the isolated Node worker. Keep its native files and the matching Node runtime outside ASAR. Renderer sandboxing and the typed export bridge are unchanged. Native encoder input/output paths are owned job scratch paths created by the Node worker; no command runner or arbitrary paths are exposed to the renderer or MCP. Cancellation kills the encoder process group, including the native helper.
