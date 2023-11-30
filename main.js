import {mat4, vec3} from 'https://wgpu-matrix.org/dist/2.x/wgpu-matrix.module.js'
import * as dat from 'https://cdn.jsdelivr.net/npm/dat.gui@0.7.9/build/dat.gui.module.js'
import {mesh as dragonMeshData} from './stanford-dragon.js'
import {mesh as backgroundMeshData} from './background.js'
import {createCube, createSphere, createTorus} from './utils.js'

const kMaxNumLights = 32;
const kMaxShadowPasses = kMaxNumLights * 2;  // 点光源用、双放物面で２倍必要

const shadowDepthTextureSize = 1024;
const envmapTextureSize = 1024;

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

function initPointLight(lightColor, index, device, lightStorageBuffer) {
    const r = randomRange(30, 180)
    const ry = randomRange(10, 40)
    const tx = posNegRand(deg2rad(10), deg2rad(40))
    const ty = posNegRand(deg2rad(10), deg2rad(40))
    const tz = posNegRand(deg2rad(10), deg2rad(40))

    const offset = 16 + (16 * (3 + 4 + 1)) * index;

    device.queue.writeBuffer(
        lightStorageBuffer,
        16 * 0 + offset,
        lightColor.buffer,
        lightColor.byteOffset,
        lightColor.byteLength
    );

    const far = 400 * 2

    const param = vec3.fromValues(r, ry, far)
    device.queue.writeBuffer(
        lightStorageBuffer,
        16 * 1 + offset,
        param.buffer,
        param.byteOffset,
        param.byteLength
    );

    const rotSpeed = vec3.fromValues(tx, ty, tz)
    device.queue.writeBuffer(
        lightStorageBuffer,
        16 * 2 + offset,
        rotSpeed.buffer,
        rotSpeed.byteOffset,
        rotSpeed.byteLength
    );
}

class Material {
    constructor(device, color, reflectivity, uniformLayout) {
        this.uniformBuffer = device.createBuffer({
            size: 4 * 4, // one color+reflectivity.
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        this.uniformBindGroup = device.createBindGroup({
            layout: uniformLayout,
            entries: [
                {
                    binding: 0,
                    resource: {
                        buffer: this.uniformBuffer,
                    },
                },
            ],
        });

        this.updateValue(device, color, reflectivity)
    }

    updateValue(device, color, reflectivity) {
        const data = new Float32Array([color[0], color[1], color[2], reflectivity])
        device.queue.writeBuffer(
            this.uniformBuffer,
            0,
            data.buffer,
            data.byteOffset,
            data.byteLength
        )
    }
}

class Mesh {
    constructor(device, meshData, vertexStride = 11) {
        this.vertexBuffer = device.createBuffer({
            // position: vec3, normal: vec3, uv: vec2
            size:
                meshData.positions.length * vertexStride * Float32Array.BYTES_PER_ELEMENT,
            usage: GPUBufferUsage.VERTEX,
            mappedAtCreation: true,
        });
        {
            const mapping = new Float32Array(this.vertexBuffer.getMappedRange());
            for (let i = 0; i < meshData.positions.length; ++i) {
                mapping.set(meshData.positions[i], vertexStride * i);
                mapping.set(meshData.normals[i], vertexStride * i + 3);
                mapping.set(meshData.uvs[i], vertexStride * i + 6);
                mapping.set(meshData.colors[i], vertexStride * i + 8);
            }
            this.vertexBuffer.unmap();
        }

        // Create the model index buffer.
        this.indexCount = meshData.triangles.length * 3;
        this.indexBuffer = device.createBuffer({
            size: this.indexCount * Uint16Array.BYTES_PER_ELEMENT,
            usage: GPUBufferUsage.INDEX,
            mappedAtCreation: true,
        });
        {
            const mapping = new Uint16Array(this.indexBuffer.getMappedRange());
            for (let i = 0; i < meshData.triangles.length; ++i) {
                mapping.set(meshData.triangles[i], 3 * i);
            }
            this.indexBuffer.unmap();
        }
    }
}

class GameObject {
    constructor(device, mesh, material, bindGroupLayout) {
        this.mesh = mesh;
        this.material = material;

        this.uniformBuffer = device.createBuffer({
            size: 4 * 16 * 1, // one 4x4 matrix
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        this.uniformBindGroup = device.createBindGroup({
            layout: bindGroupLayout,
            entries: [
                {
                    binding: 0,
                    resource: {
                        buffer: this.uniformBuffer,
                    },
                },
            ],
        });

        this.setMatrix(device, mat4.identity())
    }

    setMesh(mesh) {
        this.mesh = mesh
    }

    setMatrix(device, matrix) {
        device.queue.writeBuffer(
            this.uniformBuffer,
            0,
            matrix.buffer,
            matrix.byteOffset,
            matrix.byteLength
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
    let unlitShader
    let computeLightUpdateShader

    await Promise.all([
        fetch('./vertexWriteGBuffers.wgsl').then((r) => r.text()).then((r) => vertexWriteGBuffers = r),
        fetch('./fragmentWriteGBuffers.wgsl').then((r) => r.text()).then((r) => fragmentWriteGBuffers = r),
        fetch('./vertexTextureQuad.wgsl').then((r) => r.text()).then((r) => vertexTextureQuad = r),
        fetch('./fragmentGBuffersDebugView.wgsl').then((r) => r.text()).then((r) => fragmentGBuffersDebugView = r),
        fetch('./fragmentDeferredRendering.wgsl').then((r) => r.text()).then((r) => fragmentDeferredRendering = r),
        fetch('./shadowGen.wgsl').then((r) => r.text()).then((r) => shadowGenShader = r),
        fetch('./unlit.wgsl').then((r) => r.text()).then((r) => unlitShader = r),
        fetch('./computeLightUpdate.wgsl').then((r) => r.text()).then((r) => computeLightUpdateShader = r),
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
            arrayStride: Float32Array.BYTES_PER_ELEMENT * 11,
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
                {
                    // color
                    shaderLocation: 3,
                    offset: Float32Array.BYTES_PER_ELEMENT * 8,
                    format: 'float32x3',
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
    const materialUniformBufferBindGroupLayout = uniformBufferBindGroupLayout

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
                materialUniformBufferBindGroupLayout,
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

    const debugTexturesBindGroupLayout = device.createBindGroupLayout({
        label: 'debugTexturesBindGroupLayout',
        entries: [
            {
                binding: 0,
                visibility: GPUShaderStage.FRAGMENT,
                texture: {
                    sampleType: 'unfilterable-float',
                    viewDimension: '2d-array',
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
                    sampleType: 'unfilterable-float',
                },
            },
            {
                binding: 3,
                visibility: GPUShaderStage.FRAGMENT,
                texture: {
                    sampleType: 'depth',
                },
            },
        ],
    });

    const envmapTexturesBindGroupLayout = device.createBindGroupLayout({
        label: 'envmapTexturesBindGroupLayout',
        entries: [
            {
                binding: 0,
                visibility: GPUShaderStage.FRAGMENT,
                texture: {
                    sampleType: 'unfilterable-float',
                    viewDimension: '2d-array',
                },
            },
            {
                binding: 1,
                visibility: GPUShaderStage.FRAGMENT,
                sampler: {
                    type: 'non-filtering',
                },
            },
        ],
    });

    const gBuffersDebugViewPipeline = device.createRenderPipeline({
        label: 'gBuffersDebugViewPipeline',
        layout: device.createPipelineLayout({
            bindGroupLayouts: [
                gBufferTexturesBindGroupLayout,
                debugTexturesBindGroupLayout,
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
                cameraUniformBufferBindGroupLayout,
                lightStorageBufferBindGroupLayout,
                envmapTexturesBindGroupLayout,
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
            entryPoint: 'mainWithEnvmap',
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

    const MODE_DRAGON = 'Dragon'
    const MODE_CUBE = 'Cube'
    const MODE_SPHERE = 'Sphere'
    const MODE_TORUS = 'Torus'
    const MODE_GBUFFER = 'gBuffers view'

    const settings = {
        mode: MODE_DRAGON,
        reflectivity: 1.0,
        numLights: 10,
        rotateModel: false,
    };

    gui
        .add(settings, 'mode', [MODE_DRAGON, MODE_CUBE, MODE_SPHERE, MODE_TORUS, MODE_GBUFFER])
        .onChange(() => {
            let mesh = meshes[settings.mode]
            if (mesh != null) {
                dragonObject.setMesh(mesh)
                dragonObject.setMatrix(device, mat4.translation(modelPosition))
                vec3.set(0.0, 0.0, 0.0, modelRotation)
            }
        })
    gui
        .add(settings, 'reflectivity', 0.0, 1.0)
        .step(0.01)
        .onChange(() => {
            mirrorMaterial.updateValue(device, [1.0, 1.0, 1.0], settings.reflectivity)
        });
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
    gui.add(settings, 'rotateModel')

    const materialUniformLayoutGroup = writeGBuffersPipeline.getBindGroupLayout(1)
    const blinnPhongMaterial = new Material(device, [1.0, 1.0, 1.0], 0.0, materialUniformLayoutGroup)
    const mirrorMaterial = new Material(device, [1.0, 1.0, 1.0], settings.reflectivity, materialUniformLayoutGroup)

    const dragonMesh = new Mesh(device, dragonMeshData)
    const cubeMesh = new Mesh(device, createCube(20.0, 16))
    const sphereMesh = new Mesh(device, createSphere(25.0, 64, 32))
    const torusMesh = new Mesh(device, createTorus(25.0, 8.0, 64, 32))
    const meshes = {
        [MODE_DRAGON]: dragonMesh,
        [MODE_CUBE]: cubeMesh,
        [MODE_SPHERE]: sphereMesh,
        [MODE_TORUS]: torusMesh,
    }

    // Create the model vertex buffer.
    const dragonObject = new GameObject(device, meshes[settings.mode], mirrorMaterial, modelUniformBufferBindGroupLayout)
    const backgroundObject = new GameObject(device, new Mesh(device, backgroundMeshData), blinnPhongMaterial, modelUniformBufferBindGroupLayout)
    const sceneGameObjects = [dragonObject, backgroundObject]


    // Move the model so it's centered.
    const modelPosition = vec3.fromValues(0, 20, 0);
    dragonObject.setMatrix(device, mat4.translation(modelPosition))
    backgroundObject.setMatrix(device, mat4.translation([0, -45, 0]))

    const cameraUniformBuffer = device.createBuffer({
        size: 4 * 16 * 2 + 4 * 4, // two 4x4 matrix + one vec3
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
        //     color: vec3
        //     param: vec4
        //     rotSpeed: vec3
        //     viewProjMatrix: mat4x4
        //     pos: vec3
        // Rounded to the nearest multiple of 16.
        size: 16 + (16 * (3 + 4 + 1)) * kMaxNumLights,
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

    // VVV ライト更新関連 VVV

    const lightUpdateInfoUniformBuffer = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const lightUpdatePipeline = device.createComputePipeline({
        label: 'lightUpdatePipeline',
        layout: 'auto',
        compute: {
            module: device.createShaderModule({
                label: 'computeLightUpdateShaderModule',
                code: computeLightUpdateShader,
            }),
            entryPoint: 'main',
        },
    })

    const lightUpdateBindGroup = device.createBindGroup({
            label: 'lightUpdateBindGroup',
            layout: lightUpdatePipeline.getBindGroupLayout(0),
            entries: [
                {
                    binding: 0,
                    resource: { buffer: lightStorageBuffer },
                },
                {
                    binding: 1,
                    resource: { buffer: lightUpdateInfoUniformBuffer },
                },
            ],
        })

    const workgroupCount = {x: 1, y: 1}

    // ^^^ ライト更新関連 ^^^

    // VVV unlit関連 VVV

    const meshForLight = createSphere(1.0, 12, 6)
    const meshForLightVertexStride = 5;
    const meshForLightVerticesBuffer = (() => {
        const vertexBuffer = device.createBuffer({
            // position: vec3, normal: vec3, uv: vec2
            size: meshForLight.positions.length * meshForLightVertexStride * Float32Array.BYTES_PER_ELEMENT,
            usage: GPUBufferUsage.VERTEX,
            mappedAtCreation: true,
        });
        {
            const mapping = new Float32Array(vertexBuffer.getMappedRange());
            for (let i = 0; i < meshForLight.positions.length; ++i) {
                mapping.set(meshForLight.positions[i], meshForLightVertexStride * i);
                mapping.set(meshForLight.uvs[i], meshForLightVertexStride * i + 3);
            }
            vertexBuffer.unmap();
        }
        return vertexBuffer
    })()
    const meshForLightIndexCount = meshForLight.triangles.length * 3
    const meshForLightIndexBuffer = ((indexCount) => {
        const indexBuffer = device.createBuffer({
            size: indexCount * Uint16Array.BYTES_PER_ELEMENT,
            usage: GPUBufferUsage.INDEX,
            mappedAtCreation: true,
        });
        const mapping = new Uint16Array(indexBuffer.getMappedRange());
        for (let i = 0; i < meshForLight.triangles.length; ++i) {
            mapping.set(meshForLight.triangles[i], 3 * i);
        }
        indexBuffer.unmap();
        return indexBuffer
    })(meshForLightIndexCount)

    const unlitVertexBuffersDescritors = [
        {
            arrayStride: Float32Array.BYTES_PER_ELEMENT * meshForLightVertexStride,
            attributes: [
                {
                    // position
                    shaderLocation: 0,
                    offset: 0,
                    format: 'float32x3',
                },
                {
                    // uv
                    shaderLocation: 1,
                    offset: Float32Array.BYTES_PER_ELEMENT * 3,
                    format: 'float32x2',
                },
            ],
        },
    ]

    const unlitPipeline = device.createRenderPipeline({
        label: 'unlitPipeline',
        layout: device.createPipelineLayout({
            bindGroupLayouts: [
                cameraUniformBufferBindGroupLayout,
                lightStorageBufferBindGroupLayout,
            ],
        }),
        vertex: {
            module: device.createShaderModule({
                code: unlitShader,
            }),
            entryPoint: 'vertexMain',
            buffers: unlitVertexBuffersDescritors,
        },
        fragment: {
            module: device.createShaderModule({
                code: unlitShader,
            }),
            entryPoint: 'fragmentMain',
            targets: [{
                format: presentationFormat,
            }],
        },
        depthStencil: {
            depthWriteEnabled: true,
            depthCompare: 'less',
            format: 'depth24plus',
        },
        primitive,
    })

    const unlitPassDescriptor = {
        colorAttachments: [
            {
                // view is acquired and set in render loop.
                view: undefined,
                loadOp: 'load',
                storeOp: 'store',
            },
        ],
        depthStencilAttachment: {
            view: depthTexture.createView(),
            depthLoadOp: 'load',
            depthStoreOp: 'store',
        },
    };

    // ^^^ unlit関連 ^^^

    // VVV 環境マップ関連 VVV

    const envmapGBufferTextureNormal = device.createTexture({
        size: [envmapTextureSize, envmapTextureSize],
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        format: 'rgba16float',
    });
    const envmapGBufferTextureAlbedo = device.createTexture({
        size: [envmapTextureSize, envmapTextureSize],
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        format: 'bgra8unorm',
    });
    const envmapDepthTexture = device.createTexture({
        size: [envmapTextureSize, envmapTextureSize],
        format: 'depth24plus',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    const kEnvmapTextureFormat = 'rgba16float'
    const envmapTexture = device.createTexture({
        size: [envmapTextureSize, envmapTextureSize, 2],
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        format: kEnvmapTextureFormat,
    });
    const envmapTextureViews = [...Array(2)].map((_, i) => envmapTexture.createView({arrayLayerCount: 1, baseArrayLayer: i}))

    const writeEnvmapGBufferPassDescriptor = {
        colorAttachments: [
            {
                view: envmapGBufferTextureNormal.createView(),
                clearValue: { r: 0.0, g: 0.0, b: 1.0, a: 1.0 },
                loadOp: 'clear',
                storeOp: 'store',
            },
            {
                view: envmapGBufferTextureAlbedo.createView(),
                clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 1.0 },
                loadOp: 'clear',
                storeOp: 'store',
            },
        ],
        depthStencilAttachment: {
            view: envmapDepthTexture.createView(),
            depthClearValue: 1.0,
            depthLoadOp: 'clear',
            depthStoreOp: 'store',
        },
    }

    const writeEnvmapGBuffersPipelines = [...Array(2)].map((_, i) => device.createRenderPipeline({
            layout: device.createPipelineLayout({
                bindGroupLayouts: [
                    cameraUniformBufferBindGroupLayout,
                    modelUniformBufferBindGroupLayout,
                    materialUniformBufferBindGroupLayout,
                ],
            }),
            vertex: {
                module: device.createShaderModule({
                    code: vertexWriteGBuffers,
                }),
                entryPoint: 'main',
                buffers: vertexBuffers,
                constants: {
                    paraboloid: true,
                    viewDirection: 1.0 - i * 2,
                },
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
                constants: {
                    paraboloid: true,
                },
            },
            depthStencil: {
                depthWriteEnabled: true,
                depthCompare: 'less',
                format: 'depth24plus',
            },
            primitive: {
                topology: 'triangle-list',
                cullMode: ['back', 'front'][i],
            },
        }))

    const envmapCameraUniformBuffer = device.createBuffer({
        size: 4 * 16 * 2 + 4 * 4, // two 4x4 matrix + one vec3
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const envmapCameraUniformBindGroup = device.createBindGroup({
        layout: writeGBuffersPipeline.getBindGroupLayout(0),
        entries: [
            {
                binding: 0,
                resource: {
                    buffer: envmapCameraUniformBuffer,
                },
            },
        ],
    });

    const envmapDeferredRenderPipelines = [...Array(2)].map((_, i) => device.createRenderPipeline({
            label: 'envmapDeferredRenderPipeline',
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
                entryPoint: 'mainWithoutEnvmap',
                targets: [
                    {
                        format: kEnvmapTextureFormat,
                    },
                ],
                constants: {
                    shadowDepthTextureSize: envmapTextureSize,
                    paraboloid: true,
                    viewDirection: 1.0 - i * 2,
                },
            },
            primitive,
        }))

    const envmapCameraBufferBindGroup = device.createBindGroup({
        label: 'envmapCameraBufferBindGroup',
        layout: cameraUniformBufferBindGroupLayout,
        entries: [
            {
                binding: 0,
                resource: {
                    buffer: envmapCameraUniformBuffer,
                },
            },
        ],
    });

    const envmapGBufferTexturesBindGroup = device.createBindGroup({
        layout: gBufferTexturesBindGroupLayout,
        entries: [
            {
                binding: 0,
                resource: envmapGBufferTextureNormal.createView(),
            },
            {
                binding: 1,
                resource: envmapGBufferTextureAlbedo.createView(),
            },
            {
                binding: 2,
                resource: envmapDepthTexture.createView(),
            },
            {
                binding: 3,
                resource: shadowDepthTexture.createView(),  //gBufferTextureViews[3],
            },
            {
                binding: 4,
                resource: device.createSampler({
                    compare: 'less',
                }),
            },
        ],
    });

    const envmapTexturesBindGroup = device.createBindGroup({
        layout: envmapTexturesBindGroupLayout,
        entries: [
            {
                binding: 0,
                resource: envmapTexture.createView(),
            },
            {
                binding: 1,
                resource: device.createSampler(),
            },
        ],
    });

    const envmapUnlitPassDescriptors = [...Array(2)].map((_, i) => { return {
            colorAttachments: [
                {
                    // view is acquired and set in render loop.
                    view: envmapTextureViews[i],
                    loadOp: 'load',
                    storeOp: 'store',
                },
            ],
            depthStencilAttachment: {
                view: envmapDepthTexture.createView(),
                depthLoadOp: 'load',
                depthStoreOp: 'store',
            },
        }})

    const envmapUnlitPipelines = [...Array(2)].map((_, i) => device.createRenderPipeline({
            label: 'envmapUnlitPipeline',
            layout: device.createPipelineLayout({
                bindGroupLayouts: [
                    cameraUniformBufferBindGroupLayout,
                    lightStorageBufferBindGroupLayout,
                ],
            }),
            vertex: {
                module: device.createShaderModule({
                    code: unlitShader,
                }),
                entryPoint: 'vertexMain',
                buffers: unlitVertexBuffersDescritors,
                constants: {
                    paraboloid: true,
                    viewDirection: 1.0 - i * 2,
                },
            },
            fragment: {
                module: device.createShaderModule({
                    code: unlitShader,
                }),
                entryPoint: 'fragmentMain',
                targets: [{
                    format: kEnvmapTextureFormat,
                }],
                constants: {
                    paraboloid: true,
                },
            },
            depthStencil: {
                depthWriteEnabled: false,
                depthCompare: 'less',
                format: 'depth24plus',
            },
            primitive,
        }))

    // ^^^ 環境マップ関連 ^^^

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

    const debugTexturesBindGroup = device.createBindGroup({
        layout: debugTexturesBindGroupLayout,
        entries: [
            {
                binding: 0,
                resource: envmapTexture.createView(),
            },
            {
                binding: 1,
                resource: envmapGBufferTextureNormal.createView(),
            },
            {
                binding: 2,
                resource: envmapGBufferTextureAlbedo.createView(),
            },
            {
                binding: 3,
                resource: envmapDepthTexture.createView(),
            },
        ],
    });

    const colors = shuffle([
        vec3.fromValues(1.0, 0.0, 0.0),
        vec3.fromValues(0.0, 1.0, 0.0),
        vec3.fromValues(0.0, 0.0, 1.0),
    ])
    const intensity = 10000
    for (let i = 0; i < kMaxNumLights; ++i) {
        const color = i === 0 ? vec3.scale([1.0, 1.0, 1.0], intensity * 4)
                              : vec3.scale(colors[i % colors.length], intensity)
        initPointLight(color, i, device, lightStorageBuffer)
    }


    //--------------------

    // Scene matrices
    const eyeTarget = vec3.fromValues(0, 50, 0)
    const eyeDistance = vec3.fromValues(0, 0, 100)

    const projectionMatrix = mat4.perspective(
        (2 * Math.PI) / 5,
        aspect,
        1,
        2000.0
    );

    // Rotates the camera around the origin based on time.
    function getCameraViewMatrix(t) {
        const rad = t * (Math.PI / 20);
        const radX = Math.sin(t * (Math.PI / 13)) * (Math.PI / 8);
        const rotation = mat4.rotateX(mat4.rotateY(mat4.translation(eyeTarget), rad), radX)
        const rotatedEyePosition = vec3.transformMat4(eyeDistance, rotation)

        const viewMatrix = mat4.lookAt(rotatedEyePosition, origin, upVector);
        return {
            viewMatrix: viewMatrix,
            position: rotatedEyePosition,
        };
    }

    const modelRotation = vec3.fromValues(0.0, 0.0, 0.0)
    let lastTime = window.performance.now()

    function frame() {
        // Sample is no longer the active page.

        const now = window.performance.now()
        const t = now * (1 / 1000)
        const elapsedTime = (now - lastTime) * (1 / 1000)
        lastTime = now

        {
            const {viewMatrix, position} = getCameraViewMatrix(t);
            {
                const cameraViewProj = mat4.multiply(projectionMatrix, viewMatrix)
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
                    4 * 16,
                    cameraInvViewProj.buffer,
                    cameraInvViewProj.byteOffset,
                    cameraInvViewProj.byteLength
                );
                device.queue.writeBuffer(
                    cameraUniformBuffer,
                    4 * 16 * 2,
                    position.buffer,
                    position.byteOffset,
                    position.byteLength
                );
            }

            // 環境マップ作成用のカメラにも設定（プロジェクション変換はなし）
            {
                // 環境マッピングはワールド座標系で計算するのでカメラの回転は加えず、
                // モデル中心への変換行列
                const envmapViewMatrix = mat4.create(
                    1.0, 0.0, 0.0, 0.0,
                    0.0, 1.0, 0.0, 0.0,
                    0.0, 0.0, 1.0, 0.0,
                    0.0, -60.0, 0.0, 1.0,
                )

                let envmapProjectionMatrix = (() => {
                    const far = 400 * 2
                    const invfar = 1.0 / far
                    return mat4.create(
                        invfar, 0.0,  0.0, 0.0,
                        0.0, invfar,  0.0, 0.0,
                        0.0, 0.0, -invfar, 0.0,
                        0.0, 0.0,  0.0, 1.0)
                })();

                const envmapViewProj = mat4.multiply(envmapProjectionMatrix, envmapViewMatrix)
                device.queue.writeBuffer(
                    envmapCameraUniformBuffer,
                    0,
                    envmapViewProj.buffer,
                    envmapViewProj.byteOffset,
                    envmapViewProj.byteLength
                );
                const envmapInvViewProj = mat4.invert(envmapViewProj);
                device.queue.writeBuffer(
                    envmapCameraUniformBuffer,
                    4 * 16,
                    envmapInvViewProj.buffer,
                    envmapInvViewProj.byteOffset,
                    envmapInvViewProj.byteLength
                );
                device.queue.writeBuffer(
                    envmapCameraUniformBuffer,
                    4 * 16 * 2,
                    position.buffer,
                    position.byteOffset,
                    position.byteLength
                );
            }
        }

        {
            const WORKGROUP_SIZE = 8

            workgroupCount.x = Math.ceil(Math.sqrt(settings.numLights / (WORKGROUP_SIZE * WORKGROUP_SIZE)))
            workgroupCount.y = Math.ceil((settings.numLights / (WORKGROUP_SIZE * WORKGROUP_SIZE)) / workgroupCount.x)

            const buffer = new ArrayBuffer(16)
            const p1 = new Float32Array(buffer, 0, 1)  // nowInSeconds
            p1[0] = t
            const p2 = new Uint32Array(buffer, 4, 1)   // workgroupWidth
            p2[0] = workgroupCount.x * WORKGROUP_SIZE

            device.queue.writeBuffer(
                lightUpdateInfoUniformBuffer,
                0,
                buffer, 0, buffer.byteLength)
        }

        if (settings.rotateModel) {
            modelRotation[0] += deg2rad(10) * elapsedTime
            modelRotation[1] += deg2rad(15) * elapsedTime
            modelRotation[2] += deg2rad(25) * elapsedTime
            const matrix = mat4.rotateY(mat4.rotateX(mat4.rotateZ(mat4.translation(modelPosition), modelRotation[2]), modelRotation[0]), modelRotation[1])
            dragonObject.setMatrix(device, matrix)
        }

        const commandEncoder = device.createCommandEncoder();

        {
            const computePass = commandEncoder.beginComputePass()
            computePass.setPipeline(lightUpdatePipeline)
            computePass.setBindGroup(0, lightUpdateBindGroup)
            computePass.dispatchWorkgroups(workgroupCount.x, workgroupCount.y)
            computePass.end()
        }

        {
            // 各光源からのシャドウマップを作成（光源ごとに前後２枚）
            for (let i = 0; i < settings.numLights * 2; ++i) {
                const shadowPass = commandEncoder.beginRenderPass(shadowPassDescriptors[i]);
                shadowPass.setPipeline(shadowPipelines[i & 1]);
                shadowPass.setBindGroup(0, lightStorageBindGroup);
                shadowPass.setBindGroup(2, shadowUniformBindGroups[i >> 1])
                for (const go of sceneGameObjects) {
                    shadowPass.setBindGroup(1, go.uniformBindGroup);
                    shadowPass.setVertexBuffer(0, go.mesh.vertexBuffer);
                    shadowPass.setIndexBuffer(go.mesh.indexBuffer, 'uint16');
                    shadowPass.drawIndexed(go.mesh.indexCount);
                }
                shadowPass.end();
            }
        }
        {
            for (let i = 0; i < 2; ++i) {
                // 環境マップ用Gバッファ構築
                const envmapGBufferPass = commandEncoder.beginRenderPass(writeEnvmapGBufferPassDescriptor);
                envmapGBufferPass.setPipeline(writeEnvmapGBuffersPipelines[i]);
                envmapGBufferPass.setBindGroup(0, envmapCameraUniformBindGroup);
                for (const go of sceneGameObjects) {
                    if (go === dragonObject)
                        continue
                    envmapGBufferPass.setBindGroup(1, go.uniformBindGroup);
                    envmapGBufferPass.setBindGroup(2, go.material.uniformBindGroup);
                    envmapGBufferPass.setVertexBuffer(0, go.mesh.vertexBuffer);
                    envmapGBufferPass.setIndexBuffer(go.mesh.indexBuffer, 'uint16');
                    envmapGBufferPass.drawIndexed(go.mesh.indexCount);
                }
                envmapGBufferPass.end();

                // 環境マップ半球作成
                // （シャドウマップも使用する）
                textureQuadPassDescriptor.colorAttachments[0].view = envmapTextureViews[i]
                const envmapDeferredRenderingPass = commandEncoder.beginRenderPass(textureQuadPassDescriptor)
                envmapDeferredRenderingPass.setPipeline(envmapDeferredRenderPipelines[i]);
                envmapDeferredRenderingPass.setBindGroup(0, envmapGBufferTexturesBindGroup);
                envmapDeferredRenderingPass.setBindGroup(1, envmapCameraBufferBindGroup);
                envmapDeferredRenderingPass.setBindGroup(2, lightStorageBindGroup);
                envmapDeferredRenderingPass.draw(6);
                envmapDeferredRenderingPass.end();

                // フォワードレンダリングで点光源の位置に描画してやる
                const unlitPass = commandEncoder.beginRenderPass(envmapUnlitPassDescriptors[i])
                unlitPass.setPipeline(envmapUnlitPipelines[i]);
                unlitPass.setBindGroup(0, envmapCameraBufferBindGroup);
                unlitPass.setBindGroup(1, lightStorageBindGroup);
                unlitPass.setVertexBuffer(0, meshForLightVerticesBuffer);
                unlitPass.setIndexBuffer(meshForLightIndexBuffer, 'uint16');
                unlitPass.drawIndexed(meshForLightIndexCount, settings.numLights);
                unlitPass.end();
            }
        }
        {
            const gBufferPass = commandEncoder.beginRenderPass(writeGBufferPassDescriptor);
            gBufferPass.setPipeline(writeGBuffersPipeline);
            gBufferPass.setBindGroup(0, cameraUniformBindGroup);
            for (const go of sceneGameObjects) {
                // Write position, normal, albedo etc. data to gBuffers
                gBufferPass.setBindGroup(1, go.uniformBindGroup);
                gBufferPass.setBindGroup(2, go.material.uniformBindGroup);
                gBufferPass.setVertexBuffer(0, go.mesh.vertexBuffer);
                gBufferPass.setIndexBuffer(go.mesh.indexBuffer, 'uint16');
                gBufferPass.drawIndexed(go.mesh.indexCount);
            }
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
                debugViewPass.setBindGroup(1, debugTexturesBindGroup);
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
                deferredRenderingPass.setBindGroup(3, envmapTexturesBindGroup);
                deferredRenderingPass.draw(6);
                deferredRenderingPass.end();

                // フォワードレンダリングで点光源の位置に描画してやる
                unlitPassDescriptor.colorAttachments[0].view = view
                const unlitPass = commandEncoder.beginRenderPass(unlitPassDescriptor)
                unlitPass.setPipeline(unlitPipeline);
                unlitPass.setBindGroup(0, cameraUniformBindGroup);
                unlitPass.setBindGroup(1, lightStorageBindGroup);
                unlitPass.setVertexBuffer(0, meshForLightVerticesBuffer);
                unlitPass.setIndexBuffer(meshForLightIndexBuffer, 'uint16');
                unlitPass.drawIndexed(meshForLightIndexCount, settings.numLights);
                unlitPass.end();
            }
        }
        device.queue.submit([commandEncoder.finish()]);

        requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);

    document.body.addEventListener('mousewheel', event => {
        event.preventDefault()
        const z = eyeDistance[2] + eyeDistance[2] * event.deltaY * 0.001
        eyeDistance[2] = Math.max(30, Math.min(200, z))
        eyeTarget[1] = eyeDistance[2] * (50 / 100)
    }, {passive: false})
};

function notSupported() {
    const notSupported = document.getElementById('not-supported')
    notSupported.style.display = null  // デフォルト 'none' を削除して、表示する
}

async function main() {
    const device = await isWebGpuSupported()
    if (!device) {
        notSupported()
        return
    }

    const canvas = document.createElement('canvas')
    canvas.style.width = canvas.style.height = '100%'
    document.body.appendChild(canvas)

    const gui = new dat.GUI();

    await init({device, canvas, gui})
}

await main()
