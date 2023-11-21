const kMaxNumLights = 64;

struct Light {
    viewProjMatrix: mat4x4<f32>,
    pos: vec3<f32>,
    color: vec3<f32>,
}
struct LightInfo {
    numLights : u32,
    lights: array<Light, kMaxNumLights>,
}
@group(0) @binding(0) var<storage, read> light_info : LightInfo;

struct Model {
    modelMatrix: mat4x4<f32>,
}
@group(1) @binding(0) var<uniform> model : Model;

@group(2) @binding(0) var<uniform> light_index : u32;

struct VertexOutput {
    @builtin(position) Position : vec4<f32>,
    @location(0) zvalue: f32,
}

@vertex
fn vertexMain(
    @location(0) position: vec3<f32>
) -> VertexOutput {
    let light = light_info.lights[light_index];

    let pos = light.viewProjMatrix * model.modelMatrix * vec4(position, 1.0);

    // 放物面変換
    let shadowZ = length(pos.xyz);
    let d = pos.xyz / shadowZ;
    let dd = d.xy / (d.z + 1.0);

    var output : VertexOutput;
    output.Position = vec4(dd, shadowZ, 1);
    output.zvalue = d.z;
    return output;
}

@fragment
fn fragmentMain(
    @location(0) zvalue: f32,
) {
    if (zvalue < -0.05) {  // Some margin.
        discard;
    }
}
