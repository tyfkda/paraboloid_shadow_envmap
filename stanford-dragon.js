import * as dragonRawData from './stanford-dragon.4.js'

import { computeSurfaceNormals, computeProjectedPlaneUVs, addRect } from './utils.js'

export const mesh = {
    positions: dragonRawData.positions /*as [number, number, number][]*/,
    triangles: dragonRawData.cells /*as [number, number, number][]*/,
    normals: [] /*as [number, number, number][]*/,
    uvs: [] /*as [number, number][]*/,
}

// Compute surface normals
mesh.normals = computeSurfaceNormals(mesh.positions, mesh.triangles)

// Compute some easy uvs for testing
mesh.uvs = computeProjectedPlaneUVs(mesh.positions, 'xy')

const GROUND_W = 200
const GROUND_Y = 30

const DIV = 32
addRect(mesh, [-GROUND_W, GROUND_Y, -GROUND_W], [2 * GROUND_W, 0, 0], [0, 0, 2 * GROUND_W], [0, 1, 0], DIV)
addRect(mesh, [-GROUND_W, GROUND_Y, -GROUND_W], [0, 0,  2 * GROUND_W], [0, GROUND_W, 0], [ 1, 0, 0], DIV)
addRect(mesh, [-GROUND_W, GROUND_Y,  GROUND_W], [ 2 * GROUND_W, 0, 0], [0, GROUND_W, 0], [0, 0, -1], DIV)
addRect(mesh, [ GROUND_W, GROUND_Y,  GROUND_W], [0, 0, -2 * GROUND_W], [0, GROUND_W, 0], [-1, 0, 0], DIV)
addRect(mesh, [ GROUND_W, GROUND_Y, -GROUND_W], [-2 * GROUND_W, 0, 0], [0, GROUND_W, 0], [0, 0,  1], DIV)
addRect(mesh, [-GROUND_W, GROUND_Y + GROUND_W, -GROUND_W], [0, 0, 2 * GROUND_W], [2 * GROUND_W, 0, 0], [0, -1, 0], DIV)
