// Isolated row-kernel research bridge. Only the pinned Sony dispatch is patched.
// Its adjusted-black operation is called through a subclass, not reimplemented.
// Preserve upstream LGPL/CDDL notices and source; see licenses/ and README.md.
#include <libraw/libraw.h>
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <iomanip>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <string>
#include <sys/resource.h>
#include <chrono>
#include "rows-abi.h"

static_assert(LIBRAW_MAJOR_VERSION == 0 && LIBRAW_MINOR_VERSION == 22 && LIBRAW_PATCH_VERSION == 1,
              "The isolated RAW bridge requires pinned LibRaw 0.22.1.");

namespace {
constexpr uint64_t maximumInput = 512ULL * 1024 * 1024;
constexpr uint64_t maximumPacked = 128ULL * 1024 * 1024;
constexpr uint64_t maximumLinear = 384ULL * 1024 * 1024;
constexpr uint64_t maximumRawAllocation = 256ULL * 1024 * 1024;

class SensorRaw : public LibRaw {
 public:
  std::array<unsigned, 4> adjustedBlack() {
    const auto saved = imgdata.color;
    imgdata.color = imgdata.rawdata.color;
    try {
      const uint64_t pattern = uint64_t(imgdata.color.cblack[4]) * imgdata.color.cblack[5];
      if (pattern > LIBRAW_CBLACK_SIZE - 6) throw std::runtime_error("Invalid black pattern.");
      adjust_bl();
      std::array<unsigned, 4> result{};
      std::copy_n(imgdata.color.cblack, 4, result.begin());
      imgdata.color = saved;
      return result;
    } catch (...) {
      imgdata.color = saved;
      throw;
    }
  }
};

std::string quote(const char* value) {
  if (!value) throw std::runtime_error("Missing RAW metadata string.");
  std::ostringstream out;
  out << '"';
  for (size_t i = 0; value[i]; ++i) {
    const unsigned char c = value[i];
    if (i >= 256 || c >= 128) throw std::runtime_error("Unsupported RAW metadata string.");
    if (c == '"' || c == '\\') out << '\\' << char(c);
    else if (c < 32) out << "\\u" << std::hex << std::setw(4) << std::setfill('0') << unsigned(c) << std::dec;
    else out << char(c);
  }
  out << '"';
  return out.str();
}

void finite(double value) {
  if (!std::isfinite(value)) throw std::runtime_error("Nonfinite RAW metadata.");
}

template <typename T> void array(std::ostringstream& out, const T* values, size_t count) {
  out << '[';
  for (size_t i = 0; i < count; ++i) {
    finite(values[i]);
    if (i) out << ',';
    out << values[i];
  }
  out << ']';
}

void geometry(const SensorRaw& raw) {
  const auto& s = raw.imgdata.sizes;
  if (!s.width || !s.height || !s.raw_width || !s.raw_height ||
      s.width > 32768 || s.height > 32768 || s.raw_width > 32768 || s.raw_height > 32768 ||
      uint64_t(s.raw_width) * s.raw_height * 2 > maximumPacked ||
      uint64_t(s.width) * s.height * 16 > maximumLinear ||
      uint64_t(s.left_margin) + s.width > s.raw_width ||
      uint64_t(s.top_margin) + s.height > s.raw_height || s.flip < 0 || s.flip > 7)
    throw std::runtime_error("RAW geometry exceeds the isolated sensor contract.");
}

std::string metadata(SensorRaw& raw) {
  geometry(raw);
  const auto& data = raw.imgdata;
  const auto& s = data.sizes;
  const auto adjusted = raw.adjustedBlack();
  std::array<float, 12> matrix{}, camXyz{};
  std::memcpy(matrix.data(), data.color.rgb_cam, sizeof(data.color.rgb_cam));
  std::memcpy(camXyz.data(), data.rawdata.color.cam_xyz, sizeof(data.rawdata.color.cam_xyz));
  const std::array<int, 4> cfa = {raw.COLOR(0, 0), raw.COLOR(0, 1), raw.COLOR(1, 0), raw.COLOR(1, 1)};
  finite(s.pixel_aspect);
  std::ostringstream out;
  out << std::setprecision(std::numeric_limits<double>::max_digits10);
  out << "{\"libraryVersion\":" << quote(LibRaw::version())
      << ",\"make\":" << quote(data.idata.normalized_make)
      << ",\"model\":" << quote(data.idata.normalized_model)
      << ",\"unpackFunction\":" << quote(raw.unpack_function_name())
      << ",\"width\":" << s.width << ",\"height\":" << s.height
      << ",\"rawWidth\":" << s.raw_width << ",\"rawHeight\":" << s.raw_height
      << ",\"rawPitch\":" << s.raw_pitch << ",\"left\":" << s.left_margin
      << ",\"top\":" << s.top_margin << ",\"flip\":" << s.flip
      << ",\"colors\":" << data.idata.colors << ",\"isFoveon\":" << (data.idata.is_foveon ? "true" : "false")
      << ",\"pixelAspect\":" << s.pixel_aspect << ",\"cfa\":";
  array(out, cfa.data(), cfa.size());
  out << ",\"black\":"; array(out, adjusted.data(), adjusted.size());
  out << ",\"commonBlack\":" << data.color.black << ",\"cblack\":";
  array(out, data.color.cblack, 6);
  out << ",\"colorMaximum\":" << data.color.maximum << ",\"camMul\":";
  array(out, data.color.cam_mul, 4);
  out << ",\"matrix\":";
  array(out, matrix.data(), matrix.size());
  out << ",\"camXyz\":";
  array(out, camXyz.data(), camXyz.size());
  out << ",\"linearMax\":";
  array(out, data.rawdata.color.linear_max, 4);
  out << '}';
  const auto result = out.str();
  if (result.size() > 16 * 1024) throw std::runtime_error("RAW metadata exceeded its bound.");
  return result;
}

struct Handle {
  SensorRaw raw;
  const uint16_t* rows = nullptr;
  size_t rowWidth = 0;
  size_t rowCount = 0;
  size_t rowStride = 0;
  bool borrowed = false;
  bool released = false;
  std::string json;
  std::string error;
  bool opened = false;
  bool unpacked = false;
  const uint8_t* mappedInput = nullptr;
  size_t mappedLength = 0;
  unsigned rowMode = 0;
  unsigned rowThreads = 1;
  std::string rowJson = "{\"status\":\"not-attempted\"}";
};

// A bounded synchronous borrow, never a cache. No LibRaw method runs on row threads.
thread_local Handle* activeRows = nullptr;
struct ActiveRows {
  explicit ActiveRows(Handle* value) {
    if (activeRows) throw std::runtime_error("Nested RAW row dispatch.");
    activeRows = value;
  }
  ~ActiveRows() { activeRows = nullptr; }
};

bool overlaps(const void* a, size_t na, const void* b, size_t nb) {
  const auto aa = reinterpret_cast<uintptr_t>(a), bb = reinterpret_cast<uintptr_t>(b);
  if (na > UINTPTR_MAX - aa || nb > UINTPTR_MAX - bb)
    throw std::runtime_error("Invalid row borrow address range.");
  return aa < bb + nb && bb < aa + na;
}

template <typename Work> int guarded(Handle* handle, Work work) {
  if (!handle) return -1;
  try {
    handle->error.clear();
    work();
    return 0;
  } catch (const std::exception& error) {
    handle->error = std::string(error.what()).substr(0, 2048);
  } catch (...) {
    handle->error = "Unknown native RAW failure.";
  }
  return -1;
}

void check(int result) {
  if (result) throw std::runtime_error("LibRaw code " + std::to_string(result) + ": " + LibRaw::strerror(result));
}
}

extern "C" {
void* luma_raw_create() {
  try { return new Handle(); } catch (...) { return nullptr; }
}
void luma_raw_destroy(void* value) { delete static_cast<Handle*>(value); }
const char* luma_raw_error(void* value) { return static_cast<Handle*>(value)->error.c_str(); }
const char* luma_raw_metadata(void* value) { return static_cast<Handle*>(value)->json.c_str(); }
const char* luma_raw_row_diagnostics(void* value) { return static_cast<Handle*>(value)->rowJson.c_str(); }
int luma_raw_configure_rows(void* value, unsigned mode, unsigned threads) {
  auto* handle = static_cast<Handle*>(value);
  return guarded(handle, [&] {
    if (handle->opened || mode > 1 || (threads != 1 && threads != 2 && threads != 4 && threads != 8) ||
        (!mode && threads != 1)) throw std::runtime_error("Invalid row-kernel configuration.");
    handle->rowMode = mode;
    handle->rowThreads = threads;
  });
}
const uint16_t* luma_raw_rows(void* value) { return static_cast<Handle*>(value)->rows; }
size_t luma_raw_row_width(void* value) { return static_cast<Handle*>(value)->rowWidth; }
size_t luma_raw_row_count(void* value) { return static_cast<Handle*>(value)->rowCount; }
size_t luma_raw_row_stride(void* value) { return static_cast<Handle*>(value)->rowStride; }
int luma_raw_open(void* value, const uint8_t* input, size_t length) {
  auto* handle = static_cast<Handle*>(value);
  return guarded(handle, [&] {
    if (handle->opened || !input || !length || length > maximumInput)
      throw std::runtime_error("Invalid native RAW input.");
    handle->raw.imgdata.rawparams.max_raw_memory_mb = maximumRawAllocation / 1024 / 1024;
    check(handle->raw.open_buffer(const_cast<uint8_t*>(input), length));
    handle->mappedInput = input;
    handle->mappedLength = length;
    // Match current librawDecoder.open exactly; no demosaic or WB is executed here.
    auto& p = handle->raw.imgdata.params;
    p.half_size = 0;
    p.user_qual = 3;
    p.use_camera_wb = 1;
    p.output_color = 1;
    p.output_bps = 8;
    geometry(handle->raw);
    handle->opened = true;
    handle->json = metadata(handle->raw);
  });
}
int luma_raw_unpack(void* value) {
  auto* handle = static_cast<Handle*>(value);
  return guarded(handle, [&] {
    if (!handle->opened || handle->unpacked) throw std::runtime_error("Invalid unpack order.");
    ActiveRows active(handle);
    const auto result = handle->raw.unpack();
    if (result) throw std::runtime_error("LibRaw unpack failed: " + std::to_string(result) + " " + handle->rowJson);
    geometry(handle->raw);
    handle->unpacked = true;
  });
}
int luma_raw_prepare_rows(void* value) {
  auto* handle = static_cast<Handle*>(value);
  return guarded(handle, [&] {
    if (!handle->unpacked || handle->borrowed || handle->released)
      throw std::runtime_error("Invalid live-row borrow order.");
    geometry(handle->raw);
    const auto& s = handle->raw.imgdata.sizes;
    const auto* input = handle->raw.imgdata.rawdata.raw_image;
    const uint64_t stride = s.raw_pitch ? s.raw_pitch / sizeof(uint16_t) : s.raw_width;
    if (!input || s.raw_pitch % sizeof(uint16_t) || stride < s.raw_width ||
        stride * s.raw_height * sizeof(uint16_t) > maximumRawAllocation)
      throw std::runtime_error("Unsupported or invalid packed Bayer layout.");
    handle->json = metadata(handle->raw);
    // Borrow LibRaw's initialized rows until the host completes its blocking pipe writes.
    // No second packed vector, zero-fill, extraction copy or pixel policy is introduced.
    handle->rows = input;
    handle->rowWidth = s.raw_width;
    handle->rowCount = s.raw_height;
    handle->rowStride = size_t(stride);
    handle->borrowed = true;
  });
}
int luma_raw_release_rows(void* value) {
  auto* handle = static_cast<Handle*>(value);
  return guarded(handle, [&] {
    if (!handle->borrowed || handle->released)
      throw std::runtime_error("Invalid live-row release order.");
    handle->rows = nullptr;
    handle->rowWidth = handle->rowCount = handle->rowStride = 0;
    handle->raw.recycle();
    handle->released = true;
  });
}
uint64_t luma_raw_peak_rss_bytes() {
  rusage usage{};
  return getrusage(RUSAGE_SELF, &usage) ? 0 : uint64_t(usage.ru_maxrss) * 1024;
}

// Called only from the exact patched sony_arw2_load_raw entry, inside normal unpack().
// 0 preserves the upstream body, 1 means all rows completed, -1 rejects partial output.
int luma_parallel_sony_arw2(void* owner) {
  auto* handle = activeRows;
  if (!handle || owner != static_cast<LibRaw*>(&handle->raw)) return 0;
  const auto started = std::chrono::steady_clock::now();
  try {
    if (!handle->rowMode) {
      handle->rowJson = "{\"status\":\"upstream-control\",\"requestedThreads\":1}";
      return 0;
    }
    auto& raw = handle->raw;
    const auto& s = raw.imgdata.sizes;
    const auto flags = raw.imgdata.rawparams.specials;
    const auto* internal = raw.get_internal_data_pointer();
    const auto offset = internal->unpacker_data.data_offset;
    const auto order = internal->unpacker_data.order;
    // Unsupported inputs use the original pinned implementation, never a guessed parser.
    if (flags || !s.raw_width || s.raw_width % 32 || !s.height || s.height != s.raw_height ||
        s.left_margin || s.top_margin || s.raw_pitch != unsigned(s.raw_width) * 2 ||
        (order != 0x4949 && order != 0x4d4d) || !raw.imgdata.rawdata.raw_image ||
        !raw.imgdata.rawdata.raw_alloc ||
        static_cast<const void*>(raw.imgdata.rawdata.raw_image) != raw.imgdata.rawdata.raw_alloc) {
      handle->rowJson = "{\"status\":\"upstream-fallback\",\"reason\":\"unsupported-flags-or-layout\",\"requestedThreads\":" + std::to_string(handle->rowThreads) + "}";
      return 0;
    }
    const uint64_t count = uint64_t(s.raw_width) * s.height;
    if (!internal->internal_data.input || !handle->mappedInput || count > maximumPacked / 2 || offset < 0 ||
        uint64_t(offset) > handle->mappedLength || count > handle->mappedLength - uint64_t(offset) ||
        internal->internal_data.input->tell() != offset)
      throw std::runtime_error("Invalid LibRaw-selected compressed row span.");
    const auto* input = handle->mappedInput + size_t(offset);
    auto* output = raw.imgdata.rawdata.raw_image;
    const auto* curve = raw.imgdata.color.curve;
    if (overlaps(input, size_t(count), output, size_t(count * 2)) ||
        overlaps(curve, sizeof(raw.imgdata.color.curve), output, size_t(count * 2)))
      throw std::runtime_error("Overlapping row-kernel borrows.");
    const auto descriptorMs = std::chrono::duration<double, std::milli>(
      std::chrono::steady_clock::now() - started).count();
    LumaRowsReport report{};
    const int result = luma_rows_decode(input, size_t(count), s.raw_width, s.height,
      unsigned(order), curve, 65536, output, size_t(count), handle->rowThreads, &report);
    std::ostringstream json;
    json << std::setprecision(std::numeric_limits<double>::max_digits10)
      << "{\"status\":\"" << (result ? "failed" : "rust-complete")
      << "\",\"requestedThreads\":" << handle->rowThreads
      << ",\"participants\":" << report.participants << ",\"observedThreads\":" << report.observedThreads
      << ",\"rows\":" << report.rows << ",\"blocks\":" << report.blocks
      << ",\"samples\":" << report.samples << ",\"errorCode\":" << report.errorCode
      << ",\"descriptor\":{\"dataOffset\":" << offset << ",\"mappedBytes\":" << handle->mappedLength << ",\"compressedBytes\":" << count
      << ",\"rowBytes\":" << s.raw_width << ",\"rows\":" << s.height
      << ",\"order\":" << order << ",\"flags\":" << flags << ",\"curveWords\":65536}"
      << ",\"timings\":{\"descriptorMs\":" << descriptorMs << ",\"rustDispatchMs\":" << report.elapsedMs << "}}";
    handle->rowJson = json.str();
    if (result || report.rows != s.height || report.samples != count ||
        report.blocks != count / 16 || report.participants > handle->rowThreads ||
        report.observedThreads > 8) return -1;
    // Preserve the stream position expected after the upstream row fread loop.
    if (internal->internal_data.input->seek(offset + INT64(count), SEEK_SET)) return -1;
    return 1;
  } catch (const std::exception& error) {
    handle->rowJson = "{\"status\":\"failed\",\"reason\":" + quote(error.what()) + "}";
    return -1;
  } catch (...) {
    handle->rowJson = "{\"status\":\"failed\",\"reason\":\"unknown-row-dispatch-error\"}";
    return -1;
  }
}
}
