import * as dragonRawData from './stanford-dragon.4.js'

import { computeSurfaceNormals, computeProjectedPlaneUVs } from './utils.js'

export const mesh = {
    positions: dragonRawData.positions /*as [number, number, number][]*/,
    triangles: dragonRawData.cells /*as [number, number, number][]*/,
    normals: [] /*as [number, number, number][]*/,
    uvs: [] /*as [number, number][]*/,
    colors: [] /*as [number, number, number][]*/,
}

// Compute surface normals
mesh.normals = computeSurfaceNormals(mesh.positions, mesh.triangles)

// Compute some easy uvs for testing
mesh.uvs = computeProjectedPlaneUVs(mesh.positions, 'xy')

for (let i = 0; i < mesh.positions.length; ++i)
    mesh.colors.push([1.0, 1.0, 1.0])
