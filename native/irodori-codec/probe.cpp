#include <cstdint>
#include <memory>
#include <sys/resource.h>
#include "ultrahdr_api.h"

extern "C" {
void* irodori_output();
unsigned irodori_size();

// Probe the live stream without another full-image copy or decode. The shared
// bridge remains unchanged and owns its encoder until Rust calls irodori_release.
int irodori_codec_probe(unsigned width, unsigned height) noexcept {
  try {
    auto* bytes = irodori_output();
    const auto size = irodori_size();
    if (!bytes || !size) return 0;
    std::unique_ptr<uhdr_codec_private_t, decltype(&uhdr_release_decoder)> probe(
        uhdr_create_decoder(), uhdr_release_decoder);
    if (!probe) return 0;
    uhdr_compressed_image_t image{bytes, size, size, UHDR_CG_UNSPECIFIED,
                                 UHDR_CT_UNSPECIFIED, UHDR_CR_UNSPECIFIED};
    return uhdr_dec_set_image(probe.get(), &image).error_code == UHDR_CODEC_OK &&
           uhdr_dec_probe(probe.get()).error_code == UHDR_CODEC_OK &&
           uhdr_dec_get_gainmap_metadata(probe.get()) &&
           uhdr_dec_get_image_width(probe.get()) == width &&
           uhdr_dec_get_image_height(probe.get()) == height &&
           uhdr_dec_get_gainmap_width(probe.get()) == width &&
           uhdr_dec_get_gainmap_height(probe.get()) == height;
  } catch (...) {
    return 0;
  }
}

uint64_t irodori_codec_peak_bytes() noexcept {
  struct rusage usage{};
  if (getrusage(RUSAGE_SELF, &usage) || usage.ru_maxrss <= 0) return 0;
  // Linux reports KiB; the existing macOS helper reports bytes.
  return static_cast<uint64_t>(usage.ru_maxrss) * 1024;
}
}
