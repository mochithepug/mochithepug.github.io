/**
 * Zombie: object type 0x30 (set-up `FUN_00441d80`, task `FUN_00442460`). The spawn record's tail
 * (obj +0x1394 → record +0x24) gives skeleton, kind, behaviour and each behaviour's parameters.
 * Per frame: behaviour @005a215c[obj +0x1314], position += velocity, pose + draw (FUN_004438b0), then the
 * motion counter advances unless frozen (obj +0x34 & 0x4000).
 * Behaviours ported: 18 `FUN_00446700` (play a motion, wait for a camera time, then the next behaviour),
 * 26 `FUN_00447380` (wait, leap along an arc to a target, land), 1 `FUN_00444520` (walk to the player, turning
 * towards them; within the near band → 2) and 2 `FUN_00444770` (stand facing the player). Others hold still.
 * Not ported: the attack decision in 2 (FUN_00444e90 → 3 attack, FUN_00444ac0) and backing off (4,
 * FUN_00444ce0), being hit, word box, head turning to the player (FUN_00442c60), special part models
 * (FUN_00442510), groans and other sounds.
 */
import { transformDir, type SpawnRecord } from '@ttotd/formats';
import { rotationMatrix, toAngle } from '../core/angles.ts';
import type { DrawItem, GameObject, World } from '../core/object.ts';
import { CharacterRig, type Placement } from '../core/rig.ts';

type Vec3 = [number, number, number];

/** FUN_004371d0: turn angle `cur` towards `target` by at most `step` (Sega units), the short way round. */
export function turnTowards(cur: number, target: number, step: number): number {
  const a = cur & 0xffff, b = target & 0xffff;
  const d = a - b;
  const abs = d < 0 ? b - a : d;
  let up = b - a + 0x10000;
  if (up < 0) up = d - 0x10000;
  let down = d + 0x10000;
  if (down < 0) down = b - a - 0x10000;
  if (abs <= step || up <= step || down <= step) return b;
  if (a < b) return down < abs ? a - step : a + step;
  return abs <= up ? a - step : a + step;
}

/** FUN_0040bd10's heading: Sega angle of direction (dx, dz) on the ground. */
export const heading = (dx: number, dz: number) => toAngle(Math.atan2(dx, dz));

const view = (b: Uint8Array | undefined) => (b ? new DataView(b.buffer, b.byteOffset, b.byteLength) : undefined);
const f32 = Math.fround;

export class Zombie implements GameObject {
  readonly rig: CharacterRig;
  readonly place: Placement;
  readonly skeleton: number;
  kind: number;
  behaviour: number; // +0x1314
  state = 0; // +0x1316
  hp: number;
  /** obj +0x34 (record param | 1). */
  flags: number;
  vel: Vec3 = [0, 0, 0]; // +0x4c
  private acc: Vec3 = [0, 0, 0]; // +0x58
  private wait = 0; // +0x1338
  private target: Vec3 = [0, 0, 0]; // +0x1378
  private gravity = 0; // +0x1384
  private airFrames = 0; // +0x1334
  private hold = 0; // +0x1354
  private readonly tail?: Uint8Array;
  private items: DrawItem[] = [];

  constructor(rec: SpawnRecord, w: World) {
    this.tail = rec.tail;
    const t = rec.tail ?? new Uint8Array(4);
    this.skeleton = (t[0]! << 24) >> 24;
    this.kind = (t[1]! << 24) >> 24;
    this.behaviour = (t[2]! << 24) >> 24;
    this.hp = rec.hp;
    this.flags = (rec.param | 1) >>> 0;
    this.place = { pos: [...(rec.pos ?? [0, 0, 0])], angles: [...(rec.angles ?? [0, 0, 0])] };
    this.rig = new CharacterRig(w.skeletons[this.skeleton]!, this.skeleton, 0x3f5, w.motions, w.skins[this.skeleton]);
    this.rig.order = 1; // obj +0x200 = 1: rotX, rotZ, rotY
  }

  private i32(o: number) {
    const v = view(this.tail);
    return v && o + 4 <= v.byteLength ? v.getInt32(o, true) : 0;
  }
  private f(o: number) {
    const v = view(this.tail);
    return v && o + 4 <= v.byteLength ? v.getFloat32(o, true) : 0;
  }

  update(w: World) {
    if (this.behaviour === 18) this.waitFor(w);
    else if (this.behaviour === 26) this.leap(w);
    else if (this.behaviour === 1) this.approach(w);
    else if (this.behaviour === 2) this.stand(w);
    for (let k = 0; k < 3; k++) this.place.pos[k] = f32(this.place.pos[k]! + this.vel[k]!);
    this.rig.pose(this.place);
    this.items = this.rig.draw();
    if (!(this.flags & 0x4000)) this.rig.counter++;
  }

  /** Approach band row (obj +0x1323, set in FUN_00441d80). */
  private get bandRow() {
    return this.skeleton === 0 ? 2 : 0;
  }

  /** Ground distance to the player. */
  private playerDistance(w: World) {
    const dz = this.place.pos[2] - w.eye[2], dx = this.place.pos[0] - w.eye[0];
    return f32(Math.sqrt(dz * dz + dx * dx));
  }

  /** FUN_00445750: 1 within near, 2 near–mid, 3 mid–far, 4 beyond far. */
  private band(w: World): number {
    const d = this.playerDistance(w), [near, mid, far] = w.bands[this.bandRow] ?? [25, 38, 51];
    if (d <= near!) return 1;
    if (d <= mid!) return 2;
    if (d <= far!) return 3;
    return 4;
  }

  /** FUN_00443860: switch to a motion (blended) if not already playing it. */
  private setMotion(id: number, start: number, blend: number) {
    if (this.rig.motion !== id) this.rig.blendTo(id, start, blend);
  }

  /** Behaviour 1 (FUN_00444520): walk towards the player, turning; within the near band → behaviour 2. */
  private approach(w: World) {
    const set = w.motionSet(this.skeleton, this.kind);
    const fast = (this.flags >>> 27) & 1;
    const start = w.rand();
    if (set) this.setMotion(set[2 + fast]!, start % w.motions.frames(set[2 + fast]!), 10);
    w.rand(); // groan chance (FUN_0044d1b0) — sound not ported
    if (this.band(w) === 1) {
      this.behaviour = 2;
      this.state = 0;
      return;
    }
    // FUN_004372a0: aim at a point 1.5 ahead of the player (turned by the player's y coordinate, as the exe does)
    const e = w.eye;
    const off = transformDir(rotationMatrix([0, Math.trunc(e[1]), 0]), [0, 0, 1.5]);
    const target = heading(this.place.pos[0] - (e[0] + off[0]!), this.place.pos[2] - (e[2] + off[2]!));
    this.place.angles[1] = turnTowards(this.place.angles[1], target, Math.trunc((fast * 1.5 + 1) * 416));
    // bands 2–4 with obj +0x135c <= +0x1321 (−1) would switch to behaviour 5; kind 8 may switch to 0x21 — neither
    // happens for these zombies.
  }

  /** Behaviour 2 (FUN_00444770) without the attack decision: idle motion, face the player. */
  private stand(w: World) {
    const set = w.motionSet(this.skeleton, this.kind);
    // The exe backs off (behaviour 4) when closer than near − 1; not ported — stands instead.
    if (set && this.rig.motion !== set[0]) this.rig.blendTo(set[0]!, w.rand() % 5, 10); // + voice 0x1917a9
    const target = heading(this.place.pos[0] - w.eye[0], this.place.pos[2] - w.eye[2]);
    this.place.angles[1] = turnTowards(this.place.angles[1], target, 0x40); // FUN_00437250
  }

  /** Behaviour 18 (FUN_00446700). */
  private waitFor(w: World) {
    if (this.state === 0) {
      const motion = this.i32(4);
      if (!(this.flags & 0x40000000) && this.rig.motion !== motion) this.rig.play(motion);
      if (w.camTime !== this.i32(8)) return;
      this.state = 1;
    } else if (this.state !== 1) return;
    this.behaviour = ((this.tail?.[3] ?? 0) << 24) >> 24;
    this.state = 0;
  }

  /** FUN_00437460: launch towards `target` under gravity g; returns the frames in the air. */
  private launch(target: Vec3, g: number): number {
    const p = this.place.pos;
    let n = 0, fall = 0, y = p[1];
    if (target[1] < y) {
      do {
        fall = f32(fall - g);
        n++;
        y = f32(fall + y);
      } while (target[1] < y);
    }
    this.acc = [0, -g, 0];
    this.vel = [f32((target[0] - p[0]) / n), f32((n * n * g + (target[1] - p[1]) + (target[1] - p[1])) / (n + n)), f32((target[2] - p[2]) / n)];
    return n;
  }

  private fall() {
    for (let k = 0; k < 3; k++) this.vel[k] = f32(this.vel[k]! + this.acc[k]!);
  }

  /** Behaviour 26 (FUN_00447380): wait, leap down to a target, land, then the main behaviour (1). */
  private leap(w: World) {
    const r = this.rig;
    switch (this.state) {
      case 0:
        this.flags |= 0x2000;
        this.wait = this.i32(4);
        this.target = [this.f(8), this.f(12), this.f(16)];
        this.gravity = this.f(20);
        this.state = 1;
      // falls through
      case 1: {
        if (--this.wait >= 0) return;
        this.airFrames = this.launch(this.target, this.gravity);
        const jump = (this.flags & 0x1000000) !== 0;
        r.blendTo(jump ? 0x3c4 : 999, 0, jump ? 5 : 1);
        this.state = 2;
        this.flags &= ~0x1000000;
      }
      // falls through
      case 2:
        if (r.motion === 0x3c4) {
          if (r.frame === 0x23) {
            r.blendTo(999, 0, 0xc);
            this.state = 3;
            return;
          }
          if (r.frame > 0x1a) this.fall();
          return;
        }
        this.state = 3;
      // falls through
      case 3:
        this.fall();
        if (r.frame < 1 || this.airFrames < 0x15) this.flags &= ~0x4000;
        else this.flags |= 0x4000;
        if (--this.airFrames >= 0) return;
        // landed (FUN_0043cf20 stops the movement)
        this.vel = [0, 0, 0];
        this.acc = [0, 0, 0];
        this.flags &= ~0x4000;
        this.hold = w.motions.frames(r.motion) - 1; // exe: − rand() % 30 (rand not ported)
        this.state = 4;
      // falls through
      case 4:
        if (r.frame >= this.hold) {
          this.flags &= ~0x2000;
          this.behaviour = 1;
          this.state = 0;
        }
    }
  }

  draw(): DrawItem[] {
    return this.items;
  }
}
