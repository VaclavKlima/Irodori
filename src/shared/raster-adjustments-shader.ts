import {
  blacksModule,
  contrastModule,
  exposureModule,
  highlightsModule,
  shadowsModule,
  whitesModule,
} from './adjustments'
import { colorIntensityGlsl, colorIntensityWgsl } from './color-intensity'
import { creativeColorGlsl } from './creative-color-glsl'
import { creativeColorWgsl } from './creative-color-gpu'

/** One authored-image operator order for live presentation and streamed output.
 * GLSL and WGSL are API frontends for the same stage, on both supported platforms. */
export function rasterAdjustmentShader(language: 'glsl' | 'wgsl', creative = false, binding = 12) {
  const modules = [
    exposureModule,
    contrastModule,
    highlightsModule,
    shadowsModule,
    whitesModule,
    blacksModule,
  ]
  const math = modules.map((module) => module[language]).join('\n')
  if (language === 'glsl')
    return `${math}
${creative ? creativeColorGlsl('srgb') : colorIntensityGlsl}
vec3 rasterAdjusted(vec3 inputRgb, vec4 light, vec2 endpoints, vec2 intensity, float white) {
  vec3 rgb=max(applyExposure(inputRgb,light.x),vec3(0));
  rgb=applyContrast(rgb,light.y,white);
  rgb=applyHighlights(rgb,light.z,white);
  rgb=applyShadows(rgb,light.w,white);
  rgb=applyWhites(rgb,endpoints.x,white);
  rgb=applyBlacks(rgb,endpoints.y,white);
  ${creative ? 'rgb=applyCreativeColor(rgb/white)*white;' : 'if(any(notEqual(intensity,vec2(0)))) rgb=applyColorIntensity(rgb/white,intensity)*white;'}
  return rgb;
}`
  return `${math}
${creative ? creativeColorWgsl('srgb', binding) : colorIntensityWgsl('srgb')}
fn rasterAdjusted(inputRgb:vec3f,light:vec4f,endpoints:vec2f,intensity:vec2f,white:f32)->vec3f {
  var rgb=max(applyExposure(inputRgb,light.x),vec3f(0.));
  rgb=applyContrast(rgb,light.y,white);
  rgb=applyHighlights(rgb,light.z,white);
  rgb=applyShadows(rgb,light.w,white);
  rgb=applyWhites(rgb,endpoints.x,white);
  rgb=applyBlacks(rgb,endpoints.y,white);
  ${creative ? 'rgb=applyCreativeColor(rgb/white)*white;' : 'rgb=applyColorIntensity(rgb/white,intensity)*white;'}
  return rgb;
}`
}
