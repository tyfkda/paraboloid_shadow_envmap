override paraboloid: bool = false;
override viewDirection: f32 = 1.0;

struct Camera {
    viewProjectionMatrix : mat4x4<f32>,
    invViewProjectionMatrix : mat4x4<f32>,
}
@group(0) @binding(0) var<uniform> camera : Camera;

struct Model {
    modelMatrix : mat4x4<f32>,
}
@group(1) @binding(0) var<uniform> model : Model;

struct VertexOutput {
    @builtin(position) Position : vec4<f32>,
    @location(0) fragNormal: vec3<f32>,    // normal in world space
    @location(1) fragUV: vec2<f32>,
    @location(2) zvalue: f32,
}

@vertex
fn main(
    @location(0) position : vec3<f32>,
    @location(1) normal : vec3<f32>,
    @location(2) uv : vec2<f32>
) -> VertexOutput {
    var output : VertexOutput;
    let worldPosition = (model.modelMatrix * vec4(position, 1.0)).xyz;
    var vpPosition = camera.viewProjectionMatrix * vec4(worldPosition, 1.0);
    var zvalue = 0.0;
    var fragNormal = normalize((model.modelMatrix * vec4(normal, 0.0)).xyz);
    if (paraboloid) {
        // 放物面変換
        let shadowZ = length(vpPosition.xyz);
        var d = vpPosition.xyz / shadowZ;
        d.z *= viewDirection;
        let dd = d.xy / (d.z + 1.0);
        vpPosition = vec4(dd, shadowZ, 1);
        zvalue = d.z;
        fragNormal.z *= viewDirection;
    }
    output.Position = vpPosition;
    output.fragNormal = fragNormal;
    output.fragUV = uv;
    output.zvalue = zvalue;
    return output;
}
