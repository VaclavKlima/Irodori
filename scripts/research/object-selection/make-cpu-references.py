"""Attach explicit upstream-PyTorch int64-label diagnostic references to approved cases.

Run only after the same model passes its strict native-WebGPU execution gate.
These CPU outputs are numerical oracles, never a fallback or quality-study output.
"""
import argparse
import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import torch


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def read_tensor(record):
    path = Path(record["path"])
    if digest(path) != record["sha256"]:
        raise ValueError("Research tensor changed before reference generation.")
    return torch.from_numpy(np.fromfile(path, dtype=record["dtype"]).reshape(record["shape"]))


def save_tensor(directory, name, tensor):
    array = tensor.detach().cpu().contiguous().numpy().astype(np.float32)
    path = directory / f"reference-{name}.bin"
    array.tofile(path)
    return {"name": name, "path": str(path.resolve()), "dtype": "float32",
            "shape": list(array.shape), "bytes": path.stat().st_size, "sha256": digest(path)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", type=Path, required=True)
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--gpu-gate", type=Path, required=True)
    parser.add_argument("--cpu-reference-diagnostic", action="store_true", required=True)
    parser.add_argument("--allow-holdout", action="store_true",
                        help="Explicitly release held-out diagnostics only after the study owner freezes the candidate")
    args = parser.parse_args()
    cases = json.loads(args.cases.read_text())
    source = next(item for item in json.loads(Path(__file__).with_name("model-sources.json").read_text())["models"]
                  if item["id"] == cases["model"])
    gate = json.loads(args.gpu_gate.read_text())
    if gate.get("status") != "passed" or gate.get("model") != cases["model"] or gate.get("cpuFallbackDisabled") is not True:
        raise SystemExit("The same model must pass strict GPU execution before CPU diagnostic references.")
    if not args.allow_holdout and any(case["split"] != "development" for case in cases["cases"]):
        raise SystemExit("Held-out diagnostics require explicit frozen-candidate release; no reference inference was attempted.")
    actual_revision = subprocess.check_output(["git", "-C", str(args.source_dir), "rev-parse", "HEAD"], text=True).strip()
    if actual_revision != source["revision"] or digest(args.checkpoint) != source["checkpointSha256"]:
        raise SystemExit("Upstream source or checkpoint differs from the frozen manifest.")
    torch.set_num_threads(2)
    sys.path.insert(0, str(args.source_dir.resolve()))
    if cases["model"] == "sam2.1-hiera-tiny":
        from sam2.build_sam import build_sam2
        from sam2.sam2_image_predictor import SAM2ImagePredictor
        model = build_sam2(source["configuration"], str(args.checkpoint.resolve()), device="cpu", apply_postprocessing=False).eval()
        predictor = SAM2ImagePredictor(model)
    else:
        from efficient_sam.efficient_sam import build_efficient_sam
        model = build_efficient_sam(encoder_patch_embed_dim=192, encoder_num_heads=3,
                                    checkpoint=str(args.checkpoint.resolve())).eval()
    for case in cases["cases"]:
        image = read_tensor(case["image"])
        started = time.perf_counter()
        with torch.inference_mode():
            if cases["model"] == "sam2.1-hiera-tiny":
                # Float RGB input avoids quantization and uses the official predictor's normalization.
                predictor.set_image(image[0].permute(1, 2, 0).numpy())
            else:
                embedding = model.get_image_embeddings(image)
            for stage in case["stages"]:
                inputs = {record["name"]: read_tensor(record) for record in stage["inputs"]}
                coordinates = inputs["coordinates"]
                raw_labels = inputs["labels"]
                if not all(value in [-1, 0, 1, 2, 3] for value in raw_labels.reshape(-1).tolist()):
                    raise SystemExit("Only exact categorical prompt labels are valid.")
                labels = raw_labels.to(torch.int64)
                if cases["model"] == "sam2.1-hiera-tiny":
                    _, scores, low = predictor.predict(
                        point_coords=coordinates[0].numpy(), point_labels=labels[0].numpy(),
                        multimask_output=True, return_logits=True,
                    )
                    logits = torch.from_numpy(low).unsqueeze(0)
                    iou = torch.from_numpy(scores).unsqueeze(0)
                else:
                    low, scores = model.predict_masks(
                        embedding, coordinates.unsqueeze(1), labels.unsqueeze(1),
                        multimask_output=True, input_h=1024, input_w=1024,
                        output_h=-1, output_w=-1,
                    )
                    logits, iou = low.reshape(1, 3, 256, 256), scores.reshape(1, 3)
                directory = Path(case["image"]["path"]).parent / stage["id"]
                directory.mkdir(exist_ok=True)
                stage["outputs"] = [save_tensor(directory, "mask_logits", logits), save_tensor(directory, "iou_scores", iou)]
        case["reference"] = {"backend": "upstream-pytorch-cpu", "diagnosticOnly": True,
                             "categoricalLabels": "original-int64", "elapsedSeconds": time.perf_counter() - started,
                             "sourceRevision": actual_revision, "gpuGateSha256": digest(args.gpu_gate)}
        print(json.dumps({"model": cases["model"], "case": case["id"], "referenceSeconds": case["reference"]["elapsedSeconds"]}), flush=True)
    temporary = args.cases.with_suffix(".json.partial")
    temporary.write_text(json.dumps(cases, indent=2) + "\n")
    temporary.replace(args.cases)


if __name__ == "__main__":
    main()
