# LibRaw-derived GPU processing

The AHD shader, sensor-aware highlight blend, and display-curve calculations in `src/main/gpu/` are adapted
from LibRaw 0.22.1, under the Common Development and Distribution License 1.0
(CDDL-1.0). The modified source is included in this repository. Preserve this
notice, the license, and access to the modified source when distributing Luma.

Copyright 2019–2025 LibRaw LLC. LibRaw's dcraw portions are copyright 1997–2018
Dave Coffin. AHD is based on the work of Keigo Hirakawa, Thomas Parks, and Paul Lee.

References at the version used by `@colorhythm/libraw-wasm`:

- https://github.com/LibRaw/LibRaw/blob/0.22.1/src/demosaic/ahd_demosaic.cpp
- https://github.com/LibRaw/LibRaw/blob/0.22.1/src/postprocessing/postprocessing_utils_dcrdefs.cpp
- https://github.com/LibRaw/LibRaw/blob/0.22.1/src/postprocessing/mem_image.cpp
- https://github.com/LibRaw/LibRaw/blob/0.22.1/src/utils/curves.cpp
- https://github.com/LibRaw/LibRaw/blob/0.22.1/src/postprocessing/postprocessing_aux.cpp

Changes: express AHD as GPU compute passes over overlapping row strips; keep a
floating-point camera-to-linear-sRGB result; compute the display histogram on
GPU and the small display lookup table on CPU; read back lossless RGBA8 sRGB.
The five-pixel image border uses LibRaw's local color averages. Original RAW
files remain authoritative for future processing and editing.

`sensor-blend.ts` expresses the three-channel highlight blend in Float32 camera
RGB and WGSL. It preserves mean camera intensity, smoothly reduces chroma from
reported sensor saturation to nominal white, and leaves unsaturated samples
unchanged. It applies only to HDR RAW preview preparation, after fixed-white
measurement and before lens correction and camera color conversion. Unclipped
decoder references and merge preparation retain their original behavior.
