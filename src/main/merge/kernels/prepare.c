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
  GAIN_KEYS, GAIN_VALUES, CAPACITY, HAS_MASK, GAIN_CACHE_ENTRIES,
  SENSOR_INPUT, SENSOR_CFA, SENSOR_THRESHOLDS, SENSOR_MODE, SENSOR_CAPACITY,
  ALPHA, CHANGED, CHANGE_COUNT, REPAIR_ORIGINAL
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
static int mask_clipped(const double *p, double qx, double qy,
                        double radius, int channel, const uint8_t *mask) {
  const float *lut = (const float *)ptr(p[LUT]);
  const int raw_width = (int)p[RAW_WIDTH], raw_height = (int)p[RAW_HEIGHT];
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
static int channel_clipped(const double *p, double qx, double qy,
                           double radius, int channel) {
  return mask_clipped(p, qx, qy, radius, channel,
      (const uint8_t *)ptr(p[MASK]) + channel * (int)p[RAW_WIDTH] * (int)p[RAW_HEIGHT]);
}

int luma_kernel_version(void) { return 3; }

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

static void dilate_sensor_run(uint8_t *mask, int width, int height,
                              int y, int first, int end) {
  const int left = clamp_int(first - 2, 0, width);
  const int right = clamp_int(end, 0, width);
  const int top = clamp_int(y - 2, 0, height), bottom = clamp_int(y + 3, 0, height);
  const v128_t ones = wasm_i8x16_splat(1);
  for (int yy = top; yy < bottom; yy++) {
    uint8_t *line = mask + yy * width;
    int x = left;
    for (; x + 16 <= right; x += 16) wasm_v128_store(line + x, ones);
    for (; x < right; x++) line[x] = 1;
  }
}

// Input is a packed active-sensor strip; dilated output remains in native sensor
// coordinates. Camera masks keep the two green CFA positions in one channel.
int luma_sensor_mask(double *p, int top, int rows) {
  const int width = (int)p[RAW_WIDTH], height = (int)p[RAW_HEIGHT];
  const int channel_masks = (int)p[SENSOR_MODE];
  if (top < 0 || rows < 1 || rows > 64 || top + rows > height ||
      width < 1 || width * rows > (int)p[SENSOR_CAPACITY] ||
      (channel_masks != 0 && channel_masks != 1)) return 3;
  const uint16_t *input = (const uint16_t *)ptr(p[SENSOR_INPUT]);
  const int32_t *cfa = (const int32_t *)ptr(p[SENSOR_CFA]);
  const double *thresholds = (const double *)ptr(p[SENSOR_THRESHOLDS]);
  uint8_t *masks = (uint8_t *)ptr(p[MASK]);
  const int step = channel_masks ? 2 : 1;
  for (int row = 0; row < rows; row++) {
    const int y = top + row;
    for (int parity = 0; parity < step; parity++) {
      const int sensor_channel = cfa[(y & 1) * 2 + parity];
      const int channel = sensor_channel == 3 ? 1 : sensor_channel;
      int first = -1;
      for (int x = parity; x < width + step; x += step) {
        const int c = channel_masks ? sensor_channel : cfa[(y & 1) * 2 + (x & 1)];
        if (c < 0 || c > 3) return 2;
        const int clipped = x < width && (double)input[row * width + x] >= thresholds[c];
        if (clipped && first < 0) first = x;
        if (!clipped && first >= 0) {
          dilate_sensor_run(masks + (channel_masks ? channel * width * height : 0),
                            width, height, y, first, x + (channel_masks ? 1 : 2));
          first = -1;
        }
      }
    }
  }
  return 0;
}

int luma_repair_mask(double *p, int top, int rows) {
  const int width = (int)p[WIDTH];
  if (top < 0 || rows < 1 || rows > 256 || top + rows > (int)p[HEIGHT] ||
      width * rows > (int)p[CAPACITY]) return 3;
  float *pixels = (float *)ptr(p[INPUT]);
  uint8_t *original = (uint8_t *)ptr(p[REPAIR_ORIGINAL]);
  uint32_t *alpha = (uint32_t *)ptr(p[ALPHA]);
  int32_t *changed = (int32_t *)ptr(p[CHANGED]);
  const uint8_t *saturated = (const uint8_t *)ptr(p[MASK]);
  const int first = top * width;
  int count = 0;
  for (int k = 0; k < rows * width; k++) {
    const int i = first + k;
    const int a = (int)pixels[k * 4 + 3];
    original[k] = (uint8_t)a;
    alpha[i >> 5] |= (uint32_t)a << (i & 31);
  }
  for (int row = 0; row < rows; row++)
    for (int x = 0; x < width; x++) {
      const int k = row * width + x, a = original[k];
      if (row > 0 && row < rows - 1 && a == original[k - width] &&
          a == original[k + width] && (x == 0 || a == original[k - 1]) &&
          (x == width - 1 || a == original[k + 1])) continue;
      double qx, qy;
      coordinates(p, x, top + row, &qx, &qy);
      const double radius = canonical_hypot(qx, qy) / p[RADIUS];
      int clipped = 0;
      for (int c = 0; c < 3 && !clipped; c++)
        if (mask_clipped(p, qx, qy, radius, c, saturated)) clipped = 1;
      pixels[k * 4 + 3] = clipped ? 0.0f : 1.0f;
      const int i = first + k;
      if (clipped) alpha[i >> 5] &= ~(1u << (i & 31));
      else alpha[i >> 5] |= 1u << (i & 31);
      if (clipped && a) changed[count++] = i;
    }
  p[CHANGE_COUNT] = (double)count;
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

// Ordered source-pixel area contributions. The host flattens the authoritative
// Float64 tables without changing their values or x-before-y contribution order.
enum {
  RED_WIDTH, RED_HEIGHT, REDUCED_WIDTH, REDUCED_HEIGHT, RED_CHANNELS,
  RED_X_OFFSETS, RED_X_TARGETS, RED_X_WEIGHTS,
  RED_Y_OFFSETS, RED_Y_TARGETS, RED_Y_WEIGHTS, RED_ROW_LAST,
  RED_TOTALS, RED_COUNTS, RED_SUMS, RED_ROW_IDS, RED_INPUT, RED_LUMA,
  RED_EMIT_DATA, RED_EMIT_MASKS, RED_EMIT_ROWS, RED_EMIT_COUNT,
  RED_EMIT_CAPACITY, RED_THRESHOLD
};

static int emit_reduced_row(double *p, int slot) {
  const int width = (int)p[REDUCED_WIDTH], channels = (int)p[RED_CHANNELS];
  const int row_pixels = width * 2, emitted = (int)p[RED_EMIT_COUNT];
  if (emitted >= (int)p[RED_EMIT_CAPACITY]) return 5;
  int32_t *ids = (int32_t *)ptr(p[RED_ROW_IDS]);
  double *totals = (double *)ptr(p[RED_TOTALS]);
  double *counts = (double *)ptr(p[RED_COUNTS]);
  double *camera = (double *)ptr(p[RED_SUMS]);
  float *luma = (float *)ptr(p[RED_SUMS]);
  float *data = (float *)ptr(p[RED_EMIT_DATA]);
  uint8_t *masks = (uint8_t *)ptr(p[RED_EMIT_MASKS]);
  int32_t *rows = (int32_t *)ptr(p[RED_EMIT_ROWS]);
  rows[emitted] = ids[slot];
  for (int x = 0; x < width; x++) {
    const int at = slot * width + x;
    for (int c = 0; c < channels; c++) {
      const int k = c * row_pixels + at;
      const int out = (emitted * channels + c) * width + x;
      const int valid = counts[k] > 0.0 &&
                        __builtin_fabs(counts[k] - totals[at]) < 1e-8;
      masks[out] = valid ? 255 : 0;
      const double sum = channels == 3 ? camera[k] : (double)luma[k];
      data[out] = valid ? (float)(sum / counts[k]) : 0.0f;
      counts[k] = 0.0;
      if (channels == 3) camera[k] = 0.0;
      else luma[k] = 0.0f;
    }
    totals[at] = 0.0;
  }
  ids[slot] = -1;
  p[RED_EMIT_COUNT] = (double)(emitted + 1);
  return 0;
}

int luma_reduce_strip(double *p, int top, int rows) {
  const int width = (int)p[RED_WIDTH], height = (int)p[RED_HEIGHT];
  const int reduced_width = (int)p[REDUCED_WIDTH];
  const int channels = (int)p[RED_CHANNELS], row_pixels = reduced_width * 2;
  if (top < 0 || rows < 1 || rows > 64 || top + rows > height ||
      width < 1 || reduced_width < 1 || reduced_width > width ||
      (int)p[REDUCED_HEIGHT] < 1 || (int)p[REDUCED_HEIGHT] > height ||
      (channels != 1 && channels != 3) || p[RED_EMIT_CAPACITY] < 1.0) return 3;
  const uint32_t *xs = (const uint32_t *)ptr(p[RED_X_OFFSETS]);
  const uint32_t *ys = (const uint32_t *)ptr(p[RED_Y_OFFSETS]);
  const int32_t *xt = (const int32_t *)ptr(p[RED_X_TARGETS]);
  const int32_t *yt = (const int32_t *)ptr(p[RED_Y_TARGETS]);
  const double *xw = (const double *)ptr(p[RED_X_WEIGHTS]);
  const double *yw = (const double *)ptr(p[RED_Y_WEIGHTS]);
  const int32_t *last = (const int32_t *)ptr(p[RED_ROW_LAST]);
  int32_t *ids = (int32_t *)ptr(p[RED_ROW_IDS]);
  const float *input = (const float *)ptr(p[RED_INPUT]);
  const double *luma = (const double *)ptr(p[RED_LUMA]);
  double *totals = (double *)ptr(p[RED_TOTALS]);
  double *counts = (double *)ptr(p[RED_COUNTS]);
  double *camera_sums = (double *)ptr(p[RED_SUMS]);
  float *luma_sums = (float *)ptr(p[RED_SUMS]);
  p[RED_EMIT_COUNT] = 0.0;
  for (int row = 0; row < rows; row++) {
    const int y = top + row;
    for (int x = 0; x < width; x++) {
      const int pixel = row * width + x;
      const int valid = (int)input[pixel * 4 + 3];
      for (uint32_t xi = xs[x]; xi < xs[x + 1]; xi++)
        for (uint32_t yi = ys[y]; yi < ys[y + 1]; yi++) {
          const int px = xt[xi], py = yt[yi], slot = py & 1;
          if (px < 0 || px >= reduced_width || py < 0 || py >= (int)p[REDUCED_HEIGHT]) return 2;
          if (ids[slot] < 0) ids[slot] = py;
          if (ids[slot] != py) return 5;
          const int at = slot * reduced_width + px;
          const double weight = xw[xi] * yw[yi];
          totals[at] += weight;
          for (int c = 0; c < channels; c++) {
            const double value = channels == 3 ? (double)input[pixel * 4 + c] : luma[pixel];
            const int usable = channels == 3 ? valid & (1 << c) : valid;
            if (usable && value > p[RED_THRESHOLD]) {
              const int k = c * row_pixels + at;
              // The luma recipe rounds every individual update to Float32.
              if (channels == 3) camera_sums[k] += value * weight;
              else luma_sums[k] = (float)((double)luma_sums[k] + value * weight);
              counts[k] += weight;
            }
          }
        }
    }
    for (int slot = 0; slot < 2; slot++)
      if (ids[slot] >= 0 && last[ids[slot]] == y) {
        const int status = emit_reduced_row(p, slot);
        if (status) return status;
      }
  }
  return 0;
}
