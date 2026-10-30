/** Irodori's versioned shadows curve, in luminance normalized to display white. */
export const shadowsModule = {
  id: 'shadows',
  version: 1,
  parameters: { shadows: { min: -100, max: 100, step: 1, default: 0 } },
  cpu: (y: number, shadows: number): number => {
    if (shadows === 0 || y <= 0 || y >= 0.18) return y
    return y * 2 ** (2 * (shadows / 100) * (1 - y / 0.18) ** 2)
  },
  glsl: `vec3 applyShadows(vec3 inputRgb, float shadows, float white) {
    if (shadows == 0.0) return inputRgb;
    vec3 rgb = max(inputRgb, vec3(0));
    float y = dot(rgb, vec3(0.2126, 0.7152, 0.0722)) / white;
    if (y <= 0.0 || y >= 0.18) return rgb;
    float weight = 1.0 - y / 0.18;
    return rgb * exp2(2.0 * (shadows / 100.0) * weight * weight);
  }`,
  wgsl: `fn applyShadows(input: vec3f, shadows: f32, white: f32) -> vec3f {
    if (shadows == 0.0) { return input; }
    let rgb = max(input, vec3f(0));
    let y = dot(rgb, vec3f(0.2126, 0.7152, 0.0722)) / white;
    if (y <= 0.0 || y >= 0.18) { return rgb; }
    let weight = 1.0 - y / 0.18;
    return rgb * exp2(2.0 * (shadows / 100.0) * weight * weight);
  }`,
} as const
