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

@vertex
fn main(
    @location(0) position: vec3<f32>
) -> @builtin(position) vec4<f32> {
    let light = light_info.lights[light_index];
    return light.viewProjMatrix * model.modelMatrix * vec4(position, 1.0);
}
