// SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception
// Irodori's mask-only seam. Exact LLVM sources and full terms are retained in
// upstream/electron-llvm/llvm-libc/.
#pragma once
#if !defined(__linux__) || !defined(__x86_64__)
#error "The Electron LLVM native mask is scoped to Linux x86_64."
#endif
#ifdef LIBC_NAMESPACE
#error "The mask translation unit must own its isolated LLVM namespace."
#endif
#define LIBC_NAMESPACE irodori_electron_llvm_152
#include "shared/libc_common.h"
#include "shared/math/atan2.h"
namespace irodori_electron_atan2 {
inline double atan2(double y, double x) {
    return irodori_electron_llvm_152::shared::atan2(y, x);
}
}

// The observed Electron-compatible E probe selected these baseline branches.
// Build flags freeze them for the mask TU; normal CPU preview keeps its flags.
#if defined(LIBC_TARGET_CPU_HAS_FMA_DOUBLE) || defined(LIBC_TARGET_CPU_HAS_SSE4_2)
#error "Native mask LLVM target features differ from the verified baseline."
#endif
