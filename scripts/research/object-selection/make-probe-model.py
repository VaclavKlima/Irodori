"""Write a deterministic tiny ONNX graph for the isolated strict-GPU runtime probe."""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    left = np.array([[1, 2], [3, 4]], dtype=np.float32)
    weight = np.array([[2, 0], [1, 3]], dtype=np.float32)
    bias = np.array([1, -1], dtype=np.float32)
    graph = helper.make_graph(
        [helper.make_node("MatMul", ["input", "weight"], ["product"]),
         helper.make_node("Add", ["product", "bias"], ["output"])],
        "irodori-object-selection-strict-gpu-probe-v1",
        [helper.make_tensor_value_info("input", TensorProto.FLOAT, [2, 2])],
        [helper.make_tensor_value_info("output", TensorProto.FLOAT, [2, 2])],
        [numpy_helper.from_array(weight, "weight"), numpy_helper.from_array(bias, "bias")],
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)])
    model.ir_version = 9
    onnx.checker.check_model(model)
    onnx.save(model, args.output)
    metadata = {
        "version": 1,
        "model": args.output.name,
        "sha256": hashlib.sha256(args.output.read_bytes()).hexdigest(),
        "opset": 17,
        "input": {"name": "input", "shape": [2, 2], "type": "float32", "data": left.reshape(-1).tolist()},
        "expected": {"name": "output", "shape": [2, 2], "type": "float32", "data": (left @ weight + bias).reshape(-1).tolist()},
        "scope": "Synthetic runtime feasibility only; not segmentation quality or model operator coverage.",
    }
    args.output.with_suffix(".json").write_text(json.dumps(metadata, indent=2) + "\n")
    unsupported = args.output.with_name("cpu-only-string-normalizer.onnx")
    string_graph = helper.make_graph(
        [helper.make_node("StringNormalizer", ["input"], ["output"], case_change_action="UPPER", is_case_sensitive=1)],
        "irodori-object-selection-cpu-fallback-refusal-v1",
        [helper.make_tensor_value_info("input", TensorProto.STRING, [1])],
        [helper.make_tensor_value_info("output", TensorProto.STRING, [1])],
    )
    string_model = helper.make_model(string_graph, opset_imports=[helper.make_opsetid("", 17)])
    string_model.ir_version = 9
    onnx.checker.check_model(string_model)
    onnx.save(string_model, unsupported)
    unsupported.with_suffix(".json").write_text(json.dumps({
        "version": 1,
        "model": unsupported.name,
        "sha256": hashlib.sha256(unsupported.read_bytes()).hexdigest(),
        "opset": 17,
        "input": {"name": "input", "shape": [1], "type": "string", "data": ["mask"]},
        "expected": {"name": "output", "shape": [1], "type": "string", "data": ["MASK"]},
        "scope": "Strict WebGPU must refuse the CPU-only StringNormalizer kernel before inference; never retry on CPU.",
    }, indent=2) + "\n")
    print(json.dumps(metadata))


if __name__ == "__main__":
    main()
