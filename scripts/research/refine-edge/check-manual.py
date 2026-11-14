"""Model-free real-case coverage/persistence diagnostic; no production CPU backend."""
import argparse
import copy
import hashlib
import importlib.util
import json
from pathlib import Path

from PIL import Image


def digest_bytes(value):
    return hashlib.sha256(value).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path("."))
    parser.add_argument("--study", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True,
                        help="Fresh research artifact directory; existing output is refused.")
    args = parser.parse_args()
    root, study, output = args.root.resolve(), args.study.resolve(), args.output.resolve()
    if output.exists():
        raise ValueError("Use a fresh manual-reference output; preserve earlier evidence.")
    if not output.is_relative_to(root / "artifacts"):
        raise ValueError("Manual reference output must remain under ignored artifacts.")
    module_path = root / "scripts/research/object-selection/manual-refinement.py"
    spec = importlib.util.spec_from_file_location("retained_manual_reference", module_path)
    reference = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(reference)
    strokes_path = root / "assets/tests/references/object-selection/manual-dog-strokes.json"
    document = json.loads(strokes_path.read_text())
    baseline_manifest = study / "baseline/cases.json"
    guided_manifest = study / "guided/cases.json"
    baseline = next(case for case in json.loads(baseline_manifest.read_text())["cases"]
                    if case["id"] == "d01-fog-dog")
    guided = next(case for case in json.loads(guided_manifest.read_text())["cases"]
                  if case["id"] == baseline["id"])
    prepared = next(case for case in json.loads(
        (study / "prepared/prepared-inputs.json").read_text())["images"]
                    if case["id"] == baseline["id"])
    source = document["source"]
    width, height = source["width"], source["height"]
    if baseline["sourceSha256"] != source["sha256"] or (
            baseline["width"], baseline["height"]) != (width, height):
        raise ValueError("Scripted strokes and actual prepared source do not share a research grid.")
    if (guided["rgbaSha256"], guided["maskSha256"]) != (
            baseline["rgbaSha256"], baseline["maskSha256"]):
        raise ValueError("Guided result changed the frozen source or starting mask.")
    baseline_path, guided_path = Path(baseline["encodedMaskPath"]), Path(guided["guidedPath"])
    original_hashes = {
        str(baseline_path): baseline["encodedMaskSha256"],
        str(guided_path): guided["guidedSha256"],
        str(root / document["sourceFile"]): source["sha256"],
        str(strokes_path): reference.sha256(strokes_path),
        str(module_path): reference.sha256(module_path),
    }
    for path, expected in original_hashes.items():
        if reference.sha256(path) != expected:
            raise ValueError(f"Changed retained input: {path}")
    raw = guided_path.read_bytes()
    if len(raw) != width * height:
        raise ValueError("Guided result is not native R8.")
    if len(document["strokes"]) != 2 or [stroke["mode"] for stroke in document["strokes"]] != ["add", "subtract"]:
        raise ValueError("Use exactly the committed Paint then Erase demonstration strokes.")
    output.mkdir(parents=True)
    generated = output / "guided-native.png"
    Image.frombytes("L", (width, height), raw).save(generated, format="PNG")
    checks = []

    def require(name, condition):
        if not condition:
            raise AssertionError(name)
        checks.append({"name": name, "passed": True})

    initial = reference.create_state(baseline_path, output, source)
    authored = initial
    for stroke in document["strokes"]:
        authored = reference.add_stroke(authored, stroke)
    expected_ids = [digest_bytes(reference.canonical_bytes(stroke)) for stroke in document["strokes"]]
    require("Exactly two independent content-addressed Paint/Erase strokes in frozen order",
            reference.current(authored)["strokes"] == expected_ids and
            [authored["strokes"][key] for key in expected_ids] == document["strokes"])
    before = output / "baseline-corrected.png"
    reference.render(authored, output, before, source)
    replaced = reference.replace_base(authored, generated, output, source)
    require("Base replacement retains stroke IDs and ordered content unchanged",
            reference.current(replaced)["strokes"] == expected_ids and
            replaced["strokes"] == authored["strokes"] and
            reference.current(replaced)["base"] != reference.current(authored)["base"])
    changed = output / "guided-corrected.png"
    reference.render(replaced, output, changed, source)
    state_path = output / "state.json"
    reference.save_state(replaced, state_path)
    reloaded = reference.load_state(state_path, source)
    reloaded_path = output / "reloaded.png"
    reference.render(reloaded, output, reloaded_path, source)
    require("Model-free save/reload renders the exact accepted corrected R8 PNG",
            reference.sha256(reloaded_path) == reference.sha256(changed))
    undo = reference.move_history(reloaded, authored["cursor"])
    undone_path = output / "undone.png"
    reference.render(undo, output, undone_path, source)
    require("Undo restores the exact original-base corrected render",
            reference.current(undo) == reference.current(authored) and
            reference.sha256(undone_path) == reference.sha256(before))
    redo = reference.move_history(undo, replaced["cursor"])
    redone_path = output / "redone.png"
    reference.render(redo, output, redone_path, source)
    require("Redo restores the exact replacement-base corrected render",
            reference.current(redo) == reference.current(replaced) and
            reference.sha256(redone_path) == reference.sha256(changed))
    rejected = []
    for change in [{"gridIdentity": "0" * 64}, {"width": width - 1}]:
        mismatched = {**copy.deepcopy(source), **change}
        try:
            reference.replace_base(replaced, generated, output, mismatched)
        except ValueError as error:
            rejected.append(str(error))
    require("Changed grid identity and native dimensions refuse retargeting", len(rejected) == 2)
    immutable = all(reference.sha256(path) == expected for path, expected in original_hashes.items())
    immutable = immutable and all(reference.sha256(output / base["path"]) == base["sha256"]
                                  for base in replaced["bases"].values())
    require("Original inputs and both immutable imported bases remain unchanged", immutable)
    receipt = {
        "version": 1, "status": "passed", "scope": "Exact real-case model-free coverage/history research diagnostic only",
        "checks": checks, "source": source,
        "researchGridLimit": "Uses the committed demonstration grid identity; actual newly prepared full geometry is hashed separately. Neither identity is a production crop/lens registration claim.",
        "actualPreparedGeometrySha256": digest_bytes(reference.canonical_bytes({
            "geometry": prepared["geometry"], "inputPolicy": prepared["inputPolicy"],
            "width": width, "height": height})),
        "inputs": original_hashes,
        "baselineManifestSha256": reference.sha256(baseline_manifest),
        "guidedManifestSha256": reference.sha256(guided_manifest),
        "generatedGuidedPngSha256": reference.sha256(generated),
        "strokeIds": expected_ids, "changedGridErrors": rejected,
        "renders": {name: {"path": str(path), "sha256": reference.sha256(path)}
                    for name, path in {"before": before, "replaced": changed, "reload": reloaded_path,
                                       "undo": undone_path, "redo": redone_path}.items()},
        "limitations": ["No segmentation model imported or run.",
                        "CPU reference diagnostic, not a production rendering backend.",
                        "No application history, HDR/export or photographic quality acceptance.",
                        "Two scripted corrections do not measure human correction effort or performance."]}
    (output / "result.json").write_text(json.dumps(receipt, indent=2) + "\n")
    (output / "summary.md").write_text(
        "# Real-photo manual coverage reference\n\n"
        f"PASSED: {len(checks)} checks on the frozen {width} × {height} dog source.\n\n"
        "Replacing the baseline with the actual guided base retains both ordered Paint/Erase strokes. "
        "Save/reload and Undo/Redo reproduce exact corrected output; changed grids refuse retargeting. "
        "All original inputs and immutable bases remain unchanged.\n\n"
        "Model-free CPU coverage/persistence research diagnostic only. No production, HDR/export, "
        "photographic quality, correction-effort or performance claim.\n\n"
        "Details: [result.json](result.json).\n")
    print(json.dumps({"status": "passed", "checks": len(checks), "summary": str(output / "summary.md")}))


if __name__ == "__main__":
    main()
