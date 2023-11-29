const kMaxNumLights = 32;
const SHADOW_Z_OFFSET = 0.01;
const PI = 3.14159265359;
const GAMMA = 2.2;

override shadowDepthTextureSize: f32 = 1024.0;
override paraboloid: bool = false;
override viewDirection: f32 = 1.0;

@group(0) @binding(0) var gBufferNormal: texture_2d<f32>;
@group(0) @binding(1) var gBufferAlbedo: texture_2d<f32>;
@group(0) @binding(2) var gBufferDepth: texture_depth_2d;
@group(0) @binding(3) var shadowMap: texture_depth_2d_array;
@group(0) @binding(4) var shadowSampler: sampler_comparison;

struct Camera {
    viewProjectionMatrix : mat4x4<f32>,
    invViewProjectionMatrix : mat4x4<f32>,
    position: vec3<f32>,  // World camera position
}
@group(1) @binding(0) var<uniform> camera: Camera;

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
@group(2) @binding(0) var<storage, read> light_info : LightInfo;

@group(3) @binding(0) var envmap: texture_2d_array<f32>;
@group(3) @binding(1) var envmap_sampler: sampler;

fn world_from_screen_coord(coord : vec2<f32>, depth_sample: f32, zvalue: f32) -> vec3<f32> {
    // reconstruct world-space position from the screen coordinate.
    let posClip = vec4(coord.x * 2.0 - 1.0, (1.0 - coord.y) * 2.0 - 1.0, depth_sample, 1.0);
    if (paraboloid) {
        // 放物面逆変換
        let zv = zvalue * viewDirection;
        let d = vec3(posClip.xy * (zvalue + 1.0), zv);
        let shadowZ = posClip.z;
        let posInView = vec4(d * shadowZ, 1.0);
        var posWorld = (camera.invViewProjectionMatrix * posInView).xyz;
        return posWorld;
    } else {
        let posWorldW = camera.invViewProjectionMatrix * posClip;
        return posWorldW.xyz / posWorldW.www;
    }
}

struct FragmentInput {
    //@location(0) shadowPos : vec3<f32>,
    //@location(1) fragPos : vec3<f32>,
    //@location(2) fragNorm : vec3<f32>,

    @builtin(position) coord : vec4<f32>,
}

fn tonemap(rgb: vec3<f32>) -> vec3<f32> {
    return vec3(1.0) - exp(-rgb);
}

fn gamma(rgb: vec3<f32>) -> vec3<f32> {
    return pow(rgb, vec3(1.0 / GAMMA));
}

fn sampleReflection(position: vec3<f32>, normal: vec3<f32>) -> vec3<f32> {
    let v = normalize(position - camera.position);
    let dt = dot(v, normal);
    var color: vec3<f32>;
    var d = v - 2 * dt * normal;  //reflect(v, normal);
    if (dt >= 0) {
        d = v;
    }

    var dir: u32;
    var uv: vec2<f32>;
    if (d.z >= 0) {
        uv = 0.5 + (d.xy / (d.z + 1.0)) * 0.5;
        dir = 1;
    } else {
        uv = 0.5 + (d.xy / (1.0 - d.z)) * 0.5;
        dir = 0;
    }
    // vpPosition = vec4(dd, rz, 1);
    // zvalue = d.z;

    // uv.x = 1.0 - uv.x;
    uv.y = 1.0 - uv.y;
    return textureSample(envmap, envmap_sampler, uv, dir).rgb;
}

struct FragmentInfo {
    position: vec3<f32>,
    normal: vec3<f32>,
    albedo: vec3<f32>,
    reflectivity: f32,
    depth: f32,
}

fn getFragmentInfo(input: FragmentInput, depth: f32) -> FragmentInfo {
    var frag: FragmentInfo;

    var normal = textureLoad(gBufferNormal, vec2<i32>(floor(input.coord.xy)), 0);
    normal.z *= viewDirection;
    frag.normal = normal.xyz;
    let albedo_reflectivity = textureLoad(gBufferAlbedo, vec2<i32>(floor(input.coord.xy)), 0);
    frag.albedo = albedo_reflectivity.rgb;
    frag.reflectivity = albedo_reflectivity.a;
    frag.depth = depth;

    let bufferSize = textureDimensions(gBufferDepth);
    let coordUV = input.coord.xy / vec2<f32>(bufferSize);
    let zvalue = normal.w;  // Gバッファの法線テクスチャのw成分に入れておいたzvalueを取り出す
    frag.position = world_from_screen_coord(coordUV, depth, zvalue);

    return frag;
}

struct ShadingResult {
    visibility: f32,
    decay: f32,
    lambertFactor: f32,
    specularFactor: f32,
}

const kLightDirections = array(1.0, -1.0);

fn calcPointLighting(frag: FragmentInfo, light: Light, shadowmapBaseIndex: u32) -> ShadingResult {
    var result: ShadingResult;

    // XY is in (-1, 1) space, Z is in (0, 1) space
    let posFromLight0 = light.viewProjMatrix * vec4(frag.position, 1.0);
    let zdir = select(1u, 0u, posFromLight0.z >= 0.0);  // 0=前、1=後ろ

    // 放物面変換
    let shadowZ = length(posFromLight0.xyz);
    var posFromLightOrg = posFromLight0.xyz / shadowZ;
    posFromLightOrg.z *= kLightDirections[zdir];  // 光源との向きによって前後を選択
    let posFromLightXY = posFromLightOrg.xy / (posFromLightOrg.z + 1.0);

    // Convert XY to (0, 1)
    // Y is flipped because texture coords are Y-down.
    var shadowPos = posFromLightXY * vec2(0.5, -0.5) + vec2(0.5);

    // Percentage-closer filtering. Sample texels in the region
    // to smooth the result.
    var visibility = 0.0;
    let oneOverShadowDepthTextureSize = 1.0 / shadowDepthTextureSize;
    let shadowmapIndex = shadowmapBaseIndex + zdir;
    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            let offset = vec2<f32>(vec2(x, y)) * oneOverShadowDepthTextureSize;
            visibility += textureSampleCompare(
                shadowMap, shadowSampler,
                shadowPos.xy + offset, shadowmapIndex,
                shadowZ - SHADOW_Z_OFFSET
            );
        }
    }
    result.visibility = visibility / 9.0;

    let diff = light.pos - frag.position;
    let invlen = inverseSqrt(dot(diff, diff));
    let lightVec = diff * invlen;
    result.lambertFactor = max(dot(lightVec, frag.normal), 0.0);
    result.decay = 1.0 / (4 * PI) * (invlen * invlen);

    let viewDir = normalize(camera.position - frag.position);
    let halfDir = normalize(viewDir + lightVec);
    result.specularFactor = pow(max(dot(halfDir, frag.normal), 0.0), 200.0);

    return result;
}

fn shading(frag: FragmentInfo) -> vec3<f32> {
    var total : vec3<f32> = vec3(0, 0, 0);
    for (var lightIndex = 0u; lightIndex < light_info.numLights; lightIndex += 1) {
        let light = light_info.lights[lightIndex];
        let r = calcPointLighting(frag, light, lightIndex * 2);

        let lightingFactor = r.visibility * r.decay * light.color.rgb;
        total += lightingFactor * (frag.albedo * r.lambertFactor + r.specularFactor);
    }
    return total;
}

@fragment
fn mainWithEnvmap(
    input : FragmentInput
) -> @location(0) vec4<f32> {
    let depth = textureLoad(gBufferDepth, vec2<i32>(floor(input.coord.xy)), 0);
    if (depth >= 1.0) {
        discard;
    }

    var frag = getFragmentInfo(input, depth);
    var total = shading(frag);
    let reflection = sampleReflection(frag.position, frag.normal);
    if (frag.reflectivity > 0.0) {
        total += (reflection - total) * frag.reflectivity;
    }
    if (!paraboloid) {
        total = gamma(tonemap(total));
    }
    return vec4(total, 1.0);
}


@fragment
fn mainWithoutEnvmap(
    input : FragmentInput
) -> @location(0) vec4<f32> {
    let depth = textureLoad(gBufferDepth, vec2<i32>(floor(input.coord.xy)), 0);
    if (depth >= 1.0) {
        discard;
    }

    var frag = getFragmentInfo(input, depth);
    var total = shading(frag);
    if (!paraboloid) {
        total = gamma(tonemap(total));
    }
    return vec4(total, 1.0);
}
