# SAM 2.1 object selection model

This directory contains the Apache-2.0 SAM 2.1 Hiera Tiny model exported to two fixed-shape FP32 ONNX graphs. The application uses the same native ONNX Runtime WebGPU implementation on supported platforms. It never downloads executable model code or runs Python at installation or inference time.

`manifest.json` records the original Meta source revision, checkpoint URL and SHA-256, export environment, modifications, and exact exported graph hashes. `LICENSE-SAM2` and `NOTICE` accompany the model. The export recipe and pinned Python environment are retained in `scripts/research/object-selection/`; the research source/checkpoint manifest provides independent download provenance.

`export.publishedSourceManifest` hashes the current committed research metadata.
The separate `sourceManifestSha256` is a historical recorded digest whose original
snapshot is unavailable for revalidation. The upstream revision and checkpoint
digest agree with retained export receipts; byte identity between those metadata
snapshots is unverified. Model chunks, reconstructed graphs, exporter and environment
requirements retain independently verified hashes.

The graph bytes are losslessly gzip-compressed, then divided into chunks of at most 50 MiB. Chunk boundaries do not change the model. The loader validates each chunk, the joined archive and the decompressed pinned graph before creating a GPU session. The encoder reconstructs to 109,384,732 bytes; the decoder reconstructs to 16,444,091 bytes. Preserve all chunks and the license files when copying or packaging this directory.

Run `npm run setup:object-selection` to verify the complete bundled payload without model inference or network access. `node scripts/setup-object-selection.mjs --output <directory>` optionally reconstructs the verified ONNX files for independent inspection. Production workers consume the compressed bundle directly; generated ONNX files and local probes do not belong in Git.

The export uses exact float32 categorical prompt labels for native WebGPU compatibility, six prompt slots, and a 1024 × 1024 RGB input. The encoder performs normalization internally. Image preparation uses separable antialiased bilinear GPU sampling; native coverage uses bilinear low-resolution logits and a strict zero threshold. The highest predicted-IoU alternative wins, first on ties. Scores rank alternatives and do not certify selection accuracy or physical alpha.
