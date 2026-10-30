# Development camera runtimes

The camera MCP uses repository-pinned development runtimes for **Apple Silicon
macOS 14+** and **Linux x64 with glibc 2.35+**, including Bazzite. They are separate
from the Electron application and its installers. Node 24+ and npm are prerequisites.

```sh
npm ci
npm run camera:setup
```

`manifest.json` records the dedicated `camera-runtime-v1.0.0` GitHub release,
platform archive URLs, archive byte counts and SHA-256, executable paths, module
directories, and every installed file's mode, size and SHA-256. Setup installs
only verified regular USTAR files into ignored
`artifacts/camera/runtime/<platform>/<version>-<archive-sha256>/`. It never touches
capture journals or originals, changes USB permissions, invokes a compiler, or
uses Homebrew. A valid installation is verified and reused offline. A failed
download/extraction leaves existing installations intact; a verified staged tree
is renamed into place. Interrupted staging directories are inert and can be
removed separately. MCP startup verifies its installed runtime and never downloads
or compiles. Missing/invalid runtimes are discovery diagnostics; all seven tools
remain available.

`npm run camera:setup:macos` is a macOS-only compatibility alias for the download
installer. `npm run camera:setup -- --archive /absolute/path/to/candidate.tar.gz`
tests the exact candidate against the same committed checksums; it cannot bypass
integrity checks. Intel Macs, Windows, Linux arm64 and musl Linux are unsupported.

## Maintainer builds and provenance

`npm run camera:build` explicitly builds on the matching host; it never runs at
MCP startup or during ordinary setup. Generated runtimes, archives, manifests,
linkage evidence and command logs stay in ignored `artifacts/camera/runtime-build/`.
The [Actions workflow](../../../.github/workflows/camera-runtime.yml) uses
`macos-14` (arm64) and `ubuntu-22.04` (x64), asserts the actual architecture and
uploads candidates. The push trigger bootstraps this workflow on the temporary
implementation branch; subsequent builds can use workflow dispatch on main.

The Swift helper is built with `arm64-apple-macosx14.0`; linkage validation permits
only `/System/Library/` and `/usr/lib/`, with no private rpath. It uses Apple's
system ImageCaptureCore and Foundation. Application signing/notarization is
separate. The helper source and Apache-2.0 license accompany its source bundle.

Linux inputs are locked in [sources.lock.json](sources.lock.json): gphoto2 2.5.32,
libgphoto2 2.5.34, libusb 1.0.27, libtool/libltdl 2.4.7 and popt 1.19. Source
SHA-256 values were calculated from the downloaded upstream release archives;
popt's mirror bytes also match its upstream published checksum. Builds include
the PTP camera module, USB I/O module and all non-glibc runtime libraries.
The runtime requires only the host's glibc/ELF loader and USB device access.
libusb is built without libudev; permissions remain a host responsibility.
Optional JPEG processing, EXIF thumbnail extraction, XML/network drivers,
interactive readline/CDK/aalib interfaces, translations, serial and disk transports
are excluded. Downloaded-original metadata is read separately by ExifTool.

The provider sets private `LD_LIBRARY_PATH`, `CAMLIBS` and `IOLIBS` and preserves
its isolated configuration and locale. The loader uses relative rpaths. Builds
remove access to the build installation prefix before testing version, Sony
camera-module enumeration, USB-port enumeration and discovery. Linkage checks
reject unbundled non-glibc dependencies. A second packaging check installs into a
temporary checkout with spaces, initializes the SDK and discovers with all seven
tools. Hardware-free hosted Linux uses an empty USB bus directory with no device
nodes so libusb built without udev can initialize; the installer never creates
this directory or changes host permissions. This is packaging acceptance, not
Linux hardware acceptance. See
[upstream packaging guidance](https://raw.githubusercontent.com/gphoto/libgphoto2/v2.5.34/README.packaging)
for the camera and I/O modules required alongside both libgphoto libraries.

Each platform distribution includes `build.json`, license notices, and a matching
`*-sources.tar.gz` containing the exact upstream archives (Linux), helper source,
build scripts, source lock and Irodori license. The dedicated runtime release
publishes these source bundles with the binaries, checksums, candidate file
indices and build records. Keep the GPL/LGPL notices and matching sources with
redistributions; these development binaries are not incorporated into application
packages. Rebuilds may have different binary hashes; they are new candidates,
never replacements for already-published assets.

## Immutable release procedure

1. Build candidates on the temporary implementation branch. Download both Actions
   artifacts and copy their exact `candidate-<platform>.json` records into
   `manifest.json` after reviewing provenance, files and linkage evidence.
2. Run `camera-runtime`, `camera-control-model`, `camera-control-service` and
   `camera-control-mcp`. Install the macOS candidate in a fresh temporary checkout
   with `npm ci`; setup and operation must work without a compiler/Homebrew on PATH.
3. Run the bounded Sony MCP hardware acceptance on macOS using an explicit serial
   or discovered camera ID. Captures stay private. Required macOS failures block
   publication to main. Record platform skips and physical Linux acceptance as open.
4. Publish the **exact tested archives**, checksums, matching sources and build
   records to `camera-runtime-v1.0.0` as a non-latest dedicated development
   prerelease. GitHub can return a repository's first full release from its latest
   API despite `make_latest=false`; the prerelease flag also excludes it. Never
   replace assets under an existing tag/version. Future runtime changes need a
   new version and a new reviewed manifest.
5. Repeat clean macOS setup through the public URL and verify discovery before
   pushing main. Preserve upstream work and verify the remote commit after push.

Physical Bazzite acceptance and backlog #37 stay open until the Linux hardware
workflow passes. See the [camera guide](../../../docs/camera-control.md) for
selectors, camera preparation, recovery, Bazzite USB guidance and acceptance evidence.
