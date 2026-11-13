# Automatic sky and background models

Issue [#86](https://github.com/VaclavKlima/Irodori/issues/86) uses two MIT-licensed
FP32 models through the existing **onnxruntime-node 1.31.1 native WebGPU** worker.
Only the requested model is loaded. CPU inference fallback is disabled. Setup and
production inference need neither Python nor network access.

| Selection  | Pinned source                                                                                                                                                                   | Input and output                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Sky        | [ShaderError/perspectra-mask2former](https://huggingface.co/ShaderError/perspectra-mask2former/tree/fe51622c751dcb93f8778f0e80abe5a685ffe416), `mask2former_swint_ade_512.onnx` | ImageNet-normalized RGB 512² → 150 semantic scores at 128²; ADE20K sky class 2           |
| Background | [CoderViking/birefnet-lite-onnx](https://huggingface.co/CoderViking/birefnet-lite-onnx/tree/dc06453148f01ef4131f17e9b791345e32e8ee78), `birefnet-lite-1024.onnx`                | ImageNet-normalized RGB 1024² → salient-foreground logits 1024², inverted for background |

The sky source exports the official Meta Mask2Former Swin Tiny ADE20K weights.
The background source exports official ZhengPeng7 BiRefNet Lite weights with
deformable convolution expressed using GridSample and Conv. The background graph
is bundled unchanged. Sky needs static shape simplification, FP32 sampling
coordinates, exact FP32 boolean counts, exact GELU expansion and equivalent
opset-18 bilinear GridSample for this native provider. Shape/index integers remain
int64. There is no precision change to trained weights.

`manifest.json` pins every archive, chunk and reconstructed graph. The eight gzip
chunks total **353,762,781 bytes**; reconstructed sky/background graphs are
287,296,604 / 199,681,624 bytes. Chunks are at most 49 MiB, below GitHub's file
limit. Copy this entire directory, including licenses and NOTICE, when packaging.
`npm run setup:object-selection` verifies all SAM, sky and background bytes offline;
`--output <directory>` additionally reconstructs the four graphs.

[The research recipe](../../../../scripts/research/sky-selection/README.md) pins
source/checkpoint hashes, compatibility conversion and reference environments.
Official unmodified PyTorch references agree with native WebGPU on 7,372,800 sky
values across three photographs and 1,048,576 background values on the bird input,
at absolute + relative tolerance `1e-3 + 1e-3 * abs(reference)`, with zero threshold
or sky-label flips. This establishes sampled numerical agreement, not universal
segmentation accuracy. The older onnx-community BiRefNet export differed and was
rejected as an interchangeable reference; retained private diagnostics explain the
comparison.

Sampling uses common antialiased bilinear RGB preparation. The same sky graph
processes color and luminance views sequentially. Their union retains **all**
class-2 pixels, including disconnected openings, with first-label tie breaking.
Background is the inverse of salient-foreground probability, not depth or physical
transparency. Common RGB guided reconstruction evaluates low-resolution local
linear coefficients against native image RGB (radius 8, epsilon 0.001), then stores
immutable native-size R8 coverage. Manual Paint/Erase and existing mask edges stay
separate and editable. See the [feature contract](../../../../docs/features/sky-background-selection.md)
for quality, device and resource limits.
