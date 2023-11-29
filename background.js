import { addRect } from './utils.js'

export const mesh = {
    positions: [],
    triangles: [],
    normals: [] /*as [number, number, number][]*/,
    uvs: [] /*as [number, number][]*/,
    colors: [] /*as [number, number, number][]*/,
}

const GROUND_W = 200
const GROUND_Y = 30

const DIV = 32
const C1 = 1.0, C2 = 0.5
addRect(mesh, [-GROUND_W, GROUND_Y, -GROUND_W], [2 * GROUND_W, 0, 0], [0, 0, 2 * GROUND_W], [0, 1, 0], [C1, C1, C1], DIV)
addRect(mesh, [-GROUND_W, GROUND_Y, -GROUND_W], [0, 0,  2 * GROUND_W], [0, GROUND_W, 0], [ 1, 0, 0], [C1, C1, C2], DIV)
addRect(mesh, [-GROUND_W, GROUND_Y,  GROUND_W], [ 2 * GROUND_W, 0, 0], [0, GROUND_W, 0], [0, 0, -1], [C2, C1, C1], DIV)
addRect(mesh, [ GROUND_W, GROUND_Y,  GROUND_W], [0, 0, -2 * GROUND_W], [0, GROUND_W, 0], [-1, 0, 0], [C1, C1, C1], DIV)
addRect(mesh, [ GROUND_W, GROUND_Y, -GROUND_W], [-2 * GROUND_W, 0, 0], [0, GROUND_W, 0], [0, 0,  1], [C1, C1, C1], DIV)
addRect(mesh, [-GROUND_W, GROUND_Y + GROUND_W, -GROUND_W], [0, 0, 2 * GROUND_W], [2 * GROUND_W, 0, 0], [0, -1, 0], [C1, C2, C1], DIV)
