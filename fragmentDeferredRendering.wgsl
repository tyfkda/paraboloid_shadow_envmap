override shadowDepthTextureSize: f32 = 256.0;

@group(0) @binding(0) var gBufferNormal: texture_2d<f32>;
@group(0) @binding(1) var gBufferAlbedo: texture_2d<f32>;
@group(0) @binding(2) var gBufferDepth: texture_depth_2d;
@group(0) @binding(3) var shadowMap: texture_depth_2d_array;
@group(0) @binding(4) var shadowSampler: sampler_comparison;

struct Scene {
    lightViewProjMatrix: mat4x4<f32>,
    cameraViewProjMatrix: mat4x4<f32>,
    lightPos: vec3<f32>,
    lightColor: vec3<f32>,
}

@group(2) @binding(0) var<uniform> scene : Scene;

struct LightData {
    position : vec4<f32>,
    color : vec3<f32>,
    radius : f32,
}
struct LightsBuffer {
    lights: array<LightData>,
}
@group(1) @binding(0) var<storage, read> lightsBuffer: LightsBuffer;

struct Config {
    numLights : u32,
}
struct Camera {
    viewProjectionMatrix : mat4x4<f32>,
    invViewProjectionMatrix : mat4x4<f32>,
}
@group(1) @binding(1) var<uniform> config: Config;
@group(1) @binding(2) var<uniform> camera: Camera;

fn world_from_screen_coord(coord : vec2<f32>, depth_sample: f32) -> vec3<f32> {
    // reconstruct world-space position from the screen coordinate.
    let posClip = vec4(coord.x * 2.0 - 1.0, (1.0 - coord.y) * 2.0 - 1.0, depth_sample, 1.0);
    let posWorldW = camera.invViewProjectionMatrix * posClip;
    let posWorld = posWorldW.xyz / posWorldW.www;
    return posWorld;
}

struct FragmentInput {
    //@location(0) shadowPos : vec3<f32>,
    //@location(1) fragPos : vec3<f32>,
    //@location(2) fragNorm : vec3<f32>,

    @builtin(position) coord : vec4<f32>,
}

@fragment
fn main(
    input : FragmentInput
) -> @location(0) vec4<f32> {
    var result : vec3<f32>;

    let depth = textureLoad(
        gBufferDepth,
        vec2<i32>(floor(input.coord.xy)),
        0
    );

    // Don't light the sky.
    if (depth >= 1.0) {
        discard;
    }

    let bufferSize = textureDimensions(gBufferDepth);
    let coordUV = input.coord.xy / vec2<f32>(bufferSize);
    let position = world_from_screen_coord(coordUV, depth);

    let normal = textureLoad(
        gBufferNormal,
        vec2<i32>(floor(input.coord.xy)),
        0
    ).xyz;

    // XY is in (-1, 1) space, Z is in (0, 1) space
    let posFromLight = scene.lightViewProjMatrix * vec4(position, 1.0);

    if (dot(posFromLight.xy, posFromLight.xy) >= 1) {
        discard;
    }

    // Convert XY to (0, 1)
    // Y is flipped because texture coords are Y-down.
    var shadowPos = vec3(
        posFromLight.xy * vec2(0.5, -0.5) + vec2(0.5),
        posFromLight.z
    );

    // Percentage-closer filtering. Sample texels in the region
    // to smooth the result.
    var visibility = 0.0;
    let oneOverShadowDepthTextureSize = 1.0 / shadowDepthTextureSize;
    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            let offset = vec2<f32>(vec2(x, y)) * oneOverShadowDepthTextureSize;
            visibility += textureSampleCompare(
                shadowMap, shadowSampler,
                shadowPos.xy + offset, 0, shadowPos.z - 0.007
            );
        }
    }
    visibility /= 9.0;

    let lambertFactor = max(dot(normalize(scene.lightPos - position), normal), 0.0);
    let lightingFactor = min(visibility * lambertFactor, 1.0);

    let albedo = textureLoad(
        gBufferAlbedo,
        vec2<i32>(floor(input.coord.xy)),
        0
    ).rgb;

    return vec4(0.5 * lightingFactor * scene.lightColor.rgb * albedo, 1.0);
}
