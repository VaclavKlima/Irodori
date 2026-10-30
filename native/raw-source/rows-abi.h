// Isolated Sony ARW2 experiment. Keep LibRaw/dcraw notices in licenses/.
#pragma once
#include <cstddef>
#include <cstdint>
struct IrodoriRowsReport {
  double elapsedMs;
  uint64_t rows;
  uint64_t blocks;
  uint64_t samples;
  uint32_t participants;
  uint32_t observedThreads;
  uint32_t errorCode;
};
static_assert(sizeof(IrodoriRowsReport) == 48, "Pinned Linux x64 row-report ABI.");
extern "C" int irodori_rows_decode(const uint8_t* input, size_t inputLength,
  size_t width, size_t height, uint32_t order, const uint16_t* curve, size_t curveLength,
  uint16_t* output, size_t outputLength, uint32_t threads, IrodoriRowsReport* report);

