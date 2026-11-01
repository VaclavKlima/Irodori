export const exportResizeWgsl = `
struct ResizeParams {
  width:u32, outWidth:u32, channels:u32, slot:u32,
  y:u32, horizontalIdentity:u32, verticalIdentity:u32, padding:u32
}
@group(0) @binding(0) var<uniform> resize:ResizeParams;
@group(0) @binding(1) var<storage,read> resizeInput:array<u32>;
@group(0) @binding(2) var<storage,read_write> resizeCache:array<u32>;
@group(0) @binding(3) var<storage,read_write> resizeOutput:array<u32>;
@group(0) @binding(4) var<storage,read> horizontalTaps:array<u32>;
@group(0) @binding(5) var<storage,read> verticalTaps:array<u32>;
@group(0) @binding(6) var<storage,read> resizeRows:array<u32>;

@compute @workgroup_size(64) fn resizeHorizontal(@builtin(global_invocation_id) id:vec3u) {
  let length=resize.outWidth*resize.channels;
  if(id.x>=length) {return;}
  let destination=resize.slot*length+id.x;
  if(resize.horizontalIdentity!=0u) {
    resizeCache[destination]=resizeInput[id.x];return;
  }
  let x=id.x/resize.channels;let channel=id.x%resize.channels;
  let start=horizontalTaps[x*2u];let count=horizontalTaps[x*2u+1u];
  let anchor=bitcast<f32>(resizeInput[horizontalTaps[start]*resize.channels+channel]);
  var difference=0.;
  for(var j=0u;j<count;j++) {
    let at=start+j*4u;
    let value=bitcast<f32>(resizeInput[horizontalTaps[at]*resize.channels+channel])-anchor;
    difference+=value*bitcast<f32>(horizontalTaps[at+1u]);
    difference+=value*bitcast<f32>(horizontalTaps[at+2u]);
  }
  resizeCache[destination]=bitcast<u32>(anchor+difference);
}

@compute @workgroup_size(64) fn resizeVertical(@builtin(global_invocation_id) id:vec3u) {
  let length=resize.outWidth*resize.channels;
  if(id.x>=length) {return;}
  if(resize.verticalIdentity!=0u) {
    resizeOutput[id.x]=resizeCache[resizeRows[0]*length+id.x];return;
  }
  let start=verticalTaps[resize.y*2u];let count=verticalTaps[resize.y*2u+1u];
  let anchor=bitcast<f32>(resizeCache[resizeRows[0]*length+id.x]);
  var difference=0.;
  for(var j=0u;j<count;j++) {
    let at=start+j*4u;
    let value=bitcast<f32>(resizeCache[resizeRows[j]*length+id.x])-anchor;
    difference+=value*bitcast<f32>(verticalTaps[at+1u]);
    difference+=value*bitcast<f32>(verticalTaps[at+2u]);
  }
  resizeOutput[id.x]=bitcast<u32>(anchor+difference);
}
`
