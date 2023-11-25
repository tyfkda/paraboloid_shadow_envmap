override paraboloid: bool = false;

struct GBufferOutput {
    @location(0) normal : vec4<f32>,

    // Textures: diffuse color, reflectivity color, smoothness, emissive etc. could go here
    @location(1) albedo : vec4<f32>,
}

@fragment
fn main(
    @location(0) fragNormal: vec3<f32>,
    @location(1) fragUV : vec2<f32>,
    @location(2) zvalue : f32,
    @location(3) color_reflectivity : vec4<f32>,
) -> GBufferOutput {
    if (paraboloid && zvalue < -0.05) {  // Some margin.
        discard;
    }

    // faking some kind of checkerboard texture
    let uv = floor(10.0 * fragUV);
    let c = 0.5 + 0.5 * ((uv.x + uv.y) - 2.0 * floor((uv.x + uv.y) / 2.0));
    let albedo = vec3(c, c, c) * color_reflectivity.rgb;
    let reflectivity = color_reflectivity.a;

    let normal = normalize(fragNormal);
    var output : GBufferOutput;
    output.normal = vec4(normal, zvalue);  // 放物面逆変換用に、wにzvalueを入れておく
    output.albedo = vec4(albedo, reflectivity);

    return output;
}
