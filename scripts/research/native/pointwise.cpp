// Research-only persistent CPU service; no Electron ABI or filesystem access.
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cerrno>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <vector>
#include <unistd.h>

namespace {
constexpr uint32_t requestMagic = 0x31554d4c, responseMagic = 0x31524d4c;
constexpr uint64_t maximumBytes = 128 * 1024 * 1024;
// Bulk POSIX pipe I/O on the two research platforms (macOS/Linux). libc++ stream
// transport is a separate measured variant, not an inherent C++ compute cost.
bool readExact(void* memory, size_t size) {
  auto* bytes = static_cast<unsigned char*>(memory);
  size_t offset = 0;
  while (offset < size) {
    const ssize_t count = ::read(STDIN_FILENO, bytes + offset, size - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count < 0) throw std::runtime_error("Request pipe failed.");
    if (count == 0) {
      if (offset) throw std::runtime_error("Truncated request.");
      return false;
    }
    offset += size_t(count);
  }
  return true;
}
void writeExact(const void* memory, size_t size) {
  const auto* bytes = static_cast<const unsigned char*>(memory);
  size_t offset = 0;
  while (offset < size) {
    const ssize_t count = ::write(STDOUT_FILENO, bytes + offset, size - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) throw std::runtime_error("Response pipe closed.");
    offset += size_t(count);
  }
}
uint32_t integer(const unsigned char* p) {
  return uint32_t(p[0]) | uint32_t(p[1]) << 8 | uint32_t(p[2]) << 16 | uint32_t(p[3]) << 24;
}
double real(const unsigned char* p) {
  uint64_t bits = uint64_t(integer(p)) | uint64_t(integer(p + 4)) << 32;
  double value; std::memcpy(&value, &bits, 8); return value;
}
void putInteger(unsigned char* p, uint32_t n) { for (int i = 0; i < 4; i++) p[i] = (n >> (8 * i)) & 255; }
void putReal(unsigned char* p, double n) {
  uint64_t bits; std::memcpy(&bits, &n, 8);
  putInteger(p, uint32_t(bits)); putInteger(p + 4, uint32_t(bits >> 32));
}
class Pool {
 public:
  explicit Pool(unsigned count) : count(count) {
    if (count == 1) return;
    for (unsigned i = 0; i < count; i++) workers.emplace_back([this, i] {
      size_t seen = 0;
      std::unique_lock<std::mutex> lock(mutex);
      for (;;) {
        start.wait(lock, [&] { return stopping || generation != seen; });
        if (stopping) return;
        seen = generation;
        lock.unlock();
        process(i);
        lock.lock();
        if (++completed == this->count) done.notify_one();
      }
    });
  }
  ~Pool() {
    { std::lock_guard<std::mutex> lock(mutex); stopping = true; }
    start.notify_all();
    for (auto& worker : workers) worker.join();
  }
  void run(std::vector<float>& data, double ev, double amount) {
    this->data = &data; gain = std::exp2(ev); this->amount = amount; valid = true;
    if (count == 1) process(0);
    else {
      { std::lock_guard<std::mutex> lock(mutex); completed = 0; generation++; }
      start.notify_all();
      std::unique_lock<std::mutex> lock(mutex);
      done.wait(lock, [&] { return completed == count; });
    }
    if (!valid) throw std::runtime_error("Nonfinite pixels.");
  }
 private:
  void process(unsigned worker) {
    const size_t pixels = data->size() / 4;
    for (size_t p = pixels * worker / count; p < pixels * (worker + 1) / count; p++) {
      for (unsigned c = 0; c < 4; c++) {
        float& value = (*data)[p * 4 + c];
        if (!std::isfinite(value)) { valid = false; continue; }
        if (c == 3) continue;
        value = float(double(value) * gain); // Retain the explicit Float32 stage boundary.
        const double v = value;
        value = float(v + amount * v * std::abs(v) / (1 + std::abs(v)));
      }
    }
  }
  unsigned count, completed = 0;
  size_t generation = 0;
  bool stopping = false;
  double gain = 1, amount = 0;
  std::atomic<bool> valid{true};
  std::vector<float>* data = nullptr;
  std::vector<std::thread> workers;
  std::mutex mutex;
  std::condition_variable start, done;
};
}
int main(int argc, char** argv) {
  try {
    if (argc != 2 || std::strlen(argv[1]) != 1 || argv[1][0] < '1' || argv[1][0] > '8')
      throw std::runtime_error("Expected a bounded thread count from 1 to 8.");
    const uint16_t endian = 1;
    if (*reinterpret_cast<const unsigned char*>(&endian) != 1) throw std::runtime_error("Little-endian host required.");
    Pool pool(unsigned(argv[1][0] - '0'));
    std::vector<float> data;
    unsigned char header[32];
    while (readExact(header, sizeof(header))) {
      const uint32_t width = integer(header + 4), height = integer(header + 8);
      const uint64_t bytes = uint64_t(width) * height * 16;
      const double ev = real(header + 16), amount = real(header + 24);
      if (integer(header) != requestMagic || !width || !height || width > 32768 || height > 32768 || bytes > maximumBytes ||
          !std::isfinite(ev) || ev < -5 || ev > 5 || !std::isfinite(amount) || amount < -0.9 || amount > 1)
        throw std::runtime_error("Invalid research frame contract.");
      // Equal-size requests retain a single owned allocation across photographs.
      data.resize(bytes / sizeof(float));
      if (!readExact(data.data(), bytes)) throw std::runtime_error("Truncated frame.");
      const auto start = std::chrono::steady_clock::now();
      pool.run(data, ev, amount);
      const auto ns = std::chrono::duration<double, std::nano>(std::chrono::steady_clock::now() - start).count();
      putInteger(header, responseMagic); putReal(header + 16, ns); putReal(header + 24, double(data.capacity() * sizeof(float)));
      writeExact(header, sizeof(header));
      writeExact(data.data(), bytes);
    }
    return 0;
  } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
