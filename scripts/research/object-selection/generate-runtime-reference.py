"""Generate tiny numeric sampling references; explicit CPU preprocessing diagnostic only.

No model inference occurs. Run in requirements-export.txt's pinned environment.
The production application does not invoke Python or this generator.
"""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as functional
from torchvision.transforms.functional import InterpolationMode, resize


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    torch.set_num_threads(2)
    indices = sorted(set([0, 1, 1023, 1024, 1048575, 1048576, 2097152, 3145727] +
                         [(index * 2654435761 + 1013904223) % 3145728 for index in range(128)]))
    cases = []
    for width, height in [(57, 93), (1537, 1025), (4097, 17)]:
        rgba = (np.arange(width * height * 4, dtype=np.uint32) * 97 + 31).astype(np.uint8).reshape(height, width, 4)
        rgba[:, :, 3] = 255
        source = torch.from_numpy(rgba[:, :, :3].copy()).permute(2, 0, 1).to(torch.float32) / 255
        output = resize(source, [1024, 1024], interpolation=InterpolationMode.BILINEAR, antialias=True).numpy().reshape(-1)
        cases.append({"width": width, "height": height, "samples": [{"index": index, "value": float(output[index])} for index in indices]})
    logits = np.array([(x - 127.4) * 0.03 + (y - 100.6) * 0.02 for y in range(256) for x in range(256)], dtype=np.float32)
    reconstructed = functional.interpolate(torch.from_numpy(logits).reshape(1, 1, 256, 256), size=(19, 37), mode="bilinear", align_corners=False)
    expected = (reconstructed[0, 0].numpy() > 0).astype(np.uint8) * 255
    result = {"version": 1, "generator": "scripts/research/object-selection/generate-runtime-reference.py",
              "generatorSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              "environment": {"torch": torch.__version__, "numpy": np.__version__},
              "scope": "Independent upstream PyTorch preprocessing/reconstruction numeric references; no model inference or photographic ground truth.",
              "rgbaGenerator": "Uint8((flatIndex * 97 + 31) % 256), alpha=255", "absoluteTolerance": 1e-6,
              "preprocessing": cases,
              "reconstruction": {"width": 37, "height": 19, "expected": expected.reshape(-1).tolist()}}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    main()
