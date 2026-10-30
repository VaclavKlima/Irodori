# Development USB camera MCP

Backlog #37 adds a local development-only camera service. It runs independently of
Electron and the managed library. It discovers a specific USB camera, reports
actions and settings, changes supported photographic controls, and downloads
originals from single captures or 1–32 separate software-triggered exposures.
The application console remains disconnected. Live view, video, production
packaging, Windows, UI and in-app agent integration remain later work.

## Daily use in Codex

The repository includes a shared, camera-only
[`.codex/config.toml`](../.codex/config.toml):

```toml
[mcp_servers.irodori_camera]
command = "npm"
args = ["run", "--silent", "mcp:camera"]
cwd = "."
startup_timeout_sec = 30
tool_timeout_sec = 120
```

After the one-time prerequisites below, open and trust this checkout in Codex,
then refresh/restart its MCP connection or start a new Codex session. Codex starts
the stdio server automatically; do not also leave a terminal server running.
Use the client's MCP settings or `/mcp` where available to check the connection.
The [official configuration guide](https://learn.chatgpt.com/docs/config-file/config-basic)
explains trusted project discovery and precedence; the
[MCP guide](https://learn.chatgpt.com/docs/extend/mcp) covers stdio registration
and client refresh. An existing conversation may need to reconnect before its
tool catalog includes the seven camera tools.

The registration travels with the checkout. It contains no account settings,
credentials, absolute paths or architecture-specific executable. npm discovers
the nearest package root when launched from the checkout or one of its
subdirectories, including paths with spaces. The server resolves its helper,
journals and originals relative to its own module, so a different launch directory
cannot redirect them into another checkout. Launch Codex inside the intended
checkout. Inspect user/global configuration and project trust if the reported
registration differs. Optional UI/editor registrations are in
[the setup example](mcp-config.example.toml); they are not automatically shared.

For development inputs, reuse suitable committed fixtures first. If a missing
input needs a new capture and the camera, scene and lighting are ready, an agent
may discover capabilities, configure supported settings and execute the smallest
bounded capture needed for the declared validation without another confirmation.
Ask only for missing requirements or physical assistance: connection, positioning,
lighting, focusing, or a camera-menu setting unavailable through MCP. If camera
capture is unavailable, follow the [capture brief or licensed-photo workflow](../assets/README.md#obtaining-missing-photographic-inputs).
Captured artifacts remain private until fixture promotion is reviewed.

## One-time prerequisites per machine

Use Node 24 or newer and install the locked dependencies in each checkout:

```sh
npm ci
```

No camera is required for SDK initialization, tool discovery or read-only camera
discovery. Missing backends are returned as diagnostics; they do not prevent the
server from starting. Sharing the registration does not install machine dependencies.

### macOS

Build the small Apple ImageCaptureCore transport with Xcode or its
Command Line Tools installed:

```sh
npm run camera:setup:macos
```

The build writes only ignored `artifacts/camera/bin/` in this checkout. Rebuild
after changing the helper or moving to another machine/architecture. No Electron
build, open window, CDP endpoint or photo library is needed. Stdout carries MCP
messages; diagnostics use stderr. For manual client diagnostics only,
`npm run --silent mcp:camera` starts the same server and waits for MCP input.
The camera helper and server are development tools and are not bundled into the app.

The default macOS provider uses ImageCaptureCore because the system's
`ptpcamerad` can own the PTP interface. Discovery with gphoto2 succeeded on this
Mac, but control access failed with USB claim error -53, including after a
temporary stop of the owning process. The native provider cooperates with the
system owner; it does not disable system services. Building requires Apple's
SDK; the camera server reports an actionable diagnostic if the helper is missing.

For the Sony ZV-1A, follow [Sony's PC Remote instructions](https://helpguide.sony.net/dc/2410/v1/en/contents/0903_pc_remote_function.html):
turn smartphone control off, enable Network → PC Remote Function → PC Remote,
connect a data-capable USB cable and leave still-image playback. Choose the
save destination on the camera. PC Only transfers into camera RAM and then to
the computer; PC+Camera also writes newly captured photographs to the card.
For paired captures select RAW & JPEG and, when available, RAW+J PC Save Img →
RAW & JPEG. A read-only destination is never changed by the service.

### Bazzite/Linux

Use the **host** terminal, Node 24+ and gphoto2:

```sh
brew install gphoto2
gphoto2 --version
gphoto2 --auto-detect
```

[Bazzite documents Homebrew for host CLI tools](https://docs.bazzite.gg/Installing_and_Managing_Software/Homebrew/);
[the gphoto2 formula](https://formulae.brew.sh/formula/gphoto2) supplies libgphoto2.
Homebrew installation does not establish USB permissions. Use the distribution's
libgphoto2 USB/udev permissions for your logged-in user, reconnect after a rule
change, and close photo importers or other tethering clients. Run the server as
your ordinary user. A container additionally needs explicit USB device access;
host operation avoids that extra boundary. Do not assume a successful package
install proves Bazzite hardware access. Physical Linux acceptance remains pending.
`IRODORI_CAMERA_BACKEND=gphoto2` selects the CLI provider explicitly on macOS
for diagnosis; ImageCaptureCore is the verified Mac control path.

## MCP workflow

| Tool                              | Behavior                                                                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `irodori_camera_list`             | Cameras, backend availability/version diagnostics and retained settings recovery sessions.                                                                          |
| `irodori_camera_list_actions`     | Exact camera's actions, parameter schemas, settings, choices, current availability and evidence. Without a session it briefly opens and closes a read-only session. |
| `irodori_camera_open_session`     | Claim a discovered `cameraId`; optional `initialSettings` and explicit `recoverSessionId`. Returns `sessionId`.                                                     |
| `irodori_camera_execute_action`   | Validate an advertised action, accept a required `requestId`, and return `operationId`.                                                                             |
| `irodori_camera_get_operation`    | Progress, settings, original paths, byte counts, SHA-256, metadata, failures and restoration results.                                                               |
| `irodori_camera_cancel_operation` | Stop future work, finish an active shutter/download, retain results and restore touched settings.                                                                   |
| `irodori_camera_close_session`    | Stop pending work, restore touched settings and release the camera; report cleanup failures.                                                                        |

Use camera IDs from the current discovery. Backend aliases and USB addresses are
separate fields from physical identity. Same-model cameras retain different IDs
and exact routes. Serial-backed identity supports explicit recovery after a fresh
connection; connection-only identity never authorizes recovery on a replacement.
Linux additionally checks the USB device node's attachment identity before each
CLI command. No operation silently chooses the first camera.

### Discovery through restoration

These are MCP tool calls, not console commands. Replace placeholder IDs with
returned values. Setting strings below match the observed Sony macOS provider;
always use the current camera's advertised choices, including on Linux.

1. Call `irodori_camera_list` with `{}`. Inspect `diagnostics` and choose the exact
   intended camera from `cameras`; no attached camera is a valid discovery result.
   Call `irodori_camera_list_actions` before opening a persistent session:

   ```json
   { "cameraId": "<camera-id>" }
   ```

   Save the initial settings and inspect each action's availability, parameter
   schema, writable controls and evidence. Unavailable controls need physical
   setup or a revised recipe, not guessed values.

2. Call `irodori_camera_open_session`:

   ```json
   { "cameraId": "<camera-id>" }
   ```

   Retain its `sessionId` and `settings`. In an SDK/script, put all subsequent
   work inside `try/finally` and call `irodori_camera_close_session` in `finally`.
   An optional `initialSettings` object applies supported settings during opening;
   separate configuration operations make changing mode-dependent choices clearer.

3. Establish manual, single-frame operation with `irodori_camera_execute_action`:

   ```json
   {
     "sessionId": "<session-id>",
     "action": "apply-settings",
     "parameters": { "settings": { "exposureMode": "Manual", "driveMode": "Single" } },
     "requestId": "texture-setup-001"
   }
   ```

   Poll `irodori_camera_get_operation` with `{ "operationId": "<operation-id>" }`
   until this configuration completes. Reinspect `irodori_camera_list_actions`
   for the same camera: mode changes can change choices and writability. Apply
   the recipe's remaining supported settings with another distinct request ID,
   poll again and verify readback before capturing. Do not change a read-only
   save destination; ask for physical setup if it prevents the required transfer.

4. For one RAW/JPEG pair, call `irodori_camera_execute_action` after the subject
   is framed and focused:

   ```json
   {
     "sessionId": "<session-id>",
     "action": "capture",
     "parameters": {
       "settings": {
         "format": "RAW+JPEG",
         "iso": "100",
         "aperture": "f/4",
         "shutterSpeed": "1/100",
         "whiteBalance": "Daylight",
         "focusMode": "Manual"
       }
     },
     "requestId": "texture-pair-001"
   }
   ```

   Set RAW & JPEG PC transfer on the camera if needed. Use actual available
   settings suited to the lighting; the example is not a universal exposure.
   One shutter release should yield both unchanged companions.

5. Poll `irodori_camera_get_operation` with the returned `operationId`. While
   `state` is `queued` or `running`, wait briefly and poll the same ID. A completed
   capture requires `state: "completed"`, all expected `steps`, `complete` files,
   both RAW/JPEG companions, byte counts, SHA-256 and matching exposure metadata.
   `failed`, `cancelled`, `uncertain` and `interrupted` are terminal outcomes to
   inspect, not successful captures. Retain the operation ID on timeout and inspect
   it later; never repeat an uncertain shutter request under a new request ID.

6. To stop queued/running work, call `irodori_camera_cancel_operation` with the
   `operationId`. It waits for an in-flight shutter/download and reports restoration.
   An already completed operation still needs session close to restore settings.
   Always finish with `irodori_camera_close_session`:

   ```json
   { "sessionId": "<session-id>" }
   ```

   Check `closed`, `cleanupError` and every `restoration` entry. Successful outcomes
   are `restored`, `already-restored` or `unchanged`; retain and resolve any conflict/failure.
   Reinspect the exact camera's settings to compare with the saved baseline;
   automatic-mode readouts may legitimately change. Capture completion alone
   does not mean settings have been restored: ordinary successful operations
   keep the session's configuration until close.

The read-only settings action uses the same execution/polling flow:

```json
{
  "sessionId": "<session-id>",
  "action": "read-settings",
  "parameters": {},
  "requestId": "texture-settings-001"
}
```

For card inventory, use `action: "read-card-inventory"`, empty `parameters` and a
different request ID with the same tool. An unavailable inventory is an explicit
result, not proof of card preservation.

Supply `sessionId` and a unique `requestId` alongside each action. Discover actual
string choices before writing; they depend on provider, camera and mode. Invalid
tools/parameters are rejected at the boundary; camera-dependent failures are
retained in the returned operation. Poll until terminal. An accepted operation ID
does not mean a shutter release or successful capture.

Capabilities separately report `advertised`, `read`, `writeReadback` and `capture`.
These are bounded session/operation evidence, not certification of every enum
choice. Settings are reinspected after changes and before every exposure. Sony
acknowledges writes before applying them: the provider polls actual readback for
up to five seconds, and journals each settled aperture notch. Native burst and
bracketing remain unavailable, including while setting drive mode; software
captures require Single. Autofocus mode selection is verified; autofocus
acquisition/photographic focus quality is not certified.

### Three-exposure software sequence

Use a static scene containing bright and dark detail, fixed lighting and a tripod
or other firm support. Complete steps 1–3 above and establish fixed aperture, ISO,
white balance, focus and RAW/JPEG transfer. After a suitable middle exposure is
chosen, submit one `irodori_camera_execute_action` call:

```json
{
  "sessionId": "<session-id>",
  "action": "exposure-sequence",
  "parameters": {
    "steps": [{ "shutterSpeed": "1/200" }, { "shutterSpeed": "1/100" }, { "shutterSpeed": "1/50" }]
  },
  "requestId": "static-bracket-001"
}
```

These are three separate software shutter releases at −1/0/+1 EV relative to
1/100, not native camera bracketing or one trigger group. Use advertised choices
around the actual middle exposure. Poll to completion, verify three ordered
RAW/JPEG pairs and their read-back shutters/metadata, then close and check
restoration as above. Do not use this sequence to certify native BRK grouping,
burst timing, or subject-motion alignment.

### Controlled high-ISO texture comparison

Use a static, nonpersonal subject with fine fabric, low-contrast texture, neutral
patches, shadows and edges. Keep framing, focal length, support, focus, aperture,
white balance and lighting fixed. Focus before switching to Manual; that setting
does not focus the lens. Avoid moving people, screens, flickering light and clipped
highlights. Record in-camera noise-reduction settings; request physical adjustment
only when required by the validation and unavailable in the capability response.

For an ISO comparison at fixed incident exposure, choose a fixed shutter and aperture
that avoid clipping at the highest ISO. After configuring them through the full
workflow above, a bounded example is:

```json
{
  "sessionId": "<session-id>",
  "action": "exposure-sequence",
  "parameters": { "steps": [{ "iso": "100" }, { "iso": "3200" }, { "iso": "12800" }] },
  "requestId": "texture-iso-001"
}
```

Choose only available ISO values needed by the test. This keeps incident exposure
fixed while rendered brightness changes. A comparison at matched brightness is a
different declared protocol: shorten shutter proportionally as ISO increases and
record both values per step; it also changes photon exposure and motion blur.
Do not mix those protocols or treat an ISO-100 frame as noise-free ground truth.
Collect repeated frames only when the metric requires them, within the 32-step
limit, and record the exact order and frame count before starting. Poll and verify
every pair's ISO/shutter/aperture metadata, close and inspect restoration. Compare
native-size texture and chroma patches with frozen processing settings; acquisition
does not itself establish strong-noise photographic quality or acceptance.

## Ownership, originals and recovery

One camera-service instance owns the host broker while it has sessions, enforced
by a SQLite transaction in the user's temporary directory. SQLite releases the
lease after a crash. Within that service, different cameras can have sessions;
each camera's operations, inspection, restoration and close are serialized.
The broker deliberately excludes other service instances even when they use
another checkout. Third-party applications remain outside this cooperative lock;
backend busy/access errors and restoration comparisons handle that boundary.

Journals are retained under ignored `artifacts/camera/sessions/`. Each touched
setting records its original, last applied, intended and pending values before
mutation. Close, cancellation, failure and orderly stdio EOF/SIGINT/SIGTERM restore
touched values with readback. Shutdown waits for an in-flight capture/download.
External changes, unavailable originals, disconnects and failed restoration are
reported and retained instead of being overwritten. A crash cannot run cleanup.
After a disconnect, close the invalid old session, rediscover and open a new
session. Pass its old `recoverSessionId` only to restore a journal on the same
serial-identified camera. Conflicts require inspecting the retained journal and
choosing the setting on the camera; recovery never forces an external value.

Use a fresh request ID for each intended operation, including repeated executions
of the examples. Capture request IDs are durable across restart. Reusing the same ID returns its
existing operation; different parameters or another live physical camera reject
the reuse. A shutter attempt is journalled **before** provider entry. Interrupted
or timed-out attempts remain uncertain and are never retried automatically.
Do not replace the request ID merely to retry an uncertain shutter release.

Originals stay in unique `artifacts/camera/operations/<id>/exposure-N/` directories,
with camera filenames and hashes. The operation's `manifest.json` records requested
and read-back settings, provider identity, metadata and partial results. RAW/JPEG
companions are drained together; missing companions leave an uncertain result.
Native PTP downloads preserve received data bytes; originals are never decoded,
re-encoded or imported into the library. The CLI always passes **`--keep`**:
[gphoto2 otherwise removes downloaded card copies by default](https://gphoto.sourceforge.io/doc/manual/ref-gphoto2-cli.html).
The native transport exposes no DeleteObject command. Neither provider exposes
shell arguments, formatting, firmware, uploads or card deletion through MCP.
The CLI uses fixed argument arrays, an allowlisted environment and an empty
application-owned gphoto configuration, excluding inherited hooks and settings.
Subprocess duration and output are bounded.

Card inventory is read-only and bounded. An unavailable card is reported
explicitly; matching names and sizes alone do not prove every card byte. Captures
are private ignored artifacts. Before promoting any as reproducible fixtures,
follow [asset licensing, provenance and privacy review](../assets/README.md),
including embedded preview and EXIF/XMP/IPTC inspection. No photographs were added
to the repository for this feature.

Fixture promotion also requires applicable permission for testing/benchmarking
and GitHub redistribution. Keep approved original bytes unchanged under
`assets/tests/images/`, with SHA-256, provenance/permission evidence, the validation
goal, requested/read-back settings and complete sequence order. Inspect every
image and embedded preview and all metadata before adding it to Git; replace
unsafe inputs rather than editing their originals. Verify the exact files are
tracked in the benchmark's commit. A successful capture or ignored local manifest
alone does not meet those requirements.

## Verification and local evidence

The three registered **Node** targets use fake providers and subprocesses, with
no Electron, USB access or photographic inputs:

```sh
npm run verify -- --target camera-control-model --target camera-control-service --target camera-control-mcp
```

They cover same-model routing, dynamic/read-only choices, schemas, bounded
processes, competing services, durable deduplication, paired originals, partial
downloads, cancellation, interrupted shutter attempts, recovery conflicts,
reconnection, delayed Sony writes, button cleanup, and real SDK stdio/in-memory
MCP clients. The earlier Electron startup fix and its tests remain intact.
The MCP target also checks npm startup from the root and a subdirectory, a
relocated minimal checkout with spaces using the installed dependencies, direct
launch from an unrelated directory, all seven tools, read-only discovery with a
simulated unavailable backend, and checkout-local artifact paths. It takes no photographs.

Hardware acceptance is always separate and explicitly invoked:

```sh
npm run camera:acceptance
npm run camera:acceptance -- --inspect --serial <exact-USB-serial>
npm run camera:acceptance -- --controls --serial <exact-USB-serial>
npm run camera:acceptance -- --run --serial <exact-USB-serial>
```

The first command only discovers. `--inspect` reads controls. `--controls` changes
and restores settings without shooting. `--run` changes settings, captures one
RAW/JPEG pair and a three-exposure sequence, verifies metadata/hashes, cancels
further work, reads available card inventory, and checks restoration. Keep the
camera aimed at an appropriate private test subject. Evidence is written to a
unique ignored `artifacts/camera/acceptance/` directory; failures retain artifacts.

On 2026-10-30, the connected **Sony ZV-1A**, USB **054c:0c44**, firmware **1.00**,
passed MCP capture and restoration on macOS through ImageCaptureCore. gphoto2
**2.5.32** / libgphoto2 **2.5.34** were installed for discovery/CLI investigation;
the CLI was not a successful control backend on this Mac.

| Control/workflow      | Observed result                                                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exposure program      | Program → Manual with delayed readback; restored Program.                                                                                          |
| ISO                   | 12800 → 80 → 12800; captured at ISO 100; restored 12800.                                                                                           |
| Aperture              | f/4 → f/1.8 through individual notches; restored f/4.                                                                                              |
| White balance         | Auto → Daylight → Auto.                                                                                                                            |
| Focus mode            | AF-S → AF-C → AF-S; capture used Manual temporarily.                                                                                               |
| Shutter/exposure      | RAW+JPEG at 1/100; separate sequence at 1/200, 1/100, 1/50; original metadata matches.                                                             |
| Save destination      | Reported PC Only, read-only; remote write did not apply. Kept read-only and unchanged.                                                             |
| Exposure compensation | Available in Program; no writable choices in Manual.                                                                                               |
| Drive / bracketing    | Single read; native burst/bracketing remain unverified and unavailable.                                                                            |
| Cancellation          | Cancelled a queued sequence before a shutter release; restored touched settings. Active-pair cancellation has fake-provider coverage.              |
| Physical reconnection | User unplugged/reconnected USB; fresh discovery/session and subsequent capture workflow passed. Active unplug during a shutter remains unverified. |

The final hardware run passed in **44.97 seconds**:
`artifacts/camera/acceptance/2026-10-30T09-03-53.151Z-5b9059cd-1a24-4777-97f0-d14c3868687a/evidence.json`.
It contains four RAW/JPEG pairs, eight original files, matching hashes, settings
and ISO/exposure metadata. Early timing probes and the corrective restoration are
retained separately; they are not passing evidence. Automatic aperture/shutter
readouts may change after restoring an automatic exposure program. Close reports
`already-restored` after cancellation; it does not write those readouts again or
misreport them as conflicts. The card inventory request returned Store Not Available
in this PC Remote session. Card byte comparison remains unavailable; PC Only
stayed unchanged, and no deletion commands were sent.

The original camera-control checkpoint had **27** camera-specific
fake-provider/process/MCP tests passing in **1.9 seconds**.
The registered target selection also runs the repository's cheap Node checks;
its macOS run had **762 passes, no failures and 52 existing Linux-only skips**
in **28.2 seconds**. Type checking, lint and formatting passed. The runner reports
**incomplete (exit 2)** for those platform skips; it is not a comprehensive pass.
Evidence:
`artifacts/verification/2026-10-30T09-10-18.396Z-check-VfpRV2/summary.md`.

The portable-registration follow-up took no photographs. All **29** camera tests
passed; the selected runner took **29.47 seconds**, with type checking, lint and
formatting passing. Three unrelated loopback harness cases blocked by sandbox
`EPERM` passed on an exact-case rerun outside the sandbox; **52** Linux-only skips
still leave overall verification incomplete. TOML/Git checks, Codex discovery in
this trusted checkout, relocated SDK startup with spaces, helper-path checks and
documentation checks are recorded in
`artifacts/verification/camera-registration-final-Qf7sjU/summary.md`. Relocated
tests shared installed dependencies. Fresh dependency installation, client refresh
and Codex startup after trusting a new relocated checkout were not exercised.

Physical Bazzite acceptance, complete card-byte comparison, sustained disconnect
during an active capture, autofocus quality, native burst/bracketing and other
camera models remain explicit limits. This is development camera control,
not production camera or photographic-quality certification.

## Protocol references

The native transport is newly written Swift using Apple's
[ImageCaptureCore PTP API](https://developer.apple.com/documentation/imagecapturecore/iccameradevice).
Sony wire constants, field layouts, handshake phases and mode-2 notch behavior
were cross-checked against LGPL-2.1-or-later
[libgphoto2 v2.5.34](https://github.com/gphoto/libgphoto2/tree/v2.5.34/camlibs/ptp2)
(`ptp.h`, `ptp.c`, `ptp-pack.c`, `config.c`, `library.c`). No libgphoto2 source or
binary is bundled by this feature. The Linux provider invokes the separately
installed gphoto2 CLI. Apple's framework and SDK remain system dependencies.
