#ifndef IRODORI_CPU_RENDER_BRIDGE_H
#define IRODORI_CPU_RENDER_BRIDGE_H

#include <stdint.h>
#include "creative-color-params.h"

#ifdef __cplusplus
#define IRODORI_CPU_NOEXCEPT noexcept
extern "C" {
#else
#define IRODORI_CPU_NOEXCEPT
#endif

enum IrodoriCpuFlags {
    IRODORI_CPU_WHITE_BALANCE = 1u,
    IRODORI_CPU_SOURCE_DISPLAY = 2u,
    IRODORI_CPU_RANGES = 4u,
    IRODORI_CPU_NEUTRAL = 8u,
    IRODORI_CPU_HEADROOM_PRESENT = 16u,
};

typedef struct IrodoriCpuParams {
    double exposure;
    double contrast;
    double highlights;
    double shadows;
    double whites;
    double blacks;
    double saturation;
    double vibrance;
    double wb[9];
    double headroom;
    uint32_t flags;
    IrodoriCreativeColorParams creative;
} IrodoriCpuParams;

/* Decode exactly 52 logical values once before image allocation or strip work. */
int irodori_cpu_color(const double* values, uint32_t count,
                   IrodoriCreativeColorParams* output) IRODORI_CPU_NOEXCEPT;

/* Both matrices are copied. ACES uses row-vector order; sRGB uses row-major order. */
void* irodori_cpu_create(const double* rec2020_to_aces_9,
                      const double* rec2020_to_srgb_9) IRODORI_CPU_NOEXCEPT;

/* The context is immutable and may be shared by parallel render calls.
 * Input contains sourceRows full-width RGBA Float32 rows starting at sourceRow.
 * Each output plane contains outputRows tightly packed RGBA8 rows, starting at
 * outputRow in the complete output. All sampled source rows must be in input.
 * Output planes must be disjoint. Return 1 on success, 0 on error. */
int irodori_cpu_render(void* context, const float* input,
                    uint32_t sourceWidth, uint32_t sourceHeight,
                    uint32_t sourceRow, uint32_t sourceRows,
                    uint32_t outputWidth, uint32_t outputHeight,
                    uint32_t outputRow, uint32_t outputRows,
                    const IrodoriCpuParams* parameters,
                    uint8_t* after, uint8_t* before) IRODORI_CPU_NOEXCEPT;

/* Destroy only after every render call has joined. Errors belong to this thread. */
void irodori_cpu_destroy(void* context) IRODORI_CPU_NOEXCEPT;
const char* irodori_cpu_error(void) IRODORI_CPU_NOEXCEPT;

#ifdef __cplusplus
}
#endif
#undef IRODORI_CPU_NOEXCEPT
#endif
