/**
 * Camera paths (`cam/*.bin`) and the game camera, ported from Tod_e.exe.
 * See re/notes/overview.md "Camera paths".
 *
 * File: u32 offset per path (count from the exe), data area at 4 + count·4. Path = 7 i32 channel
 * indices (×4 bytes into the data area): 0–2 eye xyz, 3–5 look-at xyz, 6 roll (int; used only when
 * a game flag is set). Curve: u16 capacity (power of 2), u16 search depth, then keys
 * {f32 t, value, outTangent, inTangent}; evaluated by `cam_curve_eval` @0040e7c0 (cubic Hermite).
 * Angles (`cam_set_lookat` → FUN_0040bd10): d = eye − target; yaw = int16(trunc(atan2(dx, dz)·K)),
 * h = dz / cos(yaw) or dx / sin(yaw) by quadrant, pitch = −int16(trunc(atan2(dy, h)·K)), K = 65536/2π.
 * View (FUN_0040c690): view = Rz(−roll)·Rx(−pitch)·Ry(−yaw)·T(−eye) built with the matrix-stack ops.
 * Projection (FUN_00488260 → FUN_004c28b0): fov 0x1D3B Sega units (≈41.1°), aspect 4/3, near 0.5,
 * far 8000, D3D left-handed.
 */
import {
  identity,
  rotateXLocal,
  rotateYLocal,
  rotateZLocal,
  translateLocal,
  type Mat4,
} from './d3dmath.ts';
import type { PeImage } from './pe.ts';

const CAM_NAMES = 0x004f3abc;
const CAM_ID_LISTS = 0x004ddc44;
const CAM_ID_COUNTS = 0x004ddca4;
const K = 10430.378350470453; // @004dd520, 65536 / 2π (double)
const RAD = 9.587379924285257e-5; // @004dd510, 2π / 65536 (double)

export interface CameraSlot {
  index: number;
  file: string;
  ids: number[];
}

export function readCameraSlots(pe: PeImage): CameraSlot[] {
  const out: CameraSlot[] = [];
  for (let s = 0; s < 32; s++) {
    let file: string;
    try {
      file = pe.cstr(pe.u32(CAM_NAMES + s * 4));
    } catch {
      continue;
    }
    if (!/^cp_\w+\.bin$/i.test(file)) continue;
    const count = pe.u16(CAM_ID_COUNTS + s * 2), list = pe.u32(CAM_ID_LISTS + s * 4);
    out.push({ index: s, file, ids: Array.from({ length: count }, (_, k) => pe.i16(list + k * 2)) });
  }
  return out;
}

export interface CameraSample {
  eye: [number, number, number];
  target: [number, number, number];
  roll: number;
}

export class CameraFile {
  readonly count: number;
  private readonly v: DataView;
  private readonly data: number;

  constructor(file: Uint8Array, count: number) {
    this.v = new DataView(file.buffer, file.byteOffset, file.byteLength);
    this.count = count;
    this.data = 4 + count * 4;
  }

  private channel(path: number, c: number): number {
    const ph = this.v.getUint32(path * 4, true);
    return this.data + this.v.getInt32(ph + c * 4, true) * 4;
  }

  /** Port of cam_curve_eval @0040e7c0. `curve` is a byte offset into the file. */
  evalCurve(curve: number, t: number): number {
    const v = this.v;
    const key = (i: number, f: number) => v.getFloat32(curve + 4 + i * 16 + f * 4, true);
    const cap = v.getUint16(curve, true);
    let step = cap >> 2;
    let i = cap >> 1;
    for (let it = v.getUint16(curve + 2, true) - 1; it > 0; it--) {
      // exe: if (t <= key[i].t) i -= step else i += step;  step /= 2 (signed, toward zero)
      i += t <= key(i, 0) ? -step : step;
      step = Math.trunc(step / 2);
    }
    if (key(i, 0) < t) i++;
    const t0 = key(i - 1, 0), v0 = key(i - 1, 1), m0 = key(i - 1, 2);
    const t1 = key(i, 0), v1 = key(i, 1), m1 = key(i, 3);
    const s = t - t0, s2 = s * s, s3 = s2 * s;
    const d = Math.fround(t1 - t0), dd = (t1 - t0) * d, ddf = Math.fround(dd);
    const a = Math.fround(s3 / ddf);
    const b = (s3 + s3) / (dd * d);
    const c = (s2 * 3) / ddf;
    return Math.fround((c - b) * v1 + (b - c + 1) * v0 + (a - s2 / d) * m1 + (a - (s2 + s2) / d + s) * m0);
  }

  /** Eye, target and roll of path `path` at time `t` (cam_sample_lookat @0040e8b0). */
  sample(path: number, t: number): CameraSample {
    const e = (c: number) => this.evalCurve(this.channel(path, c), t);
    return { eye: [e(0), e(1), e(2)], target: [e(3), e(4), e(5)], roll: Math.trunc(e(6)) };
  }

  /** Last key time over the path's position/target channels (its length in time units). */
  duration(path: number): number {
    let max = 0;
    for (let c = 0; c < 6; c++) {
      const cv = this.channel(path, c);
      const cap = this.v.getUint16(cv, true);
      for (let k = 0; k < cap; k++) {
        const t = this.v.getFloat32(cv + 4 + k * 16, true);
        if (Number.isFinite(t) && t < 1e6) max = Math.max(max, t);
      }
    }
    return max;
  }
}

const int16 = (x: number) => ((Math.trunc(x) << 16) >> 16);

/** FUN_0040bd10: direction (eye − target) → [pitch, yaw] in Sega units. */
export function lookAngles(dx: number, dy: number, dz: number): [number, number] {
  const yaw = int16(Math.atan2(dx, dz) * K);
  const h = ((yaw + 0x2000) & 0x4000) === 0 ? dz / Math.cos(yaw * RAD) : dx / Math.sin(yaw * RAD);
  const pitch = -int16(Math.atan2(dy, h) * K);
  return [pitch, yaw];
}

export interface GameCamera {
  eye: [number, number, number];
  pitch: number;
  yaw: number;
  roll: number;
}

export function cameraFromSample(s: CameraSample): GameCamera {
  const [pitch, yaw] = lookAngles(s.eye[0] - s.target[0], s.eye[1] - s.target[1], s.eye[2] - s.target[2]);
  return { eye: s.eye, pitch, yaw, roll: s.roll };
}

/** View matrix as FUN_0040c690 builds it: Rz(−roll)·Rx(−pitch)·Ry(−yaw)·T(−eye). */
export function cameraView(c: GameCamera): Mat4 {
  let m = identity();
  m = rotateZLocal(m, -c.roll);
  m = rotateXLocal(m, -c.pitch);
  m = rotateYLocal(m, -c.yaw);
  return translateLocal(m, -c.eye[0], -c.eye[1], -c.eye[2]);
}

/** Projection as FUN_004c28b0(0x1D3B, 4/3, near, 8000): half-angle = trunc(fov × 0.5). */
export function cameraProjection(fov = 0x1d3b, aspect = 4 / 3, near = 0.5, far = 8000): Mat4 {
  const half = Math.trunc(fov * 0.5) * RAD;
  const cot = Math.cos(half) / Math.sin(half);
  const q = far / (far - near);
  return new Float32Array([cot / aspect, 0, 0, 0, 0, cot, 0, 0, 0, 0, q, 1, 0, 0, -q * near, 0]);
}

/** The fixed D3D view matrix set once at start-up (@005eb8f8): a z flip, diag(1, 1, −1, 1). */
export const D3D_VIEW_FLIP: Mat4 = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1]);

/**
 * Full D3D view for a camera at `eye` looking at `target`, exactly as the game composes it:
 * game view (from int angles) followed by the fixed z-flip. Note the flip makes the overall view a
 * reflection (det −1) compared with a plain D3DXMatrixLookAtLH — using the latter shows a mirror image.
 */
export function gameLookAt(eye: [number, number, number], target: [number, number, number], roll = 0): Mat4 {
  const c = cameraFromSample({ eye, target, roll });
  const flip = D3D_VIEW_FLIP;
  const v = cameraView(c);
  const o = new Float32Array(16);
  for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) {
    let sum = 0;
    for (let j = 0; j < 4; j++) sum += v[r * 4 + j]! * flip[j * 4 + k]!;
    o[r * 4 + k] = sum;
  }
  return o;
}

/**
 * Route structure: for each path, the paths that start where it ends (eye within `tolerance`).
 * Several continuations = a branch point; none = the end of a run (event shots stand alone).
 * The game picks the actual sequence through its event script; this is only the geometric continuity.
 */
export function pathContinuations(cf: CameraFile, tolerance = 2): number[][] {
  const n = cf.count;
  const start = Array.from({ length: n }, (_, k) => cf.sample(k, 0).eye);
  const end = Array.from({ length: n }, (_, k) => cf.sample(k, cf.duration(k)).eye);
  const near = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!) < tolerance;
  return end.map((e, k) => [...Array(n).keys()].filter((j) => j !== k && near(e, start[j]!)));
}
