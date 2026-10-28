# Public naming research

**Decision: Irodori, with the tagline Personal photo editing.** Selected by the
owner on 2026-10-28. Application branding is integrated on `main`, and the
existing GitHub repository has been renamed to `VaclavKlima/Irodori`. The local
checkout folder remains named Luma for session continuity. The existing
photo-editor overlap and incomplete registry checks remain documented below.
The selection does not establish name clearance.

## Naming brief

The name should suit an approachable personal photo editor: open a photograph,
make common adjustments, and move on. It should communicate speed and ease,
remain easy to pronounce in English, and be memorable without an elaborate
origin story. Earlier directions explored combinations of familiar words, like
Lightroom; the selected name is the real Japanese word Irodori. This describes
the naming and product feel; it does not change the application's implemented
capabilities or feature roadmap.

Keep the complete spelling compact and readable in an application menu. Avoid
names that imply an unrelated AI-generation service, camera-only capture,
professional complexity, or a single editing operation. Compare recognizable
use in photography and software before recommending public adoption.

## Assessment of Luma

Luma was the previous working name. It is short, readable, and connected to image
brightness. Research found it crowded in the exact creative-software area this
application would enter:

| Observed use            | Source and implication                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Luma AI                 | Its [first-party image-editing description](https://lumalabs.ai/learning-hub/luma-image-capabilities-ai-image-editing-animation-workflows) covers image modification and creative workflows. The shared Luma name and editing/agent vocabulary create a substantial discoverability and association concern.                                                                              |
| LumaFusion / Luma Touch | The [publisher's App Store listing](https://apps.apple.com/us/app/lumafusion/id1062022008) identifies established video-editing software. It is an adjacent creative market, not evidence that Luma is an unused product name.                                                                                                                                                            |
| LumaBooth / LumaShare   | The [vendor site](https://www.lumabooth.com/) identifies camera and photo-booth software. This adds photographic-software overlap even though its workflow differs.                                                                                                                                                                                                                       |
| LUMA AI trademark lead  | An [official USPTO office action dated 2025-10-01](https://tmng-al.uspto.gov/resting2/api/casedoc/cms/case/98899654/office-action/OfficeAction7848575.pdf) reproduces LUMA AI registration 7792979, serial 98703191, including image-related software in classes 009 and 042. This is a concrete screening lead, not a determination of infringement or a verified current-status search. |
| Exact domains           | Registry RDAP returned domain objects for `luma.com`, `luma.app`, and `luma.photo`. All are registered. The existing `VaclavKlima/Luma` repository belongs to this project.                                                                                                                                                                                                               |

The conclusion about discoverability is an inference from these observed uses.
The term's relationship to luminance does not establish trademark freedom.

## Selected name: Irodori

**Status: selected by the owner.** The chosen presentation is **Irodori**, with
**Personal photo editing** as a separate tagline. No second word is part of the
application name.

**Meaning:** Japanese 彩り (いろどり, approximately "ee-roh-doh-ree") refers to
coloring, an arrangement of colors, or figuratively adding interest and charm.
The [Shogakukan dictionary entry](https://kotobank.jp/word/%E5%BD%A9%E3%82%8A-436757)
supports those meanings. That connection suits photographic editing. The name
has seven letters and four syllables, so it takes longer to say than Luma or
Figma, but it gives this proposal a real meaning without an invented blend.

**Existing photo-editor use:** [irodori - Color Pop Editor](https://apps.apple.com/us/app/irodori-color-pop-editor/id6776964361)
is already listed in the App Store by Ryogo Owashi. It edits photographs with
selective color, brightness, contrast, filters, and export. This is a direct
photo-editing overlap, making discoverability and mistaken association concerns
more concrete than an unrelated business with the same word. That assessment
is an inference from the listing, not a legal conclusion.

The owner selected the standalone name after the existing photo-editor use was
reported. Irodori Desk and Irodori Edit were considered as possible extensions;
neither is part of the selected presentation. A generic suffix would not itself
establish that the existing photo-editor overlap is resolved.

An authenticated GitHub search for `user:VaclavKlima Irodori in:name` returned no
repositories on 2026-10-28. This does not reserve the destination. Irodori has not
received the domain or trademark checks documented for the earlier candidates
below. The existing photo-editor overlap remains a public-brand concern.

## Repository and compatibility

**Completed on 2026-10-28: the existing repository is now
[`VaclavKlima/Irodori`](https://github.com/VaclavKlima/Irodori), with the description
Personal photo editing.** Its GitHub repository ID remains `1373470999`; no new
repository was created. History and collaboration records remain together.
[GitHub's rename documentation](https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository)
describes redirects for normal repository URLs and Git operations. GitHub Pages
URLs and uses of a repository as a published Action need separate handling.

The shared `origin` URL is now `git@github.com:VaclavKlima/Irodori.git` in both
linked worktrees. A lookup through the old `VaclavKlima/Luma` name resolves to
Irodori. The primary checkout directory remains named Luma so the paused session
can resume at its existing path. No local directory was moved. GitHub reported
no Pages site before the rename; external integrations beyond the verified
repository lookup and Git remote remain unverified.

The app display name, tagline, package metadata, interface text, and main
documentation adopt Irodori. The existing `Luma` profile directory remains the
default, and an explicit `--user-data-dir` retains priority. Both Electron
`userData` and `sessionData` are pinned before startup; photographs, histories,
settings, and the editor endpoint continue to use the same location. This uses
Electron's documented [application paths](https://www.electronjs.org/docs/latest/api/app#appgetpathname)
and [path overrides before readiness](https://www.electronjs.org/docs/latest/api/app#appsetpathname-path).

The `window.luma` bridge, `luma-photo` scheme, MCP `luma_*` tools, `LUMA_*`
configuration variables, native binary names, rendering identities, historical
evidence, and `Luma.md` product-direction path remain stable compatibility
identifiers. They do not require a data migration for this branding change.

### Local verification — 2026-10-28

`npm run verify -- --target app-identity` passed **669 tests in 32.10 seconds**,
including the runner's fast Node coverage, type checking, lint, and formatting.
The three identity cases verify preserved original/settings bytes at the legacy
profile path, explicit temporary-profile priority, and creation of a fresh
profile. Evidence is retained under
`artifacts/verification/2026-10-28T16-46-15.017Z-check-AVWKGT/summary.md`.

Four naming-document checks passed in 78 ms: Markdown formatting, local links,
the retained 18 domain records, and the five earlier scoped repository results.
Evidence is retained under
`artifacts/verification/project-naming-20261028T164820279Z-2/summary.md`.

Post-integration workspace verification passed the same 669 fast tests, static
checks, and application build. Five Electron cases initially failed because the
primary checkout's prebuilt CPU helper belonged to the paused session's newer
processing code. That evidence is retained in
`artifacts/verification/2026-10-28T16-57-31.488Z-check-bmiNBz/summary.md`.

A matching helper was built in the isolated worktree without replacing the
paused session's helper. The failed startup case then passed in 1.05 seconds;
the other four failed workspace cases passed in 30.3 seconds. Evidence is
retained under `artifacts/verification/branding-ui-NkMIZP/` and
`artifacts/verification/branding-workspace-E2zWeU/`. The five native Wayland
capture cases remain deferred; visual acceptance, packaged application naming,
and a particular client MCP connection remain unverified. A helper build and
these UI cases do not establish new numerical or performance acceptance.

The paused session's unfinished work was restored locally and left unstaged.
All 358 source paths were accounted for: 345 stayed byte-identical and 13
overlaps received only the naming/licensing adaptations. Three conflicts were
resolved without discarding catalog migration or editing test targets. The
restored checkout passed type checking. Only the completed naming/licensing
commits are included in the push; unfinished editing changes remain local.

## Earlier Flash comparison

These are creative naming assessments, not a claim that any name is cleared.
The three leading concepts are followed by two screened-out comparisons.

| Name          | Construction and intended meaning                                                                | Observed use and assessment                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Flashroll** | Flash + film roll. Two familiar photography words; suggests quick work on a personal collection. | Strongest photographic fit of the current concepts. [An existing public repository](https://github.com/joris-klingen/flashroll) describes a piano-training VST with this name; another exact repository also exists. Both `.com` and `.app` are registered. Keep as a creative candidate, with software/trademark clearance outstanding.                                                                                     |
| **Flashleaf** | Flash + album leaf. Suggests personal photographs and a small, approachable editing workspace.   | No exact repository name was returned in the inspected first GitHub search page, but an [App Store flashcard listing](https://apps.apple.com/jp/app/id6771019215) uses FlashLeaf in its subscription/version text. Its `.com` is registered; the website redirected to an Atom domain-sale page whose content returned HTTP 403. Registry `.app` and `.photo` queries returned 404, which does not establish purchasability. |
| **Flashlane** | Flash + lane. Suggests a fast, straightforward editing path.                                     | An existing [desktop USB/ISO flasher](https://ritualdev.in/open-source/) already uses FlashLane, and another exact GitHub project concerns streaming. The software-name collision weakens a public-brand recommendation despite the appealing sound. `.com` is registered; `.app` and `.photo` returned registry 404.                                                                                                        |
| **Flashroom** | Flash + room. A personal photographic workspace with a familiar compound structure.              | Exclude from the shortlist: an existing [Flashroom photo-booth app](https://apps.apple.com/us/app/flashroom-retro-photo-booth/id6813983439) is directly in the Photo & Video category. `.com` and `.app` are registered.                                                                                                                                                                                                     |
| **Flashpad**  | Flash + pad. A lightweight personal workspace.                                                   | Exclude from the shortlist: [Flashpad](https://flashpad.cc/) already identifies cross-platform note-taking software, and many exact GitHub names were returned. `.com` and `.app` are registered.                                                                                                                                                                                                                            |

**Earlier provisional creative recommendation: Flashroll.** It connects ordinary
English pronunciation with photographs and speed. Flashleaf is the softer
alternative, with a potentially useful `.app` lookup result but a known unrelated
application use. Flashlane's existing desktop-software name is a meaningful
drawback. These earlier candidates were not selected.

## Domain and repository checks

All results below were checked on **2026-10-28**. **Registered** means the
authoritative registry returned a domain object. **No record** means that
registry returned a structured HTTP 404 response. It does not mean the name is
available for registration: registry reservations, premium pricing, registrar
rules and later registrations were not tested.

| Name      | `.com`     | `.app`     | `.photo`   | Existing exact name under `VaclavKlima`  |
| --------- | ---------- | ---------- | ---------- | ---------------------------------------- |
| Luma      | Registered | Registered | Registered | Existing project                         |
| Flashroll | Registered | Registered | No record  | Not found in authenticated scoped search |
| Flashleaf | Registered | No record  | No record  | Not found in authenticated scoped search |
| Flashlane | Registered | No record  | No record  | Not found in authenticated scoped search |
| Flashroom | Registered | Registered | No record  | Not found in authenticated scoped search |
| Flashpad  | Registered | Registered | No record  | Not found in authenticated scoped search |

Registry endpoints were selected from the [IANA RDAP bootstrap](https://data.iana.org/rdap/dns.json):
[Verisign `.com`](https://rdap.verisign.com/com/v1/domain/flashroll.com),
[Google Registry `.app`](https://pubapi.registry.google/rdap/domain/flashleaf.app),
and [the `.photo` registry](https://rdap.nic.photo/domain/flashleaf.photo).
The complete 18-query snapshot for the previous working name and Flash comparison is
retained under ignored `artifacts/project-setup-20261028/domains/`.

Website behavior was recorded separately. `luma.com` returned HTTP 200 and
`luma.app` redirected to `luma.com/app`; `luma.photo` had a TLS-name failure.
`flashroll.app` failed DNS resolution in both the initial lookup and the
authorized retry despite its registry record. `flashlane.com` returned HTTP
200; the Flashleaf sale-page redirect returned 403. These responses establish
neither ownership by this project nor the absence of a registered domain.

GitHub checks used authenticated owner-scoped queries and public name searches.
The public comparison inspected the first 20 results per name, not all GitHub
repositories. The absence of a name under the owner does not reserve it, exclude
unseen/private projects, or guarantee that a create/rename operation will succeed.
Other owners may use the same repository basename. Current query evidence is
retained in ignored
`artifacts/project-setup-20261028/github/flash-name-search-results.json`.

## Preliminary trademark coverage

The intended screening territories are **the Czech Republic, the EU, and the
US**, with software and image-related goods/services as the focus. Exact-name
indexed searches are only a preliminary supplement to registry searches.

| Official channel                                                                                                     | What was established                                                                                                                                    | Remaining limitation                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [USPTO Trademark Search](https://trademarksearch.uspto.gov/) and indexed official documents                          | The concrete LUMA AI lead above was found. Indexed exact-name searches for Flashroll, Flashleaf and Flashlane did not return matching official records. | The interactive search could not be read reliably. No current-status, complete exact/similar-name, phonetic or goods/services clearance was completed for the replacements. An indexed non-result is not a registry no-match. |
| [EU TMview](https://www.tmdn.org/tmview/)                                                                            | The official application was reached.                                                                                                                   | It returned no readable result data. EU exact/similar-name searches remain incomplete.                                                                                                                                        |
| [Czech Industrial Property Office](https://upv.gov.cz/en/information-sources/national-databases/trademark-databases) | Its database guidance and official search entry were inspected.                                                                                         | The search entry redirected to an inaccessible application. No Czech registry result set was obtained. The office itself notes limitations in imported data and translations.                                                 |
| [WIPO Global Brand Database](https://branddb.wipo.int/)                                                              | The official entry was reached.                                                                                                                         | A verification challenge prevented obtaining results. No claim is made about international registrations or their territorial effects.                                                                                        |

Before final public branding, inspect live exact and similar marks, their current
status, owners, jurisdictions and actual goods/services; review phonetic and
spelling variants as well. A domain lookup, a company-name record or a matching
class number alone cannot decide whether a name can be used. This report does
not establish legal clearance or trademark registrability.

## Remaining work and completion boundary

The owner selected Irodori and the tagline Personal photo editing. The
implementation changes application branding while retaining the existing
library location and compatibility identifiers. Backlog #22 remains open for
the documented registry gaps; the name decision and integration are settled.

The repository rename is complete. Local-directory renaming remains deferred
while the existing session depends on that path. Its unfinished editing work
is preserved locally and must not be discarded when the session resumes.
