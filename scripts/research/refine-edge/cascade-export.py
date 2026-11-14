"""One unchanged-upstream CascadePSP FP32 ONNX export attempt.

CPU execution is synthetic tracing for export, never a quality reference or a
fallback. The published L=900 global step pads a 600x900 input to 608x904;
the odd post-downsample width deliberately exercises the real pooling domain.
"""

import argparse
import hashlib
import importlib.metadata
import json
import platform
import sys
import time
import traceback
from pathlib import Path

sys.dont_write_bytecode = True


def sha256(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    started = time.monotonic()
    args.output.mkdir(parents=True, exist_ok=False)
    report = {"version": 1, "status": "incomplete", "candidate": "cascadepsp-official-v1.0",
              "opset": 17, "dtype": "float32", "exportAttempts": 0,
              "scope": "Unmodified upstream network, synthetic CPU tracing only, no photographic inference or independent quality reference.",
              "sourceRevision": "481847c8f20d11e036c2b29d0be290aa8fa26071",
              "upstreamPolicy": {"fast": False, "L": 900, "stride": 450, "padding": 16,
                                 "inputImage": "Upstream OpenCV BGR order; mean [.485,.456,.406], std [.229,.224,.225].",
                                 "mask": "Upstream binary threshold >127; normalization to [-1,1]."}}
    try:
        import onnx
        import torch

        torch.set_num_threads(2)
        torch.manual_seed(77)
        report["environment"] = {"python": platform.python_version(),
                                 "packages": {name: importlib.metadata.version(name) for name in ["torch", "torchvision", "onnx", "numpy"]}}
        sys.path.insert(0, str(args.source.resolve() / "segmentation-refinement"))
        from segmentation_refinement.models.psp.pspnet import RefinementModule
        from segmentation_refinement.eval_helper import safe_forward

        model = RefinementModule().eval()
        checkpoint = torch.load(args.checkpoint, map_location="cpu", weights_only=True)
        model.load_state_dict({key[7:]: value for key, value in checkpoint.items()})

        class GlobalGraph(torch.nn.Module):
            def __init__(self):
                super().__init__()
                self.network = model

            def forward(self, image, mask):
                outputs = safe_forward(self.network, image, mask)
                return outputs["pred_224"], outputs["pred_28_3"], outputs["pred_56_2"]

        # A 3:2 source is resized to 600x900 by the published L=900 policy.
        # safe_forward is retained verbatim, including its both-dimensions padding.
        image = torch.rand(1, 3, 600, 900, dtype=torch.float32)
        mask = torch.full((1, 1, 600, 900), -1.0)
        mask[:, :, 120:480, 180:720] = 1.0
        output = args.output / "global-l900.onnx"
        report["inputShapes"] = {"image": list(image.shape), "mask": list(mask.shape)}
        report["stage"] = "torch.onnx.export"
        report["exportAttempts"] = 1
        with torch.inference_mode():
            torch.onnx.export(GlobalGraph().eval(), (image, mask), str(output),
                              input_names=["image", "mask"],
                              output_names=["pred_224", "pred_28_3", "pred_56_2"],
                              opset_version=17, do_constant_folding=True, dynamo=False)
        onnx.checker.check_model(str(output))
        report.update({"status": "exported-unqualified", "path": str(output.resolve()),
                       "sha256": sha256(output), "bytes": output.stat().st_size,
                       "reason": "The global graph exported. Local graph, native WebGPU assignment/inference, numerical parity and photographs remain unqualified."})
    except Exception as error:
        message = str(error)
        report["exceptionType"] = type(error).__name__
        report["error"] = message[:12000]
        if "adaptive_avg_pool2d" in message and "not factor" in message:
            report["status"] = "rejected"
            report["reason"] = "Published L900 CascadePSP global graph cannot export AdaptiveAvgPool2d to ONNX because its requested pooling output is not a factor of the native padded feature dimensions. No architecture rewrite or alternate shape was attempted."
        elif "Unsupported" in type(error).__name__:
            report["status"] = "rejected"
            report["reason"] = "The one unchanged-upstream FP32 ONNX export attempt refused an unsupported operator; full exporter evidence is retained."
        traceback.print_exc()
    finally:
        report["elapsedSeconds"] = time.monotonic() - started
        (args.output / "receipt.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps({"status": report["status"], "reason": report.get("reason"), "elapsedSeconds": report["elapsedSeconds"]}))
    return 0 if report["status"] == "exported-unqualified" else 1


if __name__ == "__main__":
    sys.exit(main())
