# Issue body

Use this structure when useful; shorten it for a small task. Do not leave template
placeholders in saved issues. Keep only established hard dependencies under
Dependencies; use Related work for coordination.

```markdown
<!-- irodori-task:<stable-id> -->

Type: bug / improvement / verification / architecture / documentation / research
Workflow: backlog
Priority: P1 / P2 / P3 / unranked

## Outcome

Problem, intended behavior and one bounded deliverable. Distinguish delivered
behavior from what remains. State a research or adoption gate explicitly.

## Acceptance

- Observable requirements, failure/recovery behavior and stopping condition.
- Relevant shared UI/API/MCP, history, output or resource requirements.

## Dependencies and related work

Explicit GitHub issue URLs with their relationship. Use linked checklists only
when one outcome actually needs several issues.

## Briefs and evidence

Absolute GitHub URLs for specifications, preferably current default-branch files.
Pin provenance to an immutable source commit. Describe ignored artifacts as local
evidence paths, not downloadable GitHub proof.

## Verification and limits

Affected registered targets or documentation checks, source/hardware scope,
known gaps, deferred checks and effort stops. No invented passes.

## Provenance

Original request/context, legacy numbers with their document context, or a stable
migration marker. Preserve decisions when an issue is reshaped.
```

Priority P1/P2/P3 records the existing masking/native-detail/HDR sequence. Other
work stays unranked unless the user or established issue gives it a priority.
Native issue state owns completion; Workflow applies only while open.

For a compact progress update use: demonstrated behavior/decision; checks and
device; remaining work; next action or resumption condition. Keep local evidence,
remote checks and default-branch delivery distinct.
