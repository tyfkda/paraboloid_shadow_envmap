const kMaxNumLights = 32;

override lightDirection: f32 = 1.0;

struct Light {
    // Parameters.
    color: vec3<f32>,
    param: vec4<f32>,  // radius-xz, radius-y
    rotSpeed: vec3<f32>,

    // Output:
    viewProjMatrix: mat4x4<f32>,
    pos: vec3<f32>,
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
    var d = pos.xyz / shadowZ;
    d.z *= lightDirection;
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
