# Luma OpenCV alignment runtime

This directory contains OpenCV **4.13.0**, compiled to a local Node-only WebAssembly module with Emscripten **4.0.20**. Luma verifies `SHA256SUMS` before loading either executable file. The production build copies this directory beside the merge worker. There is no system OpenCV dependency or runtime download.

The C ABI in `scripts/opencv/bridge.cpp` exposes spatially capped ORB descriptors, reciprocal ratio-tested Hamming matches, RANSAC similarity/homography fitting, and `findTransformECCWithMask`. The wrapper catches OpenCV exceptions, owns allocations through RAII, uses one thread and SIMD, and limits each WASM instance to 256 MiB (two alignment workers total at most 512 MiB). TypeScript releases all call buffers even on failure. Foreground preview priority and cancellation remain managed by the separate merge process.

Native patch batches use checksummed luminance bands and independent validity masks. Translation refinement uses SIMD inverse compositional updates with exposure normalization, Gaussian filtering and robust native residuals. Filtering normalizes each source by its own validity mask so clipping boundaries cannot become image detail. The normal equations project local brightness gain and offset out of the displacement update. This prevents photometric differences from being explained as motion. Coarse motion training optimizes area-reduced patches and then checks native correlation; final motion training and held-out validation retain the full-resolution optimizer. Whole-strip equality can prove identity only after checksum and observability checks. These training shortcuts do not change the 0.5-pixel validation threshold or the required spatial support.

The bridge reports native sampling and optimization durations, patch counts and sampled pixels. Patch batches validate dimensions, matrix finiteness, bounds and matrix types before using row pointers in the inner sampler. OpenCV assertions remain enabled. SIMD correlation centers samples before reduction to preserve stability in low-signal regions.

To rebuild from the repository root with Podman installed:

```sh
podman run --rm --userns=keep-id \
  -v "$PWD:/work:Z" docker.io/emscripten/emsdk:4.0.20 \
  bash /work/scripts/opencv/build.sh
```

The script downloads the pinned upstream source archive, verifies SHA-256 `1d40ca017ea51c533cf9fd5cbde5b5fe7ae248291ddf2af99d4c17cf8e13017d`, builds only the required libraries, links the checked-in C ABI and rewrites the artifact checksums. Build intermediates live in ignored `artifacts/opencv-build`. Compiler options, exports and memory limits are checked in. Use `scripts/opencv/link.sh` inside the same container for bridge-only rebuilds. Keep the source version, runtime files and checksums together when updating.

OpenCV is distributed under Apache-2.0; see `LICENSE`. Additional notices for linked code are in `licenses/`. The wrapper is Luma source code. Upstream references: [WASM build instructions](https://docs.opencv.org/4.13.0/d4/da1/tutorial_js_setup.html), [masked ECC API](https://docs.opencv.org/4.13.0/dc/d6b/group__video__track.html).
