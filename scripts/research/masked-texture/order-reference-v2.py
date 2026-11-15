#!/usr/bin/env python3
"""Bounded independent ordered-mask oracle; no photographic input or CPU backend.

Uses the frozen small scalar LLF residual and the existing independently derived
Decimal80 mask-color reference. Only procedural arrays at most 33 by 25 are
admitted. Application shaders and production TypeScript are never imported.
"""

from copy import deepcopy
from decimal import Decimal as D
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import struct
import subprocess


ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
POLICY = "masked-texture-order-proof-v2"
TOLERANCE = {"absolute": 2e-6, "relative": 2e-5}
ZERO_LIGHT = dict(exposureEv=0, contrast=0, highlights=0, shadows=0, whites=0, blacks=0)
ZERO_COLOR = dict(temperature=0, tint=0, saturation=0)


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


texture = module("bounded_texture_reference", HERE / "reference.py")
point = module("independent_mask_color_reference", HERE.parent / "mask-color-reference.py")
MATRICES = {
    name: point.ref.primary_matrix(coordinates)
    for name, coordinates in point.ref.PRIMARIES.items()
}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def f32(value):
    return struct.unpack("<f", struct.pack("<f", float(value)))[0]


def rounded(values):
    return [f32(value) for value in values]


def decimals(values):
    return [D.from_float(float(value)) for value in values]


def word(value):
    return struct.unpack("<I", struct.pack("<f", value))[0]


def active_root(root):
    return bool(root["enabled"] and any(root["coverage"]) and (
        root["amount"] or any(root["light"].values()) or any(root["color"].values())))


def apply_global(rgba, controls, primaries, white):
    """Selected globals only: Light then saturation, neutral WB/curves/creative."""
    matrix = MATRICES[primaries]
    scene = primaries == "rec2020"
    light = {key: controls[key] for key in ZERO_LIGHT}
    output = []
    for offset in range(0, len(rgba), 4):
        rgb = decimals(rgba[offset:offset + 3])
        # rasterAdjusted always clamps after global exposure, even at neutral.
        if not scene:
            rgb = [max(D(0), value) for value in rgb]
        rgb = point.light(rgb, light, scene, D(str(white)))
        rgb = point.saturation(rgb, controls["saturation"], matrix, D(str(white)))
        output.extend(rounded(rgb))
        output.append(rgba[offset + 3])
    return output


def apply_local(previous, candidate, root, primaries, white):
    matrix = MATRICES[primaries]
    transform = point.balance(root["color"], matrix)
    output = list(previous)
    if not active_root(root):
        return output
    for pixel, coverage in enumerate(root["coverage"]):
        if coverage == 0:
            continue
        offset = pixel * 4
        changed = decimals(candidate[offset:offset + 3])
        if transform is not None:
            changed = point.ref.apply(transform, changed)
        changed = point.light(changed, root["light"], primaries == "rec2020", D(str(white)))
        changed = point.saturation(changed, root["color"]["saturation"], matrix, D(str(white)))
        weight = D.from_float(coverage)
        original = decimals(previous[offset:offset + 3])
        # Independent exact arithmetic for one final blend, not GPU FMA emulation.
        for channel in range(3):
            output[offset + channel] = f32(original[channel] * (1 - weight) + changed[channel] * weight)
    return output


def unblended(previous, root, width, height, primaries):
    if not active_root(root) or root["amount"] == 0:
        return list(previous)
    candidate, _ = texture.apply(previous, [1.0] * (width * height), width, height,
                                 primaries, root["amount"])
    return rounded(candidate)


def evaluate(case, mode="correct", keep_steps=True):
    width, height, primaries, white = (case[key] for key in ("width", "height", "primaries", "white"))
    if not 0 < width <= 33 or not 0 < height <= 25:
        raise ValueError("Ordered oracle refuses photographic/full-frame inputs")
    previous = apply_global(case["rgba"], case["globals"], primaries, white)
    expected_global = list(previous)
    if mode == "double-global":
        previous = apply_global(previous, case["globals"], primaries, white)
    roots = list(case["roots"])
    if mode != "reversed-order":
        roots.reverse()  # Application descriptors are top first.
    steps = []
    for root in roots:
        item = deepcopy(root)
        if mode == "without-texture":
            item["amount"] = 0
        candidate = unblended(previous, item, width, height, primaries)
        if mode == "double-coverage" and item["amount"] and active_root(item):
            for pixel, coverage in enumerate(item["coverage"]):
                if previous[pixel * 4 + 3] == 0:
                    continue
                for channel in range(3):
                    index = pixel * 4 + channel
                    candidate[index] = f32(previous[index] + coverage * (candidate[index] - previous[index]))
        output = apply_local(previous, candidate, item, primaries, white)
        exact_previous = [index for index in range(len(previous))
                          if index % 4 == 3 or not active_root(item) or item["coverage"][index // 4] == 0]
        hidden = [index for index in range(len(previous))
                  if index % 4 != 3 and previous[(index // 4) * 4 + 3] == 0]
        if any(word(output[index]) != word(previous[index]) for index in exact_previous):
            raise AssertionError("Zero coverage/disabled/alpha word invariant changed")
        if any(word(candidate[index]) != word(previous[index]) for index in hidden):
            raise AssertionError("Texture changed alpha-zero hidden RGB")
        if keep_steps:
            steps.append({
                "rootId": item["id"], "amount": item["amount"],
                "skipped": not active_root(item),
                "expectedUnblended": candidate, "expected": output,
                "exactPreviousWordIndices": exact_previous,
                "alphaWordIndices": list(range(3, len(previous), 4)),
                "textureHiddenWordIndices": hidden,
            })
        previous = output
    return expected_global, previous, steps


def global_controls(exposure=0.25, contrast=13, saturation=18):
    return {**ZERO_LIGHT, "exposureEv": exposure, "contrast": contrast,
            "saturation": saturation, "vibrance": 0}


def root(name, coverage, amount=0, enabled=True, color=None, **light):
    if isinstance(coverage, dict):
        gradient, values = deepcopy(coverage), []
    else:
        gradient = {"kind": "radial", "center": {"x": 0.5, "y": 0.5},
                    "radiusX": 1, "radiusY": 1, "rotation": 0, "feather": 0}
        values = rounded(coverage)
    return {"id": name, "enabled": enabled, "amount": amount,
            "light": {**ZERO_LIGHT, **light}, "color": {**ZERO_COLOR, **(color or {})},
            "gradient": gradient, "coverage": values}


def radial(x, y, radius_x, radius_y, feather=35):
    return {"kind": "radial", "center": {"x": x, "y": y},
            "radiusX": radius_x, "radiusY": radius_y, "rotation": 0, "feather": feather}


def radial_coverage(gradient, width, height, crop=None):
    canonical_width = crop["sourceWidth"] if crop else width
    canonical_height = crop["sourceHeight"] if crop else height
    affine = crop["expectedGeometry"]["outputToSource"] if crop else [1, 0, 0, 1, 0, 0]
    center = gradient["center"]
    radians = gradient["rotation"] * math.pi / 180
    cosine, sine = math.cos(radians), math.sin(radians)
    values = []
    for y in range(height):
        for x in range(width):
            source_x = affine[0] * (x + 0.5) + affine[1] * (y + 0.5) + affine[4]
            source_y = affine[2] * (x + 0.5) + affine[3] * (y + 0.5) + affine[5]
            dx, dy = source_x - center["x"] * canonical_width, source_y - center["y"] * canonical_height
            qx, qy = cosine * dx + sine * dy, -sine * dx + cosine * dy
            distance = math.hypot(qx / (gradient["radiusX"] * canonical_width),
                                  qy / (gradient["radiusY"] * canonical_height))
            feather = gradient["feather"] / 100
            if feather == 0:
                values.append(float(distance <= 1))
            else:
                t = min(1.0, max(0.0, (distance - (1 - feather)) / feather))
                values.append(f32(1 - t * t * (3 - 2 * t)))
    return values


def make_case(name, roots, width=9, height=7, primaries="srgb", controls=None, alpha=False,
              rgba=None, crop=None):
    if rgba is None:
        rgba = []
        for y in range(height):
            for x in range(width):
                p = y * width + x
                if alpha and p % 13 == 0:
                    rgba.extend([9999.0, -8888.0, 7777.0, 0.0])
                    continue
                base = (0.30 + 0.06 * math.cos(x * math.pi / 2)
                        + 0.025 * math.sin(y * math.pi / 3))
                if primaries == "rec2020":
                    base = (-0.12, 0.015, 0.18, 0.6, 1.5, 4.0, 0.8, 0.3, -0.02)[x % 9]
                    base += 0.008 * math.cos(y * math.pi / 2)
                opacity = (0.25, 0.5, 1.0)[p % 3] if alpha else 1.0
                rgba.extend(rounded([base, base * 0.84 + 0.03, base * 1.1 - 0.01, opacity]))
    roots = deepcopy(roots)
    for item in roots:
        item["coverage"] = radial_coverage(item["gradient"], width, height, crop)
    case = {"id": name, "width": width, "height": height, "primaries": primaries,
            "white": 1, "rgba": rgba, "globals": controls or global_controls(), "roots": roots}
    if crop:
        case["crop"] = crop
    expected_global, expected, steps = evaluate(case)
    _, legacy, _ = evaluate(case, "without-texture", False)
    union = [max((item["coverage"][p] for item in roots
                  if item["enabled"] and item["amount"] != 0), default=0.0)
             for p in range(width * height)]
    case.update(expectedGlobal=expected_global, steps=steps, expected=expected,
                withoutTextureExpected=legacy, unionCoverage=union)
    return case


def fixtures():
    width, height = 9, 7
    a = radial(0.58, 0.48, 0.46, 0.55)
    b = radial(0.43, 0.55, 0.42, 0.5, 30)
    active = dict(exposureEv=-0.2, contrast=-11, highlights=-17, shadows=13, whites=9, blacks=-7)
    color = dict(temperature=18, tint=-12, saturation=22)
    texture_root = root("texture", a, 25)
    point_root = root("point", b, color=dict(saturation=-25), exposureEv=0.2, contrast=11)
    mixed = [root("upper", b, -25, color=dict(saturation=-15), exposureEv=0.1),
             root("lower", a, 25, color=color, **active)]
    cases = [
        make_case("raster-single-active", [root("texture-light-color", a, 25, color=color, **active)]),
        make_case("raster-point-before-texture", [deepcopy(texture_root), deepcopy(point_root)]),
        make_case("raster-point-after-texture", [deepcopy(point_root), deepcopy(texture_root)]),
        make_case("raster-two-textures", deepcopy(mixed)),
        make_case("raster-reordered", list(reversed(deepcopy(mixed)))),
        make_case("all-texture-zero", [{**item, "amount": 0} for item in deepcopy(mixed)]),
        make_case("disabled-texture", [root("disabled", a, 25, False, color=color, **active), deepcopy(point_root)]),
        make_case("zero-coverage-texture", [root("empty", radial(2, 2, 0.2, 0.2), 25, color=color, **active)]),
        make_case("scene-signed-partial-alpha", [
            root("scene-upper", b, -25, color=dict(saturation=12), exposureEv=0.1, shadows=15),
            root("scene-lower", a, 25, color=dict(temperature=8, tint=-4, saturation=-35), exposureEv=-0.1),
        ], primaries="rec2020", controls=global_controls(-0.15, 0, -15), alpha=True),
        make_case("scene-texture-only", [root("texture-only", a, 25)], primaries="rec2020",
                  controls=global_controls(-0.1, 0, 0), alpha=True),
    ]
    even_width, even_height = 8, 6
    cases.append(make_case("raster-even-partial", [root("even", b, 25,
                            color=dict(saturation=13), exposureEv=0.12)],
                           width=even_width, height=even_height,
                           controls=global_controls(0.12, 0, 13)))
    cases.extend(cropped_cases())
    return cases


def hermite_weights(t):
    """Pure Decimal80 four-basis formula retained from crop-filter-reference.py."""
    h00, h10 = (1 + 2 * t) * (1 - t) ** 2, t * (1 - t) ** 2
    h01, h11 = t * t * (3 - 2 * t), t * t * (t - 1)
    return [-h10 / 2, h00 - h11 / 2, h01 + h10 / 2, h11 / 2]


def crop_geometry(settings):
    source_width = source_height = 9
    raw_width, raw_height = settings["width"] * 9, settings["height"] * 9
    stable = lambda value: round(value) if abs(value - round(value)) <= 1e-9 else value
    width, height = math.floor(stable(raw_width)), math.floor(stable(raw_height))
    angle = settings["angle"] * math.pi / 180
    cosine, sine = math.cos(angle), math.sin(angle)
    x = settings["centerX"] * 9 - (cosine * width + sine * height) / 2
    y = settings["centerY"] * 9 - (-sine * width + cosine * height) / 2
    turns = settings["quarterTurns"]
    if turns == 0:
        affine = [cosine, sine, -sine, cosine, x, y]
    elif turns == 1:
        affine = [-sine, cosine, -cosine, -sine, y, source_height - x]
    elif turns == 2:
        affine = [-cosine, -sine, sine, -cosine, source_width - x, source_height - y]
    else:
        affine = [sine, -cosine, cosine, sine, source_width - y, x]
    affine = [0.0 if abs(value) <= 1e-15 else value for value in affine]
    affine[4], affine[5] = stable(affine[4]), stable(affine[5])
    return {"width": width, "height": height, "source": {"width": 9, "height": 9},
            "outputToSource": affine,
            "pixelAligned": settings["angle"] == 0 and all(float(v).is_integer() for v in affine[4:])}


def crop_opaque(source, geometry):
    """Independent source9x9 alpha1 Hermite reconstruction, not application code."""
    affine = geometry["outputToSource"]
    result = []
    for y in range(geometry["height"]):
        for x in range(geometry["width"]):
            sx = affine[0] * (x + 0.5) + affine[1] * (y + 0.5) + affine[4] - 0.5
            sy = affine[2] * (x + 0.5) + affine[3] * (y + 0.5) + affine[5] - 0.5
            ix, iy = math.floor(sx), math.floor(sy)
            if geometry["pixelAligned"]:
                result.extend(source[(iy * 9 + ix) * 4:(iy * 9 + ix + 1) * 4])
                continue
            wx, wy = hermite_weights(D.from_float(sx) - ix), hermite_weights(D.from_float(sy) - iy)
            for channel in range(3):
                value = D(0)
                for j in range(4):
                    for i in range(4):
                        row, col = min(8, max(0, iy + j - 1)), min(8, max(0, ix + i - 1))
                        value += D.from_float(source[(row * 9 + col) * 4 + channel]) * wx[i] * wy[j]
                result.append(f32(value))
            result.append(1.0)
    return result


def cropped_cases():
    source = []
    for y in range(9):
        for x in range(9):
            source.extend(rounded([0.25 + 0.03 * x + 0.02 * y + 0.015 * math.sin(x),
                                   0.4 + 0.025 * y + 0.01 * math.cos(x),
                                   0.12 + 0.04 * x + 0.008 * math.sin(y), 1.0]))
    common = {"version": 1, "quarterTurns": 0, "angle": 0,
              "centerX": 0.5, "centerY": 0.5, "width": 5 / 9, "height": 5 / 9,
              "aspectRatio": None}
    settings = [
        ("crop-odd-origin", {**common, "centerX": 3.5 / 9}),
        ("crop-quarter-turn", {**common, "quarterTurns": 1, "width": 1, "height": 1}),
        ("crop-fractional-straighten", {**common, "angle": 7}),
    ]
    result = []
    for name, setting in settings:
        geometry = crop_geometry(setting)
        crop = {"sourceWidth": 9, "sourceHeight": 9, "sourceRgba": source,
                "settings": setting, "expectedGeometry": geometry,
                "independentReconstruction": "Opaque Decimal80 Hermite basis; exact copy for integral crop/quarterturn"}
        result.append(make_case(name, [root("canonical-radial", radial(3.5 / 9, 0.5, 2.4 / 9, 3 / 9, 25),
                                           25, color=dict(saturation=17), exposureEv=0.12)],
                                width=geometry["width"], height=geometry["height"], primaries="rec2020",
                                controls=global_controls(0.12, 11, 13),
                                rgba=crop_opaque(source, geometry), crop=crop))
    return result


def witness(case, mode):
    _, wrong, _ = evaluate(case, mode, False)
    expected = case["expected"]
    indices = [i for i in range(len(expected)) if i % 4 != 3]
    index = max(indices, key=lambda i: abs(wrong[i] - expected[i]) /
                (TOLERANCE["absolute"] + TOLERANCE["relative"] * abs(expected[i])))
    error = abs(wrong[index] - expected[index])
    tolerance = TOLERANCE["absolute"] + TOLERANCE["relative"] * abs(expected[index])
    if error <= tolerance:
        raise AssertionError("Frozen wrong-order/blend/global control has no discriminating witness")
    return {"caseId": case["id"], "kind": mode, "index": index,
            "expected": expected[index], "actual": wrong[index],
            "maxAbs": max(abs(a - b) for a, b in zip(expected, wrong)),
            "maxToleranceRatio": error / tolerance,
            "wrongFloat32Sha256": digest(struct.pack("<" + "f" * len(wrong), *wrong))}


def formatted_json(value):
    # Format text before freezing identities; this imports no application code.
    result = subprocess.run(["npx", "--no-install", "prettier", "--parser", "json"],
                            input=json.dumps(value, allow_nan=False), text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, cwd=ROOT)
    return result.stdout.encode()


def main():
    cases = fixtures()
    by_id = {case["id"]: case for case in cases}
    controls = [witness(by_id["raster-two-textures"], mode)
                for mode in ("double-coverage", "double-global", "reversed-order")]
    hidden_changed = []
    for case in cases:
        previous = case["expectedGlobal"]
        for step in case["steps"]:
            for index in step["textureHiddenWordIndices"]:
                if word(step["expected"][index]) != word(previous[index]):
                    hidden_changed.append({"caseId": case["id"], "rootId": step["rootId"],
                                           "index": index, "previous": previous[index],
                                           "unblended": step["expectedUnblended"][index],
                                           "expected": step["expected"][index]})
                    break
            previous = step["expected"]
    if not hidden_changed:
        raise AssertionError("A hidden-RGB Light/Color witness is required")
    dependencies = [Path(__file__), HERE / "reference.py", HERE.parent / "mask-color-reference.py",
                    HERE.parent / "color-reference.py", HERE.parent / "crop-filter-reference.py"]
    sources = [{"file": str(path.relative_to(ROOT)), "sha256": digest(path.read_bytes())}
               for path in dependencies]
    reference = {
        "version": 1, "policy": POLICY,
        "provenance": {"scope": "Bounded procedural arrays only; no photo/full-frame CPU executor",
                       "arithmetic": "Independent Decimal80 point math and scalar float64 frozen Texture; Float32 inputs, global output, unblended candidate and root output",
                       "sources": sources,
                       "limits": "Neutral global WB/curves/mixer/grading; vibrance0; white1. Actual consumer/crop/metadata gates are separate GPU evidence."},
        "tolerance": TOLERANCE,
        "cases": cases, "negativeControls": controls,
        "hiddenLightColorWitnesses": hidden_changed,
        "refusals": [
            {"id": "visible-domain-after-global", "width": 1, "height": 1,
             "primaries": "rec2020", "white": 1, "rgba": [20, 20, 20, 1],
             "globals": global_controls(1, 0, 0),
             "roots": [root("out-of-domain", [1.0], 25)],
             "expectedRefusal": "Visible preceding point-space asinh luminance exceeds6; do not clip or normalize"},
            {"id": "invalid-alpha", "width": 1, "height": 1,
             "primaries": "rec2020", "white": 1, "rgba": [0.2, 0.3, 0.4, 1.25],
             "globals": global_controls(0, 0, 0),
             "roots": [root("invalid-alpha", [1.0], 25)],
             "expectedRefusal": "Alpha outside[0,1]; no CPU repair"},
        ],
    }
    for refusal in reference["refusals"]:
        try:
            evaluate(refusal, keep_steps=False)
        except ValueError:
            continue
        raise AssertionError("Prospective refusal was not independently rejected")
    encoded = formatted_json(reference)
    if len(encoded) > 1024 * 1024:
        raise ValueError("Bounded ordered reference exceeds1MiB")
    target = ROOT / "assets/tests/references/masked-texture/order-reference-v2.json"
    target.write_bytes(encoded)
    parent_path = ROOT / "assets/tests/references/masked-texture/protocol.json"
    protocol = {
        "version": 1, "id": POLICY, "issue": 80,
        "status": "prospectively-frozen-before-ordered-candidate-gpu",
        "algorithmReference": {"file": str(parent_path.relative_to(ROOT)), "sha256": digest(parent_path.read_bytes())},
        "correction": {
            "previousProtocol": {"file": "assets/tests/references/masked-texture/order-protocol-v1.json",
                                 "sha256": "1830817ee8b6daf8e97a320c85269596d15e76e19e6f8f6d2237190bd88f58a4"},
            "previousReference": {"file": "assets/tests/references/masked-texture/order-reference-v1.json",
                                  "sha256": "109685c82217a61d6e44b63a8829bf3dca569ed323d86f6baba66daeff0645ff"},
            "previousGenerator": {"file": "scripts/research/masked-texture/order-reference.py",
                                  "sha256": "099b679296c048229a3c6ce14ef9fdff1972e23a661d2e9825338fba4cf0f0c5"},
            "reason": "V1 authoring-contract error: local exposure0.125 is not a valid0.01EV control step; the first GPU gate rejected it before filtered output for that case and before any photograph.",
            "generatorControlSites": [
                {"case": "raster-even-partial", "control": "local exposureEv", "previous": 0.125, "corrected": 0.12},
                {"case": "raster-even-partial", "control": "global exposureEv", "previous": 0.125, "corrected": 0.12},
                {"case": "all three crop cases", "control": "local exposureEv", "previous": 0.125, "corrected": 0.12},
                {"case": "all three crop cases", "control": "global exposureEv", "previous": 0.125, "corrected": 0.12},
            ],
            "limits": "Four generator control sites expand to eight scalar fields in four cases. All algorithm/kernel/domain/boundary/strength/mask/crop/source/tolerance/photo controls remain unchanged. Retain all v1 files and failed evidence; no output-driven tuning.",
        },
        "reference": {"file": str(target.relative_to(ROOT)), "sha256": digest(encoded),
                      "generator": str(Path(__file__).relative_to(ROOT)), "generatorSha256": sources[0]["sha256"]},
        "scope": "One internal ordered-mask proof, not production settings/UI/history/MCP/export adoption",
        "order": "Existing globalLight/Color then bottom-to-top roots; unblended frozen Texture then Balance, sixLight, saturation then oneexistingmix",
        "rootList": "TOP-FIRST; steps/expected are BOTTOM-TO-TOP execution",
        "strengths": [25, -25],
        "pointReferenceLimits": {"globalWhiteBalance": "neutral", "globalCurves": "neutral", "globalVibrance": 0,
                                 "mixerGrading": "neutral", "white": 1,
                                 "activeGlobalControls": ["exposureEv", "contrast", "saturation"],
                                 "activeLocalControls": ["temperature", "tint", "saturation", *ZERO_LIGHT]},
        "gridPolicy": {"id": "masked-texture-cropped-stack-v1", "referenceCases": "Identity and three explicit native crops; crop-local pixel centers+0.5, finite-levelclamp/ceilhalf unchanged; coverage mapped to canonical source",
                       "qualificationCases": ["odd integer crop origin", "quarter turn", "fractional straighten"],
                       "requiresActualGpuEvidence": True,
                       "notPromised": "Uncropped canonical phase/rotation invariance or outsidecrop neighbors"},
        "gates": {**TOLERANCE,
                  "absoluteRgb": TOLERANCE["absolute"], "relativeRgb": TOLERANCE["relative"],
                  "exact": ["per-root zeroCoverage copies precedingRGBAwords", "alpha words unchanged",
                            "Texture alpha0 unblended candidate copies preceding hiddenRGBwords",
                            "allTexture0 uses actualcompletelegacyconsumer route",
                            "actual nativeconsumer output outsideTextureunion exactvsunchangedlegacy"],
                  "hiddenPointEdits": "ExistingLight/Color maymodifyhiddenRGB; alpha0 is Texture-onlybypass, finalcompatibility selectsactuallegacy",
                  "negativeControls": "Doublecoverage, doubleglobals and reversedorder each exceedunchangedRGBgate at a frozen witness",
                  "outputMetadata": "Actual nativeHDRselected-output peaks/headroom followexistingpolicy; not certifiedbythisoracle"},
        "runtime": {"backend": "Existing isolatedDawn sharedpoint/Texture GPU; no CPUfeaturefallback",
                    "maxReferenceSize": {"width": 33, "height": 25}, "maxReferenceBytes": 1048576,
                    "photo": "Only after small GPU/domain/order/exactlegacy/resource/crop gates; existing trackedflamingo, fresh evidence",
                    "foregroundRequiresApproval": True,
                    "resources": "UnchangedAutomaticRAM/conservative2GiBGPU/devicebuffers; drainTexturebeforeseparatepointcomposite; chargeunblendedcandidate+previous+next plus source/union/legacyoutput"},
        "photo": {
            "caseFile": "assets/tests/references/masked-texture/photo-cases.json",
            "caseSha256": digest((ROOT / "assets/tests/references/masked-texture/photo-cases.json").read_bytes()),
            "caseId": "flamingo-plumage-ripples-reflected-legs",
            "globals": global_controls(0.25, 10, 10),
            "roots": [
                {"id": "ripples", "amount": -25, "light": {**ZERO_LIGHT, "exposureEv": -0.1},
                 "color": {**ZERO_COLOR, "saturation": 10}},
                {"id": "reflected-legs", "amount": 25, "light": {**ZERO_LIGHT, "exposureEv": 0.15},
                 "color": {**ZERO_COLOR, "saturation": 10}},
                {"id": "plumage", "amount": 25, "light": {**ZERO_LIGHT, "contrast": 10},
                 "color": {**ZERO_COLOR, "saturation": 10}},
            ],
            "rootOrder": "TOP-FIRST, unchanged source mask order; execute bottom-to-top",
            "crop": "Identity native crop; transformed geometry is qualified by the three tiny cases",
            "prerequisite": "All fourteen numerical/order/crop/coverage and actualconsumer/exactlegacy/resource gates pass first",
            "purpose": "Prospective integration test controls, not result-driven photographic tuning or a changed preferred user recipe",
        },
        "compatibilityOnlyCurveProbe": {
            "scope": "Separate actualconsumer activecurve comparison with allTexture0; no independent combinedTexture+curve oracle qualification",
            "freeze": "Exact tiny input and curve controls must be pinned in the owned run before dispatch",
        },
        "stop": "First failed gate stops; correctimplementation defects only withinfrozenmath/controls/tolerances. No automaticparameter/model/sourcecycle or productionfeature enablement.",
    }
    protocol_target = target.with_name("order-protocol-v2.json")
    protocol_bytes = formatted_json(protocol)
    protocol_target.write_bytes(protocol_bytes)
    print(json.dumps({"cases": len(cases), "referenceBytes": len(encoded),
                      "referenceSha256": digest(encoded), "protocolSha256": digest(protocol_bytes),
                      "generatorSha256": sources[0]["sha256"], "negativeControls": controls,
                      "hiddenLightColorWitnesses": len(hidden_changed)}, indent=2))


if __name__ == "__main__":
    main()
