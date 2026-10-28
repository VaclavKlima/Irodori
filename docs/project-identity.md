# Public naming research

**Decision: Irodori, with the tagline Personal photo editing.** Selected by the
owner on 2026-10-28. Application branding is prepared in the isolated worktree;
the primary checkout and GitHub repository still use Luma while another session
is running. The existing photo-editor overlap and incomplete registry checks
remain documented below. The selection does not establish name clearance.

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

**Recommendation: rename the existing repository to `VaclavKlima/Irodori` after
the concurrent session's work and this branch have been safely integrated.**
Keep the existing repository so its history and collaboration records remain
together. [GitHub's rename documentation](https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository)
describes redirects for normal repository URLs and Git operations. GitHub Pages
URLs and uses of a repository as a published Action need separate handling.

The remote URL and primary checkout directory remain unchanged during the
concurrent session. After an authorized repository rename, update the shared
`origin` URL, check linked worktrees and external integrations, and move the
local checkout directory only when no session or process depends on its old
path. No repository has been renamed or created by this implementation.

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
Desktop launch, visual acceptance, packaged application naming, and client MCP
integration were not selected in this isolated run and remain unverified.

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
integration and the documented registry gaps; the name decision is settled.

Merge this isolated branch only when the concurrent checkout's work can be
preserved and checked. Repository renaming and local-directory changes remain
separate follow-up actions after integration. No GitHub repository or local
primary checkout has been renamed.
