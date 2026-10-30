# Project identity

**Irodori — Personal photo editing.** The project owner selected this name and
requested complete adoption across the application on 2026-10-28. The existing
GitHub repository is `VaclavKlima/Irodori`. Original source and documentation use
Apache-2.0, subject to the [documented exceptions](licensing.md).

## Application and developer interfaces

Use Irodori for the product name and profile directory, `irodori` for package,
bridge and MCP names, and `IRODORI_` / `VITE_IRODORI_` for application environment
variables. The photograph scheme is `irodori-photo`. Native helpers, source
folders and bundled runtime files use the same name. Numeric native protocol
layouts stay unchanged; their fixed-width headers use the `IROD` abbreviation.

The product direction is [Irodori.md](../Irodori.md). The authoritative editing
plan remains [professional editing](features/professional-editing.md); naming does
not complete its unfinished photographic, platform or performance acceptance.

## Existing installations

The normal profile is `~/.config/Irodori` on Linux. Explicit isolated test profiles
always take priority. A one-time profile migration preserves originals and edits,
updates application-owned references and uses the new directory. Retain migration
evidence outside version control. Native helpers and renderer/worker bundles must
be rebuilt and checked together after interface renaming.

The checkout is `/var/home/KolegaDragan/Development/Irodori`. The existing Git
history and uncommitted editing work are retained. Package/bridge/MCP names,
source folders, native/WASM entry points, application environment variables and
managed URL references now use the current namespace.

The migration command accepts explicit absolute paths and records a database
backup, sidecar backups and an original-file identity inventory before changing
application-owned references:

```sh
node scripts/migrate-profile.mjs --from /absolute/previous-profile --to /absolute/Irodori --evidence /absolute/migration-evidence
```

Close the application before migration. The command refuses an existing target,
a live profile or a cross-filesystem move. It preserves arbitrary user metadata,
originals, durable masters and edit history. Retired disposable caches stay in the
evidence directory. The workstation migration preserved all 195 originals and
identical edit-history and processing rows; it did not import into or launch
automated tests against the user library.

## Local verification — 2026-10-28

The [adoption evidence](../artifacts/irodori-rename/20261028T171959Z/summary.md)
records the source snapshot, native/WASM rebuilds, profile preservation and
focused verification. Tests use isolated hidden profiles and small generated
images. This does not complete RAW/HDR photographic, native input, performance
or packaged-release acceptance. The macOS codec retains identical executable
code and has a verified ad-hoc signature structure; execution on macOS remains
unverified in this Linux session.

The research below is retained as a dated record. Selection and technical
adoption do not establish trademark or registry clearance.

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

## Selected name: Irodori

**Status: selected by the owner.** The chosen presentation is **Irodori**, with
**Personal photo editing** as a separate tagline. No second word is part of the
application name.

**Meaning:** Japanese 彩り (いろどり, approximately "ee-roh-doh-ree") refers to
coloring, an arrangement of colors, or figuratively adding interest and charm.
The [Shogakukan dictionary entry](https://kotobank.jp/word/%E5%BD%A9%E3%82%8A-436757)
supports those meanings. That connection suits photographic editing. The name
has seven letters and four syllables, giving it a real meaning without an
invented blend.

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

Before adoption, an authenticated GitHub search for
`user:VaclavKlima Irodori in:name` returned no repositories on 2026-10-28. The
existing project has since been renamed to `VaclavKlima/Irodori`. Irodori has not
received the domain or trademark checks documented for the earlier candidates
below. The existing photo-editor overlap remains a public-brand concern.

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

| Name      | `.com`     | `.app`     | `.photo`  | Existing exact name under `VaclavKlima`  |
| --------- | ---------- | ---------- | --------- | ---------------------------------------- |
| Flashroll | Registered | Registered | No record | Not found in authenticated scoped search |
| Flashleaf | Registered | No record  | No record | Not found in authenticated scoped search |
| Flashlane | Registered | No record  | No record | Not found in authenticated scoped search |
| Flashroom | Registered | Registered | No record | Not found in authenticated scoped search |
| Flashpad  | Registered | Registered | No record | Not found in authenticated scoped search |

Registry endpoints were selected from the [IANA RDAP bootstrap](https://data.iana.org/rdap/dns.json):
[Verisign `.com`](https://rdap.verisign.com/com/v1/domain/flashroll.com),
[Google Registry `.app`](https://pubapi.registry.google/rdap/domain/flashleaf.app),
and [the `.photo` registry](https://rdap.nic.photo/domain/flashleaf.photo).
The registry query snapshot for the earlier comparison is
retained under ignored `artifacts/project-setup-20261028/domains/`.

Website behavior was recorded separately. `flashroll.app` failed DNS resolution in both the initial lookup and the
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

| Official channel                                                                                                     | What was established                                                                                         | Remaining limitation                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [USPTO Trademark Search](https://trademarksearch.uspto.gov/) and indexed official documents                          | Indexed exact-name searches for Flashroll, Flashleaf and Flashlane did not return matching official records. | The interactive search could not be read reliably. No current-status, complete exact/similar-name, phonetic or goods/services clearance was completed for the replacements. An indexed non-result is not a registry no-match. |
| [EU TMview](https://www.tmdn.org/tmview/)                                                                            | The official application was reached.                                                                        | It returned no readable result data. EU exact/similar-name searches remain incomplete.                                                                                                                                        |
| [Czech Industrial Property Office](https://upv.gov.cz/en/information-sources/national-databases/trademark-databases) | Its database guidance and official search entry were inspected.                                              | The search entry redirected to an inaccessible application. No Czech registry result set was obtained. The office itself notes limitations in imported data and translations.                                                 |
| [WIPO Global Brand Database](https://branddb.wipo.int/)                                                              | The official entry was reached.                                                                              | A verification challenge prevented obtaining results. No claim is made about international registrations or their territorial effects.                                                                                        |

Before final public branding, inspect live exact and similar marks, their current
status, owners, jurisdictions and actual goods/services; review phonetic and
spelling variants as well. A domain lookup, a company-name record or a matching
class number alone cannot decide whether a name can be used. This report does
not establish legal clearance or trademark registrability.
