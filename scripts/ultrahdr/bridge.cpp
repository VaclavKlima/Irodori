#include "ultrahdr_api.h"
#include <cstring>
#include <cmath>
#include <exception>
#include <memory>
#include <stdexcept>
#include <string>

namespace {
uhdr_codec_private_t* encoder = nullptr;
uhdr_codec_private_t* decoder = nullptr;
std::string error;
void check(uhdr_error_info_t result) {
  if (result.error_code != UHDR_CODEC_OK)
    throw std::runtime_error(result.has_detail ? result.detail : "Ultra HDR codec failed.");
}
}

extern "C" {
void irodori_release() {
  if (encoder) uhdr_release_encoder(encoder);
  if (decoder) uhdr_release_decoder(decoder);
  encoder = decoder = nullptr;
}
const char* irodori_error() { return error.c_str(); }
int irodori_encode(void* half, unsigned width, unsigned height, void* jpeg, unsigned length, int quality, float headroom) {
  irodori_release();
  error.clear();
  try {
    if (!half || !jpeg || !width || !height || width > 32768 || height > 32768 ||
        uint64_t(width) * height * 16 > 536870912 || quality < 1 || quality > 100 ||
        !std::isfinite(headroom) || headroom < 1.0f || headroom > 10.0f)
      throw std::runtime_error("Unsupported HDR JPEG allocation or dimensions.");
    encoder = uhdr_create_encoder();
    if (!encoder) throw std::bad_alloc();
    uhdr_raw_image_t hdr{};
    hdr.fmt = UHDR_IMG_FMT_64bppRGBAHalfFloat;
    hdr.cg = UHDR_CG_BT_2100;
    hdr.ct = UHDR_CT_LINEAR;
    hdr.range = UHDR_CR_FULL_RANGE;
    hdr.w = width; hdr.h = height;
    hdr.planes[0] = half; hdr.stride[0] = width;
    uhdr_compressed_image_t sdr{jpeg, length, length, UHDR_CG_BT_709, UHDR_CT_SRGB, UHDR_CR_FULL_RANGE};
    check(uhdr_enc_set_raw_image(encoder, &hdr, UHDR_HDR_IMG));
    check(uhdr_enc_set_compressed_image(encoder, &sdr, UHDR_SDR_IMG));
    check(uhdr_enc_set_using_multi_channel_gainmap(encoder, 1));
    check(uhdr_enc_set_gainmap_scale_factor(encoder, 1));
    check(uhdr_enc_set_quality(encoder, quality, UHDR_GAIN_MAP_IMG));
    check(uhdr_enc_set_preset(encoder, UHDR_USAGE_BEST_QUALITY));
    // Describe actual content headroom so a capable display applies the full map.
    // This changes metadata, never the fixed Irodori HDR rendition's pixel values.
    check(uhdr_enc_set_target_display_peak_brightness(encoder, 203.0f * headroom));
    check(uhdr_encode(encoder));
    return 1;
  } catch (const std::exception& e) { error = e.what(); irodori_release(); return 0; }
}
void* irodori_output() { auto p = encoder ? uhdr_get_encoded_stream(encoder) : nullptr; return p ? p->data : nullptr; }
unsigned irodori_size() { auto p = encoder ? uhdr_get_encoded_stream(encoder) : nullptr; return p ? p->data_sz : 0; }
int irodori_probe(void* jpeg, unsigned length, float boost) {
  irodori_release(); error.clear();
  try {
    decoder = uhdr_create_decoder();
    if (!decoder) throw std::bad_alloc();
    uhdr_compressed_image_t image{jpeg, length, length, UHDR_CG_UNSPECIFIED, UHDR_CT_UNSPECIFIED, UHDR_CR_UNSPECIFIED};
    check(uhdr_dec_set_image(decoder, &image));
    check(uhdr_dec_set_out_img_format(decoder, UHDR_IMG_FMT_64bppRGBAHalfFloat));
    check(uhdr_dec_set_out_color_transfer(decoder, UHDR_CT_LINEAR));
    if (boost >= 1.0f) check(uhdr_dec_set_out_max_display_boost(decoder, boost));
    check(uhdr_dec_probe(decoder));
    return 1;
  } catch (const std::exception& e) { error = e.what(); irodori_release(); return 0; }
}
void irodori_info(float* out) {
  auto m = uhdr_dec_get_gainmap_metadata(decoder);
  if (!m) return;
  for (int c = 0; c < 3; c++) {
    out[c] = m->min_content_boost[c]; out[c+3] = m->max_content_boost[c];
    out[c+6] = m->gamma[c]; out[c+9] = m->offset_sdr[c]; out[c+12] = m->offset_hdr[c];
  }
  out[15] = m->hdr_capacity_min; out[16] = m->hdr_capacity_max; out[17] = m->use_base_cg;
  out[18] = uhdr_dec_get_image_width(decoder); out[19] = uhdr_dec_get_image_height(decoder);
  out[20] = uhdr_dec_get_gainmap_width(decoder); out[21] = uhdr_dec_get_gainmap_height(decoder);
}
void* irodori_map() { auto p = uhdr_dec_get_gainmap_image(decoder); return p ? p->data : nullptr; }
unsigned irodori_map_size() { auto p = uhdr_dec_get_gainmap_image(decoder); return p ? p->data_sz : 0; }
int irodori_decode() {
  try {
    check(uhdr_decode(decoder)); return 1;
  } catch (const std::exception& e) { error = e.what(); return 0; }
}
void* irodori_pixels() { auto p = uhdr_get_decoded_image(decoder); return p ? p->planes[0] : nullptr; }
unsigned irodori_stride() { auto p = uhdr_get_decoded_image(decoder); return p ? p->stride[0] : 0; }
int irodori_gamut() { auto p = uhdr_get_decoded_image(decoder); return p ? p->cg : UHDR_CG_UNSPECIFIED; }
}
