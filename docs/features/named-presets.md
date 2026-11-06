# Named editing presets

TODO [#46](README.md#task-46) adds local user-created presets. The **Presets**
tab sits between Geometry and Info, below the pinned histogram. The collection
starts empty. Bundled looks, sharing/import/export and hover previews remain
outside this version.

## Workflow

**New…** saves confirmed edits from the current photo with a name and explicit
groups. Defaults match Copy/Paste: Light, Curves, Saturation/Vibrance, Mixer,
Grading, Noise reduction and Sharpening. Crop, White balance and Lens corrections
require explicit opt-in; unsupported camera groups are disabled. Valid pending
edits flush through their existing owner; finish or cancel a crop first. Hidden
adjustment panels stay mounted.

Selecting a row only inspects it. **Included settings** shows its stored values
and revision. **Apply to current photo** and **Apply to selection** open the shared
application review, including the full hidden/unloaded selection count and known
incompatibilities. **Apply edits** accepts the frozen task. Each changed photo
receives one ordinary Undo/Redo step; unchanged photos receive none. Excluded
settings and destination processing identity remain destination-owned.

**Edit details…** changes the name, scenario icon and named color without needing
a photo. **Update…** replaces the definition from the current photo through the
same name/group/appearance chooser, retaining the current marker. **Delete…** identifies the
exact name and initially focuses Cancel. Management works without an active
photo; capture/update/current-photo application require one.

### Scenario icons and colors

New and Update include a live marker preview, a closed **Icon** disclosure and
nine named colors: Neutral, Amber, Orange, Red, Rose, Violet, Blue, Teal and Green.
The grouped icon chooser scrolls independently. Native radio controls support
arrow keys and Space; Escape within the icon chooser closes it and returns focus to its
summary before a second Escape cancels the dialog. Save and Cancel stay outside
the dialog body's scroll area at 1100 × 700 with Console open.

The 24 scenarios plus General describe the preset's intended use:

| Category             | Scenarios                                                                      |
| -------------------- | ------------------------------------------------------------------------------ |
| Light and weather    | Sunlight, Sunrise, Sunset, Backlight, Indoor, Night, Fog, Overcast, Rain, Snow |
| Subjects             | Portrait, Landscape, Street, Architecture, Macro, Food                         |
| Condition and intent | High noise, Soft photo / detail, Soft look / blur, Motion                      |
| Looks                | Cinematic, Vintage, Black and white, Vivid                                     |

Each row has one 16px colored icon and neutral surfaces. Selection/focus keep the
Sunflower outline. The preview uses 24px icons. Icons and colors have named
accessible labels; controls also show a checkmark for the chosen value. Existing
Lucide glyphs cover most scenarios; original matching High noise and Soft look
SVGs live under [application assets](../../assets/app/icons/presets/README.md).
These markers do not add processing effects or analyze photographs. Uploads,
arbitrary colors and automatic photo detection remain outside this version.

## Storage, collection and application

The catalog contains additive preset-store v2 tables (`preset_store`,
`edit_presets`). The dedicated catalog writer owns mutations. Startup validates
store versions and definitions before schema/migration/recovery writes and
preserves/refuses unsupported formats. Photo settings remain version 12; no
rendering algorithm changed. The v1 → v2 transaction supplies General/Neutral to
existing definitions, preserving IDs, revisions, timestamps, settings and the
collection revision. Failed migration writes roll back. Definition version 1
remains independent of the store version. Historical v2 application snapshots
without appearance remain readable and are never rewritten by this migration.

Definitions contain a stable UUID, unique trimmed name (1–100 characters),
independent revision, timestamps, appearance, settings version, included groups, complete
values and required compatibility facts. Names use a normalized case-insensitive
key for uniqueness/alphabetical ordering, with ID as tie breaker. Details/update
increment the preset revision; update/delete reject stale `expectedPresetRevision`.
Management creates no photo history.

Camera-dependent groups derive compatibility from verified managed-photo
metadata: a single-RAW white-balance profile identity and supported lens on/off
choices. Calibration tables, paths and source-photo dependencies are not stored.
Presets survive source deletion. Explicit definitions must provide every control
of every selected group; partial groups are rejected without default filling.
Camera-dependent explicit definitions require a verified reference photo.

The sidebar uses the shared continuous collection controller, resource policy,
60-record chunks and bounded search. A store revision protects count/order/chunk
reads. `presetsChanged` events coalesce refreshes after UI or MCP mutations.
Loading, empty, error and Retry states retain management. Arrow Up/Down and
Home/End navigate without applying. Selection, search and an ID/index/inset
anchor use shared workspace checkpoints; deleted selections clear after refresh.
Selection and keyboard reveal share the latest state to avoid lost updates.

Application reuses [selective transfer](copy-paste.md) without changing its
session clipboard. Preparation freezes the complete preset, destination IDs and
photo revisions. Accepted manifests v2 distinguish clipboard and preset snapshots;
v1 clipboard jobs remain readable. Later preset changes/deletion cannot alter
accepted jobs or applied history. Compatibility reporting, conflicts, atomic
history/result publication, resource bounds, cancellation and retained restart
results use the existing service. Unfinished edits are never replayed automatically.

## Typed API and MCP

| Application operation      | MCP tool                             |
| -------------------------- | ------------------------------------ |
| `listPresets`              | `irodori_list_presets`               |
| `getPreset`                | `irodori_get_preset`                 |
| `createPreset`             | `irodori_create_preset`              |
| `updatePreset`             | `irodori_update_preset`              |
| `deletePreset`             | `irodori_delete_preset`              |
| `preparePresetApplication` | `irodori_prepare_preset_application` |
| `startPresetApplication`   | `irodori_start_preset_application`   |
| `disposePresetPreparation` | `irodori_dispose_preset_preparation` |

Listing returns bounded summaries; inspection returns complete values.
Creation/update accepts confirmed-photo capture or explicit complete settings.
Both also accept optional `appearance: { icon, color }` using the IDs in
[`preset-appearance.ts`](../../src/shared/preset-appearance.ts). Each supplied
field is validated; omitted fields default to General/Neutral on creation and
retain their stored value on update. An appearance-only update needs no source
photo, uses the same preset revision checks, and emits the same collection event.
List/get return appearance. For example:

```json
{
  "name": "Golden Hour",
  "appearance": { "icon": "sunset", "color": "amber" },
  "source": {
    "mode": "explicit",
    "settingsVersion": 12,
    "groups": ["color"],
    "values": { "saturation": 5, "vibrance": 22 }
  }
}
```

Managed-agent instructions choose a suitable marker from the user's requested
intent on creation and preserve it on later updates unless asked to change it.
The restricted Console allowlist includes these tools. The request gate checks
source/reference/destination photo IDs against frozen targets, keeps preset and
photo revisions separate, and binds preparations to their operation and request.
Existing edit-application results and task-cancellation tools serve preset jobs.

Preset capture and explicit definitions expose a concrete object schema to agents.
Use `source: { mode: "photo", photoId, groups }` to capture confirmed edits, or
`source: { mode: "explicit", settingsVersion: 12, groups, values }` to save a
creative look without editing a photo. For example, `groups: ["color"]` requires
`values: { saturation: 5, vibrance: 22 }`. Explicit camera-dependent groups also
require `referencePhotoId`. Each included nested group exposes all required
controls/version fields; excluded group values are rejected. The managed Console
still requires its current hook-issued `requestId` on every tool call.

Managed-agent instructions and the deletion tool description require permission
for the identified preset. An explicit user instruction authorizes deletion
without another prompt. Otherwise the agent identifies its name/ID, asks in
Console and waits for agreement. Listing, creating or applying presets grants no
deletion permission. The server enforces exact identity/revision; it does not
claim to infer consent from conversation text.

## Verification boundary

Registered targets: `presets-model` (Node), `presets-service` and `presets-mcp`
(service), `presets-ui` (hidden Electron), and `presets-visual` (exclusive
foreground Electron). The [local acceptance record](../../artifacts/presets-acceptance/summary.md)
links bounded reports, failures and exact reruns. Coverage includes persistence,
both creation modes, complete groups, compatibility, stale revisions, source
independence, failed writes, frozen batches, hidden selection, Undo/Redo, no-ops,
cancellation/restart, clipboard preservation, recovery, keyboard/error/empty states
and native 1100 × 700 Console-open presentation.

Authenticated managed MCP transport checks exercise exact deletion and a
proposal/read followed by a later permission/deletion request. Deterministic
checks do not establish a model's conversational compliance. The previously
signed-in isolated Console profile is unavailable, so a live authenticated model
exercise of proposal → permission → deletion remains unverified. macOS/Windows
clients and processing-quality/performance acceptance are outside this evidence.

### Agent schema follow-up — November 6, 2026

A live request to create a Golden Hour look exposed an input-discovery failure:
the source-object union appeared as `unknown | unknown` in generated tool
declarations. The agent guessed `type`/`kind` and `settings` and both calls were
rejected. Source now has an explicit object type with `mode`, `settingsVersion`,
`groups` and `values`; shared field ownership and conditional schema rules
describe complete included groups. Runtime errors identify required/missing fields,
and managed-agent instructions show both supported creation forms.

The [follow-up record](../../artifacts/preset-schema-follow-up/summary.md)
retains the focused verification and live-client limit. The regression validates
create/update schemas with the MCP SDK, rejects the actual malformed request,
saves the corrected color/grading definition, and verifies unchanged photo
history and persistence. The isolated live client reached normal hook review;
its hooks were left untrusted, so that model creation check remains incomplete.
Restart the running application and resume Console to reload the updated tools.

### Appearance follow-up — November 6, 2026

The [appearance acceptance record](../../artifacts/preset-appearance/summary.md)
links the icon sheet, compact mockup, automated model/service/UI/MCP checks and
native Bazzite captures. Coverage includes partial appearance edits, invalid IDs,
stale revisions, old-store migration and rollback, unchanged historical sources,
keyboard choices/cancellation, restart, and expanded dialogs with Console open.
All nine colors exceed 3:1 against normal, hovered and selected neutral surfaces.
Live-model choice of a suitable marker remains unverified; the managed schema and
instructions are covered deterministically. Other platforms remain unverified.
