// Same ECC call, masks, motion model and stopping criteria as scripts/opencv/bridge.cpp.
#include <opencv2/core.hpp>
#include <opencv2/video/tracking.hpp>
#include <chrono>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <vector>
template<class T> std::vector<T> read(const char* path, size_t length) {
  std::ifstream file(path, std::ios::binary | std::ios::ate);
  if (!file || file.tellg() != std::streamoff(length * sizeof(T))) throw std::runtime_error("Invalid research plane length.");
  std::vector<T> data(length); file.seekg(0); file.read(reinterpret_cast<char*>(data.data()), length * sizeof(T));
  if (!file) throw std::runtime_error("Cannot read research plane."); return data;
}
int main(int argc, char** argv) {
  try {
    if (argc != 8) throw std::runtime_error("Expected dimensions, two planes, two masks, and thread count.");
    const int w = std::stoi(argv[1]), h = std::stoi(argv[2]), threads = std::stoi(argv[7]);
    if (w < 16 || h < 16 || w > 2048 || h > 2048 || threads < 1 || threads > 8) throw std::runtime_error("Invalid ECC workload.");
    auto a = read<float>(argv[3], size_t(w) * h), b = read<float>(argv[4], size_t(w) * h);
    auto am = read<unsigned char>(argv[5], size_t(w) * h), bm = read<unsigned char>(argv[6], size_t(w) * h);
    cv::setNumThreads(threads); cv::setRNGSeed(0);
    cv::Mat matrix = cv::Mat::eye(3, 3, CV_32F);
    const auto start = std::chrono::steady_clock::now();
    const double score = cv::findTransformECCWithMask(cv::Mat(h, w, CV_32F, a.data()), cv::Mat(h, w, CV_32F, b.data()),
      cv::Mat(h, w, CV_8U, am.data()), cv::Mat(h, w, CV_8U, bm.data()), matrix, cv::MOTION_HOMOGRAPHY,
      cv::TermCriteria(cv::TermCriteria::COUNT | cv::TermCriteria::EPS, 80, 1e-7), 5);
    const auto ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
    std::cout.precision(12);
    std::cout << "{\"library\":\"" << CV_VERSION << "\",\"threads\":" << threads << ",\"score\":" << score << ",\"computeMs\":" << ms << ",\"matrix\":[";
    for (int i = 0; i < 9; i++) std::cout << (i ? "," : "") << matrix.ptr<float>()[i];
    std::cout << "]}\n";
  } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
