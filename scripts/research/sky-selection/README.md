# Sky/background model reproduction and references

This directory is offline research tooling for [#86](https://github.com/VaclavKlima/Irodori/issues/86).
Production uses the bundled native Node/WebGPU worker only. Do not install these
Python dependencies in the application runtime or introduce a CPU inference retry.
Private original downloads, failed graphs, comparison tensors and outputs stay in
`artifacts/sky-selection/`; generated graphs are never source assets by accident.

Use an isolated Python 3.12.16 environment and `requirements.txt` for compatibility
conversion and numeric fixture generation. Download the exact source graph from
the pinned revision below, preserve it, then run:

```sh
python scripts/research/sky-selection/prepare-sky.py /private/source.onnx /private/new-sky.onnx
```

The command refuses source/output overlap, existing outputs and an unexpected
source hash. It performs the recorded static simplification and operator changes,
checks ONNX validity and the qualified graph digest, then publishes the candidate
using exclusive creation. It never overwrites bundled chunks. Exact byte
reproduction requires the pinned versions; a differing candidate needs fresh
numerical and native-provider qualification before publication. Background needs
no conversion. `npm run setup:object-selection` independently verifies the shipped
payload, without this environment.

| Source                                                                                     | Revision / file                                                               | SHA-256 / bytes                                                                  |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [Sky ONNX](https://huggingface.co/ShaderError/perspectra-mask2former)                      | `fe51622c751dcb93f8778f0e80abe5a685ffe416` / `mask2former_swint_ade_512.onnx` | `eb59758c041fcba3a34097845e259eb7cd584f9b56fdc94df15f8c1c6066f682` / 192,910,092 |
| [Official sky weights](https://huggingface.co/facebook/mask2former-swin-tiny-ade-semantic) | `c8cf1b5e823aee214d937d0d001c1850ba44ef6a` / `pytorch_model.bin`              | `97bb47771b1f679d0d8b2de75f2d48ce8ad53a60ab56d489c792d48ccb044500` / 190,189,605 |
| [Background ONNX and exporter](https://huggingface.co/CoderViking/birefnet-lite-onnx)      | `dc06453148f01ef4131f17e9b791345e32e8ee78` / `birefnet-lite-1024.onnx`        | `50a57872cc739192446da2a934159f957c81af8b5a161dfda8e3daa51660ca67` / 199,681,624 |
| [Official background weights](https://huggingface.co/ZhengPeng7/BiRefNet_lite)             | `7838f1c3472f827cd8ce13ab5ccc2ce48077360f` / `model.safetensors`              | `4417d89795250e698c3cb0ae8df15743810065f646f48a694fdfa7ca052d0815` / 177,634,392 |

Sky uses [Meta's MIT license](https://github.com/facebookresearch/Mask2Former/blob/main/LICENSE);
its official Hugging Face card's generic `other` label is recorded rather than
treated as a different grant. The pinned ONNX exporter declares MIT and unmodified
official weights. BiRefNet and its chosen exporter declare MIT. Both license texts
and notices ship alongside the graph chunks.

For the independent official-weight check, install `reference-requirements.txt`,
NumPy and SciPy in the isolated CPU environment. Fetch only pinned checkpoint and
configuration/source files; inspect remote model code before running it locally.
Load offline, eval/FP32, with unmodified torchvision deform_conv2d for BiRefNet.
For Mask2Former, combine softmax class queries (excluding the last no-object class)
with sigmoid mask queries using `einsum('bqc,bqhw->bchw', classes, masks)`.
Compare the **same input Float32 tensors** against native WebGPU outputs at
`abs(actual-reference) <= 1e-3 + 1e-3*abs(reference)`, including all values and
argmax-sky / zero-logit label flips. The original sky ONNX versus compatible graph
is an additional conversion check, not a substitute for official weights.

Frozen preprocessing samples come from independent PyTorch antialiased bilinear
sampling with a fixed `1e-6` RGB error gate. `generate-sampling-reference.py`
records its generator hash. RGB guided reconstruction follows the local linear
model of [Fast Guided Filter, He and Sun](https://arxiv.org/abs/1505.00996).
`generate-guided-reference.py` uses independent OpenCV and float64 normal equations;
the guide is scaled by 255 with epsilon scaled by 255² to avoid the OpenCV float32
normalized-space inverse degeneracy. Both references agree at every R8 pixel;
the GPU tolerance remains one byte. The failed original oracle is retained in
private evidence. Reproduction never relaxes a gate to fit GPU output.
