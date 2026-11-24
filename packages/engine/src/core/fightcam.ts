/**
 * The fight camera's aim (re/notes/overview.md "Fight camera aim").
 *
 * Every frame each enemy or civilian taking part in the fight registers (FUN_00436f00 → FUN_004205d0) with its aim
 * point (object +0x100, y + 4) and its distance from the player. The task FUN_004204f0 sorts them nearest first
 * (radix sort FUN_00420640) into the slot table DAT_00a147e0: an entry holding a player's attack slot (+0x121 ≠ −1)
 * takes the first free of slots 0–1; any other entry k takes slot 2 + k. FUN_0040d7a0 aims at slots 0/1 (one, or the
 * midpoint of both), else at slots 2/3, else nowhere (the path's own target).
 *
 * In the fight (state 3, FUN_0040cfe0) the eye stays on the fight's eye and the look target turns towards the aim by
 * 1 / (1 + speed) of the angle each frame (FUN_0040e2f0, 100 units out); the next speed comes from the angle left
 * (FUN_0040e1f0, table @005983d4[DAT_00a39478 = 1]: 64 when close, down to 16 when far), or 12 (@00598354) when there
 * is nothing to aim at. When the fight is over (state 2, FUN_0040ce90) the eye glides back to the path (1/16 a frame,
 * FUN_0040d5b0) and the target turns back to the path's target at speed 12 (FUN_0040d6d0); once the look direction
 * matches (cos² > 0.99999) the fight camera is finished (DAT_00a3946d) and the path is used directly again.
 */
import type { CameraSample, PeImage } from '@ttotd/formats';

type Vec3 = [number, number, number];

/** One registration (FUN_004205d0). */
export interface AimEntry {
  /** Object position (+0x40), for the nearest-first order. */
  pos: Vec3;
  /** Aim point (+0x100 … +0x108). */
  aim: Vec3;
  /** The player whose attack slot it holds (+0x121), −1 for none. */
  slot: number;
}

const SEGA = 65536 / (2 * Math.PI);
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec3) => Math.sqrt(dot(a, a));
const mid = (a: Vec3, b: Vec3): Vec3 => [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5, (a[2] + b[2]) * 0.5];

/** FUN_0040c450: signed cos² of the angle between a and b. */
export function cos2(a: Vec3, b: Vec3): number {
  const d = dot(a, b);
  const c = (d * d) / (dot(a, a) * dot(b, b));
  return d < 0 ? -c : c;
}

/** FUN_0040c3d0: the angle between a and b in Sega units (short). */
function angleBetween(a: Vec3, b: Vec3): number {
  const d = dot(a, b);
  const cr = Math.sqrt(Math.max(0, dot(a, a) * dot(b, b) - d * d));
  return (Math.trunc(Math.atan2(cr, d) * SEGA) << 16) >> 16;
}

/** FUN_004204f0 + FUN_0040d7a0: the aim point for this frame's registrations, or undefined (nothing to aim at). */
export function pickAim(entries: readonly AimEntry[], player: Vec3): Vec3 | undefined {
  const sorted = entries
    .slice(0, 14)
    .map((e, i) => ({ e, i, k: len(sub(e.pos, player)) }))
    .sort((a, b) => a.k - b.k || a.i - b.i)
    .map((x) => x.e);
  const s: (AimEntry | undefined)[] = [];
  sorted.forEach((e, k) => {
    if (e.slot === -1) s[2 + k] = e;
    else if (!s[0]) s[0] = e;
    else if (!s[1]) s[1] = e;
  });
  const [s0, s1, s2, s3] = s;
  if (!s0) {
    if (s1) return s1.aim;
    if (s2) return s3 ? mid(s3.aim, s2.aim) : s2.aim;
    return s3?.aim;
  }
  if (!s1) return s0.aim;
  if (s0.slot !== -1) return s1.slot === -1 ? s0.aim : mid(s1.aim, s0.aim);
  return s1.slot === -1 ? mid(s1.aim, s0.aim) : s1.aim;
}

/** FUN_0040e2f0: turn the look target `cur` towards `aim` by 1 / (1 + speed) of the angle; 100 units from the eye. */
export function turnLookTowards(eye: Vec3, aim: Vec3, cur: Vec3, speed: number): Vec3 {
  const f = sub(cur, eye), a = sub(aim, eye);
  const fl = len(f);
  if (fl === 0) return cur;
  const u: Vec3 = [f[0] / fl, f[1] / fl, f[2] / fl];
  const au = dot(a, u);
  const w: Vec3 = [a[0] - au * u[0], a[1] - au * u[1], a[2] - au * u[2]];
  const wl = len(w);
  if (wl < 1e-9) return [eye[0] + u[0] * 100, eye[1] + u[1] * 100, eye[2] + u[2] * 100];
  const v: Vec3 = [w[0] / wl, w[1] / wl, w[2] / wl];
  const theta = (Math.trunc(Math.atan2(wl, au) * SEGA) << 16) >> 16;
  const phi = Math.trunc(theta / (1 + speed)) / SEGA;
  const c = Math.cos(phi) * 100, sn = Math.sin(phi) * 100;
  return [eye[0] + u[0] * c + v[0] * sn, eye[1] + u[1] * c + v[1] * sn, eye[2] + u[2] * c + v[2] * sn];
}

/** The camera's fight states (DAT_00a39460): following the path, aiming in a fight (3), returning after it (2). */
export type FightCamMode = 'path' | 'fight' | 'return';

export class FightCamera {
  private eye?: Vec3;
  private target?: Vec3;
  private speed: number;
  private readonly idle: number;
  private readonly table: number[];

  constructor(pe?: PeImage) {
    this.idle = pe ? (pe.u8(0x00598354) << 24) >> 24 : 12;
    this.table = Array.from({ length: 64 }, (_, i) => (pe ? (pe.u8(0x00598314 + i) << 24) >> 24 : i < 26 ? 64 : 16));
    this.speed = this.idle;
  }

  /**
   * One frame. `s` = the path camera now (fight eye / default target); `aims` = last frame's registrations.
   * Returns the camera to show, and (in 'return') whether it is back on the path.
   */
  step(s: CameraSample, mode: FightCamMode, aims: readonly AimEntry[]): { cam: CameraSample; back: boolean } {
    if (mode === 'path' || !this.eye || !this.target) {
      this.eye = [...s.eye];
      this.target = [...s.target];
      this.speed = this.idle;
      return { cam: s, back: mode !== 'fight' };
    }
    if (mode === 'fight') {
      const eye: Vec3 = [...s.eye];
      const aim = pickAim(aims, eye);
      this.target = turnLookTowards(eye, aim ?? s.target, this.target, this.speed);
      this.eye = eye;
      this.speed = aim ? this.table[Math.min(0x1fff, angleBetween(sub(this.target, eye), sub(aim, eye)) & 0xffff) >> 7]! : this.idle;
      return { cam: { eye, target: this.target, roll: s.roll }, back: false };
    }
    // return: eye 1/16 of the way back a frame, target turns to the path's at the idle speed
    const e = this.eye;
    const eye: Vec3 = [(s.eye[0] + 15 * e[0]) / 16, (s.eye[1] + 15 * e[1]) / 16, (s.eye[2] + 15 * e[2]) / 16];
    this.target = turnLookTowards(eye, s.target, this.target, this.idle);
    this.eye = eye;
    this.speed = this.idle;
    const back = Math.abs(cos2(sub(s.target, eye), sub(this.target, eye))) > 0.99999;
    return { cam: { eye, target: this.target, roll: 0 }, back };
  }
}
