import {mat4, vec3} from 'https://wgpu-matrix.org/dist/2.x/wgpu-matrix.module.js'
import * as dat from 'https://cdn.jsdelivr.net/npm/dat.gui@0.7.9/build/dat.gui.module.js'
import {mesh} from './stanford-dragon.js'

const kMaxNumLights = 32;
const kMaxShadowPasses = kMaxNumLights * 2;  // 点光源用、双放物面で２倍必要

const shadowDepthTextureSize = 1024;

const upVector = vec3.fromValues(0, 1, 0);
const origin = vec3.fromValues(0, 0, 0);

function deg2rad(degree) {
    return degree * (Math.PI / 180)
}

function randomRange(min, max) {
    return Math.random() * (max - min) + min
}

function posNegRand(min, max) {
    const flag = Math.floor(Math.random() * 2) * 2 - 1
    return flag * randomRange(min, max)
}

function shuffle(array) {
    for (let i = 0; i < array.length - 1; ++i) {
        const r = Math.floor(Math.random() * (array.length - i)) + i
        const t = array[i]
        array[i] = array[r]
        array[r] = t
    }
    return array
}

class PointLight {
    constructor(lightColor) {
        this.lightColor = lightColor

        this.r = randomRange(30, 180)
        this.tx = posNegRand(deg2rad(10), deg2rad(40))
        this.ty = posNegRand(deg2rad(10), deg2rad(40))
        this.tz = posNegRand(deg2rad(10), deg2rad(40))
    }

    update(device, lightStorageBuffer, index, t) {
        const offset = 16 + (1 * 4 * 16 + 4 * 4 * 2) * index;

        const lightPosition = vec3.fromValues(Math.sin(this.tx * t) * this.r, 50 + 40 * Math.sin(this.ty * t), Math.cos(this.tz * t) * this.r);

        // const panMatrix = mat4.rotateY(
        //     mat4.rotateX(mat4.identity(), Math.sin(t * this.rx) * deg2rad(15)),
        //     Math.sin(t * this.ry) * deg2rad(15))

        const lightViewMatrix = mat4.lookAt(lightPosition, origin, upVector);
        let lightProjectionMatrix = (() => {
            const far = 400 * 2
            const invfar = 1.0 / far
            return mat4.create(
                invfar, 0.0,  0.0, 0.0,
                0.0, invfar,  0.0, 0.0,
                0.0, 0.0, -invfar, 0.0,
                0.0, 0.0,  0.0, 1.0)
        })();

        const lightViewProjMatrix = mat4.multiply(lightProjectionMatrix, lightViewMatrix)

        // The camera/light aren't moving, so write them into buffers now.
        const lightMatrixData = lightViewProjMatrix;
        device.queue.writeBuffer(
            lightStorageBuffer,
            0 + offset,
            lightMatrixData.buffer,
            lightMatrixData.byteOffset,
            lightMatrixData.byteLength
        );

        const lightData = lightPosition;
        device.queue.writeBuffer(
            lightStorageBuffer,
            64 + offset,
            lightData.buffer,
            lightData.byteOffset,
            lightData.byteLength
        );

        const lightColor = this.lightColor;
        device.queue.writeBuffer(
            lightStorageBuffer,
            80 + offset,
            lightColor.buffer,
            lightColor.byteOffset,
            lightColor.byteLength
        );
    }
}

async function isWebGpuSupported() {
    let device = null
    if (navigator.gpu) {
        const adapter = await navigator.gpu.requestAdapter()
        if (adapter) {
            device = await adapter.requestDevice()
        }
    }
    return device
}

const init = async ({ device, canvas, gui }) => {
    const context = canvas.getContext('webgpu');

    let vertexWriteGBuffers
    let fragmentWriteGBuffers
    let vertexTextureQuad
    let fragmentGBuffersDebugView
    let fragmentDeferredRendering
    let shadowGenShader

    await Promise.all([
        fetch('./vertexWriteGBuffers.wgsl').then((r) => r.text()).then((r) => vertexWriteGBuffers = r),
        fetch('./fragmentWriteGBuffers.wgsl').then((r) => r.text()).then((r) => fragmentWriteGBuffers = r),
        fetch('./vertexTextureQuad.wgsl').then((r) => r.text()).then((r) => vertexTextureQuad = r),
        fetch('./fragmentGBuffersDebugView.wgsl').then((r) => r.text()).then((r) => fragmentGBuffersDebugView = r),
        fetch('./fragmentDeferredRendering.wgsl').then((r) => r.text()).then((r) => fragmentDeferredRendering = r),
        fetch('./shadowGen.wgsl').then((r) => r.text()).then((r) => shadowGenShader = r),
    ])

    const devicePixelRatio = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * devicePixelRatio;
    canvas.height = canvas.clientHeight * devicePixelRatio;
    const aspect = canvas.width / canvas.height;
    const presentationFormat = navigator.gpu.getPreferredCanvasFormat();
    context.configure({
        device,
        format: presentationFormat,
        alphaMode: 'premultiplied',
    });

    // Create the model vertex buffer.
    const kVertexStride = 8;
    const vertexBuffer = device.createBuffer({
        // position: vec3, normal: vec3, uv: vec2
        size:
            mesh.positions.length * kVertexStride * Float32Array.BYTES_PER_ELEMENT,
        usage: GPUBufferUsage.VERTEX,
        mappedAtCreation: true,
    });
    {
        const mapping = new Float32Array(vertexBuffer.getMappedRange());
        for (let i = 0; i < mesh.positions.length; ++i) {
            mapping.set(mesh.positions[i], kVertexStride * i);
            mapping.set(mesh.normals[i], kVertexStride * i + 3);
            mapping.set(mesh.uvs[i], kVertexStride * i + 6);
        }
        vertexBuffer.unmap();
    }

    // Create the model index buffer.
    const indexCount = mesh.triangles.length * 3;
    const indexBuffer = device.createBuffer({
        size: indexCount * Uint16Array.BYTES_PER_ELEMENT,
        usage: GPUBufferUsage.INDEX,
        mappedAtCreation: true,
    });
    {
        const mapping = new Uint16Array(indexBuffer.getMappedRange());
        for (let i = 0; i < mesh.triangles.length; ++i) {
            mapping.set(mesh.triangles[i], 3 * i);
        }
        indexBuffer.unmap();
    }

    // GBuffer texture render targets
    const gBufferTextureNormal = device.createTexture({
        size: [canvas.width, canvas.height],
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        format: 'rgba16float',
    });
    const gBufferTextureAlbedo = device.createTexture({
        size: [canvas.width, canvas.height],
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        format: 'bgra8unorm',
    });
    const depthTexture = device.createTexture({
        size: [canvas.width, canvas.height],
        format: 'depth24plus',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });

    const vertexBuffers = [
        {
            arrayStride: Float32Array.BYTES_PER_ELEMENT * 8,
            attributes: [
                {
                    // position
                    shaderLocation: 0,
                    offset: 0,
                    format: 'float32x3',
                },
                {
                    // normal
                    shaderLocation: 1,
                    offset: Float32Array.BYTES_PER_ELEMENT * 3,
                    format: 'float32x3',
                },
                {
                    // uv
                    shaderLocation: 2,
                    offset: Float32Array.BYTES_PER_ELEMENT * 6,
                    format: 'float32x2',
                },
            ],
        },
    ];

    const primitive = {
        topology: 'triangle-list',
        cullMode: 'back',
    };

    const uniformBufferBindGroupLayout = device.createBindGroupLayout({
        label: 'uniformBufferBindGroupLayout',
        entries: [
            {
                binding: 0,
                visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                buffer: {
                    type: 'uniform',
                },
            },
        ],
    });

    const cameraUniformBufferBindGroupLayout = uniformBufferBindGroupLayout
    const modelUniformBufferBindGroupLayout = uniformBufferBindGroupLayout

    const lightStorageBufferBindGroupLayout = device.createBindGroupLayout({
        label: 'lightStorageBufferBindGroupLayout',
        entries: [
            {
                binding: 0,
                visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                buffer: {
                    type: 'read-only-storage',
                },
            },
        ],
    });

    const writeGBuffersPipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({
            bindGroupLayouts: [
                cameraUniformBufferBindGroupLayout,
                modelUniformBufferBindGroupLayout,
            ],
        }),
        vertex: {
            module: device.createShaderModule({
                code: vertexWriteGBuffers,
            }),
            entryPoint: 'main',
            buffers: vertexBuffers,
        },
        fragment: {
            module: device.createShaderModule({
                code: fragmentWriteGBuffers,
            }),
            entryPoint: 'main',
            targets: [
                // normal
                { format: 'rgba16float' },
                // albedo
                { format: 'bgra8unorm' },
            ],
        },
        depthStencil: {
            depthWriteEnabled: true,
            depthCompare: 'less',
            format: 'depth24plus',
        },
        primitive,
    });

    const gBufferTexturesBindGroupLayout = device.createBindGroupLayout({
        label: 'gBufferTexturesBindGroupLayout',
        entries: [
            {
                binding: 0,
                visibility: GPUShaderStage.FRAGMENT,
                texture: {
                    sampleType: 'unfilterable-float',
                },
            },
            {
                binding: 1,
                visibility: GPUShaderStage.FRAGMENT,
                texture: {
                    sampleType: 'unfilterable-float',
                },
            },
            {
                binding: 2,
                visibility: GPUShaderStage.FRAGMENT,
                texture: {
                    sampleType: 'depth',
                },
            },
            {
                binding: 3,
                visibility: GPUShaderStage.FRAGMENT,
                texture: {
                    sampleType: 'depth',
                    viewDimension: '2d-array',
                },
            },
            {
                binding: 4,
                visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                sampler: {
                    type: 'comparison',
                },
            },
        ],
    });

    const gBuffersDebugViewPipeline = device.createRenderPipeline({
        label: 'gBuffersDebugViewPipeline',
        layout: device.createPipelineLayout({
            bindGroupLayouts: [gBufferTexturesBindGroupLayout],
        }),
        vertex: {
            module: device.createShaderModule({
                code: vertexTextureQuad,
            }),
            entryPoint: 'main',
        },
        fragment: {
            module: device.createShaderModule({
                code: fragmentGBuffersDebugView,
            }),
            entryPoint: 'main',
            targets: [
                {
                    format: presentationFormat,
                },
            ],
            constants: {
                canvasSizeWidth: canvas.width,
                canvasSizeHeight: canvas.height,
            },
        },
        primitive,
    });

    const deferredRenderPipeline = device.createRenderPipeline({
        label: 'deferredRenderPipeline',
        layout: device.createPipelineLayout({
            bindGroupLayouts: [
                gBufferTexturesBindGroupLayout,
                cameraUniformBufferBindGroupLayout,
                lightStorageBufferBindGroupLayout,
            ],
        }),
        vertex: {
            module: device.createShaderModule({
                code: vertexTextureQuad,
            }),
            entryPoint: 'main',
        },
        fragment: {
            module: device.createShaderModule({
                code: fragmentDeferredRendering,
            }),
            entryPoint: 'main',
            targets: [
                {
                    format: presentationFormat,
                    // blend: {
                    //     color: {
                    //         srcFactor: 'one',
                    //         dstFactor: 'src-alpha',
                    //         operation: 'add',
                    //     },
                    //     alpha: {
                    //         srcFactor: 'src-alpha',
                    //         dstFactor: 'zero',
                    //         operation: 'add',
                    //     },
                    // },
                },
            ],
            constants: {
                shadowDepthTextureSize,
            },
        },
        primitive,
    });

    const textureQuadPassDescriptor = {
        colorAttachments: [
            {
                // view is acquired and set in render loop.
                view: undefined,

                clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 1.0 },
                loadOp: 'clear',
                storeOp: 'store',
            },
        ],
    };

    const settings = {
        mode: 'rendering',
        numLights: 1,
    };

    gui.add(settings, 'mode', ['rendering', 'gBuffers view']);
    gui
        .add(settings, 'numLights', 1, kMaxNumLights)
        .step(1)
        .onChange(() => {
            device.queue.writeBuffer(
                lightStorageBuffer,
                0,
                new Uint32Array([settings.numLights])
            );
        });

    const cameraUniformBuffer = device.createBuffer({
        size: 4 * 16 * 2, // two 4x4 matrix
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const cameraUniformBindGroup = device.createBindGroup({
        layout: cameraUniformBufferBindGroupLayout,
        entries: [
            {
                binding: 0,
                resource: {
                    buffer: cameraUniformBuffer,
                },
            },
        ],
    });

    const modelUniformBuffer = device.createBuffer({
        size: 4 * 16 * 1, // one 4x4 matrix
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const modelUniformBindGroup = device.createBindGroup({
        layout: modelUniformBufferBindGroupLayout,
        entries: [
            {
                binding: 0,
                resource: {
                    buffer: modelUniformBuffer,
                },
            },
        ],
    });

    // VVV シャドウマップ関連 VVV

    // Create the depth texture for rendering/sampling the shadow map.
    const shadowDepthTexture = device.createTexture({
        size: [shadowDepthTextureSize, shadowDepthTextureSize, kMaxShadowPasses],
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        format: 'depth32float',
    });

    const shadowPipelines = [...Array(2)].map((_, i) => device.createRenderPipeline({
        layout: device.createPipelineLayout({
            bindGroupLayouts: [
                lightStorageBufferBindGroupLayout,
                modelUniformBufferBindGroupLayout,
                uniformBufferBindGroupLayout,
            ],
        }),
        vertex: {
            module: device.createShaderModule({
                code: shadowGenShader,
            }),
            entryPoint: 'vertexMain',
            buffers: vertexBuffers,
            constants: {
                lightDirection: 1.0 - i * 2,  // 方向：1.0 or -1.0
            },
        },
        fragment: {
            module: device.createShaderModule({
                code: shadowGenShader,
            }),
            entryPoint: 'fragmentMain',
            constants: {
            },
            targets: [],
        },
        depthStencil: {
            depthWriteEnabled: true,
            depthCompare: 'less',
            format: 'depth32float',
        },
        // primitive,
        primitive: {
            topology: 'triangle-list',
            cullMode: 'none',  // これにしてみる
        },
    }))

    const shadowPassDescriptors = [...Array(kMaxShadowPasses)].map((_, i) => {
        return {
            colorAttachments: [],
            depthStencilAttachment: {
                view: shadowDepthTexture.createView({arrayLayerCount: 1, baseArrayLayer: i}),
                depthClearValue: 1.0,
                depthLoadOp: 'clear',
                depthStoreOp: 'store',
            },
        };
    })

    const lightStorageBuffer = device.createBuffer({
        // Number of light.
        // For kMaxNumLights:
        //     One 4x4 viewProj matrices for the light.
        //     Then a vec3 for the light position.
        //     Then a vec3 for the light color.
        // Rounded to the nearest multiple of 16.
        size: 16 + (1 * 4 * 16 + 4 * 4 * 2) * kMaxNumLights,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(
        lightStorageBuffer,
        0,
        new Uint32Array([settings.numLights])
    );

    const lightStorageBindGroup = device.createBindGroup({
        layout: lightStorageBufferBindGroupLayout,
        entries: [
            {
                binding: 0,
                resource: {
                    buffer: lightStorageBuffer,
                },
            },
        ],
    });

    const shadowUniformBindGroups = [...Array(kMaxNumLights)].map((_, i) => {
        const uniformBuffer = device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.UNIFORM,
            mappedAtCreation: true,
        });
        {
            const mapping = new Uint32Array(uniformBuffer.getMappedRange());
            mapping[0] = i
            uniformBuffer.unmap();
        }

        return device.createBindGroup({
            layout: uniformBufferBindGroupLayout,
            entries: [
                {
                    binding: 0,
                    resource: {
                        buffer: uniformBuffer,
                    },
                },
            ],
        });
    })

    // ^^^ シャドウマップ関連 ^^^

    const gBufferTextureViews = [
        gBufferTextureNormal.createView(),
        gBufferTextureAlbedo.createView(),
        depthTexture.createView(),
        shadowDepthTexture.createView(),
    ];

    const writeGBufferPassDescriptor = {
        colorAttachments: [
            {
                view: gBufferTextureViews[0],

                clearValue: { r: 0.0, g: 0.0, b: 1.0, a: 1.0 },
                loadOp: 'clear',
                storeOp: 'store',
            },
            {
                view: gBufferTextureViews[1],

                clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 1.0 },
                loadOp: 'clear',
                storeOp: 'store',
            },
        ],
        depthStencilAttachment: {
            view: depthTexture.createView(),

            depthClearValue: 1.0,
            depthLoadOp: 'clear',
            depthStoreOp: 'store',
        },
    };

    const gBufferTexturesBindGroup = device.createBindGroup({
        layout: gBufferTexturesBindGroupLayout,
        entries: [
            {
                binding: 0,
                resource: gBufferTextureViews[0],
            },
            {
                binding: 1,
                resource: gBufferTextureViews[1],
            },
            {
                binding: 2,
                resource: gBufferTextureViews[2],
            },
            {
                binding: 3,
                resource: gBufferTextureViews[3],
            },
            {
                binding: 4,
                resource: device.createSampler({
                    compare: 'less',
                })
            },
        ],
    });


    const colors = shuffle([
        vec3.fromValues(1.0, 0.0, 0.0),
        vec3.fromValues(0.0, 1.0, 0.0),
        vec3.fromValues(0.0, 0.0, 1.0),
    ])
    const intensity = 10000
    const pointLights = [...Array(kMaxNumLights)].map((_, i) => {
        const color = i === 0 ? vec3.scale([1.0, 1.0, 1.0], intensity * 4)
                              : vec3.scale(colors[i % colors.length], intensity)
        return new PointLight(color)
    })



    //--------------------

    // Scene matrices
    const eyePosition = vec3.fromValues(0, 50, -100);

    const projectionMatrix = mat4.perspective(
        (2 * Math.PI) / 5,
        aspect,
        1,
        2000.0
    );

    // Move the model so it's centered.
    const modelMatrix = mat4.translation([0, -45, 0]);

    const modelData = modelMatrix;
    device.queue.writeBuffer(
        modelUniformBuffer,
        0,
        modelData.buffer,
        modelData.byteOffset,
        modelData.byteLength
    );

    // Rotates the camera around the origin based on time.
    function getCameraViewProjMatrix(t) {
        const rad = t * (Math.PI / 20);
        const radX = Math.sin(t * (Math.PI / 13)) * (Math.PI / 8);
        const rotation = mat4.rotateX(mat4.rotateY(mat4.translation(origin), rad), radX);
        const rotatedEyePosition = vec3.transformMat4(eyePosition, rotation);

        const viewMatrix = mat4.lookAt(rotatedEyePosition, origin, upVector);
        return mat4.multiply(projectionMatrix, viewMatrix)
    }

    function frame() {
        // Sample is no longer the active page.

        const t = Date.now() * (1 / 1000);
        const cameraViewProj = getCameraViewProjMatrix(t);
        device.queue.writeBuffer(
            cameraUniformBuffer,
            0,
            cameraViewProj.buffer,
            cameraViewProj.byteOffset,
            cameraViewProj.byteLength
        );
        const cameraInvViewProj = mat4.invert(cameraViewProj);
        device.queue.writeBuffer(
            cameraUniformBuffer,
            64,
            cameraInvViewProj.buffer,
            cameraInvViewProj.byteOffset,
            cameraInvViewProj.byteLength
        );

        {
            const modelData = modelMatrix;
            device.queue.writeBuffer(
                modelUniformBuffer,
                0,
                modelData.buffer,
                modelData.byteOffset,
                modelData.byteLength
            );
        }

        for (let i = 0; i < settings.numLights; ++i) {
            const pointLight = pointLights[i]
            pointLight.update(device, lightStorageBuffer, i, t)
        }

        const commandEncoder = device.createCommandEncoder();
        {
            // 各光源からのシャドウマップを作成（光源ごとに前後２枚）
            for (let i = 0; i < settings.numLights * 2; ++i) {
                const shadowPass = commandEncoder.beginRenderPass(shadowPassDescriptors[i]);
                shadowPass.setPipeline(shadowPipelines[i & 1]);
                shadowPass.setBindGroup(0, lightStorageBindGroup);
                shadowPass.setBindGroup(1, modelUniformBindGroup);
                shadowPass.setBindGroup(2, shadowUniformBindGroups[i >> 1])
                shadowPass.setVertexBuffer(0, vertexBuffer);
                shadowPass.setIndexBuffer(indexBuffer, 'uint16');
                shadowPass.drawIndexed(indexCount);
                shadowPass.end();
            }
        }
        {
            // Write position, normal, albedo etc. data to gBuffers
            const gBufferPass = commandEncoder.beginRenderPass(
                writeGBufferPassDescriptor
            );
            gBufferPass.setPipeline(writeGBuffersPipeline);
            gBufferPass.setBindGroup(0, cameraUniformBindGroup);
            gBufferPass.setBindGroup(1, modelUniformBindGroup);
            gBufferPass.setVertexBuffer(0, vertexBuffer);
            gBufferPass.setIndexBuffer(indexBuffer, 'uint16');
            gBufferPass.drawIndexed(indexCount);
            gBufferPass.end();
        }
        {
            if (settings.mode === 'gBuffers view') {
                // GBuffers debug view
                // Left: depth
                // Middle: normal
                // Right: albedo (use uv to mimic a checkerboard texture)
                textureQuadPassDescriptor.colorAttachments[0].view = context
                    .getCurrentTexture()
                    .createView();
                const debugViewPass = commandEncoder.beginRenderPass(textureQuadPassDescriptor);
                debugViewPass.setPipeline(gBuffersDebugViewPipeline);
                debugViewPass.setBindGroup(0, gBufferTexturesBindGroup);
                debugViewPass.draw(6);
                debugViewPass.end();
            } else {
                // Deferred rendering
                const view = context.getCurrentTexture().createView();
                textureQuadPassDescriptor.colorAttachments[0].view = view
                const deferredRenderingPass = commandEncoder.beginRenderPass(textureQuadPassDescriptor)
                deferredRenderingPass.setPipeline(deferredRenderPipeline);
                deferredRenderingPass.setBindGroup(0, gBufferTexturesBindGroup);
                deferredRenderingPass.setBindGroup(1, cameraUniformBindGroup);
                deferredRenderingPass.setBindGroup(2, lightStorageBindGroup);
                deferredRenderingPass.draw(6);
                deferredRenderingPass.end();
            }
        }
        device.queue.submit([commandEncoder.finish()]);

        requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
};

function notSupported() {
    const notSupported = document.getElementById('not-supported')
    notSupported.style.display = null  // デフォルト 'none' を削除して、表示する
}

function getUrlQueries() {
    const queryStr = window.location.search.slice(1)  // 文頭?を除外
    const queries = {}
    if (queryStr !== '') {
        queryStr.split('&').forEach((queryStr) => {
            var queryArr = queryStr.split('=')
            queries[queryArr[0]] = queryArr[1]
        })
    }
    return queries
}

async function main() {
    const device = await isWebGpuSupported()
    if (!device) {
        notSupported()
        return
    }

    const run = async () => {
        const canvas = document.createElement('canvas')
        canvas.style.width = canvas.style.height = '100%'
        document.body.appendChild(canvas)

        const gui = new dat.GUI();

        await init({device, canvas, gui})
    }

    // クエリ文字列で自動実行も可能にする
    const queries = getUrlQueries()
    if (queries.wait) {
        const ready = document.getElementById('ready')
        ready.style.display = null  // デフォルト 'none' を削除して、表示する
        ready.addEventListener('click', async () => {
            ready.style.display = 'none'  // 再度非表示に
            await run()
        })
    } else {
        await run()
    }
}

await main()
