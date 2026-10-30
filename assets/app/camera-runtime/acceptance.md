# Camera runtime v1.0.0 acceptance

Runtime release:
[camera-runtime-v1.0.0](https://github.com/VaclavKlima/Irodori/releases/tag/camera-runtime-v1.0.0).
The release is dedicated to development camera tools and is not the latest
application release. The committed [manifest](manifest.json) is the install trust
root. Runtime archives, matching source archives, every indexed file and build
source hashes were rechecked after downloading the Actions artifacts. Generated
binaries, logs, camera journals and captures remain outside Git.

| Platform                | Tested runtime archive SHA-256                                     | Matching source archive SHA-256                                    | Build evidence                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Apple Silicon macOS 14+ | `7db1f0a7b343855c7aa068e57fa16883291d5520ff8cffd68105e141d1de89de` | `5b268b0c2d87971b444ec4d70ea64d0be7ae2a1efe8725d706e5aaffebcd140d` | [macos-14 candidate](https://github.com/VaclavKlima/Irodori/actions/runs/41041800599), source commit `3dfdaa3e0012eca3c775a46e4c908de9e62c7c59`                |
| Linux x64, glibc 2.35+  | `d73a7739ce92e3d630b1b0ccaf3f917b42a3757c1f4c21ba87acbcc18dd8347c` | `2becebd1f3a9f11a05c96d3450d48968132277bf506644b939394f130ff8f6de` | [ubuntu-22.04 packaging acceptance](https://github.com/VaclavKlima/Irodori/actions/runs/41043531286), source commit `be127680697a28fd855987632f0a606a19e20028` |

The macOS job passed system-only linkage, macOS 14 deployment, relocated setup,
offline reuse, seven-tool SDK initialization and discovery. The run's earlier
Linux job failed before candidate publication; it is not Linux acceptance. The
Linux archive comes from the later successful run and has its own matching source
bundle and build manifest. Both archives are the exact candidates verified here;
they were not rebuilt for release.

On 2026-10-30, a fresh sparse macOS checkout completed ordinary `npm ci` and
installed the exact candidate through `npm run camera:setup -- --archive <path>`.
An isolated PATH supplied Node, npm, Perl and the shell, with Homebrew, compiler
and Xcode commands trapped. None of those forbidden commands was invoked during
setup, inspection or capture. The checkout used its own camera store and no
application/user photo library. It shared no installed node_modules with the
original checkout.

The actual Sony ZV-1A, firmware 1.00, passed settings/write-readback/restoration,
one RAW/JPEG pair, three separate software exposures (1/200, 1/100, 1/50), eight
downloaded originals' sizes/SHA-256 and ISO/exposure metadata, queued cancellation
and final settings comparison in **41.70 seconds**. The save destination remained
PC Only. Private evidence:
`artifacts/camera/runtime-acceptance/candidate checkout/artifacts/camera/acceptance/2026-10-30T10-47-30.054Z-03b69824-5bd5-4d3b-98d7-571d63f16c1e/evidence.json`.
The neighboring aperture probe passed f/4 → f/4.5 → f/4; the prior f/1.8 probe
failed before capture and restored settings. Sony's
[lens specification](https://helpguide.sony.net/dc/2410/v1/en/contents/1008Q_specifications_CX64500.html)
documents the zoom-dependent maximum aperture. This is bounded control evidence,
not certification of every advertised lens setting. A read-only discovery retry
was needed after an immediate native helper process handoff. Capture ran outside
the local tool sandbox; sandboxed enumeration returned no camera.

Linux CI relocated the archive with its build install prefix unavailable, verified
every non-glibc dependency, loaded the PTP camera and USB I/O modules, checked
versions, installed/reused in a clean temporary path with spaces, initialized all
seven tools and completed discovery with no camera. Its hosted VM used an empty
USB bus directory, without device nodes or permission changes. This establishes
runtime packaging acceptance only. The setup command never provisions USB
permissions or that test directory on a developer's host.

The requested `camera-runtime`, `camera-control-model`, `camera-control-service`
and `camera-control-mcp` targets ran with their shared static/cheap checks:
**775 passed, 0 failed, 52 existing Linux-only skips; 30.60 seconds**. All **40**
camera cases passed. Type checking, lint and formatting passed. Overall status is
**incomplete (exit 2)** because selected platform cases skipped on macOS. Summary:
`artifacts/verification/2026-10-30T10-49-35.301Z-check-xxhe6J/summary.md`.
The initial sandboxed invocation's three unrelated loopback failures passed on a
narrow unsandboxed rerun and in this final selection. No comprehensive suite or
benchmark was selected. Source documentation links were checked; three existing
historical artifact pointers require their original private artifacts.

Physical Bazzite camera acceptance and backlog #37 remain open. Complete card-byte
comparison, active-shutter disconnect, autofocus quality, native burst/bracketing,
other cameras, Windows, Intel Macs, Linux arm64, application packaging and
signing/notarization are outside this acceptance. Captures have not been promoted
into fixtures or uploaded.

Public URL installation/discovery is checked after release publication and before
the final main push; its result is recorded in the delivery follow-up below.
