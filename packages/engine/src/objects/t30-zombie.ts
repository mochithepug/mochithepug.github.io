/**
 * Zombie: object type 0x30 (set-up `FUN_00441d80`, task `FUN_00442460`). The spawn record's tail
 * (obj +0x1394 → record +0x24) gives skeleton, kind, behaviour and each behaviour's parameters.
 * Per frame: behaviour @005a215c[obj +0x1314], position += velocity, pose + draw (FUN_004438b0), then the
 * motion counter advances unless frozen (obj +0x34 & 0x4000).
 * Behaviours ported: 18 `FUN_00446700` (play a motion, wait for a camera time, then the next behaviour) and
 * 26 `FUN_00447380` (wait, leap along an arc to a target, land). Others (e.g. 1, the attack) hold still.
 * Not ported: being hit, attacks, word box, head turning to the player (FUN_00442c60), special part models
 * (FUN_00442510), sounds.
 */
import type { SpawnRecord } from '@ttotd/formats';
import type { DrawItem, GameObject, World } from '../core/object.ts';
import { CharacterRig, type Placement } from '../core/rig.ts';

type Vec3 = [number, number, number];

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
    for (let k = 0; k < 3; k++) this.place.pos[k] = f32(this.place.pos[k]! + this.vel[k]!);
    this.rig.pose(this.place);
    this.items = this.rig.draw();
    if (!(this.flags & 0x4000)) this.rig.counter++;
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
