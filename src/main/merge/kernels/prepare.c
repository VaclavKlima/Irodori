// SPDX-License-Identifier: MIT
// Exact Float64 strip kernels. Build without reassociation, contraction or libc.
#include <stdint.h>
#include <wasm_simd128.h>

__attribute__((import_module("env"), import_name("hypot")))
extern double canonical_hypot(double x, double y);

// The standalone reactor has no libc or static constructors to initialize.
void _initialize(void) {}

// Float64 config slots shared with cpu-kernels.ts. Pointers are exact wasm32
// byte offsets. The host validates dimensions and owns every allocation.
enum {
  WIDTH, HEIGHT, RAW_WIDTH, RAW_HEIGHT, FLIP, PLAN_WIDTH, PLAN_HEIGHT,
  PLAN_LEFT, PLAN_TOP, CX, CY, RADIUS, INPUT, OUTPUT, LUMA, MASK,
  LUT, MATRIX, GAINS, ROI_LEFT, ROI_TOP, ROI_WIDTH, ROI_HEIGHT,
  GAIN_KEYS, GAIN_VALUES, CAPACITY, HAS_MASK, GAIN_CACHE_ENTRIES
};

static void *ptr(double offset) { return (void *)(uintptr_t)(uint32_t)offset; }
static int clamp_int(int value, int lower, int upper) {
  return value < lower ? lower : value > upper ? upper : value;
}
static double radial(const float *lut, double radius, int channel) {
  double position = radius * 4095.0;
  if (position < 0.0) position = 0.0;
  if (position > 4095.0) position = 4095.0;
  int i = (int)__builtin_floor(position);
  if (i > 4094) i = 4094;
  const double f = position - i;
  return (double)lut[i * 4 + channel] * (1.0 - f) +
         (double)lut[(i + 1) * 4 + channel] * f;
}
// Each lane is an independent row. No horizontal reduction or fused operation
// changes the original ((a*x + b*y) + c*z) operation order.
static v128_t pair_rows(const double *matrix, int stride,
                       double a, double b, double c) {
  const v128_t first = wasm_f64x2_mul(
      wasm_f64x2_make(matrix[0], matrix[stride]), wasm_f64x2_splat(a));
  const v128_t second = wasm_f64x2_mul(
      wasm_f64x2_make(matrix[1], matrix[stride + 1]), wasm_f64x2_splat(b));
  const v128_t third = wasm_f64x2_mul(
      wasm_f64x2_make(matrix[2], matrix[stride + 2]), wasm_f64x2_splat(c));
  return wasm_f64x2_add(wasm_f64x2_add(first, second), third);
}
static void coordinates(const double *p, int x, int y, double *qx, double *qy) {
  const int flip = (int)p[FLIP];
  int sx = flip & 4 ? y : x, sy = flip & 4 ? x : y;
  if (flip & 1) sx = (int)p[PLAN_WIDTH] - 1 - sx;
  if (flip & 2) sy = (int)p[PLAN_HEIGHT] - 1 - sy;
  *qx = (double)(sx + (int)p[PLAN_LEFT]) - p[CX];
  *qy = (double)(sy + (int)p[PLAN_TOP]) - p[CY];
}
static int channel_clipped(const double *p, double qx, double qy,
                           double radius, int channel) {
  const float *lut = (const float *)ptr(p[LUT]);
  const int raw_width = (int)p[RAW_WIDTH], raw_height = (int)p[RAW_HEIGHT];
  const uint8_t *mask = (const uint8_t *)ptr(p[MASK]) +
                        channel * raw_width * raw_height;
  const double scale = radial(lut, radius, channel);
  const double px = p[CX] + qx * scale, py = p[CY] + qy * scale;
  const int ix = (int)__builtin_floor(px), iy = (int)__builtin_floor(py);
  const double dx = px - ix, dy = py - iy;
  for (int yy = 0; yy < 2; yy++)
    for (int xx = 0; xx < 2; xx++)
      if ((xx ? dx : 1.0 - dx) * (yy ? dy : 1.0 - dy) > 0.0 &&
          mask[clamp_int(iy + yy, 0, raw_height - 1) * raw_width +
               clamp_int(ix + xx, 0, raw_width - 1)])
        return 1;
  return 0;
}

int luma_kernel_version(void) { return 2; }

int luma_camera_strip(double *p, int top, int rows) {
  const int width = (int)p[WIDTH];
  if (top < 0 || rows < 1 || top + rows > (int)p[HEIGHT] ||
      width * rows > (int)p[CAPACITY]) return 3;
  const float *input = (const float *)ptr(p[INPUT]);
  float *output = (float *)ptr(p[OUTPUT]);
  const double *inverse = (const double *)ptr(p[MATRIX]);
  for (int row = 0; row < rows; row++)
    for (int x = 0; x < width; x++) {
      const int at = (row * width + x) * 4;
      const v128_t pair = pair_rows(inverse, 3, input[at], input[at + 1], input[at + 2]);
      const double r = wasm_f64x2_extract_lane(pair, 0);
      const double g = wasm_f64x2_extract_lane(pair, 1);
      const double b = inverse[6] * input[at] + inverse[7] * input[at + 1] +
                       inverse[8] * input[at + 2];
      if (!__builtin_isfinite(r) || !__builtin_isfinite(g) || !__builtin_isfinite(b)) return 1;
      output[at] = (float)r;
      output[at + 1] = (float)g;
      output[at + 2] = (float)b;
      int valid = 7;
      if (p[HAS_MASK]) {
        double qx, qy;
        coordinates(p, x, top + row, &qx, &qy);
        const double radius = canonical_hypot(qx, qy) / p[RADIUS];
        for (int channel = 0; channel < 3; channel++)
          if (channel_clipped(p, qx, qy, radius, channel)) valid &= ~(1 << channel);
      }
      output[at + 3] = (float)valid;
    }
  return 0;
}

static double gain_at(const double *p, int x, int y) {
  const int key = y * (int)p[RAW_WIDTH] + x;
  const int slot = key & ((int)p[GAIN_CACHE_ENTRIES] - 1);
  int32_t *keys = (int32_t *)ptr(p[GAIN_KEYS]);
  double *values = (double *)ptr(p[GAIN_VALUES]);
  if (keys[slot] != key) {
    const double radius = canonical_hypot((double)x - p[CX], (double)y - p[CY]) / p[RADIUS];
    values[slot] = radial((const float *)ptr(p[LUT]), radius, 3);
    keys[slot] = key;
  }
  return values[slot];
}

int luma_prepare_strip(double *p, int top, int rows) {
  if (p[GAIN_CACHE_ENTRIES] != 2048.0 && p[GAIN_CACHE_ENTRIES] != 32768.0) return 4;
  const int width = (int)p[WIDTH], raw_width = (int)p[RAW_WIDTH], raw_height = (int)p[RAW_HEIGHT];
  if (top < 0 || rows < 1 || top + rows > (int)p[HEIGHT] ||
      width * rows > (int)p[CAPACITY]) return 3;
  const float *input = (const float *)ptr(p[INPUT]), *lut = (const float *)ptr(p[LUT]);
  float *output = (float *)ptr(p[OUTPUT]);
  double *luma = (double *)ptr(p[LUMA]);
  const uint8_t *saturated = (const uint8_t *)ptr(p[MASK]);
  const double *matrix = (const double *)ptr(p[MATRIX]), *working = matrix + 12;
  const double *gains = (const double *)ptr(p[GAINS]);
  for (int row = 0; row < rows; row++)
    for (int x = 0; x < width; x++) {
      double qx, qy;
      coordinates(p, x, top + row, &qx, &qy);
      const double radius = canonical_hypot(qx, qy) / p[RADIUS];
      double camera[3];
      int clipped = 0;
      for (int c = 0; c < 3; c++) {
        const double scale = radial(lut, radius, c);
        const double px = p[CX] + qx * scale, py = p[CY] + qy * scale;
        const int ix = (int)__builtin_floor(px), iy = (int)__builtin_floor(py);
        const double dx = px - ix, dy = py - iy;
        double value = 0.0;
        for (int yy = 0; yy < 2; yy++)
          for (int xx = 0; xx < 2; xx++) {
            const int tx = clamp_int(ix + xx, 0, raw_width - 1);
            const int ty = clamp_int(iy + yy, 0, raw_height - 1);
            const int rx = tx - (int)p[ROI_LEFT], ry = ty - (int)p[ROI_TOP];
            if (rx < 0 || ry < 0 || rx >= (int)p[ROI_WIDTH] || ry >= (int)p[ROI_HEIGHT]) return 2;
            const double weight = (xx ? dx : 1.0 - dx) * (yy ? dy : 1.0 - dy);
            value += (double)input[(ry * (int)p[ROI_WIDTH] + rx) * 4 + c] * weight * gain_at(p, tx, ty);
            if (weight > 0.0 && saturated[ty * raw_width + tx]) clipped = 1;
          }
        camera[c] = (((value * gains[0]) / gains[2 + c]) * gains[5 + c]) / gains[1];
      }
      const v128_t camera_pair = pair_rows(matrix, 4, camera[0], camera[1], camera[2]);
      const double cr = wasm_f64x2_extract_lane(camera_pair, 0);
      const double cg = wasm_f64x2_extract_lane(camera_pair, 1);
      const double cb = matrix[8] * camera[0] + matrix[9] * camera[1] + matrix[10] * camera[2];
      const v128_t pair = pair_rows(working, 3, cr, cg, cb);
      const double r = wasm_f64x2_extract_lane(pair, 0), g = wasm_f64x2_extract_lane(pair, 1);
      const double b = working[6] * cr + working[7] * cg + working[8] * cb;
      const int at = (row * width + x) * 4;
      output[at] = (float)r;
      output[at + 1] = (float)g;
      output[at + 2] = (float)b;
      output[at + 3] = clipped ? 0.0f : 1.0f;
      const double value = r * working[9] + g * working[10] + b * working[11];
      luma[at / 4] = value > 0.0 ? value : value == value ? 0.0 : value;
    }
  return 0;
}
