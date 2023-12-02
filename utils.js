// import { vec3 } from 'wgpu-matrix'
import {vec3} from 'https://wgpu-matrix.org/dist/2.x/wgpu-matrix.module.js'

export function computeSurfaceNormals(
  positions,
  triangles
) {
  const normals = positions.map(() => {
    // Initialize to zero.
    return [0, 0, 0]
  })
  triangles.forEach(([i0, i1, i2]) => {
    const p0 = positions[i0]
    const p1 = positions[i1]
    const p2 = positions[i2]

    const v0 = vec3.subtract(p1, p0)
    const v1 = vec3.subtract(p2, p0)

    vec3.normalize(v0, v0)
    vec3.normalize(v1, v1)
    const norm = vec3.cross(v0, v1)

    // Accumulate the normals.
    vec3.add(normals[i0], norm, normals[i0])
    vec3.add(normals[i1], norm, normals[i1])
    vec3.add(normals[i2], norm, normals[i2])
  })
  normals.forEach((n) => {
    // Normalize accumulated normals.
    vec3.normalize(n, n)
  })

  return normals
}

// type ProjectedPlane = 'xy' | 'xz' | 'yz'

const projectedPlane2Ids = {
  xy: [0, 1],
  xz: [0, 2],
  yz: [1, 2],
}

export function computeProjectedPlaneUVs(
  positions,
  projectedPlane = 'xy'
) {
  const idxs = projectedPlane2Ids[projectedPlane]
  const uvs = positions.map(() => {
    // Initialize to zero.
    return [0, 0]
  })
  const extentMin = [Infinity, Infinity]
  const extentMax = [-Infinity, -Infinity]
  positions.forEach((pos, i) => {
    // Simply project to the selected plane
    uvs[i][0] = pos[idxs[0]]
    uvs[i][1] = pos[idxs[1]]

    extentMin[0] = Math.min(pos[idxs[0]], extentMin[0])
    extentMin[1] = Math.min(pos[idxs[1]], extentMin[1])
    extentMax[0] = Math.max(pos[idxs[0]], extentMax[0])
    extentMax[1] = Math.max(pos[idxs[1]], extentMax[1])
  })
  uvs.forEach((uv) => {
    uv[0] = (uv[0] - extentMin[0]) / (extentMax[0] - extentMin[0])
    uv[1] = (uv[1] - extentMin[1]) / (extentMax[1] - extentMin[1])
  })
  return uvs
}

export function addRect(mesh, basePos, vec1, vec2, normal, color, div) {
    if (mesh.colors == undefined) {
        mesh.colors = []
    }

    const baseIndex = mesh.positions.length
    const nv = div + 1
    // Triangle
    for (let i = 0; i < div; ++i) {
        for (let j = 0; j < div; ++j) {
            let k = baseIndex + (i * nv + j)
            mesh.triangles.push(
                [k + 0, k + nv, k + 1],
                [k + 1, k + nv, k + nv + 1],
            )
        }
    }

    // Position, normal, uv
    for (let i = 0; i < nv; ++i) {
        const pi = i / div
        for (let j = 0; j < nv; ++j) {
            const pj = j / div
            mesh.positions.push([
                basePos[0] + vec1[0] * pj + vec2[0] * pi,
                basePos[1] + vec1[1] * pj + vec2[1] * pi,
                basePos[2] + vec1[2] * pj + vec2[2] * pi])
            mesh.normals.push(normal)
            mesh.uvs.push([pj, pi])
            mesh.colors.push(color)
        }
    }
}

export function createCube(halfWidth, divisions) {
    const mesh = {
        positions: [] /*as [number, number, number][]*/,
        triangles: [] /*as [number, number, number][]*/,
        normals: [] /*as [number, number, number][]*/,
        uvs: [] /*as [number, number][]*/,
        colors: [] /*as [number, number, number][]*/,
    }

    const W = halfWidth * 2

    const white = [1.0, 1.0, 1.0]
    addRect(mesh, [-halfWidth, -halfWidth, -halfWidth], [ W, 0,  0], [0,  W,  0], [ 0, 0, -1], white, divisions)
    addRect(mesh, [ halfWidth, -halfWidth, -halfWidth], [ 0, 0,  W], [0,  W,  0], [ 1, 0,  0], white, divisions)
    addRect(mesh, [ halfWidth, -halfWidth,  halfWidth], [-W, 0,  0], [0,  W,  0], [ 0, 0,  1], white, divisions)
    addRect(mesh, [-halfWidth, -halfWidth,  halfWidth], [ 0, 0, -W], [0,  W,  0], [-1, 0,  0], white, divisions)
    addRect(mesh, [-halfWidth,  halfWidth, -halfWidth], [ W, 0,  0], [0,  0,  W], [ 0,  1, 0], white, divisions)
    addRect(mesh, [-halfWidth, -halfWidth,  halfWidth], [ W, 0,  0], [0,  0, -W], [ 0, -1, 0], white, divisions)

    return mesh
}

export function createSphere(radius, widthSegments, heightSegments) {
    const positions = [];
    const normals = [];
    const uvs = [];
    const triangles = [];

    for (let i = 0; i <= heightSegments; i++) {
        const theta = i * Math.PI / heightSegments;
        const sinTheta = Math.sin(theta);
        const cosTheta = Math.cos(theta);

        for (let j = 0; j <= widthSegments; j++) {
            const phi = j * 2 * Math.PI / widthSegments;
            const sinPhi = Math.sin(phi);
            const cosPhi = Math.cos(phi);

            const x = cosPhi * sinTheta;
            const y = cosTheta;
            const z = sinPhi * sinTheta;

            positions.push([radius * x, radius * y, radius * z]);
            normals.push([x, y, z]);
            uvs.push([j / widthSegments, i / heightSegments]);
        }
    }

    for (let i = 0; i < heightSegments; i++) {
        for (let j = 0; j < widthSegments; j++) {
            const first = (i * (widthSegments + 1)) + j;
            const second = first + widthSegments + 1;

            triangles.push([first, first + 1, second]);
            triangles.push([second, first + 1, second + 1]);
        }
    }

    const colors = []
    for (let i = 0; i < positions.length; ++i)
        colors.push([1.0, 1.0, 1.0])

    return {
        positions,
        normals,
        uvs,
        triangles,
        colors,
    };
}

export function createTorus(radius, tube, radialSegments, tubularSegments) {
    const positions = [];
    const normals = [];
    const uvs = [];
    const triangles = [];

    for (let j = 0; j <= radialSegments; j++) {
        for (let i = 0; i <= tubularSegments; i++) {
            const u = i / tubularSegments;
            const v = j / radialSegments;

            const x = (radius + tube * Math.cos(2 * Math.PI * u)) * Math.cos(2 * Math.PI * v);
            const y = (radius + tube * Math.cos(2 * Math.PI * u)) * Math.sin(2 * Math.PI * v);
            const z = tube * Math.sin(2 * Math.PI * u);

            positions.push([x, y, z]);

            const nx = Math.cos(2 * Math.PI * v) * Math.cos(2 * Math.PI * u);
            const ny = Math.sin(2 * Math.PI * v) * Math.cos(2 * Math.PI * u);
            const nz = Math.sin(2 * Math.PI * u);

            normals.push([nx, ny, nz]);

            uvs.push([u, v]);
        }
    }

    for (let j = 1; j <= radialSegments; j++) {
        for (let i = 1; i <= tubularSegments; i++) {
            const a = (tubularSegments + 1) * j + i - 1;
            const b = (tubularSegments + 1) * (j - 1) + i - 1;
            const c = (tubularSegments + 1) * (j - 1) + i;
            const d = (tubularSegments + 1) * j + i;

            triangles.push([a, d, b]);
            triangles.push([b, d, c]);
        }
    }

    const colors = []
    for (let i = 0; i < positions.length; ++i)
        colors.push([1.0, 1.0, 1.0])

    return {
        positions,
        normals,
        uvs,
        triangles,
        colors,
    };
}

// From Three.js:
// https://github.com/mrdoob/three.js/blob/09fe0527a9aa5aaca7aaf17531e6c0d0efaa8c59/src/geometries/TorusKnotGeometry.js
export function createKnot(radius, tube, radialSegments, tubularSegments, p, q) {
    function calculatePositionOnCurve( u, p, q, radius, position ) {

        const cu = Math.cos( u );
        const su = Math.sin( u );
        const quOverP = q / p * u;
        const cs = Math.cos( quOverP );

        position[0] = radius * ( 2 + cs ) * 0.5 * cu;
        position[1] = radius * ( 2 + cs ) * su * 0.5;
        position[2] = radius * Math.sin( quOverP ) * 0.5;
    }

    const positions = [];
    const normals = [];
    const uvs = [];
    const triangles = [];


    const vertex = vec3.create();
    const normal = vec3.create();

    const P1 = vec3.create();
    const P2 = vec3.create();

    const B = vec3.create();
    const T = vec3.create();
    const N = vec3.create();

    // generate vertices, normals and uvs

    for ( let i = 0; i <= tubularSegments; ++ i ) {

        // the radian "u" is used to calculate the position on the torus curve of the current tubular segment

        const u = i / tubularSegments * p * Math.PI * 2;

        // now we calculate two points. P1 is our current position on the curve, P2 is a little farther ahead.
        // these points are used to create a special "coordinate space", which is necessary to calculate the correct vertex positions

        calculatePositionOnCurve( u, p, q, radius, P1 );
        calculatePositionOnCurve( u + 0.01, p, q, radius, P2 );

        // calculate orthonormal basis

        vec3.sub(P2, P1, T)
        vec3.add(P2, P1, N)
        vec3.cross(T, N, B)
        vec3.cross(B, T, N)

        // normalize B, N. T can be ignored, we don't use it

        vec3.normalize(B, B)
        vec3.normalize(N, N)

        for ( let j = 0; j <= radialSegments; ++ j ) {

            // now calculate the vertices. they are nothing more than an extrusion of the torus curve.
            // because we extrude a shape in the xy-plane, there is no need to calculate a z-value.

            const v = j / radialSegments * Math.PI * 2;
            const cx = - tube * Math.cos( v );
            const cy = tube * Math.sin( v );

            // now calculate the final vertex position.
            // first we orient the extrusion with our basis vectors, then we add it to the current position on the curve

            vertex[0] = P1[0] + ( cx * N[0] + cy * B[0] );
            vertex[1] = P1[1] + ( cx * N[1] + cy * B[1] );
            vertex[2] = P1[2] + ( cx * N[2] + cy * B[2] );

            positions.push( [vertex[0], vertex[1], vertex[2]] );

            // normal (P1 is always the center/origin of the extrusion, thus we can use it to calculate the normal)

            vec3.normalize( vec3.sub( vertex, P1, normal ), normal)

            normals.push( [normal[0], normal[1], normal[2]] );

            // uv

            uvs.push( [q * i / tubularSegments, j / radialSegments] );

        }

    }

    // generate indices

    for ( let j = 1; j <= tubularSegments; j ++ ) {

        for ( let i = 1; i <= radialSegments; i ++ ) {

            // indices

            const a = ( radialSegments + 1 ) * ( j - 1 ) + ( i - 1 );
            const b = ( radialSegments + 1 ) * j + ( i - 1 );
            const c = ( radialSegments + 1 ) * j + i;
            const d = ( radialSegments + 1 ) * ( j - 1 ) + i;

            // faces

            triangles.push( [a, b, d] );
            triangles.push( [b, c, d] );

        }

    }

    const colors = []
    for (let i = 0; i < positions.length; ++i)
        colors.push([1.0, 1.0, 1.0])

    return {
        positions,
        normals,
        uvs,
        triangles,
        colors,
    };
}
