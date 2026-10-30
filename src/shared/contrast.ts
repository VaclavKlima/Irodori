/** Irodori's SDR luminance curve; this is not OpenColorIO's contrast operator. */
export const contrastModule = {
  id: 'contrast',
  version: 1,
  parameters: { contrast: { min: -100, max: 100, step: 1, default: 0 } },
  pivot: 0.18,
  cpu: (y: number, contrast: number, strength = 2 ** (contrast / 100)): number => {
    if (contrast === 0 || y <= 0 || y >= 1) return y
    return y <= 0.18 ? 0.18 * (y / 0.18) ** strength : 1 - 0.82 * ((1 - y) / 0.82) ** strength
  },
  glsl: `vec3 applyContrast(vec3 rgb, float contrast, float white) {
    if (contrast == 0.0) return rgb;
    rgb = max(rgb, vec3(0));
    float y = dot(rgb, vec3(0.2126, 0.7152, 0.0722)) / white;
    if (y <= 0.0 || y >= 1.0) return rgb;
    float s = exp2(contrast / 100.0);
    float curved = y <= 0.18 ? 0.18 * pow(y / 0.18, s)
      : 1.0 - 0.82 * pow((1.0 - y) / 0.82, s);
    return rgb * (curved / y);
  }`,
  wgsl: `fn applyContrast(input: vec3f, contrast: f32, white: f32) -> vec3f {
    if (contrast == 0.0) { return input; }
    let rgb = max(input, vec3f(0));
    let y = dot(rgb, vec3f(0.2126, 0.7152, 0.0722)) / white;
    if (y <= 0.0 || y >= 1.0) { return rgb; }
    let s = exp2(contrast / 100.0);
    var curved: f32;
    if (y <= 0.18) { curved = 0.18 * pow(y / 0.18, s); }
    else { curved = 1.0 - 0.82 * pow((1.0 - y) / 0.82, s); }
    return rgb * (curved / y);
  }`,
} as const
