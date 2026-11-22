/**
 * Direct3D-style 4×4 matrices (row-vector convention: v' = v · M), stored row-major as D3D keeps
 * them in memory. Uploaded to GLSL unchanged, a D3D matrix M reads as Mᵀ, so `M * v` in GLSL equals
 * v · M — i.e. `proj * view * world * pos` reproduces D3D's `pos · World · View · Proj`.
 */
export type Mat4 = Float32Array;

export const identity = (): Mat4 => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** a · b (apply a, then b). */
export function mul(a: Mat4, b: Mat4): Mat4 {
  const o = new Float32Array(16);
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 4; c++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[r * 4 + k]! * b[k * 4 + c]!;
      o[r * 4 + c] = s;
    }
  return o;
}

export function translation(x: number, y: number, z: number): Mat4 {
  const m = identity();
  m[12] = x; m[13] = y; m[14] = z;
  return m;
}

export function scaling(x: number, y: number, z: number): Mat4 {
  const m = identity();
  m[0] = x; m[5] = y; m[10] = z;
  return m;
}

/** D3DXMatrixLookAtLH */
export function lookAtLH(eye: number[], at: number[], up: number[]): Mat4 {
  const sub = (a: number[], b: number[]) => a.map((v, i) => v - b[i]!);
  const norm = (a: number[]) => { const l = Math.hypot(...a) || 1; return a.map((v) => v / l); };
  const cross = (a: number[], b: number[]) => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
  const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i]!, 0);
  const z = norm(sub(at, eye));
  const x = norm(cross(up, z));
  const y = cross(z, x);
  return new Float32Array([
    x[0]!, y[0]!, z[0]!, 0,
    x[1]!, y[1]!, z[1]!, 0,
    x[2]!, y[2]!, z[2]!, 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ]);
}

/** D3DXMatrixPerspectiveFovLH (z → [0, 1]). */
export function perspectiveFovLH(fovY: number, aspect: number, zn: number, zf: number): Mat4 {
  const ys = 1 / Math.tan(fovY / 2);
  const xs = ys / aspect;
  return new Float32Array([
    xs, 0, 0, 0,
    0, ys, 0, 0,
    0, 0, zf / (zf - zn), 1,
    0, 0, -zn * zf / (zf - zn), 0,
  ]);
}
