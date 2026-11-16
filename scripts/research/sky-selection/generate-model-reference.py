"""Generate independent official-weight FP32 references; never an app dependency."""

import argparse
import hashlib
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import platform
import sys
import time
import types
import urllib.request


PINS = {
    "sky": {
        "repository": "facebook/mask2former-swin-tiny-ade-semantic",
        "revision": "c8cf1b5e823aee214d937d0d001c1850ba44ef6a",
        "checkpoint": "pytorch_model.bin",
        "files": {
            "pytorch_model.bin": "97bb47771b1f679d0d8b2de75f2d48ce8ad53a60ab56d489c792d48ccb044500",
            "config.json": "7929dfd52f551f8dc0d6302dc9329abc7741277c8e853c5abcd479776745e65e",
        },
    },
    "background": {
        "repository": "ZhengPeng7/BiRefNet_lite",
        "revision": "7838f1c3472f827cd8ce13ab5ccc2ce48077360f",
        "checkpoint": "model.safetensors",
        "files": {
            "model.safetensors": "4417d89795250e698c3cb0ae8df15743810065f646f48a694fdfa7ca052d0815",
            "config.json": "9dc8614fccddd40c601aeadc69b9db6dd820598179b2a2198492e6ffa016a824",
            "BiRefNet_config.py": "e7b8c2a74f6cea6a59553d517f71d47f2c1d90e670a13416af17c25fe2f3dc52",
            "birefnet.py": "af8568b5be406bf4d2a68a7ed6d72e40f73b37a1fb6fc9ebd71b5b3cbcd069c9",
        },
    },
}
VERSIONS = {
    "torch": "2.8.0",
    "torchvision": "0.23.0",
    "transformers": "4.52.4",
    "timm": "1.0.15",
    "einops": "0.8.1",
    "safetensors": "0.5.3",
    "huggingface-hub": "0.32.4",
    "kornia": "0.7.4",
    "scipy": "1.18.1",
    "numpy": "2.5.4",
}


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def model_files(directory, download):
    """Authenticate before importing the reviewed, pinned official model code."""
    for kind, pin in PINS.items():
        folder = directory / kind
        folder.mkdir(parents=True, exist_ok=True)
        for name, expected in pin["files"].items():
            path = folder / name
            if not path.exists() and download:
                url = f"https://huggingface.co/{pin['repository']}/resolve/{pin['revision']}/{name}"
                temporary = path.with_suffix(path.suffix + ".part")
                with urllib.request.urlopen(url, timeout=180) as response, temporary.open("xb") as output:
                    total = 0
                    while block := response.read(1024 * 1024):
                        total += len(block)
                        if total > 256 * 1024 * 1024:
                            raise ValueError("Official reference download exceeds its bound.")
                        output.write(block)
                if sha256(temporary.read_bytes()) != expected:
                    raise ValueError(f"Official reference hash mismatch: {kind}/{name}")
                temporary.rename(path)
            if not path.is_file() or path.stat().st_size > 256 * 1024 * 1024:
                raise ValueError(f"Missing bounded reference input: {path}; use --download once.")
            if sha256(path.read_bytes()) != expected:
                raise ValueError(f"Official reference hash mismatch: {kind}/{name}")


def contained_file(directory, name):
    if not isinstance(name, str) or Path(name).name != name:
        raise ValueError("Tensor paths must be plain files in the reference directory.")
    path = directory / name
    if path.is_symlink():
        raise ValueError("Reference tensors cannot be symbolic links.")
    return path


def load_background(directory):
    # The exact reviewed snapshot uses local constant model names in eval(), no
    # user expressions. Its pretrained-backbone branch remains disabled.
    package_name = "irodori_official_birefnet_reference"
    package = types.ModuleType(package_name)
    package.__path__ = [str(directory)]
    sys.modules[package_name] = package
    spec = importlib.util.spec_from_file_location(package_name + ".birefnet", directory / "birefnet.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    from safetensors.torch import load_file

    model = module.BiRefNet(config=module.BiRefNetConfig(bb_pretrained=False))
    model.load_state_dict(load_file(str(directory / "model.safetensors"), device="cpu"), strict=True)
    return model.cpu().float().eval()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("reference_directory", type=Path)
    parser.add_argument("--models", type=Path, required=True)
    parser.add_argument("--download", action="store_true", help="Download missing pinned inputs, then run offline.")
    args = parser.parse_args()
    if platform.python_version() != "3.12.16":
        raise ValueError("Use isolated Python 3.12.16 for reproducible official references.")
    versions = {name: importlib.metadata.version(name) for name in VERSIONS}
    for name, expected in VERSIONS.items():
        if versions[name].removesuffix("+cpu") != expected:
            raise ValueError(f"Expected {name} {expected}, found {versions[name]}.")
    model_files(args.models.resolve(), args.download)
    # No remote code, checkpoint lookup, MPS, CUDA or application inference path.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    import numpy as np
    import torch
    from transformers import Mask2FormerForUniversalSegmentation

    torch.set_num_threads(min(8, os.cpu_count() or 1))
    torch.manual_seed(0)
    directory = args.reference_directory.resolve()
    manifest_path = directory / "manifest.json"
    if manifest_path.stat().st_size > 1024 * 1024:
        raise ValueError("Reference manifest is oversized.")
    manifest = json.loads(manifest_path.read_text())
    cases = manifest.get("cases", [])
    if manifest.get("version") != 1 or len(cases) != 7 or manifest.get("officialReference"):
        raise ValueError("Prepare a fresh seven-case input manifest before generating references.")
    results = []
    for kind in ("sky", "background"):
        model = (
            Mask2FormerForUniversalSegmentation.from_pretrained(
                args.models.resolve() / "sky", local_files_only=True, use_safetensors=False
            ).cpu().float().eval()
            if kind == "sky"
            else load_background(args.models.resolve() / "background")
        )
        for case in cases:
            if case["selection"] != kind:
                continue
            expected_input = [1, 3, 512, 512] if kind == "sky" else [1, 3, 1024, 1024]
            if case["input"]["shape"] != expected_input:
                raise ValueError("Unexpected official model input shape.")
            source = contained_file(directory, case["input"]["file"]).read_bytes()
            if len(source) != int(np.prod(expected_input)) * 4 or sha256(source) != case["input"]["sha256"]:
                raise ValueError("Input Float32 bytes do not match their authenticated identity.")
            tensor = torch.from_numpy(np.frombuffer(source, dtype="<f4").copy().reshape(expected_input))
            if not bool(torch.isfinite(tensor).all()):
                raise ValueError("Official model input is nonfinite.")
            started = time.monotonic()
            with torch.inference_mode():
                if kind == "sky":
                    outputs = model(pixel_values=tensor)
                    values = torch.einsum(
                        "bqc,bqhw->bchw",
                        outputs.class_queries_logits.softmax(dim=-1)[..., :-1],
                        outputs.masks_queries_logits.sigmoid(),
                    )
                else:
                    values = model(tensor)[-1]
            shape = [1, 150, 128, 128] if kind == "sky" else [1, 1, 1024, 1024]
            if list(values.shape) != shape or not bool(torch.isfinite(values).all()):
                raise ValueError("Official model output has invalid shape or values.")
            data = values.detach().cpu().numpy().astype("<f4", copy=False).tobytes()
            filename = case["id"] + ".reference.f32"
            with contained_file(directory, filename).open("xb") as output:
                output.write(data)
            case["reference"] = {"file": filename, "shape": shape, "sha256": sha256(data)}
            results.append({"id": case["id"], "values": values.numel(), "seconds": round(time.monotonic() - started, 3)})
            print(json.dumps(results[-1]), flush=True)
        del model
    generator = Path(__file__).resolve()
    root = generator.parents[3]
    manifest["officialReference"] = {
        "generator": str(generator.relative_to(root)),
        "generatorSha256": sha256(generator.read_bytes()),
        "environment": {"python": platform.python_version(), "platform": platform.platform(), "versions": versions, "device": "cpu", "dtype": "float32", "threads": torch.get_num_threads()},
        "models": {kind: {"repository": pin["repository"], "revision": pin["revision"], "checkpointSha256": pin["files"][pin["checkpoint"]], "sourceFiles": pin["files"]} for kind, pin in PINS.items()},
        "cases": results,
    }
    temporary = manifest_path.with_suffix(".tmp")
    with temporary.open("x") as output:
        output.write(json.dumps(manifest, indent=2) + "\n")
    temporary.replace(manifest_path)


if __name__ == "__main__":
    main()
