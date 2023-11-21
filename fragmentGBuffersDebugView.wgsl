
@group(0) @binding(0) var gBufferNormal: texture_2d<f32>;
@group(0) @binding(1) var gBufferAlbedo: texture_2d<f32>;
@group(0) @binding(2) var gBufferDepth: texture_depth_2d;
@group(0) @binding(3) var shadowMap: texture_depth_2d_array;

override canvasSizeWidth: f32;
override canvasSizeHeight: f32;

const kShadowMapWidth = 1024.0;
const kShadowMapHeight = 1024.0;

@fragment
fn main(
    @builtin(position) coord : vec4<f32>
) -> @location(0) vec4<f32> {
    var result = vec4<f32>(0.0, 0.0, 0.0, 1.0);
    var c = coord.xy / vec2<f32>(canvasSizeWidth, canvasSizeHeight);
    if (c.y < 2.0 / 3) {
        c.y = c.y * (3.0 / 2);
        var layer: u32;
        if (c.x < 0.5) {
            c.x = c.x * (3.0 / 2) - (0.5 - 2.0 / 3);
            layer = 0u;
        } else {
            c.x = (c.x - 0.5) * (3.0 / 2) - (0.5 - 2.0 / 3);
            layer = 1u;
        }

        let rawDepth = textureLoad(
            shadowMap,
            vec2<i32>(floor(c * vec2<f32>(kShadowMapWidth, kShadowMapHeight))),  // shadowDepthTextureSize
            layer, 0
        );
        // remap depth into something a bit more visible
        let depth = 1.0 - rawDepth * 2.0;
        result = vec4(vec3(depth), 1);
    } else {
        c.y = c.y * 3.0 - 2.0;
        if (c.x < 1.0 / 3) {
            c.x = c.x * 3.0;
            let rawDepth = textureLoad(
                gBufferDepth,
                vec2<i32>(floor(c * vec2<f32>(canvasSizeWidth, canvasSizeHeight))),
                0);
            // remap depth into something a bit more visible
            let depth = (1.0 - rawDepth) * 50.0;
            result = vec4(vec3(depth), 1);
        } else if (c.x < 2.0 / 3) {
            c.x = c.x * 3.0 - 1.0;
            result = textureLoad(
                gBufferNormal,
                vec2<i32>(floor(c * vec2<f32>(canvasSizeWidth, canvasSizeHeight))),
                0);
            result = (result + 1.0) * 0.5;
        } else {
            c.x = c.x * 3.0 - 2.0;
            result = textureLoad(
                gBufferAlbedo,
                vec2<i32>(floor(c * vec2<f32>(canvasSizeWidth, canvasSizeHeight))),
                0);
        }
    }
    return result;
}
