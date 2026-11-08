#!/usr/bin/env python3
"""Audit immutable Irodori cutover records, optionally against connector readbacks."""
import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path

def digest(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()

def audit(root, snapshot=None):
    directory = root / "docs/task-migration"
    inventory = json.loads((directory / "source-inventory.json").read_text())
    manifest = json.loads((directory / "manifest.json").read_text())
    sources = json.loads((directory / "source-audit.json").read_text())
    assert manifest["repository"] == inventory["repository"] == "VaclavKlima/Irodori"
    assert manifest["source_commit"] == inventory["source_commit"]
    for name, original in inventory["files"].items():
        assert digest(original["text"]) == original["sha256"], name
        frozen = subprocess.check_output(
            ["git", "show", inventory["source_commit"] + ":" + name], cwd=root
        ).decode("utf-8")
        assert frozen == original["text"], "Frozen source differs: " + name
    entries = inventory["numbered_tasks"]
    assert {e["number"] for e in entries} == set(range(1, 71))
    assert sum(e["completed"] for e in entries) == 36
    for entry in entries:
        assert entry["text"] in inventory["files"]["docs/features/README.md"]["text"]
    outputs = manifest["issues"]
    keys = {o["key"] for o in outputs}
    assert len(outputs) == len(keys) == 89
    assert len({o["marker"] for o in outputs}) == len(outputs)
    assert len({o["number"] for o in outputs}) == len(outputs)
    assert {n for o in outputs for n in o["legacy_tasks"]} == set(range(1, 71))
    for entry in entries:
        owners = [o for o in outputs if entry["number"] in o["legacy_tasks"]]
        assert owners
        if entry["completed"]:
            assert all(o["initial_state"] == "closed" for o in owners)
        else:
            assert all(o["initial_state"] == "open" for o in owners)
    for issue in outputs:
        assert issue["url"] == "https://github.com/VaclavKlima/Irodori/issues/" + str(issue["number"])
        assert set(issue["dependencies"] + issue["related"]) <= keys
    for requirement in sources["requirements"]:
        assert requirement["disposition"] in {
            "owned", "historical", "superseded", "third-party", "unadopted"
        }
        assert set(requirement["owners"]) <= keys
        if requirement["disposition"] in {"owned", "historical"}:
            assert requirement["owners"], requirement["id"]
    assert {
        "camera-characterization", "hdr-next-format",
        "hdr-native-readers", "tone-rendering-controls"
    } <= keys
    legacy = (root / "docs/features/README.md").read_text()
    for number in range(1, 71):
        assert 'id="task-' + str(number) + '"' in legacy, number
        row = next(line for line in legacy.splitlines() if 'id="task-' + str(number) + '"' in line)
        for issue in outputs:
            if number in issue["legacy_tasks"]:
                assert issue["url"] in row, (number, issue["key"])
    if snapshot:
        raw = json.loads(snapshot.read_text())
        if isinstance(raw, dict):
            raw = raw.get("issues", list(raw.values()))
        issues = [item.get("issue", item) for item in raw]
        marker_counts = {}
        for issue in issues:
            for marker in re.findall(r"<!-- (irodori-task-migration-v1:[^ ]+) -->", issue.get("body") or ""):
                marker_counts[marker] = marker_counts.get(marker, 0) + 1
        assert len(marker_counts) == len(outputs), "Missing or unexpected migration markers"
        assert all(count == 1 for count in marker_counts.values()), "Duplicate marker"
        for expected in outputs:
            found = [i for i in issues if i.get("issue_number", i.get("number")) == expected["number"]
                     and "github.com/VaclavKlima/Irodori/issues/" in (i.get("html_url") or i.get("url", ""))]
            assert len(found) == 1, expected["key"]
            actual = found[0]
            assert actual["title"] == expected["title"], expected["key"]
            expected_hash = expected.get("closed_body_sha256", expected["body_sha256"]) if actual["state"] == "closed" else expected["body_sha256"]
            assert digest(actual["body"]) == expected_hash, expected["key"]
            if expected.get("delivery_issue"):
                assert actual["state"] in {"open", "closed"}
            else:
                assert actual["state"] == expected["initial_state"], expected["key"]
            assert "link pending migration" not in actual["body"]
            assert not re.search(r"\]\((?!https?://|mailto:)[^)]+\)", actual["body"])
            assert "/blob/main/artifacts/" not in actual["body"]
            for key in expected["dependencies"] + expected["related"]:
                target = next(o for o in outputs if o["key"] == key)
                assert target["url"] in actual["body"], (expected["key"], key)
    return {
        "numbered_sources": len(entries), "historical_completed": 36,
        "destinations": len(outputs), "classified_requirements": len(sources["requirements"]),
        "saved_content_checked": snapshot is not None
    }

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--snapshot", type=Path)
    args = parser.parse_args()
    print(json.dumps(audit(args.root.resolve(), args.snapshot), indent=2))
