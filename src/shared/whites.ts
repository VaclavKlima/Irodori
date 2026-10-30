/** Irodori's versioned whites curve, in luminance normalized to display white. */
export const whitesModule = {
  id: 'whites',
  version: 1,
  parameters: { whites: { min: -100, max: 100, step: 1, default: 0 } },
  cpu: (y: number, whites: number): number => {
    if (whites === 0 || y <= 0.18) return y
    const t = Math.min(1, (y - 0.18) / 0.82)
    return y * 2 ** ((whites / 100) * t * t * (3 - 2 * t))
  },
  glsl: `vec3 applyWhites(vec3 inputRgb, float whites, float white) {
    if (whites == 0.0) return inputRgb;
    vec3 rgb = max(inputRgb, vec3(0));
    float y = dot(rgb, vec3(0.2126, 0.7152, 0.0722)) / white;
    if (y <= 0.18) return rgb;
    float t = clamp((y - 0.18) / 0.82, 0.0, 1.0);
    return rgb * exp2((whites / 100.0) * t * t * (3.0 - 2.0 * t));
  }`,
  wgsl: `fn applyWhites(input: vec3f, whites: f32, white: f32) -> vec3f {
    if (whites == 0.0) { return input; }
    let rgb = max(input, vec3f(0));
    let y = dot(rgb, vec3f(0.2126, 0.7152, 0.0722)) / white;
    if (y <= 0.18) { return rgb; }
    let t = clamp((y - 0.18) / 0.82, 0.0, 1.0);
    return rgb * exp2((whites / 100.0) * t * t * (3.0 - 2.0 * t));
  }`,
} as const
