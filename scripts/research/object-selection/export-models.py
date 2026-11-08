"""Export pinned research-only segmentation components and explicit CPU probe references.

This is an offline export/diagnostic step after the strict native-WebGPU gate.
It never installs dependencies, downloads weights, chooses a fallback, or accesses
an application library. Actual segmentation inference must use the qualified GPU.
"""
import argparse
import hashlib
import importlib.metadata
import json
import platform
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import onnx
import torch


SOURCE_MANIFEST = Path(__file__).with_name("model-sources.json")


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def tensor_file(directory, name, tensor):
    array = tensor.detach().cpu().contiguous().numpy()
    path = directory / f"{name}.bin"
    array.tofile(path)
    return {"name": name, "path": str(path.resolve()), "dtype": str(array.dtype),
            "shape": list(array.shape), "bytes": path.stat().st_size, "sha256": digest(path)}


class SamEncoder(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model
        self.register_buffer("mean", torch.tensor([0.485, 0.456, 0.406]).reshape(1, 3, 1, 1))
        self.register_buffer("std", torch.tensor([0.229, 0.224, 0.225]).reshape(1, 3, 1, 1))

    def forward(self, image):
        backbone = self.model.forward_image((image - self.mean) / self.std)
        _, features, _, _ = self.model._prepare_backbone_features(backbone)
        if self.model.directly_add_no_mem_embed:
            features[-1] = features[-1] + self.model.no_mem_embed
        sizes = [(256, 256), (128, 128), (64, 64)]
        levels = [feature.permute(1, 2, 0).reshape(1, -1, *size)
                  for feature, size in zip(features, sizes)]
        return levels[0], levels[1], levels[2]


class SamDecoder(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, feature0, feature1, embedding, coordinates, labels, mask_input, has_mask):
        prompt = self.model.sam_prompt_encoder
        sparse, dense = prompt(points=(coordinates, labels), boxes=None, masks=mask_input)
        empty = prompt.no_mask_embed.weight.reshape(1, -1, 1, 1)
        dense = has_mask.reshape(1, 1, 1, 1) * dense + (1 - has_mask.reshape(1, 1, 1, 1)) * empty
        masks, scores, _, _ = self.model.sam_mask_decoder(
            image_embeddings=embedding,
            image_pe=prompt.get_dense_pe(),
            sparse_prompt_embeddings=sparse,
            dense_prompt_embeddings=dense,
            multimask_output=True,
            repeat_image=False,
            high_res_features=[feature0, feature1],
        )
        return torch.clamp(masks, -32.0, 32.0), scores


class EfficientEncoder(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, image):
        return self.model.get_image_embeddings(image)


class EfficientDecoder(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, embedding, coordinates, labels):
        masks, scores = self.model.predict_masks(
            embedding, coordinates.unsqueeze(1), labels.unsqueeze(1),
            multimask_output=True, input_h=1024, input_w=1024,
            output_h=-1, output_w=-1,
        )
        return masks.reshape(1, 3, 256, 256), scores.reshape(1, 3)


def export_component(module, inputs, input_names, output_names, directory, component):
    path = directory / f"{component}.onnx"
    started = time.perf_counter()
    with torch.inference_mode():
        outputs = module(*inputs)
        if isinstance(outputs, torch.Tensor):
            outputs = (outputs,)
        torch.onnx.export(
            module, tuple(inputs), str(path), input_names=input_names,
            output_names=output_names, opset_version=17, do_constant_folding=True,
        )
    onnx.checker.check_model(str(path))
    probe = directory / component
    probe.mkdir(exist_ok=True)
    record = {"component": component, "path": str(path.resolve()), "bytes": path.stat().st_size,
              "sha256": digest(path), "opset": 17, "exportSeconds": time.perf_counter() - started,
              "inputs": [tensor_file(probe, name, tensor) for name, tensor in zip(input_names, inputs)],
              "outputs": [tensor_file(probe, name, tensor) for name, tensor in zip(output_names, outputs)]}
    return record, outputs


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True, choices=["sam2.1-hiera-tiny", "efficient-sam-vitt"])
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--gpu-gate", type=Path, required=True,
                        help="JSON result of the successful strict native-WebGPU known-tensor probe")
    parser.add_argument("--cpu-export-reference", action="store_true", required=True,
                        help="Acknowledge CPU execution solely for model export and known-tensor reference")
    parser.add_argument("--label-dtype", choices=["int64", "float32"], default="int64")
    parser.add_argument("--reuse-encoder-manifest", type=Path)
    parser.add_argument("--original-reference-manifest", type=Path,
                        help="Require exact decoder output agreement with the original int64 PyTorch reference")
    args = parser.parse_args()
    gate = json.loads(args.gpu_gate.read_text())
    # The caller must pass the actual runtime receipt, not infer success from package availability.
    if gate.get("status") not in ["passed", "pass"]:
        raise SystemExit("Strict native GPU gate has not passed; no model export/inference was attempted.")
    source = next(item for item in json.loads(SOURCE_MANIFEST.read_text())["models"] if item["id"] == args.model)
    actual_revision = subprocess.check_output(["git", "-C", str(args.source_dir), "rev-parse", "HEAD"], text=True).strip()
    if actual_revision != source["revision"]:
        raise SystemExit("Upstream source revision differs from its frozen research manifest.")
    args.output.mkdir(parents=True, exist_ok=True)
    torch.set_num_threads(2)
    torch.manual_seed(17)
    np.random.seed(17)
    sys.path.insert(0, str(args.source_dir.resolve()))
    checkpoint_sha = digest(args.checkpoint)
    if checkpoint_sha != source["checkpointSha256"]:
        raise SystemExit("Checkpoint SHA-256 differs from its frozen research manifest.")
    if args.model == "sam2.1-hiera-tiny":
        from sam2.build_sam import build_sam2
        model = build_sam2(source["configuration"], str(args.checkpoint.resolve()), device="cpu", apply_postprocessing=False).eval()
        encoder, decoder = SamEncoder(model).eval(), SamDecoder(model).eval()
        feature_names = ["feature0", "feature1", "image_embeddings"]
    else:
        from efficient_sam.efficient_sam import build_efficient_sam
        model = build_efficient_sam(encoder_patch_embed_dim=192, encoder_num_heads=3,
                                    checkpoint=str(args.checkpoint.resolve())).eval()
        encoder, decoder = EfficientEncoder(model).eval(), EfficientDecoder(model).eval()
        feature_names = ["image_embeddings"]
    # The deterministic synthetic image probes numeric/runtime parity, not photographic quality.
    y, x = np.mgrid[0:1024, 0:1024].astype(np.float32)
    image = torch.from_numpy(np.stack([x / 1023, y / 1023, (x + y) / 2046], axis=0)[None])
    coordinates = torch.tensor([[[256., 256.], [128., 128.], [768., 768.], [0., 0.], [0., 0.], [0., 0.]]])
    labels = torch.tensor([[1, 2, 3, -1, -1, -1]], dtype=torch.int64 if args.label_dtype == "int64" else torch.float32)
    records = []
    if args.reuse_encoder_manifest:
        prior = json.loads(args.reuse_encoder_manifest.read_text())
        encoded = next(component for component in prior["components"] if component["component"] == "encoder")
        if digest(Path(encoded["path"])) != encoded["sha256"]:
            raise SystemExit("The reused encoder changed.")
        with torch.inference_mode():
            features = encoder(image)
            if isinstance(features, torch.Tensor):
                features = (features,)
    else:
        encoded, features = export_component(encoder, [image], ["image"], feature_names, args.output, "encoder")
    records.append(encoded)
    decoder_inputs = list(features) + [coordinates, labels]
    decoder_names = feature_names + ["coordinates", "labels"]
    if args.model == "sam2.1-hiera-tiny":
        decoder_inputs += [torch.zeros((1, 1, 256, 256)), torch.zeros((1,))]
        decoder_names += ["mask_input", "has_mask"]
    decoded, decoder_outputs = export_component(decoder, decoder_inputs, decoder_names,
                                  ["mask_logits", "iou_scores"], args.output, "decoder")
    records.append(decoded)
    parity = None
    if args.original_reference_manifest:
        original = json.loads(args.original_reference_manifest.read_text())
        original_decoder = next(component for component in original["components"] if component["component"] == "decoder")
        comparisons = []
        for output, reference in zip(decoder_outputs, original_decoder["outputs"]):
            reference_path = Path(reference["path"])
            if digest(reference_path) != reference["sha256"]:
                raise SystemExit("The original int64 CPU reference changed.")
            expected = np.fromfile(reference_path, dtype=np.dtype(reference["dtype"])).reshape(reference["shape"])
            actual = output.detach().cpu().numpy()
            equal = bool(np.array_equal(actual, expected))
            comparisons.append({"name": reference["name"], "exact": equal,
                                "maxAbsoluteError": float(np.max(np.abs(actual - expected)))})
            if not equal:
                raise SystemExit("Categorical label compatibility change differs from original int64 reference.")
        parity = {"status": "passed", "source": str(args.original_reference_manifest.resolve()),
                  "sourceSha256": digest(args.original_reference_manifest), "comparisons": comparisons}
    result = {"version": 1, "status": "exported-unqualified", "model": args.model,
              "sourceRevision": actual_revision, "checkpoint": {"path": str(args.checkpoint.resolve()),
              "sourceUrl": source["checkpointUrl"], "bytes": args.checkpoint.stat().st_size, "sha256": checkpoint_sha},
              "environment": {"python": platform.python_version(), "platform": platform.platform(),
              "packages": {name: importlib.metadata.version(name) for name in ["torch", "torchvision", "onnx", "numpy"]}},
              "execution": "explicit CPU export/known-tensor reference, not production or fallback inference",
              "input": "RGB float32 NCHW [0,1], 1024 square; per-model normalization inside encoder",
              "prompts": "Six fixed slots in 1024-square pixel coordinates; labels -1 padding, 0 negative, 1 positive, 2/3 box corners. Reject excess prompts.",
              "categoricalLabelDtype": args.label_dtype, "originalInt64Parity": parity,
              "outputs": "Three 256-square low-resolution segmentation logits and predicted IoU scores, not alpha opacity or semantic confidence.",
              "components": records}
    (args.output / "manifest.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"model": args.model, "status": result["status"], "manifest": str(args.output / "manifest.json")}))


if __name__ == "__main__":
    main()
