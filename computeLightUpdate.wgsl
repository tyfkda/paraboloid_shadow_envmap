const kMaxNumLights = 32;

override lightDirection: f32 = 1.0;

struct Light {
    // Parameters.
    color: vec3<f32>,
    param: vec4<f32>,  // radius-xz, radius-y, far
    rotSpeed: vec3<f32>,

    // Output:
    viewProjMatrix: mat4x4<f32>,
    pos: vec3<f32>,
}
struct LightInfo {
    numLights : u32,
    lights: array<Light, kMaxNumLights>,
}
@group(0) @binding(0) var<storage, read_write> light_info : LightInfo;

struct Uniform {
    nowInSecond: f32,
    workgroupWidth: u32,
};
@group(0) @binding(1) var<uniform> param: Uniform;

const origin = vec3<f32>(0.0, 0.0, 0.0);
const upVector = vec3<f32>(0.0, 1.0, 0.0);

fn lookAt(eye: vec3<f32>, targetPos: vec3<f32>, up: vec3<f32>) -> mat4x4<f32> {
    let zaxis = normalize(eye - targetPos);
    let xaxis = normalize(cross(up, zaxis));
    let yaxis = cross(zaxis, xaxis);

    let result = mat4x4<f32>(
        vec4<f32>(xaxis.x, yaxis.x, zaxis.x, 0.0),
        vec4<f32>(xaxis.y, yaxis.y, zaxis.y, 0.0),
        vec4<f32>(xaxis.z, yaxis.z, zaxis.z, 0.0),
        vec4<f32>(-dot(xaxis, eye), -dot(yaxis, eye), -dot(zaxis, eye), 1.0)
    );
    return result;
}

fn updateLight(index: u32) {
    let light = light_info.lights[index];

    let t = param.nowInSecond;
    let r = light.param.x;
    let ry = light.param.y;
    let far = light.param.z;

    let lightPosition = vec3(
        sin(light.rotSpeed.x * t) * r,
        35 + ry * sin(light.rotSpeed.y * t),
        cos(light.rotSpeed.z * t) * r);

    let lightViewMatrix = lookAt(lightPosition, origin, upVector);
    let invfar = 1.0 / far;
    let lightProjectionMatrix = mat4x4<f32>(
        invfar, 0.0,  0.0, 0.0,
        0.0, invfar,  0.0, 0.0,
        0.0, 0.0, -invfar, 0.0,
        0.0, 0.0,  0.0, 1.0);

    let lightViewProjMatrix = lightProjectionMatrix * lightViewMatrix;

    light_info.lights[index].viewProjMatrix = lightViewProjMatrix;
    light_info.lights[index].pos = lightPosition;
}

const WORKGROUP_SIZE = 8;

@compute
@workgroup_size(WORKGROUP_SIZE, WORKGROUP_SIZE)
fn main(@builtin(global_invocation_id) cell: vec3u) {
    let index = cell.y * param.workgroupWidth + cell.x;
    if (index < light_info.numLights) {
        updateLight(index);
    }
}
