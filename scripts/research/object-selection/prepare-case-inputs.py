"""Prepare fixed research tensors from privacy-reviewed neutral image manifests.

Uses the official model's geometric preprocessing, never a screen capture or a
camera embedded preview. This fixture preparation step performs no segmentation
inference and changes no managed photograph or edits.
"""
import argparse
import hashlib
import json
import time
from pathlib import Path

import numpy as np
from PIL import Image
import torch
import torch.nn.functional as functional
from torchvision.transforms import InterpolationMode
from torchvision.transforms.functional import pil_to_tensor, resize


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def save_tensor(directory, name, tensor):
    array = tensor.contiguous().numpy()
    path = directory / f"{name}.bin"
    array.tofile(path)
    return {"name": name, "path": str(path.resolve()), "dtype": str(array.dtype),
            "shape": list(array.shape), "bytes": path.stat().st_size, "sha256": digest(path)}


def prompts(record, refined, label_dtype):
    prompt = record["prompt"]
    if prompt["units"] != "normalized":
        raise ValueError("Research manifest prompts must use explicit normalized coordinates.")
    x0, y0, x1, y1 = prompt["box"]
    if not (0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1):
        raise ValueError("Invalid normalized research box.")
    points = [(x0, y0), (x1, y1)]
    labels = [2, 3]
    if refined:
        for key, label in [("positivePoints", 1), ("negativePoints", 0)]:
            for x, y in prompt.get(key, []):
                if not (0 <= x <= 1 and 0 <= y <= 1):
                    raise ValueError("Invalid normalized research prompt point.")
                points.append((x, y))
                labels.append(label)
    if len(points) > 6:
        raise ValueError("Research decoder supports six prompt slots; excess points are refused, never truncated.")
    coordinates = torch.zeros((1, 6, 2), dtype=torch.float32)
    point_labels = torch.full((1, 6), -1, dtype=torch.int64 if label_dtype == "int64" else torch.float32)
    for index, (point, label) in enumerate(zip(points, labels)):
        coordinates[0, index] = torch.tensor(point) * 1024
        point_labels[0, index] = label
    return coordinates, point_labels


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inputs", type=Path, required=True)
    parser.add_argument("--model", choices=["sam2.1-hiera-tiny", "efficient-sam-vitt"], required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--ids", nargs="+")
    parser.add_argument("--allow-holdout", action="store_true",
                        help="Explicitly release held-out tensor fixtures only after the study owner freezes the candidate")
    parser.add_argument("--label-dtype", choices=["int64", "float32"], default="float32")
    args = parser.parse_args()
    source = json.loads(args.inputs.read_text())
    if source.get("version") != 1 or not source.get("images"):
        raise SystemExit("Use the prepared version-1 image manifest.")
    torch.set_num_threads(2)
    args.output.mkdir(parents=True, exist_ok=True)
    cases = []
    selected = [record for record in source["images"] if record["split"] == "development"] if not args.ids else [record for record in source["images"] if record["id"] in args.ids]
    if not args.allow_holdout and any(record["split"] != "development" for record in selected):
        raise SystemExit("Held-out tensors require an explicit frozen-candidate release; no inputs were prepared.")
    if args.ids and len(selected) != len(set(args.ids)):
        raise SystemExit("A selected research case is absent from the prepared manifest.")
    for record in selected:
        path = Path(record["path"])
        if digest(path) != record["preparedSha256"]:
            raise SystemExit(f"Prepared image changed: {record['id']}")
        directory = args.output / record["id"]
        directory.mkdir(exist_ok=True)
        started = time.perf_counter()
        with Image.open(path) as image:
            rgb = pil_to_tensor(image.convert("RGB")).to(torch.float32) / 255
        if list(rgb.shape[1:]) != [record["height"], record["width"]]:
            raise SystemExit(f"Prepared image dimensions changed: {record['id']}")
        if args.model == "sam2.1-hiera-tiny":
            resized = resize(rgb, [1024, 1024], interpolation=InterpolationMode.BILINEAR, antialias=True).unsqueeze(0)
            policy = "Official SAM2 tensor Resize bilinear antialias=true; mean/std in exported encoder"
        else:
            resized = functional.interpolate(rgb.unsqueeze(0), (1024, 1024), mode="bilinear")
            policy = "Official EfficientSAM F.interpolate bilinear align_corners=false; mean/std in exported encoder"
        image_tensor = save_tensor(directory, "image", resized)
        stages = []
        for stage in ["box", "refined"]:
            coordinates, labels = prompts(record, stage == "refined", args.label_dtype)
            stages.append({"id": stage, "inputs": [
                save_tensor(directory, f"{stage}-coordinates", coordinates),
                save_tensor(directory, f"{stage}-labels", labels),
            ]})
        # Prefixes identify fixture files only; exported model input names are stable.
        for stage in stages:
            stage["inputs"][0]["name"] = "coordinates"
            stage["inputs"][1]["name"] = "labels"
        extras = []
        if args.model == "sam2.1-hiera-tiny":
            extras = [save_tensor(directory, "mask_input", torch.zeros((1, 1, 256, 256))),
                      save_tensor(directory, "has_mask", torch.zeros((1,)))]
        cases.append({"id": record["id"], "split": record["split"],
                      "source": record["source"], "sourceSha256": record["sha256"],
                      "preparedImage": str(path), "preparedSha256": record["preparedSha256"],
                      "width": record["width"], "height": record["height"],
                      "image": image_tensor, "stages": stages, "decoderExtras": extras,
                      "preprocessPolicy": policy, "preprocessSeconds": time.perf_counter() - started,
                      "mapping": {"space": "complete once-oriented neutral source",
                                  "modelWidth": 1024, "modelHeight": 1024,
                                  "scaleX": 1024 / record["width"], "scaleY": 1024 / record["height"]}})
    result = {"version": 1, "model": args.model, "sourceManifest": str(args.inputs.resolve()),
              "sourceManifestSha256": digest(args.inputs), "cases": cases,
              "categoricalLabelDtype": args.label_dtype,
              "execution": "CPU/native tensor fixture preparation only; no model inference or application edits"}
    output = args.output / "cases.json"
    output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"model": args.model, "cases": len(cases), "manifest": str(output)}))


if __name__ == "__main__":
    main()
