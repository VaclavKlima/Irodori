# Codex photo console

Backlog [#52](README.md#task-52) is an independent console/MCP deliverable. Codex
is the first supported agent. Other providers remain separate work. [Flexible detail inspection](detail-inspection.md)
extends the shared preview tools. This feature makes no photo-settings or catalog schema migration.

## Using the console

Open Console and choose **Connect Codex**. Irodori discovers an installed Codex
executable; **Choose Codex executable** offers a native file picker when setup
fails. Stable patch releases in the reviewed **0.166.x** and **0.167.x** families
are accepted automatically when the strict startup configuration check passes.
Other minor or major versions, prereleases and malformed version strings are
refused until their configuration and tool defaults have been reviewed and tested.

Sign in through Codex inside this console. When it emits its authentication
hyperlink, **Open sign-in** opens that exact link in the system browser and
**Copy sign-in link** copies it. The xterm hyperlink uses the same main-owned
validation. Only an emitted OpenAI authentication link with unique parameters
and a local CLI callback is allowed; ordinary browser windows remain blocked.
The dedicated `agent/codex` directory
under Irodori's user-data directory owns its authentication and conversations.
Irodori never copies credentials, API keys, instructions or conversation data
from the coding profile and implements no separate OAuth flow.

Review and trust Irodori's hooks using Codex's normal `/hooks` flow before the
first photo request. The application does not bypass hook trust. Without a
trusted prompt hook there is no authorized photo request. See the
[official hook documentation](https://learn.chatgpt.com/docs/hooks).

Drag the divider above Console to resize it. Arrow Up/Down adjusts the focused
divider (Shift makes larger steps); Home/End selects the bounds. Escape cancels
a drag and double-click restores the responsive default. The chosen height is
a workspace preference retained across panel/workspace changes and restart; it
clamps in smaller windows while preserving photograph and panel space. It does
not enter photo settings or edit history.

One terminal, worker and conversation survive closing Console and switching
Editor/Library. **Stop** interrupts the current turn. **New conversation** fences
old requests, interrupts the old process, waits for accepted application calls
to settle and starts with fresh context. Already accepted exports and edit-paste
jobs retain their task lifecycle. After application restart, **Resume
conversation** and **New conversation** wait for an explicit choice; no agent
starts automatically. Reconnect continues the recorded conversation when one
exists. A new conversation does not erase the dedicated profile's old transcripts.

Supported requested edits apply directly and share ordinary photo-wide
Undo/Redo. The console is a photo assistant, with no general command runner.
Selecting terminal text copies it to the clipboard when the mouse is released.
Ctrl+C copies selected text; with no selection it interrupts the running turn.
Copy/paste uses bounded, session-specific main-process operations.
Unsupported requests explain the missing capability. Independent, authorized
editing can continue; a failed local edit must not silently become a global
substitute. The agent makes a concrete relevant feature suggestion in the
conversation, including production use. It does not create files, tickets,
messages or workaround jobs. The [editing workflow](agent-editing-workflow.md)
records the photographic strategy, on-demand guidance and evaluation status.

## Instance, request and tool ownership

The packaged `out/main/editor-mcp.js` stdio server uses the bundled Node runtime
and existing authenticated local editing endpoint. Its managed connection has
an instance-specific credential and exact port; it never falls back to another
profile's connection file. A normal application launch needs neither a global
Codex MCP registration nor the development debugging endpoint. See the
[official MCP configuration documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

The `UserPromptSubmit` hook freezes the active photograph, complete selection,
workspace and confirmed revisions. Selection uses the existing bounded paging
size in `irodori_get_editor_context`. The renderer's edit owner flushes valid
pending drafts before revision capture. An unfinished crop requires Apply or
Cancel and resubmission. Navigation after capture cannot retarget the request.
Every managed tool call must include the newly issued `requestId`; the endpoint
checks its targets independently of model instructions.

A shared allowlist exposes context, supported edits/analysis/history,
copy/paste, [named presets](named-presets.md), previews, existing export authorization and owned task results or
cancellation. Structural collection/merge management and unrelated task control
are outside this first console surface. The ordinary external editing MCP
retains its existing tools and adds context and compact previews.

Preset capture/reference/application photo IDs remain inside the request's frozen
targets. Create/update expose validated optional scenario icons and named colors;
list/get include the marker. The agent chooses a marker from requested intent on
creation, such as Sunset/Amber for Golden Hour, and preserves it during updates
unless asked to change it. Appearance-only edits need no photo and create no
photo history. Preset revisions are independent of photo-edit revisions. An explicit
user instruction authorizes deletion of the identified preset without another
prompt. Otherwise the agent must identify its exact name/ID, ask in Console and
wait for agreement; listing, creating or applying presets grants no deletion
permission. The server validates identity and revision rather than inferring
conversational consent. Live-model permission acceptance remains unverified when
an authenticated isolated client is unavailable; see the preset brief.

Each startup checks the CLI version, strict configuration parsing and effective
configuration. Irodori writes its restrictions to `irodori-policy.toml` and applies
the same session overrides to strict preflight and terminal startup. Codex keeps normal hook-trust state in its base
`config.toml`; reconnect and New conversation preserve it. Only the enumerated
Irodori MCP tools are preapproved for direct requested edits. Shell escalation
remains unavailable. The dedicated workspace uses a read-only execution sandbox,
never approves escalation and disables command execution, browser/computer
control, image/file inspection, plugins, unrelated servers, memory and
delegation. Built-in file editing cannot write through the read-only sandbox;
a secondary `PreToolUse` hook denies all tools except the exact Irodori
allowlist with the current prompt's identity. A missing restriction refuses
startup. These hooks supplement the sandbox and transport ownership checks.
No hook-trust bypass is used.

The existing edit service still checks revisions atomically. One conflict can
be refreshed and retried once; a repeated manual conflict pauses the request.
New conversations and shutdown revoke credentials before retiring the worker.
The node-pty native module lives only in a bundled-Node child process. The
renderer receives session IDs, text and dimensions, never executable paths or
arbitrary IPC. Terminal input/paste, output/replay and xterm scrollback are
bounded; output pressure pauses the PTY until the renderer acknowledges parsing.
All owned process groups are retired on close or worker failure.

## Compact photo previews

The calls below remain the legacy default. Optional [inspection](detail-inspection.md)
adds grid-bound regions, native percentage resolution, PNG/JPEG encoding and
matched neutral Before/After, with explicit HDR capability reporting.

`irodori_get_photo_preview(photoId, expectedRevision)` returns a standard MCP
image block and metadata: photo ID, confirmed revision, rendering identity,
dimensions, encoded bytes and color space. It is the **complete edited and
cropped photograph**, independent of viewport zoom/pan.

The frozen policy is a maximum 1024-pixel long edge, JPEG quality 80, no
enlargement, at most 1 MiB encoded bytes and no personal EXIF/XMP/IPTC metadata.
It is labelled **sRGB SDR rendition**, including for authored HDR and scene-linear
RAW sources. The source preparation cache, GPU rendition/crop/Lanczos3 resize
and isolated export encoder are shared with exports. Source leases, live
resource admission and bounded encoded-cache byte accounting remain in force.
The revision is checked before processing and immediately before publication.
Import thumbnails, camera JPEG substitutes and full-resolution originals are
never returned by this tool.

The renderer inventory counts shared source-cache ownership once. Those sources
remain fully charged in each frozen presentation admission, including retained
leases and submitted-work fences; the presenter's own inventory excludes that
shared portion. Browsing multiple RAW photographs must not create a duplicate
reservation that blocks an otherwise valid compact preview. Memory limits,
rendering quality and explicit refusal of genuinely insufficient budgets remain
unchanged.

These images support composition and broad tone/color assessment. They do not
establish native-detail sharpness/noise quality or physical HDR luminance.
Use the extended inspection API for native SDR detail. Strict HDR visual requests
remain unavailable until client qualification.

## Verification and limitations

Registered targets are `agent-policy` (fast request ownership), `agent-session`
(native PTY and actual CLI configuration), `agent-console` (Electron/MCP) and
`agent-photo-preview` (real photographic raster/RAW and generated authored-HDR
reference). `editor-mcp` preserves ordinary external clients. `sunflower-fidelity`
checks the existing composition; `workspace-recovery` checks height persistence
and older workspace documents. Native terminal focus/paste and compositor
captures explicitly require foreground mode. Test profiles and photographic
imports are isolated from user libraries.

The [raster preview recovery record](console-preview-recovery.md) documents #101:
auxiliary editing demand is bound to its primary source so an older retained
preview cannot cancel a newer full-resolution request or leave Crop unavailable.

The authenticated live edit/Undo/Redo and missing editing/communication capability
exercises use a dedicated sign-in and are recorded separately from the
stand-in CLI transport/lifecycle tests. macOS and Windows verification are
unavailable on this Bazzite host; no cross-platform acceptance is claimed.

Focused acceptance results follow. Existing failed
runs remain under ignored `artifacts/verification/` with their diagnostic reruns.

### Local automated evidence — November 4, 2026

The [acceptance record](../../artifacts/verification/agent-console-acceptance-2026-11-04/summary.md)
combines focused background checks, explicit foreground completions and bounded
authenticated exercises. The latest background selection passes **905 cases**
with no failures in **70.01 seconds**, including static checks and the height,
session and workspace cases. Its two deferred native cases pass separately:
terminal links, clipboard paste, focus and resizing at 1100 × 700, and Sunflower
minimum/large composition. The background invocation retains its incomplete/exit-2
status; the acceptance record links both foreground results.

The earlier preview and ordinary MCP results remain applicable. Raster, Sony RAW
and authored-HDR compact images match ordinary exports
byte-for-byte at the same edits/crop/options, reuse prepared sources and leave
source and managed-original hashes unchanged. Setup and source-image manifests
remain committed; generated evidence stays ignored.

The user completed isolated sign-in and trusted all four hooks through Codex.
A resumed live conversation requested one compact preview and changed only
exposure by +0.25 EV; UI Undo/Redo passed and Undo left the photograph neutral.
The managed original remained byte-identical. A development request for automatic
sky masking and email explained both unavailable capabilities, suggested an
Irodori feature and ended. The production counterpart omitted development
suggestions and ended with unchanged settings/history and no jobs. Restart waited
for an explicit conversation choice. Normal hook trust survived reconnect and
New conversation.

Live setup also exposed blocked terminal links and overwritten hook-trust state.
The final controls open/copy only the exact emitted authentication link, and the
generated policy preserves Codex's base configuration. Focused regression tests
and the production authenticated exercise cover those fixes. Verification is on
Bazzite Linux x64 with Codex 0.166.0; no other CLI version or operating system is
qualified by this record.

### Budget and clipboard follow-up — November 4, 2026

A real conversation exposed duplicate shared-source accounting after browsing
RAWs. The corrected frozen-plan inventory counts retained source-cache bytes once,
while preserving admission limits and fences. A two-RAW regression now requests
the actual MCP preview and asserts complete bounded output, the live inventory,
unchanged originals/history and unchanged 2 GiB memory preference.

Releasing a terminal selection now copies its plain text. Native verification
covers unchanged clipboard while dragging, selection copy, Ctrl+C copy versus
interruption, stale-session rejection, paste and the minimum resized layout.
See the [selection contract](../input-design.md#console-text-selection).

The [follow-up acceptance record](../../artifacts/verification/agent-preview-budget-2026-11-04/summary.md)
contains 907 distinct passing focused cases, final static checks, the read-only
successful preview of the affected real photograph and the reopened window's
retained conversation choice. Historical failed runs are preserved. Tests use
the existing 120-second managed Console/HTTP deadline instead of the SDK's
60-second default; production timeouts and performance gates are unchanged.
Final RAW cases pass in 8–12 seconds, without a new performance qualification.

## Output proofs — November 7, 2026

`irodori_get_output_proof` shares Custom export's [Output preview](output-proof.md)
service. Use an owned export preparation, an authorized frozen photo ID, full
validated export options and a distinct UUID `proofToken`, in addition to the
current managed `requestId`. The proof uses the actual encoded/decoded JPEG,
including output sizing and compression, without a destination or preference and
history writes.

The image response is a clearly labelled SDR overview of the decoded JPEG primary,
with its own dimensions (longest edge at most 1024) and payload at most 1 MiB.
Noisy overviews can use a smaller edge to meet that limit; the full output's size
and quality remain unchanged. Full-resolution/HDR inspection belongs to the
dialog. Full proof assets are released before returning the response. Existing
`irodori_get_photo_preview` behavior remains unchanged.

Focused protocol tests cover both editing MCP and the managed Console request
gate, including foreign preparations, outside targets and ended requests. A live
signed-in Console client was not exercised. Restart Irodori and Resume/New Console
to load the updated tool registration in an existing session.

## Export-only output sharpening

The Console uses the same output-sharpening controls as Custom export:
`off`, `low`, `standard` and `high`. `irodori_get_export_capabilities` reports
the available modes, default Off, operator version and processing stage. If the
user requests output sharpening without specifying a strength, the assistant
starts with Standard. An omitted setting preserves Off, including older requests.
Output sharpening changes no saved detail controls or photo history.

The assistant reads export preferences, prepares the frozen request targets and
passes `outputSharpening` in the full Custom export/proof options. A proof needs
no destination or preference write. The subsequent export uses the same explicit
strength and pixel options, together with an existing application-authorized
destination. Quick export presets keep sharpening Off; accepted Custom exports
retain the choice in Last custom.

Proof metadata identifies the effective strength and frozen output-sharpening
policy. Retained export results expose `outputSharpening` and
`outputSharpeningVersion`, so the assistant can confirm what was accepted and
report per-file success or failure. Frozen request IDs, target revisions,
preparation ownership and task ownership retain their existing checks; this adds
no tools, filesystem access or permissions.

The assistant still receives only a bounded SDR overview. It can apply a
supported strength and report tool evidence, but that overview does not establish
native sharpness, halos, noise or HDR appearance. Those judgments belong to
Custom export's Output preview at 100%. The `export-proof-mcp` target exercises
managed and standalone discovery, proof settings, export/result readback,
legacy omission, invalid modes and existing authorization fences with isolated
service renderers; GPU pixels are covered by the separate output-sharpening
rendering checks. A live signed-in model conversation requires its own acceptance.
Restart Irodori and Resume/New Console to refresh existing tool registration.

## Codex version compatibility — November 7, 2026

The installed Codex 0.167.0 passes the existing strict configuration preflight
without sign-in or a model request. It joins 0.166.0 in the explicit reviewed
version list. The generated restrictions and normal hook-trust flow are unchanged;
other versions still require review. Unsupported-version errors now include the
detected version and all reviewed versions.

The [focused acceptance record](../../artifacts/verification/codex-0.167-compatibility-2026-11-07/summary.md)
retains 941 passing cases across the background batch and its exact native
foreground follow-up. Coverage includes both reviewed version strings, refusal of
unreviewed/prerelease builds, failed shell/hook restrictions, installed-CLI
configuration and preserved hook trust, PTY lifecycle, managed tools, and native
terminal focus/paste/resize at minimum size. Static checks and the production build
pass. This is Bazzite evidence; a signed-in 0.167.0 model conversation and other
operating systems were not exercised.

## Codex patch compatibility — November 12, 2026

[Issue #108](https://github.com/VaclavKlima/Irodori/issues/108) replaces the exact
patch-version allowlist with the stable **0.166.x** and **0.167.x** families.
Routine patch updates within those families no longer require another allowlist
entry. Every connection still requires strict configuration parsing and the
effective photo-tool restrictions; a failed check refuses startup. Dedicated
sign-in, normal hook trust, frozen request targets and the restricted tool set
remain required.

This acceptance is bounded to the reviewed release families. Configuration
validation does not establish compatibility with newly introduced tools or a new
minor or major release. It runs without sign-in or a model request, so signed-in
model behavior and other operating systems require separate verification.

Bazzite/Linux x64 acceptance passes with installed **codex-cli 0.167.2**, Node
26.13.1 and the existing isolated-profile fixture. The `agent-session` and
`agent-policy` selection passes **1,044 cases in 57.33 seconds**, with no skipped
or incomplete cases; type checking, lint, formatting and the production build
also pass. Tests cover compatible patches, unsupported/malformed releases,
unsafe effective restrictions, refusal before terminal startup, ordinary PTY
lifecycle and preservation of normal hook-trust configuration. Local receipt:
`artifacts/verification/2026-11-12T13-47-57.229Z-check-piFXix/summary.md`.
This is configuration/lifecycle acceptance without an authenticated model turn.
[Issue #109](https://github.com/VaclavKlima/Irodori/issues/109) retains macOS and
Windows qualification. Delivery is tracked in #108.

## Linear and radial mask gradients — issue #84

The shared mask mutation tool accepts an optional complete `gradient` on atomic
`create` and `update` operations. Linear geometry is
`{kind:"linear", start:{x,y}, end:{x,y}}`; coverage fades from full strength at
start to zero at end. Radial geometry is
`{kind:"radial", center:{x,y}, radiusX, radiusY, rotation, feather}` and initially
selects the inside. Radii are normalized independently to the full oriented
source width/height, rotation is in degrees (-180–180), and Feather is an integer
percent (0–100, UI default 50). Endpoint/center coordinates are -1–2, radii are
at most 2, and endpoint separation and both radial semiaxes require at least one
actual source pixel. Updates replace the entire gradient geometry. Duplicates
retain geometry and manual corrections.

`irodori_get_mask_context` keeps ordinary brush mapping at 0–1. The optional
`allowOutsidePhoto:true` admits -1–2 output positions for gradient handles, then
applies the exact crop/lens/flip mapping. Unsupported canonical coordinates are
refused instead of clamped. Returned width/height describe the cropped output;
canonical dimensions describe the full oriented source. Never reuse extended
points as brush strokes, whose validation remains 0–1.

Each mask has one analytic gradient or one generated object base. Object
refinement refuses gradient masks before source decoding or inference. Coverage
composition is gradient/base, ordered Paint/Erase corrections, inversion,
Expand/Contract, then whole-mask Feather. Local Light and Color consume this
coverage once. Mutations retain the Console's frozen targets and expected photo
revision; neutral gradient creation still receives source-geometry admission.
Settings 17/catalog 27 preserve settings-16 Color/edge values, history snapshots,
immutable content, older presets and accepted frozen jobs. See the
[gradient implementation brief](mask-gradients.md) for interaction and current
device acceptance.
