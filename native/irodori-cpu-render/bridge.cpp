#include "bridge.h"
#include "creative-color.h"

#include <array>
#include <cmath>
#include <cstddef>
#include <cstdio>
#include <exception>
#include <stdexcept>

#ifdef __FAST_MATH__
#error "The CPU rendering reference equations require fast math to be disabled."
#endif

// Build with -ffp-contract=off and -fno-fast-math. This include is generated
// directly from the pinned CTL by this directory's generate_math.py.
#include "aces_math.inc"

namespace {
using irodori_cpu_aces::Chromaticities;
using irodori_cpu_aces::M;
using irodori_cpu_aces::ODTParams;
using irodori_cpu_aces::V;

thread_local char last_error[512]{};

void error(const char* message) noexcept {
    std::snprintf(last_error, sizeof(last_error), "%s", message);
}

M matrix(const double* values) {
    if (!values) throw std::invalid_argument("Missing CPU renderer matrix.");
    M result{};
    for (std::size_t row = 0; row < 3; ++row) {
        for (std::size_t column = 0; column < 3; ++column) {
            const double value = values[row * 3 + column];
            if (!std::isfinite(value)) throw std::invalid_argument("Non-finite CPU renderer matrix.");
            result[row][column] = value;
        }
    }
    return result;
}

struct Context {
    const M to_aces;
    const M to_srgb;
    const ODTParams sdr;
    const ODTParams content;

    Context(const double* aces, const double* srgb)
        : to_aces(matrix(aces)), to_srgb(matrix(srgb)),
          sdr(irodori_cpu_aces::init_ODTParams(
              100., Chromaticities{{.64, .33}, {.3, .6}, {.15, .06}, {.3127, .329}})),
          content(irodori_cpu_aces::init_ODTParams(
              1000., Chromaticities{{.708, .292}, {.17, .797}, {.131, .046}, {.3127, .329}})) {}
};

double luminance(const V& value) {
    return value[0] * .2627002120112671
        + value[1] * .6779980715188708 + value[2] * .059301716469862;
}

double clamp(double value, double minimum, double maximum) {
    return std::fmax(minimum, std::fmin(maximum, value));
}

V row_major(const M& matrix, const V& value) {
    return {
        matrix[0][0] * value[0] + matrix[0][1] * value[1] + matrix[0][2] * value[2],
        matrix[1][0] * value[0] + matrix[1][1] * value[1] + matrix[1][2] * value[2],
        matrix[2][0] * value[0] + matrix[2][1] * value[1] + matrix[2][2] * value[2],
    };
}

template <typename Next>
void scale(V& value, Next next) {
    const double y = luminance(value);
    if (y > 0.) {
        const double factor = next(y) / y;
        for (auto& channel : value) channel *= factor;
    }
}

// CIE Lab/D65 chroma editing preserves linear Y, including signed/HDR inputs.
V color_intensity(const V& value, const IrodoriCpuParams& p) {
    if ((p.saturation == 0. && p.vibrance == 0.) ||
        (value[0] == value[1] && value[1] == value[2])) return value;
    const M to_xyz{{
        {63426534./99577255., 20160776./139408157., 47086771./278816314.},
        {26158966./99577255., 472592308./697040785., 8267143./139408157.},
        {0., 19567812./697040785., 295819943./278816314.},
    }};
    const M from_xyz{{
        {30757411./17917100., -6372589./17917100., -4539589./17917100.},
        {-19765991./29648200., 47925759./29648200., 467509./29648200.},
        {792561./44930125., -1921689./44930125., 42328811./44930125.},
    }};
    const V xyz = row_major(to_xyz, value);
    if (p.saturation == -100.) return {xyz[1], xyz[1], xyz[1]};
    const auto lab_f = [](double v) {
        return v > 216./24389. ? std::cbrt(v) : ((24389./27.)*v+16.)/116.;
    };
    const auto inverse_f = [](double v) {
        return v > 6./29. ? v*v*v : (116.*v-16.)*(27./24389.);
    };
    const double xw = 3127./3290., zw = 3583./3290.;
    const double f = lab_f(xyz[1]), l = 116.*f-16.;
    const double a = 500.*(lab_f(xyz[0]/xw)-f), b = 200.*(f-lab_f(xyz[2]/zw));
    const double denominator = l*l+4.*(a*a+b*b);
    const double weight = denominator > 0. ? l*l/denominator : 0.;
    const double gain = (1.+p.saturation/100.)*std::pow(2.,p.vibrance/100.*weight);
    if (gain == 1.) return value;
    return row_major(from_xyz, {xw*inverse_f(f+gain*a/500.),xyz[1],zw*inverse_f(f-gain*b/200.)});
}

// Keep the expression and operation order of shared/hdr.ts:adjustHdr.
V adjust(V value, const IrodoriCpuParams& parameters) {
    if (parameters.flags & IRODORI_CPU_WHITE_BALANCE) {
        const auto& wb = parameters.wb;
        value = {
            wb[0] * value[0] + wb[1] * value[1] + wb[2] * value[2],
            wb[3] * value[0] + wb[4] * value[1] + wb[5] * value[2],
            wb[6] * value[0] + wb[7] * value[1] + wb[8] * value[2],
        };
    }
    const double gain = std::pow(2., parameters.exposure);
    for (auto& channel : value) channel *= gain;
    if (parameters.contrast) {
        scale(value, [&](double y) {
            return y >= 1. ? y : y <= .18
                ? .18 * std::pow(y / .18, std::pow(2., parameters.contrast / 100.))
                : 1. - .82 * std::pow((1. - y) / .82, std::pow(2., parameters.contrast / 100.));
        });
    }
    if (parameters.highlights) {
        scale(value, [&](double y) {
            return y <= .18 ? y : (1. + parameters.highlights / 100.) * y
                - (parameters.highlights / 100.) * (.18 + (.82 * (y - .18)) / (.82 + y - .18));
        });
    }
    if (parameters.shadows) {
        scale(value, [&](double y) {
            return y >= .18 ? y
                : y * std::pow(2., ((2. * parameters.shadows) / 100.) * std::pow(1. - y / .18, 2.));
        });
    }
    if (parameters.whites) {
        scale(value, [&](double y) {
            const double t = clamp((y - .18) / .82, 0., 1.);
            return y * std::pow(2., (parameters.whites / 100.) * t * t * (3. - 2. * t));
        });
    }
    if (parameters.blacks) {
        const double y = luminance(value);
        if (y >= 0.) {
            const double d = ((.04 * parameters.blacks) / 100.)
                * std::pow(std::fmax(1. - y / .18, 0.), 3.);
            if (parameters.blacks > 0.) {
                for (auto& channel : value) channel += d;
            } else {
                scale(value, [&](double current) { return std::fmax(0., current + d); });
            }
        }
    }
    return irodori_creative_color::apply(value, parameters.creative, true,
        [&](const V& rgb) { return color_intensity(rgb, parameters); });
}

V rendered(const Context& context, const V& value, const ODTParams& prepared, double peak) {
    const V aces = irodori_cpu_aces::mult_f3_f33(value, context.to_aces);
    V result = irodori_cpu_aces::outputTransform_fwd(aces, prepared);
    for (auto& channel : result) {
        if (!std::isfinite(channel)) throw std::runtime_error("Non-finite CPU rendered channel.");
        channel = clamp(channel, 0., peak);
    }
    return result;
}

V output(const Context& context, const V& value, bool source_display) {
    if (!source_display) return rendered(context, value, context.sdr, 1.);
    V content = value;
    for (auto& channel : content) channel = std::fmax(0., channel);
    V result = row_major(context.to_srgb, content);
    for (auto& channel : result) channel = clamp(channel, 0., 1.);
    return result;
}

V hdr_content(const Context& context, const V& value, bool source_display) {
    if (!source_display) return rendered(context, value, context.content, 10.);
    V result = value;
    for (auto& channel : result) channel = std::fmax(0., channel);
    return result;
}

bool range_color(const V& content, const IrodoriCpuParams& parameters,
                 uint32_t x, uint32_t y, V& result) {
    const double maximum = luminance(content);
    if (maximum <= 1.) return false;
    if ((parameters.flags & IRODORI_CPU_HEADROOM_PRESENT) && maximum > parameters.headroom) {
        result = (static_cast<uint64_t>(x) + y) % 8 < 4 ? V{1., 0., 0.} : V{.35, .02, .02};
    } else if (maximum <= 2.) result = {0., 1., 1.};
    else if (maximum <= 4.) result = {0., 0., 1.};
    else if (maximum <= 8.) result = {.6, 0., 1.};
    else result = {1., 0., 1.};
    return true;
}

double encode(double linear) {
    if (!std::isfinite(linear)) throw std::runtime_error("Non-finite diagnostic channel.");
    const double magnitude = std::fabs(linear);
    const double encoded = magnitude <= .0031308
        ? 12.92 * magnitude : 1.055 * std::pow(magnitude, 1. / 2.4) - .055;
    return linear < 0. ? -encoded : linear == 0. ? linear : encoded;
}

uint8_t byte(double value) {
    if (!std::isfinite(value)) throw std::runtime_error("Non-finite CPU output channel.");
    // JS writes Math.round(value * 255) into Uint8ClampedArray. Compare the
    // fraction directly: adding .5 can round a value just below a half upward.
    const double scaled = value * 255.;
    if (scaled <= 0.) return 0;
    if (scaled >= 255.) return 255;
    const double lower = std::floor(scaled);
    return static_cast<uint8_t>(lower + (scaled - lower >= .5 ? 1. : 0.));
}

void encode_pixel(const Context& context, const V& value, const IrodoriCpuParams& parameters,
                  uint32_t x, uint32_t y, uint8_t* destination) {
    const bool source_display = parameters.flags & IRODORI_CPU_SOURCE_DISPLAY;
    const V display = output(context, value, source_display);
    V diagnostic{};
    const bool range = (parameters.flags & IRODORI_CPU_RANGES)
        && range_color(hdr_content(context, value, source_display), parameters, x, y, diagnostic);
    for (std::size_t channel = 0; channel < 3; ++channel)
        destination[channel] = byte(range ? diagnostic[channel] : encode(display[channel]));
}
} // namespace

static_assert(sizeof(IrodoriCpuParams) == 520, "Unexpected native CPU parameter ABI.");

extern "C" int irodori_cpu_color(const double* values, uint32_t count,
                              IrodoriCreativeColorParams* output) noexcept {
    last_error[0] = '\0';
    try {
        if (!values || !output || count != 52)
            throw std::invalid_argument("Invalid native creative-color packet extent.");
        std::array<double, 52> raw{};
        std::copy_n(values, raw.size(), raw.begin());
        *output = irodori_creative_color::from_values(raw);
        return 1;
    } catch (const std::exception& exception) {
        error(exception.what());
    } catch (...) {
        error("Native creative-color validation failed.");
    }
    return 0;
}

extern "C" void* irodori_cpu_create(const double* aces, const double* srgb) noexcept {
    last_error[0] = '\0';
    try {
        return new Context(aces, srgb);
    } catch (const std::exception& exception) {
        error(exception.what());
    } catch (...) {
        error("CPU rendering context initialization failed.");
    }
    return nullptr;
}

extern "C" int irodori_cpu_render(void* context, const float* input,
                                uint32_t sourceWidth, uint32_t sourceHeight,
                                uint32_t sourceRow, uint32_t sourceRows,
                                uint32_t outputWidth, uint32_t outputHeight,
                                uint32_t outputRow, uint32_t outputRows,
                                const IrodoriCpuParams* parameters,
                                uint8_t* after, uint8_t* before) noexcept {
    last_error[0] = '\0';
    try {
        if (!context || !parameters || !sourceWidth || !sourceHeight
            || !outputWidth || !outputHeight || sourceWidth > 32768 || sourceHeight > 32768
            || outputWidth > 32768 || outputHeight > 32768
            || sourceRow > sourceHeight || sourceRows > sourceHeight - sourceRow
            || sourceRows > 64 || outputRow > outputHeight || outputRows > outputHeight - outputRow)
            throw std::invalid_argument("Invalid CPU rendering strip geometry.");
        if (!outputRows) return 1;
        if (!input || !after || !before || !sourceRows)
            throw std::invalid_argument("Missing CPU rendering strip buffers.");
        const auto& prepared = *static_cast<const Context*>(context);
        for (uint32_t row = 0; row < outputRows; ++row) {
            const uint32_t global_row = outputRow + row;
            const auto y = static_cast<uint32_t>(std::floor(
                ((static_cast<double>(global_row) + .5) * sourceHeight) / outputHeight));
            if (y < sourceRow || y >= static_cast<uint64_t>(sourceRow) + sourceRows)
                throw std::invalid_argument("CPU output row is outside its supplied source strip.");
            for (uint32_t column = 0; column < outputWidth; ++column) {
                const auto x = static_cast<uint32_t>(std::floor(
                    ((static_cast<double>(column) + .5) * sourceWidth) / outputWidth));
                const std::size_t source = (static_cast<std::size_t>(y - sourceRow) * sourceWidth + x) * 4;
                const std::size_t destination = (static_cast<std::size_t>(row) * outputWidth + column) * 4;
                const V rgb{input[source], input[source + 1], input[source + 2]};
                if (!std::isfinite(rgb[0]) || !std::isfinite(rgb[1]) || !std::isfinite(rgb[2])
                    || !std::isfinite(input[source + 3]) || input[source + 3] < 0. || input[source + 3] > 1.)
                    throw std::invalid_argument("Invalid CPU source pixel.");
                encode_pixel(prepared, adjust(rgb, *parameters), *parameters, x, y, after + destination);
                if (parameters->flags & IRODORI_CPU_NEUTRAL) {
                    for (std::size_t channel = 0; channel < 3; ++channel)
                        before[destination + channel] = after[destination + channel];
                } else {
                    encode_pixel(prepared, rgb, *parameters, x, y, before + destination);
                }
                after[destination + 3] = before[destination + 3] = byte(input[source + 3]);
            }
        }
        return 1;
    } catch (const std::exception& exception) {
        error(exception.what());
    } catch (...) {
        error("CPU rendering failed.");
    }
    return 0;
}

extern "C" void irodori_cpu_destroy(void* context) noexcept {
    delete static_cast<const Context*>(context);
}

extern "C" const char* irodori_cpu_error(void) noexcept {
    return last_error;
}
