# Native RAW source host

This Linux x64 host returns actual sensor samples and pinned LibRaw metadata to
the existing preview worker. It contains no display renderer, JPEG substitute or
GPU device. Rust divides admitted Sony ARW2 rows between at most seven scoped
workers and the caller. The LibRaw bridge, row ABI and kernel are copied exactly
from the retained independent source/full-F32 controls; the new owned entry and
binary require their own integration and parity verification.

The sole command is:

```text
irodori-raw --owned-rows-v1 EXPECTED_MAIN_PID NONCE DEV INO LENGTH
```

Main owns the actual child and holds the original source pin. It passes a fresh
32-character lowercase hexadecimal nonce and canonical decimal fstat identity.
FD0 carries exact `IRODORI-RAW-START1 NONCE\n` followed by EOF; FD1 is the unchanged
sensor header/payload/trailer; FD2 carries diagnostics; FD3 is the inherited
read-only regular original; FD4 receives exact `ARMED NONCE\n` then closes.
The expected main PID and Linux parent-death SIGKILL guard are checked before
source ownership/readiness. No mapping, byte read or LibRaw allocation begins
until the exact start token and EOF. FD3 outlives the mapping and decoder borrows.
The main owner must admit the complete frozen request policy before start and
wait actual helper close before releasing the source or admitting its replacement.

The helper accepts no source pathname, runtime mode, thread selector or decoding
environment override. It preserves the upstream decoder body for unsupported
layouts/default flags. Existing per-source format/allocation checks are safety
guardrails; whole-application RAM/VRAM admission remains in the main request owner.
Normal error unwinding drops decoder storage before its read-only input mapping.
Process-fatal cancellation is owned by main and does not claim cooperative joins.

From the repository root, an explicit pinned archive is required:

```sh
node scripts/native-raw/build-linux.mjs /absolute/path/LibRaw-0.22.1.tar.gz
```

No dependency is downloaded. Required archive SHA-256 is
`a789dc4e2409e2901d93793a4e0b80c7b49d0d97cf6ad71c850eb7616acfd786`.
The build snapshots host sources, retains original and modified LibRaw source,
records tool versions/commands/logs/source and binary hashes under a fresh
`artifacts/native-raw-source-build/build-*`, and stages the owned binary, checksums,
provenance and licenses under `vendor/native-raw/linux-x64`. `--no-stage` retains
only the fresh build. `CARGO`, `RUSTC`, `CXX` and `AR` select build tools only.
The build is explicitly `built-unverified`; a successful compile certifies no
pixel, lifecycle, memory or application performance gate.

LibRaw 0.22.1 is available under its LGPL/CDDL alternatives. Preserve all files in
`licenses/`, the upstream source and the exact dispatch patch. Upstream source is
https://www.libraw.org/ and https://github.com/LibRaw/LibRaw/tree/0.22.1.
The dispatch changes only the Sony function entry; the build verifies both the
original decoder hash and exact patched hash. Build artifacts retain the full
corresponding source needed to inspect or rebuild the statically linked library.
