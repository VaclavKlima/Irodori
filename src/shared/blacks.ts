/** Irodori's versioned blacks curve, in luminance normalized to display white. */
export const blacksModule = {
  id: 'blacks',
  version: 1,
  parameters: { blacks: { min: -100, max: 100, step: 1, default: 0 } },
  cpu: (y: number, blacks: number): number => {
    if (blacks === 0 || y >= 0.18) return y
    return Math.max(0, y + 0.04 * (blacks / 100) * Math.max(1 - y / 0.18, 0) ** 3)
  },
  glsl: `vec3 applyBlacks(vec3 inputRgb, float blacks, float white) {
    if (blacks == 0.0) return inputRgb;
    vec3 rgb = max(inputRgb, vec3(0));
    float y = dot(rgb, vec3(0.2126, 0.7152, 0.0722)) / white;
    float weight = max(1.0 - y / 0.18, 0.0);
    float d = 0.04 * (blacks / 100.0) * weight * weight * weight;
    if (blacks > 0.0) return rgb + vec3(d * white);
    if (y <= 0.0) return rgb;
    return rgb * (max(0.0, y + d) / y);
  }`,
  wgsl: `fn applyBlacks(input: vec3f, blacks: f32, white: f32) -> vec3f {
    if (blacks == 0.0) { return input; }
    let rgb = max(input, vec3f(0));
    let y = dot(rgb, vec3f(0.2126, 0.7152, 0.0722)) / white;
    let weight = max(1.0 - y / 0.18, 0.0);
    let d = 0.04 * (blacks / 100.0) * weight * weight * weight;
    if (blacks > 0.0) { return rgb + vec3f(d * white); }
    if (y <= 0.0) { return rgb; }
    return rgb * (max(0.0, y + d) / y);
  }`,
} as const
