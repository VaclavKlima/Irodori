// Equivalent to the existing WASM linear-camera adapter before orientation normalization.
#include <libraw/libraw.h>
#include <chrono>
#include <fstream>
#include <iostream>
#include <memory>
#include <stdexcept>
int main(int argc, char** argv) {
  try {
    if (argc != 3) throw std::runtime_error("Expected a read-only fixture and an owned output path.");
    LibRaw raw;
    auto& p = raw.imgdata.params;
    p.half_size = 0; p.user_qual = 3; p.use_camera_wb = 1; p.output_color = 0;
    p.output_bps = 16; p.gamm[0] = 1; p.gamm[1] = 1; p.no_auto_bright = 1;
    const auto started = std::chrono::steady_clock::now();
    int error = raw.open_file(argv[1]);
    if (error || (error = raw.unpack()) || (error = raw.dcraw_process())) throw std::runtime_error(libraw_strerror(error));
    std::unique_ptr<libraw_processed_image_t, decltype(&LibRaw::dcraw_clear_mem)> pixels(raw.dcraw_make_mem_image(&error), LibRaw::dcraw_clear_mem);
    if (error || !pixels || pixels->type != LIBRAW_IMAGE_BITMAP || pixels->bits != 16 || pixels->colors != 3) throw std::runtime_error("Invalid linear camera output.");
    const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
    std::ofstream output(argv[2], std::ios::binary | std::ios::out);
    output.write(reinterpret_cast<const char*>(pixels->data), pixels->data_size);
    if (!output) throw std::runtime_error("Cannot write owned research output.");
    std::cout << "{\"library\":\"" << LibRaw::version() << "\",\"width\":" << pixels->width << ",\"height\":" << pixels->height << ",\"computeMs\":" << ms << "}\n";
  } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
