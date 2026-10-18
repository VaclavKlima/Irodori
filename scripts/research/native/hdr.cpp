// Isolated research wrapper around the unchanged production Ultra HDR bridge.
#include <chrono>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <vector>
extern "C" {
int luma_encode(void*, unsigned, unsigned, void*, unsigned, int, float);
void* luma_output(); unsigned luma_size(); const char* luma_error(); void luma_release();
}
std::vector<char> read(const char* path, size_t maximum) {
  std::ifstream file(path, std::ios::binary | std::ios::ate);
  const auto size = file.tellg();
  if (!file || size <= 0 || uint64_t(size) > maximum) throw std::runtime_error("Invalid HDR input length.");
  std::vector<char> data(static_cast<size_t>(size)); file.seekg(0); file.read(data.data(), size);
  if (!file) throw std::runtime_error("Cannot read HDR input."); return data;
}
int main(int argc, char** argv) {
  try {
    if (argc != 6) throw std::runtime_error("Expected dimensions, owned half/JPEG inputs and output.");
    const unsigned width = std::stoul(argv[1]), height = std::stoul(argv[2]);
    if (!width || !height || width > 8192 || height > 8192 || uint64_t(width) * height * 8 > 128 * 1024 * 1024) throw std::runtime_error("Invalid HDR dimensions.");
    auto half = read(argv[3], 128 * 1024 * 1024), jpeg = read(argv[4], 64 * 1024 * 1024);
    if (half.size() != uint64_t(width) * height * 8) throw std::runtime_error("Half-float dimensions differ.");
    const auto start = std::chrono::steady_clock::now();
    if (!luma_encode(half.data(), width, height, jpeg.data(), unsigned(jpeg.size()), 100, 10)) throw std::runtime_error(luma_error());
    const auto ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
    std::ofstream output(argv[5], std::ios::binary | std::ios::out);
    output.write(static_cast<char*>(luma_output()), luma_size());
    if (!output) throw std::runtime_error("Cannot write HDR output.");
    std::cout << "{\"computeMs\":" << ms << ",\"bytes\":" << luma_size() << "}\n";
    luma_release();
  } catch (const std::exception& error) { luma_release(); std::cerr << error.what() << '\n'; return 1; }
}
