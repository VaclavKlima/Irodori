"""Render reproducible CPU research artifacts from frozen GPU mask logits.

This helper is artifact preparation, not production rendering or model inference.
Both candidates use the same explicit reconstruction: highest returned predicted
IoU, bilinear native-grid logit resize with align_corners=False, threshold zero.
Predicted IoU is a model ranking signal, not measured accuracy or physical alpha.
The +1 EV view doubles linear sRGB in binary coverage; it is an SDR diagnostic,
not Irodori's actual RAW/HDR edit pipeline or an automatic matting result.
"""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
import torch
import torch.nn.functional as functional


POLICY = {
    "version": 1,
    "id": "shared-bilinear-native-binary-v1",
    "candidate": "highest-returned-predicted-iou-first-index-on-tie",
    "logitReconstruction": "bilinear-to-native-align-corners-false",
    "coverage": "logit-greater-than-zero-binary-r8",
    "diagnostic": "linear-srgb-times-two-in-binary-coverage-clamp-to-sdr",
    "timing": "CPU artifact preparation excluded from model inference timings",
    "physicalAlpha": False,
    "automaticMatting": False,
}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def tensor_output(stage, name):
    record = next(output for output in stage["outputs"] if output["name"] == name)
    path = Path(record["path"])
    if digest(path) != record["sha256"]:
        raise ValueError(f"Changed model output: {path}")
    values = np.fromfile(path, dtype="<f4")
    if values.size != np.prod(record["shape"]):
        raise ValueError("Incomplete model output.")
    return values.reshape(record["shape"])


def fit(image, maximum):
    result = image.copy()
    result.thumbnail((maximum, maximum), Image.Resampling.LANCZOS)
    return result


def diagnostic(rgb, coverage):
    values = rgb.astype(np.float32) / 255.0
    linear = np.where(values <= 0.04045, values / 12.92,
                      ((values + 0.055) / 1.055) ** 2.4)
    linear *= 1.0 + coverage[:, :, None]
    linear = np.minimum(linear, 1.0)
    encoded = np.where(linear <= 0.0031308, linear * 12.92,
                       1.055 * linear ** (1.0 / 2.4) - 0.055)
    return Image.fromarray(np.rint(np.clip(encoded, 0, 1) * 255).astype(np.uint8))


def overlay(rgb, coverage):
    mix = coverage[:, :, None] * 0.38
    result = rgb.astype(np.float32) * (1 - mix) + np.array([255, 60, 45]) * mix
    return Image.fromarray(np.rint(result).astype(np.uint8))


def panel(images, labels):
    width = sum(image.width for image in images)
    height = max(image.height for image in images)
    result = Image.new("RGB", (width, height + 28), "#202020")
    draw = ImageDraw.Draw(result)
    x = 0
    for image, label in zip(images, labels):
        result.paste(image, (x, 28))
        draw.text((x + 6, 7), label, fill="white")
        x += image.width
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--crops", type=Path,
                        help="Frozen id -> named [x,y,width,height] native proof regions.")
    parser.add_argument("--ids", nargs="+")
    parser.add_argument("--allow-holdout", action="store_true")
    parser.add_argument("--fit-long-edge", type=int, default=1400)
    args = parser.parse_args()
    corpus = json.loads(args.corpus.read_text())
    crops = json.loads(args.crops.read_text()) if args.crops else {}
    if corpus.get("status") != "passed":
        raise SystemExit("Render only a successful strict-GPU research corpus result.")
    cases = [case for case in corpus["cases"] if not args.ids or case["id"] in args.ids]
    if any(case["split"] != "development" for case in cases) and not args.allow_holdout:
        raise SystemExit("Held-out proofs require an explicit frozen-candidate release.")
    if args.ids and len(cases) != len(set(args.ids)):
        raise SystemExit("A selected proof case is absent.")
    if not 1 <= args.fit_long_edge <= 2048:
        raise SystemExit("Fit proof long edge must be between 1 and 2048.")
    torch.set_num_threads(2)
    args.output.mkdir(parents=True, exist_ok=True)
    manifest = {"version": 1, "policy": POLICY, "corpus": str(args.corpus.resolve()),
                "corpusSha256": digest(args.corpus), "proofs": []}
    for case in cases:
        source_path = Path(case["preparedImage"])
        if digest(source_path) != case["preparedSha256"]:
            raise ValueError("Changed prepared source.")
        source = Image.open(source_path).convert("RGB")
        if source.size != (case["width"], case["height"]):
            raise ValueError("Prepared source dimensions changed.")
        if source.width * source.height > 24_000_000:
            raise ValueError("Proof preparation exceeds the declared 24 MP bound.")
        rgb = np.asarray(source)
        directory = args.output / case["id"]
        directory.mkdir(parents=True, exist_ok=True)
        source_fit = directory / "source-fit.png"
        fit(source, args.fit_long_edge).save(source_fit)
        record = {"id": case["id"], "model": corpus["model"],
                  "width": source.width, "height": source.height,
                  "sourceFit": str(source_fit.resolve()), "stages": []}
        for stage in case["stages"]:
            scores = tensor_output(stage, "iou_scores").reshape(-1)
            logits = tensor_output(stage, "mask_logits")
            if not np.isfinite(scores).all() or not np.isfinite(logits).all():
                raise ValueError("Nonfinite research model output.")
            selected = int(np.argmax(scores))
            if selected != stage["selectedCandidate"]:
                raise ValueError("Selected candidate disagrees with frozen ranking policy.")
            flat = logits.reshape(-1, *logits.shape[-2:])
            if flat.shape[0] != scores.size:
                raise ValueError("Mask and score candidate count mismatch.")
            native = functional.interpolate(torch.from_numpy(flat[selected].copy())[None, None],
                                            size=(source.height, source.width), mode="bilinear",
                                            align_corners=False)[0, 0].numpy()
            coverage = (native > 0).astype(np.uint8)
            mask_path = directory / f"{stage['id']}-coverage-r8.png"
            Image.fromarray(coverage * 255).save(mask_path)
            overlay_image = overlay(rgb, coverage)
            diagnostic_image = diagnostic(rgb, coverage)
            overlay_path = directory / f"{stage['id']}-overlay-fit.png"
            diagnostic_path = directory / f"{stage['id']}-plus-one-ev-fit.png"
            fit(overlay_image, args.fit_long_edge).save(overlay_path)
            fit(diagnostic_image, args.fit_long_edge).save(diagnostic_path)
            fit_panel_path = directory / f"{stage['id']}-fit-panel.png"
            panel([fit(source, 720), fit(overlay_image, 720), fit(diagnostic_image, 720)],
                  ["Source - fit", "Binary selection overlay - fit", "+1 EV SDR diagnostic - fit"]).save(fit_panel_path)
            stage_record = {"id": stage["id"], "selectedCandidate": selected,
                            "predictedIou": float(scores[selected]),
                            "coverage": str(mask_path.resolve()),
                            "coverageSha256": digest(mask_path),
                            "selectedPixels": int(coverage.sum()),
                            "overlayFit": str(overlay_path.resolve()),
                            "diagnosticFit": str(diagnostic_path.resolve()),
                            "fitPanel": str(fit_panel_path.resolve()), "nativeCrops": []}
            for name, bounds in crops.get(case["id"], {}).items():
                x, y, width, height = bounds
                if not all(isinstance(value, int) for value in bounds) or not (
                    x >= 0 and y >= 0 and width > 0 and height > 0
                    and x + width <= source.width and y + height <= source.height
                ):
                    raise ValueError(f"Invalid frozen native crop: {case['id']}/{name}")
                rectangle = (x, y, x + width, y + height)
                crop_path = directory / f"{stage['id']}-{name}-native-panel.png"
                panel([image.crop(rectangle) for image in
                       [source, overlay_image, diagnostic_image]],
                      ["Source - 1 image pixel per pixel", "Binary selection overlay - native",
                       "+1 EV SDR diagnostic - native"]).save(crop_path)
                stage_record["nativeCrops"].append({"name": name, "bounds": bounds,
                                                    "path": str(crop_path.resolve())})
            record["stages"].append(stage_record)
            del native, coverage, overlay_image, diagnostic_image
        manifest["proofs"].append(record)
        (args.output / "proofs.json").write_text(json.dumps(manifest, indent=2) + "\n")
        print(json.dumps({"id": case["id"], "model": corpus["model"],
                          "stages": len(record["stages"])}), flush=True)
    print("CPU diagnostic artifacts prepared; no model inference or application edit was performed.")


if __name__ == "__main__":
    main()
