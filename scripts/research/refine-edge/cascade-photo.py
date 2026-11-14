"""Exact upstream photographic research adapter; every learned forward uses audited native ORT.

Original Torch native preparation/interpolation/tiling is explicitly selected for
this research stage. No Torch learned model is constructed or used as fallback.
"""
import argparse
import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[3]
PRIOR = ROOT / "artifacts/research/refine-edge/2026-11-13T19-41-14Z"


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--study", type=Path, required=True)
    parser.add_argument("--id", choices=["d08-flamingo", "h11-robin", "d04-forest-fence", "d06-wig"], required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    study, output = args.study.resolve(), args.output.resolve()
    if output.exists() or not output.is_relative_to(ROOT / "artifacts/research/refine-edge"):
        raise ValueError("Use a fresh private research destination.")
    output.mkdir(parents=True)
    (output / "generator.py").write_bytes(Path(__file__).read_bytes())
    started = time.monotonic()
    protocol = ROOT / "assets/tests/references/refine-edge/metadata-photos.json"
    (output / "protocol.json").write_bytes(protocol.read_bytes())
    base = next(x for x in json.loads((PRIOR / "baseline/cases.json").read_text())["cases"] if x["id"] == args.id)
    for path, expected in [(base["sourcePath"], base["sourceSha256"]), (base["preparedPath"], base["preparedSha256"]), (base["maskPath"], base["maskSha256"])]:
        if sha(path) != expected:
            raise ValueError("Frozen photograph/baseline changed.")
    report = {"version": 1, "id": args.id, "status": "running", "calls": [], "source": base,
              "protocolSha256": sha(protocol), "generatorSha256": sha(__file__),
              "learnedModel": "Native ORT WebGPU with same-live-session pre-audit; no CPU learned model",
              "preparation": "Unchanged upstream Torch CPU native preprocessing/tiling, explicitly selected research stage",
              "photographicQuality": "unreviewed", "productionEnabled": False}
    try:
        import numpy as np
        import torch
        from PIL import Image
        from torchvision import transforms

        torch.set_num_threads(2)
        source = PRIOR / "cascade/source"
        revision = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
        if revision != "481847c8f20d11e036c2b29d0be290aa8fa26071":
            raise ValueError("Upstream source revision changed.")
        if subprocess.check_output(["git", "-C", str(source), "status", "--porcelain"], text=True):
            raise ValueError("Upstream source has local changes.")
        report["upstreamHelperSha256"] = sha(source / "segmentation-refinement/segmentation_refinement/eval_helper.py")
        sys.path.insert(0, str(source / "segmentation-refinement"))
        from segmentation_refinement.eval_helper import process_high_res_im

        class AuditedModel:
            def __call__(self, image, mask, inter_s8=None, inter_s4=None):
                if inter_s4 is not None:
                    raise ValueError("Unexpected fourth model input; preserve upstream local contract.")
                kind = "global" if inter_s8 is None else "local"
                original = (ROOT / "artifacts/research/refine-edge/2026-11-13-cascade-pooling-followup/export/global/model-manifest.json"
                            if kind == "global" else study / "export/local/model-manifest.json")
                manifest = json.loads(original.read_text())
                component = manifest["components"][0]
                directory = output / f"call-{len(report['calls']):03d}-{kind}"
                directory.mkdir()
                tensors = [image, mask] if kind == "global" else [image, mask, inter_s8]
                names = ["image", "mask"] if kind == "global" else ["image", "mask", "inter_s8"]
                component["inputs"] = []
                for name, tensor in zip(names, tensors):
                    array = tensor.detach().contiguous().numpy()
                    path = directory / (name + ".f32")
                    array.tofile(path)
                    component["inputs"].append({"name": name, "path": str(path), "dtype": "float32", "shape": list(array.shape), "bytes": path.stat().st_size, "sha256": sha(path)})
                height, width = image.shape[-2:]
                if kind == "local" and (height, width) != (904, 904):
                    raise ValueError("Local tile shape differs from its qualified graph.")
                component["freeDimensionOverrides"] = {"H": height, "W": width} if kind == "global" else {}
                component["outputs"] = [{"name": name, "dtype": "float32", "shape": [1, 1, height, width]} for name in ["pred_224", "pred_28_3", "pred_56_2"]]
                receipt = study / (kind + "-execute/model-result.json")
                manifest.update({"photoCaseId": args.id, "numericalReceiptPath": str(receipt), "numericalReceiptSha256": sha(receipt),
                                 "parentManagedImageBytes": base["width"] * base["height"] * 64 + 64 * 1024 ** 2})
                manifest_path = directory / "manifest.json"
                write_json(manifest_path, manifest)
                runtime = directory / "runtime"
                command = ["node", "scripts/research/refine-edge/cascade-metadata-runtime.mjs", "--execute", "--photograph", "--manifest", str(manifest_path), "--pooling-manifest", str(ROOT / "artifacts/research/refine-edge/2026-11-13-cascade-pooling-followup/export/pooling/model-manifest.json"), "--output", str(runtime)]
                with (directory / "parent.log").open("w") as log:
                    completed = subprocess.run(command, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, timeout=270, check=False)
                result = json.loads((runtime / "model-result.json").read_text())
                if completed.returncode != 0 or result["status"] != "passed":
                    raise ValueError("Audited GPU proposal failed; preserve the call receipt, no CPU retry.")
                measured = next(x for x in result["components"] if x["component"] == kind)
                report["calls"].append({"kind": kind, "manifest": str(manifest_path), "runtime": str(runtime), "inferenceMs": measured["inferenceMs"], "cpuMetadataNodes": len(measured["metadataAudit"]["cpuMetadataNodes"])})
                write_json(output / "result.json", report)
                print(json.dumps({"id": args.id, "call": len(report["calls"]), "kind": kind, "ms": measured["inferenceMs"]}), flush=True)
                return {entry["name"]: torch.from_numpy(np.fromfile(entry["path"], dtype=np.float32).reshape(entry["shape"]).copy()) for entry in measured["outputs"]}

        with Image.open(base["preparedPath"]) as im:
            bgr = np.asarray(im.convert("RGB"))[:, :, ::-1].copy()
        mask_bytes = Path(base["maskPath"]).read_bytes()
        mask = np.frombuffer(mask_bytes, dtype=np.uint8).reshape(base["height"], base["width"])
        image = transforms.Compose([transforms.ToTensor(), transforms.Normalize([.485, .456, .406], [.229, .224, .225])])(bgr).unsqueeze(0)
        coverage = transforms.Compose([transforms.ToTensor(), transforms.Normalize([.5], [.5])])((mask > 127).astype(np.uint8) * 255).unsqueeze(0)
        with torch.inference_mode():
            result = process_high_res_im(AuditedModel(), image, coverage, L=900)
        raw = result[0, 0].numpy()
        if raw.shape != mask.shape or not np.isfinite(raw).all() or raw.min() < 0 or raw.max() > 1:
            raise ValueError("Native proposal has invalid coverage.")
        quantized = (raw * 255).astype(np.uint8)
        path = output / "coverage.r8"
        quantized.tofile(path)
        Image.fromarray(quantized, mode="L").save(output / "coverage.png")
        report.update({"status": "passed-proposal-unreviewed", "coveragePath": str(path), "coverageSha256": sha(path), "width": base["width"], "height": base["height"], "fractionalPixels": int(((quantized > 0) & (quantized < 255)).sum())})
    except Exception as error:
        report["status"] = "failed"
        report["error"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        report["durationSeconds"] = time.monotonic() - started
        write_json(output / "result.json", report)
        (output / "summary.md").write_text(f"# Cascade photographic proposal: {report['status']}\n\nCase {args.id}; {len(report['calls'])} audited GPU calls; {report['durationSeconds']:.2f} seconds.\n\n{report.get('error', 'Native proposal only; photographic review still required.')}\n\nExplicit upstream native CPU preparation; learned inference on GPU with pre-run metadata audit. No CPU model fallback or production acceptance. Details: result.json.\n")


if __name__ == "__main__":
    main()
