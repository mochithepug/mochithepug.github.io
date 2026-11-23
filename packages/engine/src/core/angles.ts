/**
 * The exe's angle maths on matrices (Sega angle units, 65536 = 360°).
 *   anglesFromMatrix  FUN_0040c040 (+ FUN_0040bdf0): rotation → (rx, ry, rz) for rotZ·rotY·rotX order
 *   blendRotation     FUN_00476550: rotation from A towards B by t, as swing (tilt of the Y axis) + twist
 *                     (around Y), each angle scaled by t and truncated
 */
import { identity, invert, mul, rotateAxisLocal, rotateXLocal, rotateYLocal, rotateZLocal, transformDir, transformPoint, type Mat4 } from '@ttotd/formats';

const K = 65536 / (2 * Math.PI);
const RAD = (2 * Math.PI) / 65536;

/** __ftol then a 16-bit store: truncate toward zero, wrap to int16. */
export const toAngle = (radians: number) => (Math.trunc(radians * K) << 16) >> 16;

/** Rotation-only matrix rotZ(z), rotY(y), rotX(x) premultiplied on identity — how joints apply angles. */
export function rotationMatrix(a: readonly number[]): Mat4 {
  return rotateXLocal(rotateYLocal(rotateZLocal(identity(), a[2]!), a[1]!), a[0]!);
}

/** FUN_0040bdf0: angles of direction (x, y, z) → [p5, p6]. */
function dirAngles(x: number, y: number, z: number): [number, number] {
  const p6 = toAngle(Math.atan2(y, x));
  const h = ((p6 + 0x2000) & 0x4000) === 0 ? x / Math.cos(p6 * RAD) : y / Math.sin(p6 * RAD);
  return [-toAngle(Math.atan2(z, h)), p6];
}

/** FUN_0040c040: angles (rx, ry, rz) of a matrix's rotation. */
export function anglesFromMatrix(m: Mat4): [number, number, number] {
  const [ex, ey, ez] = transformDir(m, [1, 0, 0]);
  const [ry, rz] = dirAngles(ex, ey, ez);
  const v = transformDir(m, [0, 1, 0]);
  const n = rotateZLocal(rotateYLocal(identity(), -ry), -rz);
  const w = transformDir(n, v);
  return [toAngle(Math.atan2(w[2], w[1])), ry, rz];
}

/** FUN_00476550 + FUN_0040c040: angles between pose A and pose B at fraction t. */
export function blendAngles(a: readonly number[], b: readonly number[], t: number): [number, number, number] {
  const A = rotationMatrix(a), B = rotationMatrix(b);
  const R = mul(B, invert(A));
  const v = transformPoint(R, [0, 1, 0]);
  const theta = toAngle(Math.atan2(Math.hypot(v[0], v[2]), v[1]));
  if (theta === 0) {
    const u = transformPoint(R, [1, 0, 0]);
    const phi = toAngle(Math.atan2(-u[2], u[0]));
    return anglesFromMatrix(rotateYLocal(A, Math.trunc(phi * t)));
  }
  const axis = theta === -0x8000 || theta === 0x8000 ? [1, 0, 0] : [v[2], 0, -v[0]];
  const T = mul(R, rotateAxisLocal(identity(), axis, -theta));
  const u = transformPoint(T, [1, 0, 0]);
  const M = rotateAxisLocal(A, axis, Math.trunc(theta * t));
  const phi = toAngle(Math.atan2(-u[2], u[0]));
  return anglesFromMatrix(rotateYLocal(M, Math.trunc(phi * t)));
}

/** Half-frame / non-matrix angle lerp (FUN_00475660 __ftol branch): shortest way round, truncated. */
export function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) & 0xffff;
  if (d > 32768) d -= 65536;
  return Math.trunc(d * t + a);
}
