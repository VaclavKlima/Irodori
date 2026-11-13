"""Convert only the pinned FP32 sky export for native WebGPU; never overwrite inputs."""
import argparse
import hashlib
import pathlib

import numpy as np
import onnx
import onnxslim
from onnx import TensorProto, helper, numpy_helper

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('source', type=pathlib.Path)
parser.add_argument('output', type=pathlib.Path)
args = parser.parse_args()
source, output = args.source.resolve(), args.output.resolve()
if source == output or output.exists():
    parser.error('Use distinct source and a new output path; existing evidence is immutable.')
payload = source.read_bytes()
if hashlib.sha256(payload).hexdigest() != 'eb59758c041fcba3a34097845e259eb7cd584f9b56fdc94df15f8c1c6066f682':
    parser.error('Source is not the qualified pinned Mask2Former export.')
model = onnx.shape_inference.infer_shapes(onnxslim.slim(onnx.load_model_from_string(payload)))
names = {value.name: value for value in model.graph.value_info}
changed = 0
for node in model.graph.node:
    if node.op_type == 'Cast':
        attribute = next(a for a in node.attribute if a.name == 'to')
        if attribute.i == TensorProto.DOUBLE:
            attribute.i = TensorProto.FLOAT
            changed += 1
for index, tensor in enumerate(model.graph.initializer):
    if tensor.data_type == TensorProto.DOUBLE:
        model.graph.initializer[index].CopyFrom(numpy_helper.from_array(
            numpy_helper.to_array(tensor).astype(np.float32), tensor.name))
for value in model.graph.value_info:
    if value.type.tensor_type.elem_type == TensorProto.DOUBLE:
        value.type.tensor_type.elem_type = TensorProto.FLOAT

# Counts contain at most 16384 booleans, exactly representable in FP32.
# Keep independent shape and index int64 constants unchanged.
for node in model.graph.node:
    if node.op_type != 'Cast' or '/transformer_module/decoder/Cast' not in node.name:
        continue
    attribute = next(a for a in node.attribute if a.name == 'to')
    if attribute.i != TensorProto.INT64:
        continue
    attribute.i = TensorProto.FLOAT
    changed += 1
    names[node.output[0]].type.tensor_type.elem_type = TensorProto.FLOAT
    reduction = next(n for n in model.graph.node if n.op_type == 'ReduceSum' and node.output[0] in n.input)
    names[reduction.output[0]].type.tensor_type.elem_type = TensorProto.FLOAT
    equal = next(n for n in model.graph.node if n.op_type == 'Equal' and reduction.output[0] in n.input)
    for index, name in enumerate(equal.input):
        tensor = next((t for t in model.graph.initializer if t.name == name), None)
        if tensor is not None and tensor.data_type == TensorProto.INT64:
            replacement = name + '__count_f32'
            if not any(t.name == replacement for t in model.graph.initializer):
                model.graph.initializer.append(numpy_helper.from_array(
                    numpy_helper.to_array(tensor).astype(np.float32), replacement))
            equal.input[index] = replacement
assert changed == 15
for name, value in [('gelu_sqrt2', 2 ** .5), ('gelu_one', 1.), ('gelu_half', .5)]:
    model.graph.initializer.append(numpy_helper.from_array(np.array(value, dtype=np.float32), name))
nodes, expanded = [], 0
for node in model.graph.node:
    if node.op_type == 'GridSample':
        attributes = {a.name: helper.get_attribute_value(a) for a in node.attribute}
        assert attributes == {'align_corners': 0, 'mode': b'linear', 'padding_mode': b'zeros'}
        next(a for a in node.attribute if a.name == 'mode').s = b'bilinear'
    if node.op_type != 'Gelu':
        nodes.append(node)
        continue
    assert not node.attribute or helper.get_attribute_value(node.attribute[0]) == b'none'
    prefix = node.name + '__exact_'
    x = node.input[0]
    div, erf, add, half = [prefix + name for name in ['div', 'erf', 'add', 'half']]
    nodes.extend([
        helper.make_node('Div', [x, 'gelu_sqrt2'], [div]),
        helper.make_node('Erf', [div], [erf]),
        helper.make_node('Add', [erf, 'gelu_one'], [add]),
        helper.make_node('Mul', [x, 'gelu_half'], [half]),
        helper.make_node('Mul', [add, half], list(node.output)),
    ])
    expanded += 1
assert expanded == 12
del model.graph.node[:]
model.graph.node.extend(nodes)
model.opset_import[0].version = 18
onnx.checker.check_model(model)
result = model.SerializeToString()
digest = hashlib.sha256(result).hexdigest()
if digest != '2035d1c38fff88ee792d32002b269fe29f5c561009e9256200bdd9e3fbfb515f':
    raise RuntimeError(f'Candidate differs from the qualified graph ({digest}); preserve evidence and requalify.')
with output.open('xb') as destination:
    destination.write(result)
print(f'{len(result)} bytes, SHA-256 {digest}')
