import {mat4, vec3, vec4} from 'https://wgpu-matrix.org/dist/2.x/wgpu-matrix.module.js'
import {mesh} from './stanford-dragon.js'

const kMaxNumLights = 9;
const lightExtentMin = vec3.fromValues(-50, -30, -50);
const lightExtentMax = vec3.fromValues(50, 50, 50);

const shadowDepthTextureSize = 512;

const upVector = vec3.fromValues(0, 1, 0);
const origin = vec3.fromValues(0, 0, 0);

class PointLight {
    constructor(lightColor) {
        const extent = vec3.sub(lightExtentMax, lightExtentMin);
        const W = 150
        this.lightPosition = vec3.fromValues(Math.random() * (W * 2) - W, 100 + Math.random() * 50, Math.random() * (W * 2) - W);
        this.lightColor = lightColor
    }

    update(device, sceneUniformBuffer, index) {
        const lightPosition = this.lightPosition
        const offset = (1 * 4 * 16 + 4 * 4 * 2) * index;

        const lightViewMatrix = mat4.lookAt(lightPosition, origin, upVector);
        const lightProjectionMatrix = mat4.create();
        {
            const W = 80 / 2;
            const left = -W;
            const right = W;
            const bottom = -W;
            const top = W;
            const near = -200;
            const far = 400;  // 300;
            mat4.ortho(left, right, bottom, top, near, far, lightProjectionMatrix);
        }

        const lightViewProjMatrix = mat4.multiply(
            lightProjectionMatrix,
            lightViewMatrix
        );

        // The camera/light aren't moving, so write them into buffers now.
        const lightMatrixData = lightViewProjMatrix /*as Float32Array*/;
        device.queue.writeBuffer(
            sceneUniformBuffer,
            0 + offset,
            lightMatrixData.buffer,
            lightMatrixData.byteOffset,
            lightMatrixData.byteLength
        );

        const lightData = lightPosition /*as Float32Array*/;
        device.queue.writeBuffer(
            sceneUniformBuffer,
            64 + offset,
            lightData.buffer,
            lightData.byteOffset,
            lightData.byteLength
        );

        const lightColor = this.lightColor /*as Float32Array*/;
        device.queue.writeBuffer(
            sceneUniformBuffer,
            80 + offset,
            lightColor.buffer,
            lightColor.byteOffset,
            lightColor.byteLength
        );
    }
}

const init /*: SampleInit*/ = async ({ canvas /*, pageState, gui*/ }) => {
    const adapter = await navigator.gpu.requestAdapter();
    const device = await adapter.requestDevice();

    // if (!pageState.active) return;
    const context = canvas.getContext('webgpu') /*as GPUCanvasContext*/;

    let lightUpdate
    let vertexWriteGBuffers
    let fragmentWriteGBuffers
    let vertexTextureQuad
    let fragmentGBuffersDebugView
    let fragmentDeferredRendering
    let vertexShadow

    await Promise.all([
        fetch('./lightUpdate.wgsl').then((r) => r.text()).then((r) => lightUpdate = r),
        fetch('./vertexWriteGBuffers.wgsl').then((r) => r.text()).then((r) => vertexWriteGBuffers = r),
        fetch('./fragmentWriteGBuffers.wgsl').then((r) => r.text()).then((r) => fragmentWriteGBuffers = r),
        fetch('./vertexTextureQuad.wgsl').then((r) => r.text()).then((r) => vertexTextureQuad = r),
        fetch('./fragmentGBuffersDebugView.wgsl').then((r) => r.text()).then((r) => fragmentGBuffersDebugView = r),
        fetch('./fragmentDeferredRendering.wgsl').then((r) => r.text()).then((r) => fragmentDeferredRendering = r),
        fetch('./vertexShadow.wgsl').then((r) => r.text()).then((r) => vertexShadow = r),
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
    const gBufferTexture2DFloat16 = device.createTexture({
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

    const vertexBuffers /*: Iterable<GPUVertexBufferLayout>*/ = [
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

    const primitive /*: GPUPrimitiveState*/ = {
        topology: 'triangle-list',
        cullMode: 'back',
    };

    const writeGBuffersPipeline = device.createRenderPipeline({
        layout: 'auto',
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

    const lightsBufferBindGroupLayout = device.createBindGroupLayout({
        label: 'lightsBufferBindGroupLayout',
        entries: [
            {
                binding: 0,
                visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
                buffer: {
                    type: 'read-only-storage',
                },
            },
            {
                binding: 1,
                visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
                buffer: {
                    type: 'uniform',
                },
            },
            {
                binding: 2,
                visibility: GPUShaderStage.FRAGMENT,
                buffer: {
                    type: 'uniform',
                },
            },
            {
                binding: 3,
                visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                buffer: {
                    type: 'uniform',
                },
            },
        ],
    });

    const gBuffersDebugViewPipeline = device.createRenderPipeline({
        label: 'gBuffersDebugViewPipeline',
        layout: device.createPipelineLayout({
            bindGroupLayouts: [
                gBufferTexturesBindGroupLayout,
                lightsBufferBindGroupLayout,
                uniformBufferBindGroupLayout,
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
                lightsBufferBindGroupLayout,
                uniformBufferBindGroupLayout,
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
                    blend: {
                        color: {
                            srcFactor: 'one',
                            dstFactor: 'src-alpha',
                            operation: 'add',
                        },
                        alpha: {
                            srcFactor: 'src-alpha',
                            dstFactor: 'zero',
                            operation: 'add',
                        },
                    },
                },
            ],
            constants: {
                shadowDepthTextureSize,
            },
        },
        primitive,
    });

    const textureQuadPassDescriptor /*: GPURenderPassDescriptor*/ = {
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
        // mode: 'gBuffers view',
        numLights: 3,
        // numLights: 8,
    };
    const configUniformBuffer = (() => {
        const buffer = device.createBuffer({
            size: Uint32Array.BYTES_PER_ELEMENT,
            mappedAtCreation: true,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        new Uint32Array(buffer.getMappedRange())[0] = settings.numLights;
        buffer.unmap();
        return buffer;
    })();

    // gui.add(settings, 'mode', ['rendering', 'gBuffers view']);
    // gui
    //     .add(settings, 'numLights', 1, kMaxNumLights)
    //     .step(1)
    //     .onChange(() => {
    //         device.queue.writeBuffer(
    //             configUniformBuffer,
    //             0,
    //             new Uint32Array([settings.numLights])
    //         );
    //     });

    const modelUniformBuffer = device.createBuffer({
        size: 4 * 16 * 2, // two 4x4 matrix
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const cameraUniformBuffer = device.createBuffer({
        size: 4 * 16 * 2, // two 4x4 matrix
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const sceneUniformBindGroup = device.createBindGroup({
        layout: writeGBuffersPipeline.getBindGroupLayout(0),
        entries: [
            {
                binding: 0,
                resource: {
                    buffer: modelUniformBuffer,
                },
            },
            {
                binding: 1,
                resource: {
                    buffer: cameraUniformBuffer,
                },
            },
        ],
    });

    // VVV シャドウマップ関連 VVV

    // Create the depth texture for rendering/sampling the shadow map.
    const shadowDepthTexture = device.createTexture({
        size: [shadowDepthTextureSize, shadowDepthTextureSize, kMaxNumLights],
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        format: 'depth32float',
    });

    const shadowPipelines = [...Array(kMaxNumLights)].map((_, i) => {
        return device.createRenderPipeline({
            layout: device.createPipelineLayout({
                bindGroupLayouts: [
                    uniformBufferBindGroupLayout,
                    uniformBufferBindGroupLayout,
                ],
            }),
            vertex: {
                module: device.createShaderModule({
                    code: vertexShadow,
                }),
                entryPoint: 'main',
                buffers: vertexBuffers,
                constants: {
                    lightIndex: i,
                },
            },
            depthStencil: {
                depthWriteEnabled: true,
                depthCompare: 'less',
                format: 'depth32float',
            },
            primitive,
        });
    })

    const modelBindGroup = device.createBindGroup({
        layout: uniformBufferBindGroupLayout,
        entries: [
            {
                binding: 0,
                resource: {
                    buffer: modelUniformBuffer,
                },
            },
        ],
    });

    const shadowPassDescriptors = [...Array(kMaxNumLights)].map((_, i) => {
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

    const sceneUniformBuffer = device.createBuffer({
        // One 4x4 viewProj matrices for the light.
        // Then a vec3 for the light position.
        // Then a vec3 for the light color.
        // Rounded to the nearest multiple of 16.
        size: (1 * 4 * 16 + 4 * 4 * 2) * kMaxNumLights,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const sceneBindGroupForShadow = device.createBindGroup({
        layout: uniformBufferBindGroupLayout,
        entries: [
            {
                binding: 0,
                resource: {
                    buffer: sceneUniformBuffer,
                },
            },
        ],
    });

    // ^^^ シャドウマップ関連 ^^^

    const gBufferTextureViews = [
        gBufferTexture2DFloat16.createView(),
        gBufferTextureAlbedo.createView(),
        depthTexture.createView(),
        shadowDepthTexture.createView(),
    ];

    const writeGBufferPassDescriptor /*: GPURenderPassDescriptor*/ = {
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

    // Lights data are uploaded in a storage buffer
    // which could be updated/culled/etc. with a compute shader
    const extent = vec3.sub(lightExtentMax, lightExtentMin);
    const lightDataStride = 8;
    const bufferSizeInByte =
        Float32Array.BYTES_PER_ELEMENT * lightDataStride * kMaxNumLights;
    const lightsBuffer = device.createBuffer({
        size: bufferSizeInByte,
        usage: GPUBufferUsage.STORAGE,
        mappedAtCreation: true,
    });

    // We randomaly populate lights randomly in a box range
    // And simply move them along y-axis per frame to show they are
    // dynamic lightings
    const lightData = new Float32Array(lightsBuffer.getMappedRange());
    const tmpVec4 = vec4.create();
    let offset = 0;
    for (let i = 0; i < kMaxNumLights; i++) {
        offset = lightDataStride * i;
        // position
        for (let i = 0; i < 3; i++) {
            tmpVec4[i] = Math.random() * extent[i] + lightExtentMin[i];
        }
        tmpVec4[3] = 1;
        lightData.set(tmpVec4, offset);
        // color
        tmpVec4[0] = Math.random() * 2;
        tmpVec4[1] = Math.random() * 2;
        tmpVec4[2] = Math.random() * 2;
        // radius
        tmpVec4[3] = 20.0;
        lightData.set(tmpVec4, offset + 4);
    }
    lightsBuffer.unmap();

    const lightExtentBuffer = device.createBuffer({
        size: 4 * 8,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const lightExtentData = new Float32Array(8);
    lightExtentData.set(lightExtentMin, 0);
    lightExtentData.set(lightExtentMax, 4);
    device.queue.writeBuffer(
        lightExtentBuffer,
        0,
        lightExtentData.buffer,
        lightExtentData.byteOffset,
        lightExtentData.byteLength
    );

    const lightsBufferBindGroup = device.createBindGroup({
        label: 'lightsBufferBindGroup',
        layout: lightsBufferBindGroupLayout,
        entries: [
            {
                binding: 0,
                resource: {
                    buffer: lightsBuffer,
                },
            },
            {
                binding: 1,
                resource: {
                    buffer: configUniformBuffer,
                },
            },
            {
                binding: 2,
                resource: {
                    buffer: cameraUniformBuffer,
                },
            },
            {
                binding: 3,
                resource: {
                    buffer: sceneUniformBuffer,
                },
            },
        ],
    });


    const pointLights = []
    const colors = [
        vec3.fromValues(1.0, 0.0, 0.0),
        vec3.fromValues(0.0, 1.0, 0.0),
        vec3.fromValues(0.0, 0.0, 1.0),
    ]
    for (let i = 0; i < kMaxNumLights; ++i) {
        const color = colors[i % colors.length]
        pointLights.push(new PointLight(color))
    }



    //--------------------

    // Scene matrices
    const eyePosition = vec3.fromValues(0, 50, -100);

    const projectionMatrix = mat4.perspective(
        (2 * Math.PI) / 5,
        aspect,
        1,
        2000.0
    );

    const viewMatrix = mat4.inverse(mat4.lookAt(eyePosition, origin, upVector));

    const viewProjMatrix = mat4.multiply(projectionMatrix, viewMatrix);

    // Move the model so it's centered.
    const modelMatrix = mat4.translation([0, -45, 0]);

    const modelData = modelMatrix /*as Float32Array*/;
    device.queue.writeBuffer(
        modelUniformBuffer,
        0,
        modelData.buffer,
        modelData.byteOffset,
        modelData.byteLength
    );
    const invertTransposeModelMatrix = mat4.invert(modelMatrix);
    mat4.transpose(invertTransposeModelMatrix, invertTransposeModelMatrix);
    const normalModelData = invertTransposeModelMatrix /*as Float32Array*/;
    device.queue.writeBuffer(
        modelUniformBuffer,
        64,
        normalModelData.buffer,
        normalModelData.byteOffset,
        normalModelData.byteLength
    );

    // Rotates the camera around the origin based on time.
    function getCameraViewProjMatrix(t) {
        const eyePosition = vec3.fromValues(0, 50, -100);

        const rad = t * (Math.PI / 10);
        const rotation = mat4.rotateY(mat4.translation(origin), rad);
        vec3.transformMat4(eyePosition, rotation, eyePosition);
        const rotatedEyePosition = vec3.transformMat4(eyePosition, rotation);

        const viewMatrix = mat4.lookAt(rotatedEyePosition, origin, upVector);

        mat4.multiply(projectionMatrix, viewMatrix, viewProjMatrix);
        return viewProjMatrix /*as Float32Array*/;
    }

    function frame() {
        // Sample is no longer the active page.
        // if (!pageState.active) return;

        const t = Date.now() * (1 / 1000);
        const cameraViewProj = getCameraViewProjMatrix(t);
        device.queue.writeBuffer(
            cameraUniformBuffer,
            0,
            cameraViewProj.buffer,
            cameraViewProj.byteOffset,
            cameraViewProj.byteLength
        );
        const cameraInvViewProj = mat4.invert(cameraViewProj) /*as Float32Array*/;
        device.queue.writeBuffer(
            cameraUniformBuffer,
            64,
            cameraInvViewProj.buffer,
            cameraInvViewProj.byteOffset,
            cameraInvViewProj.byteLength
        );

        {
            const modelData = modelMatrix /*as Float32Array*/;
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
            pointLight.update(device, sceneUniformBuffer, i)
        }

        const commandEncoder = device.createCommandEncoder();
        {
            // Write position, normal, albedo etc. data to gBuffers
            const gBufferPass = commandEncoder.beginRenderPass(
                writeGBufferPassDescriptor
            );
            gBufferPass.setPipeline(writeGBuffersPipeline);
            gBufferPass.setBindGroup(0, sceneUniformBindGroup);
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
                const debugViewPass = commandEncoder.beginRenderPass(
                    textureQuadPassDescriptor
                );
                debugViewPass.setPipeline(gBuffersDebugViewPipeline);
                debugViewPass.setBindGroup(0, gBufferTexturesBindGroup);
                debugViewPass.draw(6);
                debugViewPass.end();
            } else {
                //シャドウマップの描画
                for (let i = 0; i < settings.numLights; ++i) {
                    const shadowPass = commandEncoder.beginRenderPass(shadowPassDescriptors[i]);
                    shadowPass.setPipeline(shadowPipelines[i]);
                    shadowPass.setBindGroup(0, sceneBindGroupForShadow);
                    shadowPass.setBindGroup(1, modelBindGroup);
                    shadowPass.setVertexBuffer(0, vertexBuffer);
                    shadowPass.setIndexBuffer(indexBuffer, 'uint16');
                    shadowPass.drawIndexed(indexCount);
                    shadowPass.end();
                }

                // Deferred rendering
                const view = context.getCurrentTexture().createView();
                textureQuadPassDescriptor.colorAttachments[0].view = view
                const deferredRenderingPass = commandEncoder.beginRenderPass(textureQuadPassDescriptor)
                deferredRenderingPass.setPipeline(deferredRenderPipeline);
                deferredRenderingPass.setBindGroup(0, gBufferTexturesBindGroup);
                deferredRenderingPass.setBindGroup(1, lightsBufferBindGroup);
                deferredRenderingPass.setBindGroup(2, sceneBindGroupForShadow);
                deferredRenderingPass.draw(6);
                deferredRenderingPass.end();
            }
        }
        device.queue.submit([commandEncoder.finish()]);

        requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
};

async function main() {
    const canvas = document.querySelector('canvas')

    await init({canvas})
}

await main()
