# Native RAW startup and row-thread retirement

[Issue #94](https://github.com/VaclavKlima/Irodori/issues/94) owns the native RAW
startup defect discovered during Bazzite masking qualification. The original
failed invocation remains retained; successful reruns do not rewrite it as a pass.

## Reproduced cause

The packaged application initially reported only that its native decoder did not
close successfully. A bounded direct probe of the unchanged shipped helper and
committed `tests/fixtures/sony-zv1.ARW` reproduced the failure on launch eight:
exit code 1, no signal or timeout, and no sensor output. Stderr identified the
first post-join thread-count check:

```text
Native RAW source failed: The native RAW decoder retained row tasks after its join barrier.
```

The original bytes and pinned file identity remained unchanged. The
[reproduction receipt](../artifacts/research/raw-startup-94/extended-owned-rows-ki0rbosq/summary.md)
retains the exact child protocol, source, executable hash and failed launch.

Rust's scoped joins complete through `pthread_join`. Linux can clear and wake
that join's child-TID futex during `mm_release` before subsequent task removal
updates the thread count reported by `/proc/self/status`. An immediate count
check can therefore reject a completed decode. The relevant primary sources are
[Rust's pthread join](https://raw.githubusercontent.com/rust-lang/rust/1.99.0/library/std/src/sys/thread/unix.rs),
[glibc's child-TID wait](https://raw.githubusercontent.com/bminor/glibc/master/nptl/pthread_join_common.c),
[Linux 7.2 mm_release](https://raw.githubusercontent.com/torvalds/linux/v7.2/kernel/fork.c),
[task removal](https://raw.githubusercontent.com/torvalds/linux/v7.2/kernel/exit.c)
and [the proc thread-count reader](https://raw.githubusercontent.com/torvalds/linux/v7.2/fs/proc/array.c).
The glibc source explains the protocol; it is not an exact source certification
of the installed glibc build.

## Correction and preserved contracts

The host retains its actual scoped joins and separately observes retirement at
both existing publication gates. It polls at one-millisecond intervals for at
most one second, accepting observations only from one through eight and returning
only the exact final count of one. Invalid counts, read errors and observations
at or after the deadline fail explicitly. The final trailer still reports one
thread. A wait does not repeat the decoder or row computation.

The pinned LibRaw bridge, Sony row arithmetic, source mapping/identity, original
bytes, resource ceilings, parent-death guard, exact start/EOF handshake and actual
child-close/source-release barriers remain unchanged. The native build snapshots
the retirement module alongside its other source inputs.

Main retains at most 8 KiB of native stderr and records actual exit code, signal
and stderr for an unexpected failed close. These details remain in the privileged
process/worker path; renderer errors expose the exit status without native stderr.
Successful children omit failure diagnostics, and expected cancellation preserves
its existing drainage behavior. The packaged test retains a bounded main stderr
attachment so a later failure remains diagnosable.

## Focused verification

The registered `native-raw-retirement` target is explicit-only and compiles the
standalone Rust module's deterministic tests without LibRaw or a GPU. They cover
an already retired worker, two/eight threads settling to one, persistent tasks,
invalid counts, failed observations and a late successful observation beyond the
deadline.

`native-raw-source`, `native-raw-owner-lifecycle`, `native-raw-pipe`,
`native-raw-executable` and `native-raw-preparation` retain protocol, failure-only
diagnostics, EOF/close ordering, source leases, cancellation and resource checks.
The exact foreground `desktop-package` case exercises the original Sony RAW
through offline packaged startup, masking, frozen output and restart.

On Bazzite 45.20261105 / Linux 7.2.15 x64, the
[focused foreground run](../artifacts/verification/2026-11-10T09-26-39.573Z-check-r022Xy/summary.md)
passes **1013 checks, zero failures/skips, 88.97 seconds**, including type checking,
lint, formatting and build. The retirement wrapper executes seven deterministic
Rust cases. The actual packaged case passes in 32.18 seconds on the original
Radeon 610M process selection, with Mesa 26.2.6, Electron 44.3.0 and bundled
Node 24.20.0. The routine-budget warning is retained; its required packaged
workflow and common checks account for the elapsed time.

The [post-fix native probe](../artifacts/research/raw-startup-94/post-fix-owned-rows-2tj4hj0d/summary.md)
passes **128 consecutive fixed launches in 8.54 seconds**, after obtaining one
successful packet from the preserved original helper. Every launch reaches real
EOF and child close with code zero, no signal, complete production framing and
one final thread. Sensor SHA-256
`ec29cae44a859a805b1be56d9cc23320cdd935d9bb1da2d5376e7d8c6231b1ad`
and opened/unpacked/source-layout metadata match that baseline exactly. Original
SHA-256 `14c9d2912584a3ccc5cf10f554fbe495fc960c36758a14d7d858b36ac5ca88e2`
and pinned identity remain unchanged.

The final [native build manifest](../artifacts/native-raw-source-build/build-Gsy1cq/build-manifest.json)
records binary SHA-256
`d0636eefa2b74d28843b6bb877146bc78726a958be73c416dd958c5f23ede987`
and the unchanged pinned bridge/row sources. The original binary/runtime and
packaged application remain under
`artifacts/research/raw-startup-94/baseline-before-fix/`; the original failing
qualification invocation is unchanged. Generated artifacts stay local and are
not downloadable GitHub proof. GitHub owns publication/completion state.

These receipts qualify the reproduced Linux-native startup defect and its
correction. They do not certify broader platforms, every camera/recording mode,
physical-memory peaks, HDR luminance or sustained performance.
