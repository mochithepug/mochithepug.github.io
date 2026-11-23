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

// --- Tod_e.exe matrix-stack operations (FUN_004c2600 / 2450 / 2360 / 2270) -------------------
// Each premultiplies the current matrix (a "local" transform): M' = R · M. Angles are Sega units
// (65536 = 360°; the exe multiplies by 2π/65536 held as a double @004dd510).

const ANGLE = (2 * Math.PI) / 65536;

/** M' = T(x, y, z) · M */
export function translateLocal(m: Mat4, x: number, y: number, z: number): Mat4 {
  const o = new Float32Array(m);
  for (let c = 0; c < 4; c++) o[12 + c] = x * m[c]! + y * m[4 + c]! + z * m[8 + c]! + m[12 + c]!;
  return o;
}

/** M' = S(x, y, z) · M (FUN_004c2540) */
export function scaleLocal(m: Mat4, x: number, y: number, z: number): Mat4 {
  const o = new Float32Array(m);
  for (let k = 0; k < 4; k++) {
    o[k] = m[k]! * x;
    o[4 + k] = m[4 + k]! * y;
    o[8 + k] = m[8 + k]! * z;
  }
  return o;
}

/** M' = Rx(a) · M, Rx = [[1,0,0],[0,c,s],[0,-s,c]] (D3DXMatrixRotationX) */
export function rotateXLocal(m: Mat4, a: number): Mat4 {
  const c = Math.cos(a * ANGLE), s = Math.sin(a * ANGLE), o = new Float32Array(m);
  for (let k = 0; k < 4; k++) {
    o[4 + k] = m[4 + k]! * c + s * m[8 + k]!;
    o[8 + k] = c * m[8 + k]! - m[4 + k]! * s;
  }
  return o;
}

/** M' = Ry(a) · M, Ry = [[c,0,-s],[0,1,0],[s,0,c]] (D3DXMatrixRotationY) */
export function rotateYLocal(m: Mat4, a: number): Mat4 {
  const c = Math.cos(a * ANGLE), s = Math.sin(a * ANGLE), o = new Float32Array(m);
  for (let k = 0; k < 4; k++) {
    o[k] = m[k]! * c - s * m[8 + k]!;
    o[8 + k] = m[k]! * s + c * m[8 + k]!;
  }
  return o;
}

/** M' = Rz(a) · M, Rz = [[c,s,0],[-s,c,0],[0,0,1]] (D3DXMatrixRotationZ) */
export function rotateZLocal(m: Mat4, a: number): Mat4 {
  const c = Math.cos(a * ANGLE), s = Math.sin(a * ANGLE), o = new Float32Array(m);
  for (let k = 0; k < 4; k++) {
    o[k] = m[k]! * c + s * m[4 + k]!;
    o[4 + k] = c * m[4 + k]! - m[k]! * s;
  }
  return o;
}

/** M' = R(axis, a) · M (FUN_004c2150; the axis is normalised first). */
export function rotateAxisLocal(m: Mat4, axis: readonly number[], a: number): Mat4 {
  const n = Math.hypot(axis[0]!, axis[1]!, axis[2]!);
  const x = axis[0]! / n, y = axis[1]! / n, z = axis[2]! / n;
  const c = Math.cos(a * ANGLE), s = Math.sin(a * ANGLE), t = 1 - c;
  const r = identity();
  r[0] = x * x * t + c; r[1] = y * x * t + z * s; r[2] = z * x * t - y * s;
  r[4] = y * x * t - z * s; r[5] = y * y * t + c; r[6] = z * y * t + x * s;
  r[8] = z * x * t + y * s; r[9] = z * y * t - x * s; r[10] = z * z * t + c;
  return mul(r, m);
}

/** Point · M (FUN_004c1320). */
export function transformPoint(m: Mat4, v: readonly number[]): [number, number, number] {
  return [
    v[0]! * m[0]! + v[1]! * m[4]! + v[2]! * m[8]! + m[12]!,
    v[0]! * m[1]! + v[1]! * m[5]! + v[2]! * m[9]! + m[13]!,
    v[0]! * m[2]! + v[1]! * m[6]! + v[2]! * m[10]! + m[14]!,
  ];
}

/** Direction · M, no translation (FUN_004c1390). */
export function transformDir(m: Mat4, v: readonly number[]): [number, number, number] {
  return [
    v[0]! * m[0]! + v[1]! * m[4]! + v[2]! * m[8]!,
    v[0]! * m[1]! + v[1]! * m[5]! + v[2]! * m[9]!,
    v[0]! * m[2]! + v[1]! * m[6]! + v[2]! * m[10]!,
  ];
}

/** General 4×4 inverse (FUN_004c15c0). */
export function invert(m: Mat4): Mat4 {
  const a = Array.from(m, Number), o = new Array<number>(16);
  o[0] = a[5]! * a[10]! * a[15]! - a[5]! * a[11]! * a[14]! - a[9]! * a[6]! * a[15]! + a[9]! * a[7]! * a[14]! + a[13]! * a[6]! * a[11]! - a[13]! * a[7]! * a[10]!;
  o[4] = -a[4]! * a[10]! * a[15]! + a[4]! * a[11]! * a[14]! + a[8]! * a[6]! * a[15]! - a[8]! * a[7]! * a[14]! - a[12]! * a[6]! * a[11]! + a[12]! * a[7]! * a[10]!;
  o[8] = a[4]! * a[9]! * a[15]! - a[4]! * a[11]! * a[13]! - a[8]! * a[5]! * a[15]! + a[8]! * a[7]! * a[13]! + a[12]! * a[5]! * a[11]! - a[12]! * a[7]! * a[9]!;
  o[12] = -a[4]! * a[9]! * a[14]! + a[4]! * a[10]! * a[13]! + a[8]! * a[5]! * a[14]! - a[8]! * a[6]! * a[13]! - a[12]! * a[5]! * a[10]! + a[12]! * a[6]! * a[9]!;
  o[1] = -a[1]! * a[10]! * a[15]! + a[1]! * a[11]! * a[14]! + a[9]! * a[2]! * a[15]! - a[9]! * a[3]! * a[14]! - a[13]! * a[2]! * a[11]! + a[13]! * a[3]! * a[10]!;
  o[5] = a[0]! * a[10]! * a[15]! - a[0]! * a[11]! * a[14]! - a[8]! * a[2]! * a[15]! + a[8]! * a[3]! * a[14]! + a[12]! * a[2]! * a[11]! - a[12]! * a[3]! * a[10]!;
  o[9] = -a[0]! * a[9]! * a[15]! + a[0]! * a[11]! * a[13]! + a[8]! * a[1]! * a[15]! - a[8]! * a[3]! * a[13]! - a[12]! * a[1]! * a[11]! + a[12]! * a[3]! * a[9]!;
  o[13] = a[0]! * a[9]! * a[14]! - a[0]! * a[10]! * a[13]! - a[8]! * a[1]! * a[14]! + a[8]! * a[2]! * a[13]! + a[12]! * a[1]! * a[10]! - a[12]! * a[2]! * a[9]!;
  o[2] = a[1]! * a[6]! * a[15]! - a[1]! * a[7]! * a[14]! - a[5]! * a[2]! * a[15]! + a[5]! * a[3]! * a[14]! + a[13]! * a[2]! * a[7]! - a[13]! * a[3]! * a[6]!;
  o[6] = -a[0]! * a[6]! * a[15]! + a[0]! * a[7]! * a[14]! + a[4]! * a[2]! * a[15]! - a[4]! * a[3]! * a[14]! - a[12]! * a[2]! * a[7]! + a[12]! * a[3]! * a[6]!;
  o[10] = a[0]! * a[5]! * a[15]! - a[0]! * a[7]! * a[13]! - a[4]! * a[1]! * a[15]! + a[4]! * a[3]! * a[13]! + a[12]! * a[1]! * a[7]! - a[12]! * a[3]! * a[5]!;
  o[14] = -a[0]! * a[5]! * a[14]! + a[0]! * a[6]! * a[13]! + a[4]! * a[1]! * a[14]! - a[4]! * a[2]! * a[13]! - a[12]! * a[1]! * a[6]! + a[12]! * a[2]! * a[5]!;
  o[3] = -a[1]! * a[6]! * a[11]! + a[1]! * a[7]! * a[10]! + a[5]! * a[2]! * a[11]! - a[5]! * a[3]! * a[10]! - a[9]! * a[2]! * a[7]! + a[9]! * a[3]! * a[6]!;
  o[7] = a[0]! * a[6]! * a[11]! - a[0]! * a[7]! * a[10]! - a[4]! * a[2]! * a[11]! + a[4]! * a[3]! * a[10]! + a[8]! * a[2]! * a[7]! - a[8]! * a[3]! * a[6]!;
  o[11] = -a[0]! * a[5]! * a[11]! + a[0]! * a[7]! * a[9]! + a[4]! * a[1]! * a[11]! - a[4]! * a[3]! * a[9]! - a[8]! * a[1]! * a[7]! + a[8]! * a[3]! * a[5]!;
  o[15] = a[0]! * a[5]! * a[10]! - a[0]! * a[6]! * a[9]! - a[4]! * a[1]! * a[10]! + a[4]! * a[2]! * a[9]! + a[8]! * a[1]! * a[6]! - a[8]! * a[2]! * a[5]!;
  const det = a[0]! * o[0]! + a[1]! * o[4]! + a[2]! * o[8]! + a[3]! * o[12]!;
  return new Float32Array(o.map((v) => v / det));
}

/** D3DXMatrixOrthoOffCenterLH (z → [0, 1]). */
export function orthoOffCenterLH(l: number, r: number, b: number, t: number, zn: number, zf: number): Mat4 {
  return new Float32Array([
    2 / (r - l), 0, 0, 0,
    0, 2 / (t - b), 0, 0,
    0, 0, 1 / (zf - zn), 0,
    (l + r) / (l - r), (t + b) / (b - t), zn / (zn - zf), 1,
  ]);
}
