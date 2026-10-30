// Research extension in the same translation unit, reusing the unchanged engine
// context, generated pinned CTL, adjustment order, and content rendering helpers.
// The production bridge and its independent generator are not copied or edited.
#include "electron-atan2.h"
#include "mask-context.inc"

extern "C" int irodori_mask_render(void* context, const float* input,
                                 uint32_t width, uint32_t rows,
                                 const IrodoriCpuParams* parameters,
                                 const double* proof_values, double peak,
                                 uint8_t* mask) noexcept {
    last_error[0] = '\0';
    try {
        if (!context || !input || !parameters || !proof_values || !mask
            || !width || width > 32768 || !rows || rows > 64
            || (parameters->flags & ~(IRODORI_CPU_WHITE_BALANCE | IRODORI_CPU_SOURCE_DISPLAY
                | IRODORI_CPU_HEADROOM_PRESENT))
            || !std::isfinite(peak) || peak < 1. || peak > 100.)
            throw std::invalid_argument("Invalid isolated mask strip contract.");
        const auto& prepared = *static_cast<const Context*>(context);
        const M proof = matrix(proof_values);
        const bool source_display = parameters->flags & IRODORI_CPU_SOURCE_DISPLAY;
        const bool headroom = parameters->flags & IRODORI_CPU_HEADROOM_PRESENT;
        if (headroom && (!std::isfinite(parameters->headroom)
            || parameters->headroom < 1. || parameters->headroom > 100.))
            throw std::invalid_argument("Invalid isolated mask headroom.");
        const std::size_t pixels = static_cast<std::size_t>(width) * rows;
        for (std::size_t pixel = 0; pixel < pixels; ++pixel) {
            const std::size_t at = pixel * 4;
            const V rgb{input[at], input[at + 1], input[at + 2]};
            const double alpha = input[at + 3];
            if (!std::isfinite(rgb[0]) || !std::isfinite(rgb[1]) || !std::isfinite(rgb[2])
                || !std::isfinite(alpha) || alpha < 0. || alpha > 1.)
                throw std::invalid_argument("Invalid isolated mask source pixel.");
            mask[pixel] = 0;
            if (alpha == 0.) continue;
            const V content = hdr_content(prepared, adjust(rgb, *parameters), source_display);
            const double y = luminance(content);
            const V converted = row_major(proof, content);
            bool clipped = false, gamut_limited = false;
            for (const auto channel : converted) {
                if (!std::isfinite(channel))
                    throw std::runtime_error("Non-finite isolated mask proof channel.");
                clipped = clipped || channel < -2e-6 || channel > peak + 2e-6;
                gamut_limited = gamut_limited || channel < -2e-6;
            }
            if (!std::isfinite(y)) throw std::runtime_error("Non-finite isolated mask content luminance.");
            mask[pixel] = static_cast<uint8_t>(clipped)
                | (static_cast<uint8_t>(headroom && y > parameters->headroom) << 1)
                | (static_cast<uint8_t>(y > 1.) << 2)
                | (static_cast<uint8_t>(gamut_limited) << 3);
        }
        return 1;
    } catch (const std::exception& exception) {
        error(exception.what());
    } catch (...) {
        error("Isolated mask classification failed.");
    }
    return 0;
}
