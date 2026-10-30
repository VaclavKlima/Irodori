#include <cerrno>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <fcntl.h>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <sys/mman.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <unistd.h>
#include "ultrahdr_api.h"

extern "C" {
int irodori_encode(void*, unsigned, unsigned, void*, unsigned, int, float);
void* irodori_output();
unsigned irodori_size();
const char* irodori_error();
void irodori_release();
}

namespace {
unsigned integer(const char* text) {
  std::string value(text);
  size_t end = 0;
  const auto number = std::stoul(value, &end);
  if (end != value.size() || number > 32768) throw std::runtime_error("Invalid encoder argument.");
  return static_cast<unsigned>(number);
}
// These files are immutable, owned scratch inputs. Mapping avoids a second full image copy.
class Input {
 public:
  Input(const char* path, size_t maximum, size_t expected = 0) {
    const int file = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    struct stat info{};
    if (file < 0 || fstat(file, &info) || !S_ISREG(info.st_mode) || info.st_size <= 0 ||
        uint64_t(info.st_size) > maximum || (expected && uint64_t(info.st_size) != expected)) {
      if (file >= 0) close(file);
      throw std::runtime_error("Invalid native encoder input length.");
    }
    size = static_cast<size_t>(info.st_size);
    data = mmap(nullptr, size, PROT_READ, MAP_PRIVATE, file, 0);
    close(file);
    if (data == MAP_FAILED) throw std::runtime_error("Cannot map native encoder input.");
  }
  ~Input() { munmap(data, size); }
  Input(const Input&) = delete;
  Input& operator=(const Input&) = delete;
  void* data;
  size_t size;
};
void write(const char* path, const uint8_t* bytes, size_t size) {
  const int file = open(path, O_WRONLY | O_CREAT | O_EXCL, 0600);
  if (file < 0) throw std::runtime_error("Cannot create native encoder output.");
  size_t offset = 0;
  while (offset < size) {
    const auto count = ::write(file, bytes + offset, size - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) {
      close(file);
      throw std::runtime_error("Cannot write native encoder output.");
    }
    offset += static_cast<size_t>(count);
  }
  if (close(file)) throw std::runtime_error("Cannot close native encoder output.");
}
}

// Only the isolated Node export worker invokes this bundled, checksummed helper.
int main(int argc, char** argv) {
  try {
    if (argc != 8) throw std::runtime_error("Expected dimensions, quality, headroom and three owned paths.");
    const unsigned width = integer(argv[1]), height = integer(argv[2]), quality = integer(argv[3]);
    const uint64_t pixels = uint64_t(width) * height;
    size_t end = 0;
    const float headroom = std::stof(argv[4], &end);
    if (!width || !height || !quality || quality > 100 || pixels * 16 > 536870912 ||
        end != std::strlen(argv[4]) || !std::isfinite(headroom) || headroom < 1 || headroom > 10)
      throw std::runtime_error("Unsupported native encoder allocation or dimensions.");
    const Input half(argv[5], 536870912, pixels * 8);
    const Input jpeg(argv[6], 268435456);
    if (pixels * 56 + jpeg.size * 3 + 134217728 > 2147483648ULL)
      throw std::runtime_error("HDR JPEG exceeds the supported encoder allocation limit.");
    if (!irodori_encode(half.data, width, height, jpeg.data, jpeg.size, quality, headroom))
      throw std::runtime_error(irodori_error());
    auto* start = static_cast<uint8_t*>(irodori_output());
    const auto size = irodori_size();
    if (!start || !size) throw std::runtime_error("Native encoder returned no image.");
    // Probe the live encoder stream without copying it or decoding the photograph again.
    std::unique_ptr<uhdr_codec_private_t, decltype(&uhdr_release_decoder)> probe(
        uhdr_create_decoder(), uhdr_release_decoder);
    if (!probe) throw std::bad_alloc();
    uhdr_compressed_image_t image{start, size, size, UHDR_CG_UNSPECIFIED,
                                 UHDR_CT_UNSPECIFIED, UHDR_CR_UNSPECIFIED};
    const auto set = uhdr_dec_set_image(probe.get(), &image);
    if (set.error_code != UHDR_CODEC_OK || uhdr_dec_probe(probe.get()).error_code != UHDR_CODEC_OK ||
        !uhdr_dec_get_gainmap_metadata(probe.get()) ||
        uhdr_dec_get_image_width(probe.get()) != width ||
        uhdr_dec_get_image_height(probe.get()) != height ||
        uhdr_dec_get_gainmap_width(probe.get()) != width ||
        uhdr_dec_get_gainmap_height(probe.get()) != height)
      throw std::runtime_error("Invalid native HDR JPEG rendition geometry.");
    struct rusage usage{};
    if (getrusage(RUSAGE_SELF, &usage) || usage.ru_maxrss <= 0)
      throw std::runtime_error("Cannot measure native encoder allocation.");
    // macOS reports ru_maxrss in bytes. Other platforms retain the WASM backend.
    if (uint64_t(usage.ru_maxrss) > 2147483648ULL)
      throw std::runtime_error("Native HDR JPEG exceeded the 2 GiB process memory limit.");
    write(argv[7], start, size);
    irodori_release();
    std::cout << "{\"width\":" << width << ",\"height\":" << height
              << ",\"peakBytes\":" << usage.ru_maxrss << "}\n";
    return 0;
  } catch (const std::exception& error) {
    irodori_release();
    std::cerr << error.what() << '\n';
    return 1;
  }
}
