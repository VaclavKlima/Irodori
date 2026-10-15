# Luma Ultra HDR JPEG runtime

Pinned **libultrahdr 2.0.2**, **libjpeg-turbo 3.1.0**, **Emscripten 4.0.20**. The Node-only ES module and WASM binary are verified against `SHA256SUMS` before loading and copied beside `export-worker.js` and `preview-worker.js` by the normal build. Ship the entire directory outside ASAR in future installers. No system codec or runtime network access is used.

`scripts/ultrahdr/bridge.cpp` wraps the compressed-SDR-plus-linear-HDR encoder, probe and bounded ISO JPEG import decoder. The SDR JPEG is supplied by sharp with a controlled sRGB rendition. Input HDR is linear Rec.2020 RGBA binary16 relative to SDR white, preserving the preview values. The codec target argument is 203 × the resized HDR pixels' maximum channel value, bounded from 1.01× to 10× white. This describes actual content headroom so a display that fits the image applies the full map. It never rescales pixels or changes Luma's fixed nominal 1000/100 rendering. No `100/203` pixel scaling is applied: that would dim HDR relative to the supplied SDR primary. ISO 21496-1 is enabled, gain-map XMP is disabled, gain-map scale is 1, and multichannel gain maps are enabled. A checked source substitution forces `GetCPUCoreCount()` to 1; no pthread runtime or shared memory is enabled. The growing heap has a hard 2 GiB maximum and returns allocation errors instead of reducing dimensions. Decoder preparation runs in a different process so LibRaw's WASM heap has exited first.

Rebuild from the repository root with an activated Emscripten 4.0.20 SDK, CMake and Python 3:

```sh
bash scripts/ultrahdr/build.sh
```

Alternatively mount the repository at `/work` in `emscripten/emsdk:4.0.20` and run `/work/scripts/ultrahdr/build.sh`. Build intermediates go into ignored `artifacts/ultrahdr-build`. Downloads use pinned tag archives and verify these SHA-256 values before extraction:

| Source              | SHA-256                                                            |
| ------------------- | ------------------------------------------------------------------ |
| libultrahdr v2.0.2  | `aa8d193bb887c348c419780511dd03b374f4e07af8812b6d3f80c8537cf1ef2c` |
| libjpeg-turbo 3.1.0 | `35fec2e1ddfb05ecf6d93e50bc57c1e54bc81c16d611ddf6eff73fff266d8285` |

`scripts/ultrahdr/link.sh` rebuilds only the Luma bridge and rewrites the runtime checksums after a complete source build. Compiler flags, exported functions, threading, memory and metadata choices are checked in. Keep source versions, executable artifacts, checksums and notices together when changing the bundle.

Retain `LICENSE` and all files in `licenses/`: Ultra HDR's MIT/Apache terms, the Adobe gain-map technology notice, and libjpeg-turbo's license/Independent JPEG Group notice. Test fixtures are excluded from the application bundle. Compatibility and reader limitations are documented in [the export brief](../../docs/features/export.md).

Primary references: [pinned API](https://github.com/google/libultrahdr/blob/v2.0.2/ultrahdr_api.h), [encoder metadata constraints](https://github.com/google/libultrahdr/blob/v2.0.2/lib/src/jpegr.cpp), and [libjpeg-turbo 3.1.0](https://github.com/libjpeg-turbo/libjpeg-turbo/tree/3.1.0).
