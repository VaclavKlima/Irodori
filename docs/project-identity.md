# Public naming research

**Research snapshot: 2026-10-28. Replacement name remains open.** Luma stays the
working application and repository name. The current direction is a natural
two-word name involving **Flash**, with a clear connection to photographs and
quick personal editing. No rebrand, domain purchase, or repository rename is
part of this research delivery.

## Naming brief

The name should suit an approachable personal photo editor: open a photograph,
make common adjustments, and move on. It should communicate speed and ease,
remain easy to pronounce in English, and be memorable without an elaborate
origin story. A meaningful combination of familiar words, like Lightroom,
is the current direction. This describes the naming and product feel; it does
not change the application's implemented capabilities or feature roadmap.

Keep the complete spelling compact and readable in an application menu. Avoid
names that imply an unrelated AI-generation service, camera-only capture,
professional complexity, or a single editing operation. Compare recognizable
use in photography and software before recommending public adoption.

## Assessment of Luma

**Recommendation: retain Luma during development, but resolve public branding
before a broad release.** It is short, readable, and connected to image
brightness. It is also crowded in the exact creative-software area this
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

## Current Flash comparison

These are creative naming assessments, not a claim that any name is cleared.
The three leading concepts are followed by two screened-out comparisons.

| Name          | Construction and intended meaning                                                                | Observed use and assessment                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Flashroll** | Flash + film roll. Two familiar photography words; suggests quick work on a personal collection. | Strongest photographic fit of the current concepts. [An existing public repository](https://github.com/joris-klingen/flashroll) describes a piano-training VST with this name; another exact repository also exists. Both `.com` and `.app` are registered. Keep as a creative candidate, with software/trademark clearance outstanding.                                                                                     |
| **Flashleaf** | Flash + album leaf. Suggests personal photographs and a small, approachable editing workspace.   | No exact repository name was returned in the inspected first GitHub search page, but an [App Store flashcard listing](https://apps.apple.com/jp/app/id6771019215) uses FlashLeaf in its subscription/version text. Its `.com` is registered; the website redirected to an Atom domain-sale page whose content returned HTTP 403. Registry `.app` and `.photo` queries returned 404, which does not establish purchasability. |
| **Flashlane** | Flash + lane. Suggests a fast, straightforward editing path.                                     | An existing [desktop USB/ISO flasher](https://ritualdev.in/open-source/) already uses FlashLane, and another exact GitHub project concerns streaming. The software-name collision weakens a public-brand recommendation despite the appealing sound. `.com` is registered; `.app` and `.photo` returned registry 404.                                                                                                        |
| **Flashroom** | Flash + room. A personal photographic workspace with a familiar compound structure.              | Exclude from the shortlist: an existing [Flashroom photo-booth app](https://apps.apple.com/us/app/flashroom-retro-photo-booth/id6813983439) is directly in the Photo & Video category. `.com` and `.app` are registered.                                                                                                                                                                                                     |
| **Flashpad**  | Flash + pad. A lightweight personal workspace.                                                   | Exclude from the shortlist: [Flashpad](https://flashpad.cc/) already identifies cross-platform note-taking software, and many exact GitHub names were returned. `.com` and `.app` are registered.                                                                                                                                                                                                                            |

**Provisional creative recommendation: Flashroll.** It best connects ordinary
English pronunciation with photographs and speed. Flashleaf is the softer
alternative, with a potentially useful `.app` lookup result but a known unrelated
application use. Flashlane's existing desktop-software name is a meaningful
drawback. Final naming remains under discussion; none of these candidates is a
confirmed public brand.

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
The complete 18-query snapshot for the working name and current comparison is
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

The Luma assessment and initial source-backed comparison are recorded. Backlog
#22 remains open while a satisfactory replacement recommendation is refined
and the registry gaps above remain explicit. Selecting or applying a new name
is separate from documenting the options.

A later rebrand must account for application/repository identity, existing
library and user-data locations, protocol identifiers and development tooling.
It must not silently create a second user library. No such implementation change
is made by this research snapshot.
