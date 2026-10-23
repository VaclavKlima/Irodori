#ifndef LUMA_CPU_RENDER_BRIDGE_H
#define LUMA_CPU_RENDER_BRIDGE_H

#include <stdint.h>

#ifdef __cplusplus
#define LUMA_CPU_NOEXCEPT noexcept
extern "C" {
#else
#define LUMA_CPU_NOEXCEPT
#endif

enum LumaCpuFlags {
    LUMA_CPU_WHITE_BALANCE = 1u,
    LUMA_CPU_SOURCE_DISPLAY = 2u,
    LUMA_CPU_RANGES = 4u,
    LUMA_CPU_NEUTRAL = 8u,
    LUMA_CPU_HEADROOM_PRESENT = 16u,
};

typedef struct LumaCpuParams {
    double exposure;
    double contrast;
    double highlights;
    double shadows;
    double whites;
    double blacks;
    double wb[9];
    double headroom;
    uint32_t flags;
} LumaCpuParams;

/* Both matrices are copied. ACES uses row-vector order; sRGB uses row-major order. */
void* luma_cpu_create(const double* rec2020_to_aces_9,
                      const double* rec2020_to_srgb_9) LUMA_CPU_NOEXCEPT;

/* The context is immutable and may be shared by parallel render calls.
 * Input contains sourceRows full-width RGBA Float32 rows starting at sourceRow.
 * Each output plane contains outputRows tightly packed RGBA8 rows, starting at
 * outputRow in the complete output. All sampled source rows must be in input.
 * Output planes must be disjoint. Return 1 on success, 0 on error. */
int luma_cpu_render(void* context, const float* input,
                    uint32_t sourceWidth, uint32_t sourceHeight,
                    uint32_t sourceRow, uint32_t sourceRows,
                    uint32_t outputWidth, uint32_t outputHeight,
                    uint32_t outputRow, uint32_t outputRows,
                    const LumaCpuParams* parameters,
                    uint8_t* after, uint8_t* before) LUMA_CPU_NOEXCEPT;

/* Destroy only after every render call has joined. Errors belong to this thread. */
void luma_cpu_destroy(void* context) LUMA_CPU_NOEXCEPT;
const char* luma_cpu_error(void) LUMA_CPU_NOEXCEPT;

#ifdef __cplusplus
}
#endif
#undef LUMA_CPU_NOEXCEPT
#endif
