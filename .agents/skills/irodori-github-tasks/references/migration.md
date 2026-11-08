# Legacy migration and safe resumption

Use [the migration audit](../../../../docs/task-migration/README.md),
[manifest](../../../../docs/task-migration/manifest.json) and
[frozen inventory](../../../../docs/task-migration/source-inventory.json).
They are immutable cutover records, not a second live backlog.

1. Read the source commit and complete entries, including continuation paragraphs,
   shared evidence, dependencies, rejected candidates and effort stops. Inspect
   additional repository TODOs, future briefs and acceptance checklists; classify
   requirements to existing owners, explicit additional outcomes, historical
   counterparts, superseded plans or third-party exclusions.
2. Maintain a many-to-many mapping with a stable marker per output, independent of
   title. One task may split, overlapping requirements may share an issue. Preserve
   all completed records as historical closed issues without re-verification.
3. Discover existing open and closed issues before mutation. Compare exact markers
   and semantic matches; never infer future issue numbers. Persist every returned
   URL/number and reconcile fresh body/comments before updates.
4. Publish through the connector. After an uncertain result, locate and read the
   saved record before retrying; use recent records as well as search. If lookup
   cannot resolve it, leave that creation pending and stop retries. Populate
   dependencies and related work with actual numbers after destinations exist.
5. Fetch every output by number and compare saved body, state, provenance and
   links against the intended content. Check all source entries and additional
   requirements have owners. Rerun discovery and require zero duplicate markers.
   Convert relative specification links to absolute GitHub URLs. Ignored local
   artifact paths stay labeled local; do not fabricate downloadable evidence.
6. Replace duplicated status/backlog lists only after coverage and readback pass.
   Preserve old section and `task-N` anchors with a static legacy-reference map.
   Resolve bare historical numbers in document context: old merge TODO 29 in
   workability/handoff documents corresponds to legacy 31, not today's deletion
   task. Never globally rewrite bare `#N`.
7. Keep Markdown authoritative until the audit passes and replacement links are
   verified on the default branch. Local-only work stays open awaiting delivery.
   Close migration and skill issues separately after their own acceptance and
   default-branch delivery, then read their saved states back.

The deterministic [audit helper](../scripts/audit-migration.py) checks the frozen
inventory, manifest and optional readback snapshot. Run it against a JSON list of
issues fetched through the connector (normalized `issue_number/url` or GitHub
`number/html_url` fields are accepted). The saved snapshot belongs under ignored
`artifacts/`; it is not committed as a second backlog.
