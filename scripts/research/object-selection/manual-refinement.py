"""Research-only immutable R8 base plus separate, ordered manual brush corrections.

The vectorized CPU tiles are an explicit coverage/persistence diagnostic, not a
segmentation inference fallback or production rendering/history integration.
"""
import argparse
import copy
import hashlib
import json
import math
import resource
import sys
import time
import tracemalloc
from pathlib import Path

import numpy as np
from PIL import Image

TILE = 256
MAX_POINTS = 65536
MAX_STROKE_POINTS = 4096
MAX_METADATA_BYTES = 32 * 1024 * 1024
MAX_HISTORY = 128
MAX_PIXELS = 32 * 1024 * 1024


def sha256(path):
    result = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def canonical_bytes(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def is_hash(value):
    return isinstance(value, str) and len(value) == 64 and all(c in "0123456789abcdef" for c in value)


def validate_source(source):
    if not isinstance(source, dict) or set(source) != {"sha256", "gridIdentity", "width", "height"}:
        raise ValueError("Use an explicit source SHA-256, grid identity and native dimensions.")
    if not is_hash(source["sha256"]) or not is_hash(source["gridIdentity"]):
        raise ValueError("Invalid source or grid identity.")
    width, height = source["width"], source["height"]
    if any(type(n) is not int or n < 1 or n > 32768 for n in [width, height]) or width * height > MAX_PIXELS:
        raise ValueError("Native coverage exceeds the bounded research dimensions.")


def require_source(stored, expected):
    validate_source(stored)
    validate_source(expected)
    if stored != expected:
        raise ValueError("Source or geometry grid changed; corrections cannot be retargeted.")


def validate_stroke(stroke):
    if not isinstance(stroke, dict) or set(stroke) != {"mode", "radius", "feather", "points"}:
        raise ValueError("Invalid manual stroke fields.")
    if stroke["mode"] not in ["add", "subtract"]:
        raise ValueError("Use add/paint or subtract/erase.")
    radius, feather = stroke["radius"], stroke["feather"]
    if type(radius) not in (int, float) or not math.isfinite(radius) or not 0 < radius <= 0.5:
        raise ValueError("Invalid brush radius.")
    if not np.isfinite(np.float32(radius)) or np.float32(radius) <= 0:
        raise ValueError("Brush radius is not representable in the shared Float32 geometry.")
    if type(feather) not in (int, float) or not math.isfinite(feather) or not 0 <= feather <= 1:
        raise ValueError("Invalid brush feather.")
    points = stroke["points"]
    if not isinstance(points, list) or not 1 <= len(points) <= MAX_STROKE_POINTS:
        raise ValueError("Manual stroke point limit exceeded.")
    for point in points:
        if not isinstance(point, dict) or set(point) != {"x", "y"}:
            raise ValueError("Invalid normalized stroke point.")
        if any(type(n) not in (int, float) or not math.isfinite(n) or not 0 <= n <= 1 for n in point.values()):
            raise ValueError("Stroke points must be finite normalized source coordinates.")


def import_base(path, directory, source):
    validate_source(source)
    path = Path(path)
    with Image.open(path) as image:
        if image.format != "PNG" or image.mode != "L" or image.size != (source["width"], source["height"]):
            raise ValueError("The AI base must be native-size single-channel 8-bit PNG on the frozen grid.")
    digest = sha256(path)
    relative = Path("bases") / f"{digest}.png"
    target = Path(directory) / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        with path.open("rb") as original, target.open("xb") as output:
            for chunk in iter(lambda: original.read(1024 * 1024), b""):
                output.write(chunk)
    if sha256(target) != digest:
        raise ValueError("An immutable AI base changed.")
    return {"path": str(relative), "sha256": digest, "width": source["width"], "height": source["height"],
            "encoding": "PNG-R8", "decodedBytes": source["width"] * source["height"]}


def create_state(base_path, directory, source):
    base = import_base(base_path, directory, source)
    return {"version": 1, "scope": "research-coverage-and-persistence-only", "source": copy.deepcopy(source),
            "bases": {base["sha256"]: base}, "strokes": {},
            "history": [{"base": base["sha256"], "strokes": [], "inverted": False}], "cursor": 0}


def current(state):
    return state["history"][state["cursor"]]


def push(state, snapshot):
    value = copy.deepcopy(state)
    value["history"] = value["history"][:value["cursor"] + 1]
    if len(value["history"]) >= MAX_HISTORY:
        raise ValueError("The bounded research history is full.")
    value["history"].append(snapshot)
    value["cursor"] += 1
    validate_state(value)
    return value


def add_stroke(state, stroke):
    validate_stroke(stroke)
    value = copy.deepcopy(state)
    digest = hashlib.sha256(canonical_bytes(stroke)).hexdigest()
    value["strokes"][digest] = copy.deepcopy(stroke)
    snapshot = copy.deepcopy(current(value))
    snapshot["strokes"].append(digest)
    return push(value, snapshot)


def replace_base(state, path, directory, expected_source):
    require_source(state["source"], expected_source)
    value = copy.deepcopy(state)
    base = import_base(path, directory, expected_source)
    value["bases"][base["sha256"]] = base
    snapshot = copy.deepcopy(current(value))
    snapshot["base"] = base["sha256"]
    return push(value, snapshot)


def set_inverted(state, inverted):
    if type(inverted) is not bool:
        raise ValueError("Inversion must be explicit.")
    snapshot = copy.deepcopy(current(state))
    snapshot["inverted"] = inverted
    return push(state, snapshot)


def move_history(state, cursor):
    if type(cursor) is not int or not 0 <= cursor < len(state["history"]):
        raise ValueError("Invalid research history cursor.")
    value = copy.deepcopy(state)
    value["cursor"] = cursor
    return value


def validate_state(state):
    if state.get("version") != 1:
        raise ValueError("Unsupported research coverage version.")
    validate_source(state["source"])
    if len(canonical_bytes(state)) > MAX_METADATA_BYTES:
        raise ValueError("Retained manual coverage metadata exceeds 32 MiB.")
    if not isinstance(state["history"], list) or not 1 <= len(state["history"]) <= MAX_HISTORY:
        raise ValueError("Invalid or oversized research history.")
    if type(state["cursor"]) is not int or not 0 <= state["cursor"] < len(state["history"]):
        raise ValueError("Invalid research history cursor.")
    for digest, base in state["bases"].items():
        if (not is_hash(digest) or base.get("sha256") != digest or
                base.get("path") != str(Path("bases") / f"{digest}.png") or
                base.get("encoding") != "PNG-R8" or
                base.get("width") != state["source"]["width"] or
                base.get("height") != state["source"]["height"] or
                base.get("decodedBytes") != state["source"]["width"] * state["source"]["height"]):
            raise ValueError("An immutable AI base descriptor changed or has the wrong grid.")
    for digest, stroke in state["strokes"].items():
        validate_stroke(stroke)
        if hashlib.sha256(canonical_bytes(stroke)).hexdigest() != digest:
            raise ValueError("Immutable stroke content changed.")
    for snapshot in state["history"]:
        if snapshot["base"] not in state["bases"] or type(snapshot["inverted"]) is not bool:
            raise ValueError("Missing AI base or invalid inversion in history.")
        points = 0
        for digest in snapshot["strokes"]:
            if digest not in state["strokes"]:
                raise ValueError("Historical manual coverage content is missing.")
            points += len(state["strokes"][digest]["points"])
        if points > MAX_POINTS:
            raise ValueError("Live manual coverage point limit exceeded.")


def save_state(state, path):
    validate_state(state)
    Path(path).write_text(json.dumps(state, indent=2, allow_nan=False) + "\n")


def load_state(path, expected_source):
    state = json.loads(Path(path).read_text())
    validate_state(state)
    require_source(state["source"], expected_source)
    return state


def stroke_tile(stroke, x, y, width, height, image_width, image_height):
    short = min(image_width, image_height)
    radius = np.float32(stroke["radius"])
    points = stroke["points"]
    px = (np.arange(x, x + width, dtype=np.float32)[None, :] + np.float32(0.5)) / np.float32(short)
    py = (np.arange(y, y + height, dtype=np.float32)[:, None] + np.float32(0.5)) / np.float32(short)
    brush = np.zeros((height, width), dtype=np.float32)
    for index in range(max(1, len(points) - 1)):
        a, b = points[index], points[min(index + 1, len(points) - 1)]
        ax, ay = np.float32(a["x"] * image_width / short), np.float32(a["y"] * image_height / short)
        bx, by = np.float32(b["x"] * image_width / short), np.float32(b["y"] * image_height / short)
        dx, dy = bx - ax, by - ay
        length = dx * dx + dy * dy
        if length > 0:
            t = np.clip(((px - ax) * dx + (py - ay) * dy) / length, 0, 1)
            distance = np.sqrt((px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2)
        else:
            distance = np.sqrt((px - ax) ** 2 + (py - ay) ** 2)
        if stroke["feather"] > 0:
            inner = radius * (np.float32(1) - np.float32(stroke["feather"]))
            phase = np.clip((distance - inner) / (radius - inner), 0, 1)
            amount = np.float32(1) - phase * phase * (np.float32(3) - np.float32(2) * phase)
        else:
            amount = (distance <= radius).astype(np.float32)
        np.maximum(brush, amount, out=brush)
    return brush


def intersects(stroke, x, y, width, height, source):
    reach = stroke["radius"] * min(source["width"], source["height"])
    px = [point["x"] * source["width"] for point in stroke["points"]]
    py = [point["y"] * source["height"] for point in stroke["points"]]
    return not (max(px) + reach < x or min(px) - reach > x + width or
                max(py) + reach < y or min(py) - reach > y + height)


def peak_rss_bytes():
    value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return int(value if sys.platform == "darwin" else value * 1024)


def render(state, directory, output_path, expected_source):
    validate_state(state)
    require_source(state["source"], expected_source)
    snapshot = current(state)
    base = state["bases"][snapshot["base"]]
    root = Path(directory).resolve()
    path = (root / base["path"]).resolve()
    if not path.is_relative_to(root) or sha256(path) != base["sha256"]:
        raise ValueError("Immutable AI base missing, changed or outside its research bundle.")
    source = state["source"]
    width, height = source["width"], source["height"]
    with Image.open(path) as original:
        if original.mode != "L" or original.format != "PNG" or original.size != (width, height):
            raise ValueError("Immutable AI base encoding or grid changed.")
        output = Image.new("L", (width, height))
        started = time.perf_counter()
        before = peak_rss_bytes()
        tracemalloc.start()
        tiles, corrected = 0, 0
        for y in range(0, height, TILE):
            for x in range(0, width, TILE):
                tile_width, tile_height = min(TILE, width - x), min(TILE, height - y)
                coverage = np.asarray(original.crop((x, y, x + tile_width, y + tile_height)), dtype=np.float32) / np.float32(255)
                for digest in snapshot["strokes"]:
                    stroke = state["strokes"][digest]
                    if not intersects(stroke, x, y, tile_width, tile_height, source):
                        continue
                    brush = stroke_tile(stroke, x, y, tile_width, tile_height, width, height)
                    if stroke["mode"] == "add":
                        np.maximum(coverage, brush, out=coverage)
                    else:
                        coverage *= np.float32(1) - brush
                    corrected += 1
                if snapshot["inverted"]:
                    coverage = np.float32(1) - coverage
                quantized = np.floor(np.clip(coverage, 0, 1) * np.float32(255) + np.float32(0.5)).astype(np.uint8)
                output.paste(Image.fromarray(quantized), (x, y))
                tiles += 1
        _, tracked_peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()
        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output.save(output_path, format="PNG", compress_level=6)
        stats = {"width": width, "height": height, "tiles": tiles, "correctedTileStrokePairs": corrected,
                 "tileEdge": TILE, "maximumFloatPlaneBytes": min(TILE, width) * min(TILE, height) * 4,
                 "fullSourceFloat32PlaneAllocated": False,
                 "baseR8DecodedBytes": width * height, "outputR8DecodedBytes": width * height,
                 "conservativeTileScratchBytes": TILE * TILE * 4 * 16,
                 "tracemallocPeakBytes": tracked_peak, "processPeakRssBytes": peak_rss_bytes(),
                 "processPeakRssBeforeBytes": before, "elapsedSeconds": time.perf_counter() - started,
                 "encodedBytes": output_path.stat().st_size, "sha256": sha256(output_path),
                 "backend": "explicit NumPy/native tiled research diagnostic; no model inference",
                 "quantization": "R8 round-half-up after ordered Float32 coverage; inversion last"}
        output.close()
        return stats


def scalar_reference(base_value, strokes, x, y, width, height, inverted=False):
    """Independent Float64 point oracle, separate from tile candidate/array logic."""
    short = min(width, height)
    point = ((x + 0.5) / short, (y + 0.5) / short)
    coverage = base_value / 255
    for stroke in strokes:
        brush = 0
        points = stroke["points"]
        for index in range(max(1, len(points) - 1)):
            a, b = points[index], points[min(index + 1, len(points) - 1)]
            a = (a["x"] * width / short, a["y"] * height / short)
            b = (b["x"] * width / short, b["y"] * height / short)
            delta = (b[0] - a[0], b[1] - a[1])
            length = delta[0] ** 2 + delta[1] ** 2
            t = 0 if not length else min(1, max(0, ((point[0] - a[0]) * delta[0] + (point[1] - a[1]) * delta[1]) / length))
            distance = math.hypot(point[0] - a[0] - t * delta[0], point[1] - a[1] - t * delta[1])
            radius = stroke["radius"]
            if stroke["feather"] == 0:
                amount = 1 if distance <= radius else 0
            else:
                phase = min(1, max(0, (distance - radius * (1 - stroke["feather"])) / (radius * stroke["feather"])))
                amount = 1 - phase * phase * (3 - 2 * phase)
            brush = max(brush, amount)
        coverage = max(coverage, brush) if stroke["mode"] == "add" else coverage * (1 - brush)
    if inverted:
        coverage = 1 - coverage
    return math.floor(min(1, max(0, coverage)) * 255 + 0.5)


def synthetic_source(width, height):
    identity = hashlib.sha256(f"synthetic-research-r8:{width}:{height}".encode()).hexdigest()
    return {"sha256": identity, "gridIdentity": hashlib.sha256((identity + ":grid-v1").encode()).hexdigest(),
            "width": width, "height": height}


def circle(x, y, width, height, radius, mode, feather=0):
    return {"mode": mode, "radius": radius / min(width, height), "feather": feather,
            "points": [{"x": (x + 0.5) / width, "y": (y + 0.5) / height}]}


def self_test(directory):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    source = synthetic_source(513, 257)
    a, b = directory / "synthetic-base-a.png", directory / "synthetic-base-b.png"
    Image.new("L", (513, 257), 64).save(a)
    Image.new("L", (513, 257), 160).save(b)
    initial = create_state(a, directory, source)
    paint = {"mode": "add", "radius": 12 / 257, "feather": 0.5,
             "points": [{"x": 240.5 / 513, "y": 128.5 / 257}, {"x": 272.5 / 513, "y": 128.5 / 257}]}
    erase = circle(264, 128, 513, 257, 8, "subtract", 0.5)
    worked = add_stroke(add_stroke(initial, paint), erase)
    final_path = directory / "worked.png"
    stats = render(worked, directory, final_path, source)
    samples = [(200, 128), (240, 128), (254, 128), (255, 128), (256, 128), (257, 128), (264, 128), (264, 134), (280, 128)]
    with Image.open(final_path) as image:
        differences = [abs(image.getpixel(point) - scalar_reference(64, [paint, erase], *point, 513, 257)) for point in samples]
        assert max(differences) <= 1, differences
        assert image.getpixel((240, 128)) == 255 and image.getpixel((264, 128)) == 0
    checks = [{"name": "independent numeric points, polyline feather and tile seams", "passed": True, "maximumR8Error": max(differences)}]
    ordered = add_stroke(add_stroke(initial, erase), paint)
    render(ordered, directory, directory / "reversed-order.png", source)
    inverted = set_inverted(worked, True)
    render(inverted, directory, directory / "inverted.png", source)
    with Image.open(directory / "reversed-order.png") as reversed_image, Image.open(directory / "inverted.png") as inverted_image:
        assert reversed_image.getpixel((264, 128)) == 255
        assert inverted_image.getpixel((264, 128)) == 255 and inverted_image.getpixel((240, 128)) == 0
    checks.append({"name": "paint/erase order and inversion after coverage", "passed": True})
    save_state(worked, directory / "state.json")
    loaded = load_state(directory / "state.json", source)
    render(loaded, directory, directory / "reloaded.png", source)
    assert sha256(final_path) == sha256(directory / "reloaded.png")
    checks.append({"name": "restart without model retains byte-exact accepted coverage", "passed": True})
    refined = replace_base(loaded, b, directory, source)
    assert current(refined)["strokes"] == current(worked)["strokes"]
    render(refined, directory, directory / "new-ai-base.png", source)
    with Image.open(directory / "new-ai-base.png") as image:
        assert image.getpixel((240, 128)) == 255 and image.getpixel((264, 128)) == 0
        assert image.getpixel((200, 128)) == 160
    undone = move_history(refined, refined["cursor"] - 1)
    render(undone, directory, directory / "undone.png", source)
    assert sha256(final_path) == sha256(directory / "undone.png")
    redone = move_history(undone, undone["cursor"] + 1)
    render(redone, directory, directory / "redone.png", source)
    assert sha256(directory / "new-ai-base.png") == sha256(directory / "redone.png")
    checks.append({"name": "AI base refinement preserves separate strokes; cursor Undo/Redo restores exact bases", "passed": True})
    rejected = 0
    for key in ["sha256", "gridIdentity"]:
        changed = {**source, key: "0" * 64}
        try:
            render(worked, directory, directory / "must-not-exist.png", changed)
        except ValueError:
            rejected += 1
    assert rejected == 2 and not (directory / "must-not-exist.png").exists()
    immutable_path = directory / worked["bases"][current(worked)["base"]]["path"]
    immutable_bytes = immutable_path.read_bytes()
    try:
        Image.new("L", (513, 257), 65).save(immutable_path)
        try:
            render(worked, directory, directory / "must-not-exist.png", source)
        except ValueError:
            rejected += 1
    finally:
        immutable_path.write_bytes(immutable_bytes)
    assert rejected == 3 and not (directory / "must-not-exist.png").exists()
    checks.append({"name": "changed source/grid and tampered immutable base refuse retargeting", "passed": True})
    native = synthetic_source(5472, 3648)
    native_base = directory / "native-synthetic-base.png"
    Image.new("L", (native["width"], native["height"]), 64).save(native_base)
    native_state = create_state(native_base, directory, native)
    native_state = add_stroke(native_state, circle(2600, 1700, 5472, 3648, 48, "add", 0.75))
    native_state = add_stroke(native_state, circle(2610, 1700, 5472, 3648, 12, "subtract", 0.5))
    native_stats = render(native_state, directory, directory / "native-worked.png", native)
    native_stats["baseEncodedBytes"] = native_base.stat().st_size
    assert native_stats["maximumFloatPlaneBytes"] <= TILE * TILE * 4
    assert native_stats["tracemallocPeakBytes"] < native["width"] * native["height"] * 4
    with Image.open(directory / "native-worked.png") as image:
        assert image.getpixel((2610, 1700)) == 0 and image.getpixel((0, 0)) == 64
    checks.append({"name": "20MP R8 storage and bounded native tiles without a full-source floating plane", "passed": True})
    result = {"version": 1, "status": "passed", "checks": checks, "smallCoverage": stats, "native20MP": native_stats,
              "limitations": ["Synthetic coverage/persistence diagnostic only; no real-photo correction effort claim.",
                              "No production settings migration, app history, GPU coverage integration or HDR export activation."]}
    (directory / "summary.json").write_text(json.dumps(result, indent=2) + "\n")
    (directory / "summary.md").write_text("# Manual refinement prototype: PASSED\n\n" +
        f"{len(checks)} checks passed. Native size {native['width']} × {native['height']}; {native_stats['elapsedSeconds']:.3f} s.\n\n" +
        "Base plus separate normalized stroke content reloads without a model. The replacement AI base retains authored corrections.\n\n" +
        f"Maximum floating tile plane: {native_stats['maximumFloatPlaneBytes']} bytes; traced allocation peak: {native_stats['tracemallocPeakBytes']} bytes; process peak RSS: {native_stats['processPeakRssBytes']} bytes.\n\n" +
        "Research prototype only; physical GPU memory and production history integration are unqualified. Full details: [summary.json](summary.json).\n")
    print(json.dumps({"status": result["status"], "checks": len(checks), "summary": str(directory / "summary.md")}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--base", type=Path)
    parser.add_argument("--strokes", type=Path, help="JSON {version:1,source:{sha256,gridIdentity,width,height},strokes:[...],inverted:false}")
    parser.add_argument("--output", type=Path, required=True, help="Disposable research bundle/output directory")
    args = parser.parse_args()
    if args.self_test:
        self_test(args.output)
        return
    if not args.base or not args.strokes:
        parser.error("Use --base and --strokes, or --self-test.")
    document = json.loads(args.strokes.read_text())
    if document.get("version") != 1:
        raise ValueError("Unsupported research stroke document.")
    source = document["source"]
    args.output.mkdir(parents=True, exist_ok=True)
    state = create_state(args.base, args.output, source)
    for stroke in document["strokes"]:
        state = add_stroke(state, stroke)
    inverted = document.get("inverted", False)
    if type(inverted) is not bool:
        raise ValueError("Inversion must be explicit Boolean coverage state.")
    if inverted:
        state = set_inverted(state, True)
    save_state(state, args.output / "state.json")
    result = render(state, args.output, args.output / "mask.png", source)
    (args.output / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"status": "rendered-research-only", "mask": str(args.output / "mask.png"), "state": str(args.output / "state.json")}))


if __name__ == "__main__":
    main()
