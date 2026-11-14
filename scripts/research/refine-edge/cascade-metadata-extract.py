"""Read finalized provider assignments from a SAME-live-session ORT snapshot.

This decoder never creates a session or executes a model. Reloading the saved
model would repartition it and is not an assignment proof for another session.
"""
import hashlib
import importlib.metadata
import json
import math
import struct
import sys
from pathlib import Path

from onnxruntime.tools.ort_format_model.ort_flatbuffers_py.fbs.InferenceSession import InferenceSession
from onnxruntime.tools.ort_format_model.ort_flatbuffers_py.fbs.TensorTypeAndShape import TensorTypeAndShape


def text(value):
    return value.decode() if isinstance(value, bytes) else value or ""


def main():
    source, output = map(Path, sys.argv[1:3])
    if output.exists() or source.stat().st_size > 600_000_000:
        raise ValueError("Use a fresh output and a bounded ORT snapshot.")
    data = source.read_bytes()
    if data[4:8] != b"ORTM" or importlib.metadata.version("onnxruntime") != "1.31.1":
        raise ValueError("Require ORTM and the matching pinned 1.31.1 parser.")
    root = InferenceSession.GetRootAsInferenceSession(data, 0)
    graph = root.Model().Graph()
    if graph.NodesLength() > 12000:
        raise ValueError("Final graph exceeds the frozen node bound.")
    tensors = {}
    names = {1: "float32", 2: "uint8", 6: "int32", 7: "int64", 9: "bool", 10: "float16", 11: "float64"}
    for i in range(graph.NodeArgsLength()):
        arg = graph.NodeArgs(i)
        info = arg.Type()
        if info is None or info.ValueType() != 1:
            continue
        value = info.Value()
        tensor = TensorTypeAndShape()
        tensor.Init(value.Bytes, value.Pos)
        shape = tensor.Shape()
        dimensions = None if shape is None else [
            int(shape.Dim(j).Value().DimValue())
            if shape.Dim(j).Value() is not None and shape.Dim(j).Value().DimType() == 1 else None
            for j in range(shape.DimLength())
        ]
        tensors[text(arg.Name())] = {"dtype": names.get(tensor.ElemType(), "unknown"), "shape": dimensions}
    for i in range(graph.InitializersLength()):
        tensor = graph.Initializers(i)
        shape = [int(tensor.Dims(j)) for j in range(tensor.DimsLength())]
        descriptor = {"dtype": names.get(tensor.DataType(), "unknown"), "shape": shape, "initializer": True}
        elements = math.prod(shape)
        if tensor.DataType() in (6, 7) and len(shape) <= 2 and elements <= 16:
            raw = bytes(tensor.RawDataAsNumpy())
            size, code = (4, "i") if tensor.DataType() == 6 else (8, "q")
            if len(raw) != size * elements:
                raise ValueError("Integer metadata initializer bytes are incomplete.")
            descriptor["data"] = [str(value) for value in struct.unpack("<" + code * elements, raw)]
        tensors[text(tensor.Name())] = descriptor
    nodes = []
    for i in range(graph.NodesLength()):
        node = graph.Nodes(i)
        if node.ImplicitInputsLength():
            raise ValueError("Implicit/subgraph inputs require a separate audit contract.")
        attributes = {}
        for j in range(node.AttributesLength()):
            attr = node.Attributes(j)
            if attr.Type() in (5, 10):
                raise ValueError("Nested graphs are not admitted by this contract.")
            if attr.Type() == 2:
                attributes[text(attr.Name())] = int(attr.I())
            elif attr.Type() == 7:
                attributes[text(attr.Name())] = [int(attr.Ints(k)) for k in range(attr.IntsLength())]
        nodes.append({"index": int(node.Index()), "name": text(node.Name()),
                      "operator": text(node.OpType()), "domain": text(node.Domain()),
                      "provider": text(node.ExecutionProviderType()),
                      "inputs": [text(node.Inputs(j)) for j in range(node.InputsLength())],
                      "outputs": [text(node.Outputs(j)) for j in range(node.OutputsLength())],
                      "attributes": attributes})
    if not nodes or any(not node["provider"] for node in nodes):
        raise ValueError("Finalized provider assignment is incomplete.")
    result = {"version": 1, "complete": True, "nodeCount": graph.NodesLength(),
              "nodeIndices": [node["index"] for node in nodes], "nodes": nodes, "tensors": tensors,
              "graphInputs": [text(graph.Inputs(i)) for i in range(graph.InputsLength())],
              "graphOutputs": [text(graph.Outputs(i)) for i in range(graph.OutputsLength())],
              "graphSha256": hashlib.sha256(data).hexdigest(), "ortFormatVersion": text(root.OrtVersion()),
              "parserVersion": importlib.metadata.version("onnxruntime"),
              "bindingRequirement": "Audit only while the originating session stays alive; never trust snapshot reload."}
    output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"nodes": len(nodes), "cpu": sum(n["provider"] == "CPUExecutionProvider" for n in nodes)}))


if __name__ == "__main__":
    main()
