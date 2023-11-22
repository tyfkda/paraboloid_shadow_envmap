const kMaxNumLights : u32 = 32;

struct Camera {
    viewProjectionMatrix : mat4x4<f32>,
    // invViewProjectionMatrix : mat4x4<f32>,
}
@group(0) @binding(0) var<uniform> camera : Camera;

struct Light {
    viewProjMatrix: mat4x4<f32>,
    pos: vec3<f32>,
    color: vec3<f32>,
}
struct LightInfo {
    numLights : u32,
    lights: array<Light, kMaxNumLights>,
}
@group(1) @binding(0) var<storage, read> light_info : LightInfo;

struct VertexOutput {
    @builtin(position) Position : vec4<f32>,
    @location(0) color: vec4<f32>,
}

@vertex
fn vertexMain(
    @builtin(instance_index) instanceIdx : u32,
    @location(0) position : vec4<f32>,
) -> VertexOutput {
    var output : VertexOutput;
    output.Position = camera.viewProjectionMatrix * (vec4((light_info.lights[instanceIdx].pos + position.xyz), 1.0));
    output.color = vec4(light_info.lights[instanceIdx].color, 1.0);
    return output;
}

@fragment
fn fragmentMain(
    @location(0) color: vec4<f32>,
) -> @location(0) vec4<f32> {
    return color;
}
