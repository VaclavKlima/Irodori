/** Irodori's rational highlight shoulder, adapted from Reinhard et al. (2002). */
export const highlightsModule = {
  id: 'highlights',
  version: 1,
  parameters: { highlights: { min: -100, max: 100, step: 1, default: 0 } },
  cpu: (y: number, highlights: number): number => {
    if (highlights === 0 || y <= 0.18) return y
    const h = highlights / 100
    const d = y - 0.18
    const shoulder = 0.18 + (0.82 * d) / (0.82 + d)
    return (1 + h) * y - h * shoulder
  },
  glsl: `vec3 applyHighlights(vec3 inputRgb, float highlights, float white) {
    if (highlights == 0.0) return inputRgb;
    vec3 rgb = max(inputRgb, vec3(0));
    float y = dot(rgb, vec3(0.2126, 0.7152, 0.0722)) / white;
    if (y <= 0.18) return rgb;
    float h = highlights / 100.0;
    float d = y - 0.18;
    float shoulder = 0.18 + 0.82 * d / (0.82 + d);
    float curved = (1.0 + h) * y - h * shoulder;
    return rgb * (curved / y);
  }`,
  wgsl: `fn applyHighlights(input: vec3f, highlights: f32, white: f32) -> vec3f {
    if (highlights == 0.0) { return input; }
    let rgb = max(input, vec3f(0));
    let y = dot(rgb, vec3f(0.2126, 0.7152, 0.0722)) / white;
    if (y <= 0.18) { return rgb; }
    let h = highlights / 100.0;
    let d = y - 0.18;
    let shoulder = 0.18 + 0.82 * d / (0.82 + d);
    let curved = (1.0 + h) * y - h * shoulder;
    return rgb * (curved / y);
  }`,
} as const
