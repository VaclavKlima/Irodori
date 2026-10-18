export { acesPrecisionData as exportPrecisionData } from '../../shared/aces-precision-wgsl'

/** Export retains its small uniform lookup while sharing preview's compensated functions. */
export const exportPrecisionWgsl = `
struct ExportMathData { values:array<vec4f,192> }
@group(0) @binding(3) var<uniform> exportMathData:ExportMathData;
fn acesMath(index:u32)->vec2f {
  let pair=exportMathData.values[index>>1u];
  return select(pair.xy,pair.zw,(index&1u)!=0u);
}
`
