"""One exact CascadePSP pooling export follow-up; research artifacts only.

The original failed export remains untouched. This maps AdaptiveAvgPool2d to
standard ONNX operations using its exact floor/ceil windows. Eager PyTorch
execution is limited to synthetic pooling references and model export references;
no photographic CPU inference, fallback or production integration is provided.
"""

import argparse
import hashlib
import importlib.metadata
import json
import platform
import resource
import shutil
import subprocess
import sys
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[3]
SOURCE_REVISION = "481847c8f20d11e036c2b29d0be290aa8fa26071"
CHECKPOINT_SHA256 = "60826ace3385961cdf8608abbdf1234cd22379303b97edf96f18d67bba769cfa"
PROTOCOL = ROOT / "assets/tests/references/refine-edge/pooling-followup.json"
MAXIMUM_GRAPH_BYTES = 600_000_000
MAXIMUM_GRAPH_NODES = 12_000


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def tensor_file(directory, name, tensor):
    array = tensor.detach().cpu().contiguous().numpy()
    path = directory / f"{name}.f32"
    array.tofile(path)
    return {"name": name, "path": str(path.resolve()), "dtype": str(array.dtype),
            "shape": list(array.shape), "bytes": path.stat().st_size, "sha256": digest(path)}


def numeric_comparison(reference, actual):
    import torch

    error = (actual - reference).abs()
    limit = 0.001 + 0.001 * reference.abs()
    quantized_error = (torch.round(actual.clamp(0, 1) * 255)
                       - torch.round(reference.clamp(0, 1) * 255)).abs()
    return {"samples": reference.numel(), "maxAbsoluteError": float(error.max()),
            "outOfTolerance": int((error > limit).sum()),
            "maxR8Difference": int(quantized_error.max()),
            "r8Purpose": "Clipped diagnostic encoding of synthetic pooling values; not physical alpha or full model quality."}


def register_exact_pooling():
    import torch
    from torch.onnx import symbolic_helper

    def lowering(graph, value, output_size):
        bins = symbolic_helper._parse_arg(output_size, "is")
        if len(bins) != 2 or any(not isinstance(size, int) or size <= 0 for size in bins):
            raise ValueError("Exact pooling lowering requires positive frozen output bins.")

        def constant(values):
            return graph.op("Constant", value_t=torch.tensor(values, dtype=torch.int64))

        # Shape-derived bounds permit the same frozen graph to preserve pooling
        # on every admitted padded aspect ratio; no per-image export is needed.
        shape = graph.op("Shape", value)
        height = graph.op("Gather", shape, constant([2]), axis_i=0)
        width = graph.op("Gather", shape, constant([3]), axis_i=0)
        axes = constant([2, 3])

        def start(extent, index, bins):
            return graph.op("Div", graph.op("Mul", extent, constant([index])), constant([bins]))

        def end(extent, index, bins):
            product = graph.op("Mul", extent, constant([index + 1]))
            return graph.op("Div", graph.op("Add", product, constant([bins - 1])), constant([bins]))

        rows = []
        for y in range(bins[0]):
            cells = []
            for x in range(bins[1]):
                starts = graph.op("Concat", start(height, y, bins[0]), start(width, x, bins[1]), axis_i=0)
                ends = graph.op("Concat", end(height, y, bins[0]), end(width, x, bins[1]), axis_i=0)
                window = graph.op("Slice", value, starts, ends, axes)
                cells.append(graph.op("ReduceMean", window, axes_i=[2, 3], keepdims_i=1))
            rows.append(cells[0] if len(cells) == 1 else graph.op("Concat", *cells, axis_i=3))
        return rows[0] if len(rows) == 1 else graph.op("Concat", *rows, axis_i=2)

    torch.onnx.register_custom_op_symbolic("aten::adaptive_avg_pool2d", lowering, 17)
    torch.onnx.register_custom_op_symbolic("aten::_adaptive_avg_pool2d", lowering, 17)


def export_component(module, inputs, names, output_names, directory, component, dynamic=True):
    import onnx
    import torch

    path = directory / f"{component}.onnx"
    begin = time.monotonic()
    with torch.inference_mode():
        references = module(*inputs)
        if isinstance(references, torch.Tensor):
            references = (references,)
        # Export-only symbolic registration leaves eager upstream PyTorch math
        # and the synthetic independent reference outputs unchanged.
        torch.onnx.export(
            module, tuple(inputs), str(path), input_names=names,
            output_names=output_names, opset_version=17, dynamo=False,
            do_constant_folding=True,
            dynamic_axes={name: {2: "H", 3: "W"} for name in names} if dynamic else None,
        )
    if path.stat().st_size > MAXIMUM_GRAPH_BYTES:
        raise ValueError("Export exceeds the frozen 600 MB graph bound; stop without repair.")
    model = onnx.load(str(path))
    onnx.checker.check_model(model)
    if len(model.graph.node) > MAXIMUM_GRAPH_NODES:
        raise ValueError("Export exceeds the frozen 12000-node graph bound; stop without repair.")
    nonstandard = sorted({node.domain for node in model.graph.node if node.domain not in ("", "ai.onnx")})
    if nonstandard:
        raise ValueError(f"Export contains nonstandard operator domains: {nonstandard}")
    record = {"component": component, "path": str(path.resolve()), "sha256": digest(path),
              "bytes": path.stat().st_size, "graphNodes": len(model.graph.node),
              "operators": sorted({node.op_type for node in model.graph.node}),
              "exportSeconds": time.monotonic() - begin, "opset": 17,
              "dynamicPaddedSpatialInputs": dynamic,
              "freeDimensionOverrides": {"H": int(inputs[0].shape[2]), "W": int(inputs[0].shape[3])} if dynamic else {},
              "inputs": [tensor_file(directory, name, value) for name, value in zip(names, inputs)],
              "outputs": [tensor_file(directory, name, value) for name, value in zip(output_names, references)]}
    return record


def common_manifest(component, args, report):
    return {"version": 1, "model": f"cascadepsp-exact-pooling-{component['component']}",
            "sourceRevision": SOURCE_REVISION,
            "checkpoint": {"sha256": CHECKPOINT_SHA256, "redistributed": False},
            "generator": report["generator"], "environment": report["environment"],
            "components": [component], "status": "exported-unqualified",
            "numericComparison": {"absoluteTolerance": 0.001, "relativeTolerance": 0.001,
                                  "maximumR8Difference": 1},
            "limits": "Synthetic export/reference only. Native WebGPU execution, full-resolution orchestration, photographs and broad-adoption weight rights remain unqualified."}


def pooling_stage(args, report):
    import torch
    import torch.nn.functional as functional

    height, width = 76, 113
    y = torch.arange(height, dtype=torch.int64).reshape(height, 1).expand(height, width)
    x = torch.arange(width, dtype=torch.int64).reshape(1, width).expand(height, width)
    feature = torch.stack([
        ((17 * x + 31 * y) % 257).to(torch.float32) / 256,
        ((x // 3 + y // 5) % 2).to(torch.float32),
        ((x == 0) | (x == width - 1) | (y == 0) | (y == height - 1)).to(torch.float32),
    ]).unsqueeze(0)

    class Pooling(torch.nn.Module):
        def forward(self, image):
            return tuple(functional.adaptive_avg_pool2d(image, (bins, bins)) for bins in (2, 3, 6))

    comparisons, outputs = [], []
    with torch.inference_mode():
        for bins in (2, 3, 6):
            reference = functional.adaptive_avg_pool2d(feature, (bins, bins))
            rows = []
            for out_y in range(bins):
                cells = []
                for out_x in range(bins):
                    start_y, start_x = out_y * height // bins, out_x * width // bins
                    end_y = ((out_y + 1) * height + bins - 1) // bins
                    end_x = ((out_x + 1) * width + bins - 1) // bins
                    cells.append(feature[:, :, start_y:end_y, start_x:end_x].mean(dim=(-2, -1), keepdim=True))
                rows.append(torch.cat(cells, dim=3))
            lowered = torch.cat(rows, dim=2)
            comparison = numeric_comparison(reference, lowered)
            comparisons.append({"bins": bins, **comparison})
            if comparison["outOfTolerance"] or comparison["maxR8Difference"] > 1:
                raise ValueError("The exact pooling microcheck failed the unchanged tolerance; stop.")
            outputs.append({"name": f"pool{bins}", "shape": list(reference.shape),
                            "data": reference.flatten().tolist()})
    golden = {"version": 1, "sourceRevision": SOURCE_REVISION, "generator": report["generator"],
              "environment": report["environment"], "featureShape": [1, 3, height, width],
              "inputGeneration": {"type": "procedural-coordinate-v1", "indexOrder": "NCHW",
                                  "x": "column index 0..112", "y": "row index 0..75",
                                  "channels": ["((17*x + 31*y) % 257) / 256", "(floor(x/3) + floor(y/5)) % 2", "1 on the outer image border, otherwise 0"],
                                  "conversion": "FP32 after exact integer arithmetic; channel0 division by256 is exactly representable."},
              "tolerances": {"absolute": 0.001, "relative": 0.001, "maxR8Difference": 1},
              "reference": "Original torch.nn.functional.adaptive_avg_pool2d, not the export lowering.",
              "outputs": outputs, "independentComparison": comparisons}
    write_json(args.output / "golden.json", golden)
    component = export_component(Pooling().eval(), [feature], ["image"], ["pool2", "pool3", "pool6"], args.output, "pooling", dynamic=False)
    report["comparison"] = comparisons
    report["component"] = component
    write_json(args.output / "model-manifest.json", common_manifest(component, args, report))


def model_stage(args, report):
    import torch

    if digest(args.checkpoint) != CHECKPOINT_SHA256:
        raise ValueError("Original checkpoint SHA-256 changed.")
    revision = subprocess.check_output(["git", "-C", str(args.source), "rev-parse", "HEAD"], text=True).strip()
    if revision != SOURCE_REVISION:
        raise ValueError("Original source revision changed.")
    dirty = subprocess.check_output(["git", "-C", str(args.source), "status", "--porcelain"], text=True)
    if dirty:
        raise ValueError("Original upstream source has local changes.")
    sys.path.insert(0, str(args.source.resolve() / "segmentation-refinement"))
    from segmentation_refinement.models.psp.pspnet import RefinementModule

    model = RefinementModule().eval()
    weights = torch.load(args.checkpoint, map_location="cpu", weights_only=True)
    model.load_state_dict({name[7:]: value for name, value in weights.items()})
    del weights
    torch.manual_seed(77)

    class Global(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.model = model

        def forward(self, image, mask):
            outputs = self.model(image, mask)
            return outputs["pred_224"], outputs["pred_28_3"], outputs["pred_56_2"]

    class Local(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.model = model

        def forward(self, image, mask, inter_s8):
            outputs = self.model(image, mask, inter_s8)
            return outputs["pred_224"], outputs["pred_28_3"], outputs["pred_56_2"]

    if args.stage == "global":
        # This is the exact tensor seen by the original network after upstream
        # safe_forward pads synthetic 600x900 to608x904, including extra H rows.
        raw_image = torch.rand(1, 3, 600, 900, dtype=torch.float32)
        raw_mask = torch.full((1, 1, 600, 900), -1.0)
        raw_mask[:, :, 120:480, 180:720] = 1.0
        image = torch.zeros(1, 3, 608, 904, dtype=torch.float32)
        mask = torch.full((1, 1, 608, 904), -1.0)
        image[:, :, :600, :900] = raw_image
        mask[:, :, :600, :900] = raw_mask
        module, inputs, names = Global().eval(), [image, mask], ["image", "mask"]
    else:
        # Upstream local call passes only one optional intermediate; inter_s4
        # remains None, so the unchanged model executes its second+third passes.
        image = torch.zeros(1, 3, 904, 904, dtype=torch.float32)
        image[:, :, :900, :900] = torch.rand(1, 3, 900, 900)
        mask = torch.full((1, 1, 904, 904), -1.0)
        mask[:, :, 180:720, 180:720] = 1.0
        intermediate = torch.full((1, 1, 904, 904), -1.0)
        intermediate[:, :, :900, :900] = torch.rand(1, 1, 900, 900) * 2 - 1
        module, inputs, names = Local().eval(), [image, mask, intermediate], ["image", "mask", "inter_s8"]
    component = export_component(module, inputs, names, ["pred_224", "pred_28_3", "pred_56_2"], args.output, args.stage, dynamic=args.stage == "global")
    report["component"] = component
    report["interface"] = {"rawPaddedNetwork": True,
                           "externalPolicy": "Preserve upstream resize_max_side/safe_forward padding, crop-back, local overlap/skip/averaging and final interpolation exactly.",
                           "source600x900PaddedShape": [608, 904], "local900x900PaddedShape": [904, 904],
                           "localOptionalInputs": "inter_s8 only; inter_s4 remains None."}
    write_json(args.output / "model-manifest.json", common_manifest(component, args, report))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage", choices=["pooling", "global", "local"], required=True)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--checkpoint", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.stage != "pooling" and (not args.source or not args.checkpoint):
        parser.error("Model export requires the pinned --source and --checkpoint.")
    args.output = args.output.resolve()
    args.output.mkdir(parents=True, exist_ok=False)
    shutil.copyfile(PROTOCOL, args.output / "protocol.json")
    shutil.copyfile(Path(__file__), args.output / "generator.py")
    started = time.monotonic()
    report = {"version": 1, "stage": args.stage, "status": "incomplete",
              "startedAt": datetime.now(timezone.utc).isoformat(),
              "protocolSha256": digest(PROTOCOL), "sourceRevision": SOURCE_REVISION,
              "checkpointSha256": CHECKPOINT_SHA256,
              "generator": {"path": "scripts/research/refine-edge/cascade-pooling-export.py", "sha256": digest(Path(__file__))},
              "host": platform.platform(), "command": [sys.executable, *sys.argv],
              "cpuPurpose": "Synthetic pooling/reference/export only; no photographic CPU execution or fallback.",
              "gpuExecution": "not attempted by this exporter", "weightAdoptionRights": "unresolved",
              "graphBounds": {"maximumBytes": MAXIMUM_GRAPH_BYTES, "maximumNodes": MAXIMUM_GRAPH_NODES}}
    try:
        import torch

        torch.set_num_threads(2)
        report["environment"] = {"python": platform.python_version(),
                                 "packages": {name: importlib.metadata.version(name) for name in ["torch", "torchvision", "onnx", "numpy"]}}
        register_exact_pooling()
        if args.stage == "pooling":
            pooling_stage(args, report)
        else:
            model_stage(args, report)
        report["status"] = "exported-unqualified"
        report["reason"] = "Exact pooling export complete; strict native WebGPU execution and all later gates require separate receipts."
    except Exception as error:
        report["status"] = "rejected"
        report["exceptionType"] = type(error).__name__
        report["reason"] = str(error)[:12000]
        traceback.print_exc()
    finally:
        report["elapsedSeconds"] = time.monotonic() - started
        report["peakProcessRssBytes"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024
        write_json(args.output / "receipt.json", report)
        (args.output / "summary.md").write_text(
            f"# Cascade exact-pooling {args.stage}: {report['status'].upper()}\n\n"
            f"{report['reason'][:1800]}\n\nDuration {report['elapsedSeconds']:.2f}s; "
            f"peak process RSS {report['peakProcessRssBytes']} bytes.\n\n"
            "FP32/opset17; original source/weights and pooling windows retained. "
            "CPU use is synthetic references/export only; GPU execution, photographic quality and broad-adoption rights remain unqualified. "
            "No foreground window or application library was used. Full evidence: receipt.json and model-manifest.json when exported.\n")
        print(json.dumps({"stage": args.stage, "status": report["status"], "elapsedSeconds": report["elapsedSeconds"],
                          "reason": report["reason"][:1200], "receipt": str(args.output / "receipt.json")}))
    return 0 if report["status"] == "exported-unqualified" else 1


if __name__ == "__main__":
    sys.exit(main())
