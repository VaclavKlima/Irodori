---
name: irodori-github-tasks
description: Create, deduplicate, prioritize and maintain GitHub Issues for Irodori from requests or raw notes, and track bounded issue delivery. Use for Irodori backlog and task-management requests or work on a selected issue; do not turn unrelated discussion into tasks.
---

# Irodori GitHub tasks

Bind all task operations to **VaclavKlima/Irodori**. Check the repository before
writing; a similarly named repository or the current GitHub account is not a
substitute. Read the repository's `AGENTS.md` and
[task policy](../../../docs/task-management.md). GitHub owns task scope, priority
and completion; repository briefs own technical contracts, decisions and evidence.

Use the connected GitHub tools. Discover their current schemas rather than
assuming label, project, dependency or sub-issue capabilities. Type, Workflow and
Priority live in the body; native open/closed state owns completion. If connector
writes fail, diagnose its repository installation and permissions. Respect a
user's connector preference; do not silently switch clients.

## Turn notes into tasks

For "create tasks from this text" or "add this to the backlog":

1. Extract intended outcomes and acceptance, then inspect the relevant briefs.
   Separate delivered portions, remaining work, optional proposals and research.
   Scale the issue to one useful bounded outcome.
2. Search both open and closed issues by meaning, affected feature and provenance.
   Read promising matches and comments before deciding. Extend an existing owner
   when the note adds requirements; link independent outcomes rather than duplicating
   ownership. A closed task's new requirement can need a focused follow-up rather
   than reopening its already delivered scope.
3. Create or update directly when the request authorizes task management. Use the
   [issue template](references/issue-template.md), preserving user wording where
   it defines product behavior. Ask only when an ambiguity materially changes
   scope, acceptance or a product decision; do useful independent work meanwhile.
   Do not turn a speculative example into an accepted implementation.
4. Read back each saved issue, including its body, state and actual links, and
   return verified URLs. An attempted mutation is not a saved result.

For a timeout or uncertain creation response, search open and closed records for
the exact stable marker/provenance and inspect recent records to account for
search-index delay. Read a found record before retrying. Persist the returned
number immediately. If existence remains uncertain, stop that creation and
report the resumption condition; do not blindly retry.

## Select and deliver one issue

For "what should we do next", inspect current priorities, dependencies, comments,
available device and effort stops. Recommend one actionable bounded deliverable.
Preserve **masking → native-detail inspection → HDR visual assessment** before
additional stylistic effects unless the user changes priority. Optional research,
missing calibration equipment and other-device checks are not universal blockers.

For "work on this issue", fetch the issue and comments, establish the deliverable,
acceptance, device and stopping condition, then set **Workflow: in progress**.
Follow repository implementation and focused verification rules. Task-management
authorization alone does not authorize feature coding, code publication, merging
or adoption of speculative proposals; an explicit implementation request does
authorize the selected implementation.

Record meaningful progress, decisions, exact scoped evidence and remaining work
compactly. A blocker needs a concrete reason and resumption condition. Preserve
other people's comments and requirements; refetch before replacing a body that
may have changed.

- **backlog:** available work, not started.
- **in progress:** the selected deliverable is being worked on.
- **blocked:** an unmet dependency prevents this deliverable; link it and say what
  permits resumption.
- **deferred:** intentionally postponed, including optional research and explicit
  effort stops; preserve why and what would reopen the decision.
- **awaiting delivery:** locally accepted work whose required publication or
  integration has not reached the default branch.

Close as completed only when the scoped acceptance passes and required code/docs
are verified on the repository's current default branch. Local checks, a commit,
an open PR or queued CI alone do not establish delivery. Remove the open Workflow
field on closure. Historical completed migration records retain their original
scope and verification; do not rerun them merely to recreate history.

Current-device delivery may close its scoped issue after that device's acceptance
and publication. Create or update a linked, clearly named other-device follow-up
with platform/hardware, focused targets, expected behavior, gaps and resumption
condition. A failure on the available device must be fixed before enabling that
affected behavior; unavailable checks remain incomplete.

## Reshape and migrate

For split, merge or defer, retain original provenance and decisions, move each
remaining requirement to an explicit owner and link replacements in both
directions. Close superseded/rejected issues with the appropriate non-completion
reason and explanation; never present supersession as implemented acceptance.

For the one-time legacy migration or its resumption, read
[the migration procedure](references/migration.md). Historical TODO numbers are
not GitHub issue numbers; use the frozen manifest and document context.
