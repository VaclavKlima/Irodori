# Shutdown and save recovery

Window Close, application Quit and development stopping share the serialized
coordinator in [shutdown.ts](../src/main/shutdown.ts). Repeated requests join the
current attempt, including an open recovery dialog. The historical macOS orphaned
development session observed on 2026-10-14 is the motivation for TODO #25; its original cause remains
unconfirmed. The regressions inject failures deterministically.

## Saving and recovery choices

An edit flush has one token and one original renderer document/frame. Main accepts
only its matching acknowledgement. The production deadline remains **10 seconds**.
Destruction, renderer process loss and a main-frame document navigation end an
obsolete wait immediately; old replies are ignored and listeners are removed.
Same-document and child-frame navigation do not invalidate the request. These
events follow Electron's [webContents lifecycle contract](https://www.electronjs.org/docs/latest/api/web-contents).
Preload invokes listeners through a promise so synchronous throws produce explicit
save errors too.

Successful saving, a reported save error and an unknown save status are distinct.
A missing acknowledgement says saving could not be confirmed; it does not claim
that the disk failed. A main-process native dialog provides:

- **Keep open**, the default and Escape/cancel action, cancels shutdown and restores
  admission. Console stays connected and application services remain open.
- **Retry saving**, when a live, loaded editor remains available, sends a fresh
  token and repeats saving.
- **Quit anyway** warns that unconfirmed recent changes may be lost, then follows
  the same orderly library drain and cleanup as successful saving.

New task starts and agent submissions are paused during a shutdown attempt.
Renderer flush writes and already accepted work remain allowed. After successful
saving or explicit Quit anyway, mutation admission is sealed. A final workspace
checkpoint is attempted while its renderer document is available. If it cannot
respond, the latest durable workspace checkpoint is retained; this cannot recover
uncommitted local renderer drafts.

## Library ownership and cleanup

The library owns an entry-to-completion admission barrier for edits, Undo/Redo,
the queued lens tail, workspace checkpoints and group mutations. Validation and
scheduler admission are part of that ownership. Sealing rejects new mutations;
nested work belonging to an accepted entry can finish. Task creation that awaits
a flush or other asynchronous preparation is also owned through its acceptance.

Accepted entries drain with the renderer's resource-reply handlers and processing
dependencies still available. Existing task owners then cancel and drain
background work, edit applications, import acceptance and exports. An in-flight
system Trash call must settle before removal cleanup continues. Removal journals,
recoverable bundles and completed publications retain their existing recovery
rules. There is no permanent-deletion fallback.

All publishers settle before the catalog writer closes. Its `close()` waits for
the actual worker thread exit before the read connection closes. The renderer is
destroyed after accepted operations no longer need it. Each remaining cleanup
step is attempted even if another fails; errors are reported and the application
exits with status 1 after cleanup. No generic force-kill deadline bypasses writes
or Trash operations. A permanently stalled external operation can therefore keep
shutdown pending.

## Development launcher

`npm run dev` and its `dev:mcp` alias retain electron-vite. Before starting Vite,
the launcher creates an ephemeral loopback listener with a random per-launch
token. Unpackaged Electron main registers its instance and PID over a persistent
authenticated connection. The channel admits only registration, shutdown
requests, development loss and shutdown outcomes. It is not exposed by preload,
the Console or photo MCP. Main removes the inherited connection credentials
before starting its workers.

SIGINT/SIGTERM received by the launcher request orderly application shutdown.
Vite stays alive while saving, recovery or cleanup is pending. Keep open cancels
the stop request. Repeated signals do not escalate to killing the application.
Signals during startup wait for application registration.

Unexpected Vite exit or loss of the supervisor connection enters recovery once.
Keep open retains the window and explains that development has ended and reload
may be unavailable. Retiring and replacement instances remain tracked until
their actual PIDs disappear. A socket close or a `closing` outcome does not prove
process exit. On Unix, a process-group inventory also protects Electron processes
that have started but not registered. Only after applications have disappeared
may the launcher clean up remaining descendants. Unexpected Vite failure remains
an unsuccessful launcher exit.

Electron main installs **no application SIGTERM override**. Automatic main-code
hot restarts retain electron-vite's existing behavior and are outside this
deliverable, as are OS forced termination, power loss and the historical incident's
root-cause diagnosis.

## Verification

The registered targets are `shutdown-model` (fast Node model/flush/preload cases),
`shutdown-library` (real catalog worker and held library boundaries),
`development-launcher` (real launcher with isolated process fixtures),
`shutdown-ui` (automated Electron recovery and process exit) and the explicit-only
`development-stop-native` foreground acceptance. They cover stale replies,
silence, explicit and synchronous errors, crash/reload/unresponsiveness, Retry,
Keep open, repeated requests, held validation/publication, queued lens and history
operations, groups, Trash, cleanup failure, launcher signals, connection/Vite
loss, replacement instances and descendant cleanup.

The native case starts real `npm run dev` with a shared-bootstrap isolated profile.
It waits for one physical **Keep open** choice, verifies cancellation preserves
Electron and Vite, then requests stopping again and asserts Electron, Vite,
supervisor and npm exit before fixture teardown. Run it when ready to interact:

```sh
IRODORI_NATIVE_DIALOG_MANUAL=1 npm run verify -- --foreground --target development-stop-native
```

Without explicit foreground/manual opt-in, selecting this target defers the case
and reports incomplete verification. It is excluded from automatic selections.
This Bazzite desktop did not expose the native recovery action to the attempted
AT-SPI/X11 drivers; their unsuccessful evidence and sources remain in ignored
verification artifacts. No automated native-widget pass is claimed. The automated
model and Electron tests inject dialog choices deterministically. Foreground
evidence on Bazzite is separate from unverified macOS and Windows behavior. Tests
never import into a user library.

### Bazzite acceptance — 2026-11-05

The final background invocation passed **926 cases with no failures or skips** in
**103.89 seconds**, including type checking, lint, formatting and build. It selected
`shutdown-model`, `shutdown-library`, `shutdown-ui` and `development-launcher`:
911 fast Node cases, eight library/service cases and seven hidden Electron cases.
See the [automated report](../artifacts/verification/2026-11-05T20-47-54.285Z-check-MdlpvJ/summary.md).
The routine 60-second budget warning remains; deliberate production-deadline cases
retain their full 10-second waits and no assertions were cut short.

The real development/native-dialog check separately passed in **40.71 seconds**.
The physical Keep open choice preserved Electron and Vite; the subsequent stop
exited Electron, Vite, the supervisor and npm with status 0 before fixture teardown.
SQLite integrity also passed. Its native action is manual, not an automated-widget
pass. The tested case was subsequently extracted into `development-stop-native`.
The [acceptance summary](../artifacts/verification/shutdown-acceptance-fjqiko5k/summary.md)
links actual process-exit evidence, retained unsuccessful attempts and reused
catalog, deletion, edit-transfer, workspace and export regressions. One existing
workspace pointer-interaction timeout passed its exact isolated rerun. The stale
schema-17 recovery assertion was corrected to verify that recovery preserves the
current catalog version; its focused rerun and the full selected service batch pass.

These results cover Bazzite 45 on the local Wayland desktop with isolated profiles.
macOS and Windows remain unverified. This is a focused feature acceptance, not a
comprehensive application checkpoint or a performance benchmark.
