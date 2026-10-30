#ifndef IRODORI_CREATIVE_COLOR_PARAMS_H
#define IRODORI_CREATIVE_COLOR_PARAMS_H

#include <stdint.h>

/* Validated once per request. Read-only during strip rendering; no owned allocations.
 * Integer flags avoid language-dependent bool representations across the C ABI. */
typedef struct IrodoriCreativeColorParams {
    double ranges[8][4];
    double tones[3][3];
    double saturation;
    double vibrance;
    double width;
    double balance;
    uint32_t mixer_active;
    uint32_t grading_active;
} IrodoriCreativeColorParams;

#endif
