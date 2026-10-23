# Mask-only native CPU arithmetic

The normal CPU presentation renderer compiles the unchanged `bridge.cpp` and
unchanged output of `generate_math.py`, with its existing compiler flags. Mask
mode is a separate translation unit selected only by `--mask-v1` in the same
bounded Rust executable. `--capabilities` describes the embedded build identity.

The mask arithmetic reference is Electron 44.3.0, Chromium 152.0.7977.78, and V8
15.2.124.19-electron.0. Electron's exact DEPS pins Chromium; Chromium's exact
`third_party/llvm-libc/README.chromium` pins LLVM libc revision
`3ea89f4304312567e31a8eb45e0737577e65b676`. The exact V8 `base/ieee754.cc`
delegates `atan2` to `LIBC_NAMESPACE::shared::atan2`. The local upstream inventory
retains those source snapshots and the complete Linux x86_64 include closure,
with original URLs, byte lengths and SHA-256 values. These are the Chromium
embedder's pins; the standalone V8 DEPS pin is retained only as provenance.

`prepare-mask.py` checks every local inventory entry before deriving the mask
translation unit. It requires exactly one generated ACES
`atan2(Aab[2], Aab[1])` call, changes that call to the tiny `electron-atan2.h`
wrapper, and applies namespace and four C symbol renames for isolation. The
wrapper invokes the unmodified vendored LLVM shared implementation in a private
namespace. No ordinary include or bridge is rewritten, and no other math call
is substituted. The mask compilation alone adds `-mno-fma`, `-mno-avx`, and
`-mno-sse4.2` to freeze the LLVM feature branches selected by the independently
compiled E primitive probe. Its header guard also rejects FMA-double or SSE4.2
branches. The ordinary presentation translation unit retains its original flags.

The source tree is an offline build input; builds do not fetch source or read
research artifacts. The complete LLVM libc `LICENSE.TXT` remains unchanged,
including the Apache-2.0 license with LLVM exceptions and additional notices.
Staging distributes that license, the source provenance inventory, and the ACES
license. The exact Electron MIT, Chromium BSD and V8 BSD/additional-notice
licenses accompany their uncompiled provenance snapshots and are staged in
separately named provenance-license files. Source pins for Electron, Chromium and V8 establish provenance; those
projects' implementation sources are not compiled into this wrapper.

The build emits the canonical sorted-key compact JSON receipt
`native-hdr-mask-arithmetic-v2-electron-llvm`. It records the exact four reference
fields, mask-only compiler flags, ordinary/candidate/mask generated hashes,
bridge/context/wrapper/host/preparation hashes, upstream inventory hash, every
source pin, and the one-call substitution. Its SHA-256 is embedded at compile
time into the Rust mask request validator. Every different request arithmetic
SHA is rejected before mask context creation, strip allocation or stdout output.
Capability and receipt output stay bounded to 64 KiB each. The staging manifest
binds this identity, its source inputs, generated artifacts and binary checksum.

The startup resolver first verifies the trusted bundled executable checksum.
Discovery requires bounded valid UTF-8 output, real stdout/stderr EOF and a
successful actual child close. A timeout or output limit owns TERM-to-KILL
retirement and waits for actual close before rejecting. It validates the exact
E receipt version, runtime reference, mask flags, substitution, bounded source
provenance and canonical arithmetic hash. In Electron it also requires the
actual Electron/V8/Chromium runtime versions to match the receipt. Ordinary Node
service/build discovery may inspect the same bundle without claiming to be
Electron. No PATH, working-directory, renderer-supplied executable, research
artifact or old Node/D arithmetic fallback is available.

The renderer's seventeen primitive expectations come from the actual pinned
Electron runtime. The production `analyzeHdr` pixel oracle, threshold decisions,
full mask and mip byte comparisons remain unchanged. The independently compiled
E seam agrees with all seventeen actual Electron primitive results. That small
probe is a prerequisite rather than full application acceptance: the E shipping
build, hidden Electron full-photographic parity, cancellation/drain/resource
checks and presentation measurements still require their own evidence.

Historical Node/D source freezes, reference outputs and failed Electron results
remain unchanged in research archives. In the retained D Electron run, both
photographs and thirteen public/golden cases had no mask/mip byte differences;
the run still failed its strict primitive gate. Neither that result nor the E
primitive probe permits a numeric tolerance or waiver of the full application
gates. Other transcendentals still use the unchanged generated ACES math and
must be assessed by the independent full pixel oracle on this exact runtime.
