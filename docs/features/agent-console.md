# Codex photo console

Backlog [#52](README.md#task-52) is an independent console/MCP deliverable. Codex
is the first supported agent. Other providers and native-detail image tools are
separate work. This feature makes no photo-settings or catalog schema migration.

## Using the console

Open Console and choose **Connect Codex**. Irodori discovers an installed Codex
executable; **Choose Codex executable** offers a native file picker when setup
fails. The initially supported CLI is **0.166.0**. Other versions are refused
until their configuration and tool defaults have been reviewed and tested.

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
Unsupported editing, native-detail inspection and communication requests must
explain the missing capability and end the turn. Development launches also
request one concrete Irodori feature suggestion in the conversation. They do
not create files, tickets, messages or workaround jobs. Production omits those
development suggestions.

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
Requests needing those unavailable capabilities must pause with an explanation.

## Verification and limitations

Registered targets are `agent-policy` (fast request ownership), `agent-session`
(native PTY and actual CLI configuration), `agent-console` (Electron/MCP) and
`agent-photo-preview` (real photographic raster/RAW and generated authored-HDR
reference). `editor-mcp` preserves ordinary external clients. `sunflower-fidelity`
checks the existing composition; `workspace-recovery` checks height persistence
and older workspace documents. Native terminal focus/paste and compositor
captures explicitly require foreground mode. Test profiles and photographic
imports are isolated from user libraries.

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
