"""Run one isolated CascadePSP FP32 export gate; never adopt or distribute weights.

The only CPU execution is an explicitly requested synthetic ONNX export trace.
No photographic inference, CPU quality reference, fallback or application access
is performed. An export failure ends the candidate attempt without alteration.
"""

import argparse
import hashlib
import json
import platform
import shutil
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
MANIFEST = ROOT / "assets/tests/references/refine-edge/cascade-sources.json"


def digest(path, algorithm="sha256"):
    value = hashlib.new(algorithm)
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def download(url, path, max_bytes):
    request = urllib.request.Request(url, headers={"User-Agent": "Irodori-Refine-Edge-Study/1"})
    with urllib.request.urlopen(request, timeout=60) as response, path.open("xb") as output:
        size = 0
        for chunk in iter(lambda: response.read(1024 * 1024), b""):
            size += len(chunk)
            if size > max_bytes:
                raise ValueError("Upstream response exceeded the frozen download bound.")
            output.write(chunk)
    return size


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--export-python", type=Path, required=True)
    parser.add_argument("--checkpoint", type=Path,
                        help="Reuse the unchanged official checkpoint after integrity verification; never download twice after a setup-only failure.")
    parser.add_argument("--cpu-export-trace", action="store_true", required=True)
    args = parser.parse_args()
    started = time.monotonic()
    source, output = args.source.resolve(), args.output.resolve()
    if source == output or source in output.parents or output in source.parents:
        raise SystemExit("Source and output must be independent immutable locations.")
    output.mkdir(parents=True, exist_ok=False)
    specification = json.loads(MANIFEST.read_text())
    shutil.copyfile(MANIFEST, output / "source-manifest.json")
    report = {
        "version": 1,
        "candidate": "cascadepsp-official-v1.0",
        "status": "incomplete",
        "startedAt": datetime.now(timezone.utc).isoformat(),
        "sourceRevision": specification["sourceRevision"],
        "manifestSha256": digest(MANIFEST),
        "manifestPath": "source-manifest.json",
        "host": {"platform": platform.platform(), "python": platform.python_version()},
        "licensing": specification["licensing"],
        "execution": {
            "cpuPurpose": "synthetic FP32 ONNX export trace only",
            "photographicInferenceAttempted": False,
            "cpuQualityReferenceGenerated": False,
            "gpuInferenceAttempted": False,
            "cpuFallbackAttempted": False,
            "productionAdoption": False,
        },
        "stages": [],
    }
    try:
        revision = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
        if revision != specification["sourceRevision"]:
            raise ValueError("Upstream source differs from the frozen revision.")
        dirty = subprocess.check_output(["git", "-C", str(source), "status", "--porcelain"], text=True)
        if dirty:
            raise ValueError("The pinned upstream checkout has local changes.")
        report["sourceEvidence"] = []
        notices = output / "source-evidence"
        notices.mkdir()
        for relative in specification["sourceEvidenceFiles"]:
            original = source / relative
            target = notices / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(original, target)
            report["sourceEvidence"].append({"file": relative, "sha256": digest(original), "bytes": original.stat().st_size})
        report["stages"].append({"stage": "pinned-source-and-rights", "status": "passed", "adoptionRights": "unresolved"})
        checkpoint = output / "official-v1.0-model.pth"
        begin = time.monotonic()
        if args.checkpoint:
            if args.checkpoint.stat().st_size > specification["checkpoint"]["maximumBytes"]:
                raise ValueError("Reused checkpoint exceeds the frozen bound.")
            shutil.copyfile(args.checkpoint, checkpoint)
        else:
            download(specification["checkpoint"]["url"], checkpoint, specification["checkpoint"]["maximumBytes"])
        checkpoint_md5 = digest(checkpoint, "md5")
        report["checkpoint"] = {"url": specification["checkpoint"]["url"], "bytes": checkpoint.stat().st_size,
                                "sha256": digest(checkpoint), "upstreamMd5": checkpoint_md5,
                                "elapsedSeconds": time.monotonic() - begin,
                                "redistributed": False}
        if checkpoint_md5 != specification["checkpoint"]["upstreamMd5"]:
            raise ValueError("Official checkpoint does not match the upstream integrity pin.")
        if specification["checkpoint"].get("sha256") and digest(checkpoint) != specification["checkpoint"]["sha256"]:
            raise ValueError("Official checkpoint SHA-256 changed.")
        report["stages"].append({"stage": "official-checkpoint-integrity", "status": "passed"})
        begin = time.monotonic()
        # Preserve a virtual environment's interpreter symlink; resolving it
        # would bypass that environment and silently lose its installed modules.
        command = [str(args.export_python.absolute()), str(Path(__file__).with_name("cascade-export.py")),
                   "--source", str(source), "--checkpoint", str(checkpoint), "--output", str(output / "export")]
        report["exportCommand"] = command
        with (output / "export.log").open("w") as log:
            outcome = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, timeout=240, check=False)
        record = json.loads((output / "export" / "receipt.json").read_text())
        report["stages"].append({"stage": "single-fp32-onnx-export", "status": record["status"],
                                 "elapsedSeconds": time.monotonic() - begin, "exitCode": outcome.returncode,
                                 "receipt": "export/receipt.json", "log": "export.log"})
        report["export"] = record
        if record["status"] == "rejected":
            report["status"] = "rejected"
            report["reason"] = record["reason"]
            report["unreachedGates"] = ["native WebGPU model load/inference", "independent numerical parity", "photographic usefulness", "broad-adoption weight rights"]
        elif record["status"] == "exported-unqualified":
            report["status"] = "exported-unqualified"
            report["reason"] = "Export alone does not establish native WebGPU execution or useful photographic refinement."
        elif record["status"] == "incomplete":
            report["status"] = "incomplete"
            report["reason"] = f"Export setup did not reach qualification: {record.get('exceptionType', 'unknown')}: {record.get('error', '')}"
        else:
            raise ValueError("Exporter returned an unknown status.")
    except Exception as error:
        report["error"] = f"{type(error).__name__}: {error}"
    finally:
        report["elapsedSeconds"] = time.monotonic() - started
        (output / "receipt.json").write_text(json.dumps(report, indent=2) + "\n")
        reason = report.get("reason", report.get("error", "No qualification result."))
        summary = (f"# CascadePSP study gate: {report['status'].upper()}\n\n{reason}\n\n"
                   f"Source: `{report['sourceRevision']}`. Duration {report['elapsedSeconds']:.2f} seconds. "
                   "Official weights remain private local artifacts; broad-adoption weight rights are unresolved.\n\n"
                   "CPU execution is synthetic export tracing only. No photographic inference, quality-reference generation, "
                   "CPU fallback, production integration or cross-platform acceptance is claimed. "
                   "GPU execution was not attempted unless a separate successful runtime receipt records it.\n\n"
                   "Full stage/rights/hash evidence: `receipt.json`; exporter detail: `export/receipt.json` and `export.log`.\n")
        (output / "summary.md").write_text(summary)
        print(json.dumps({"status": report["status"], "reason": reason, "elapsedSeconds": report["elapsedSeconds"], "receipt": str(output / "receipt.json")}))
    return 0 if report["status"] in ["rejected", "exported-unqualified"] else 2


if __name__ == "__main__":
    sys.exit(main())
