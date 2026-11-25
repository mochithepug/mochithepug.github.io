/**
 * A thrown item (task `FUN_00449d20`, created by `FUN_00449980` when a thrower zombie — behaviour 33 — lets go):
 * one model (+0x13f4), its own word box (flags 0x38000A12: a single letter, always shown), flying from the hand to
 * a point just in front of the camera (`FUN_004497a0`). States by type (@005a27e0): 1 = spinning item (models
 * 0x271–0x278: axes, spin 0xB00) `FUN_00448cc0`, 2 = other items (spin 0x1600, `FUN_00448fa0` — not ported, not in
 * Stage 1), 3 = typed `FUN_004493f0`.
 * - Flight: frames = distance / speed (@005ea6e8[rank] × 1.5 for kind-7 throwers); on arrival it hits the player
 *   (FUN_004846d0(p, 1, 4)), sticks in front of the camera for 30 frames, blinks for 60, frees the attack slot and
 *   ends.
 * - Typed (word complete): the attack slot is freed and it flies off to a random point near where it was, 1.5 a frame,
 *   until it gets there or 180 frames pass. (The debris effect FUN_00412010 and the sounds are not ported.)
 * While flying it registers for the fight (FUN_004205d0) with aim point y + 1.5, so the camera follows it.
 */
import { identity, invert, rotateXLocal, rotateYLocal, rotateZLocal, transformPoint, translateLocal, type PeImage } from '@ttotd/formats';
import { toAngle } from '../core/angles.ts';
import type { DrawItem, GameObject, World } from '../core/object.ts';
import type { WordOwner } from './wordbox.ts';

type Vec3 = [number, number, number];
const f32 = Math.fround;
const isAxe = (model: number) => model >= 0x271 && model <= 0x278;

/** Flight speed by rank (@005ea6e8). */
function itemSpeed(pe: PeImage | undefined, rank: number): number {
  return pe ? pe.f32(0x005ea6e8 + rank * 4) : 0.15;
}

export class ThrownItem implements GameObject, WordOwner {
  readonly model: number;
  /** The player it flies at (+0x121) — also the attack slot it holds. */
  readonly player: number;
  pos: Vec3;
  /** Sega angles x (spin), y, z (+0x64 / +0x68 / +0x6c). */
  angles: Vec3 = [0, 0, 0x800];
  flags = 0x80000001;
  wordFlags = 0x38000a12;
  hp = 1;
  anchor?: Vec3;
  worldAnchor?: Vec3;
  dead?: boolean;
  /** 1 flying (axe), 3 typed. */
  behaviour: number;
  state = 0;
  private readonly spin: number;
  private readonly speed: number;
  private vel: Vec3 = [0, 0, 0];
  private frames = 0;
  private target: Vec3 = [0, 0, 0];
  private timer = 0;
  private count = 0;
  private visible = true;

  constructor(w: World, opts: { pos: Vec3; model: number; player: number; strong: boolean }) {
    this.pos = [...opts.pos];
    this.model = opts.model;
    this.player = Math.max(0, opts.player);
    this.behaviour = isAxe(this.model) ? 1 : 2;
    this.spin = isAxe(this.model) ? 0xb00 : 0x1600;
    const rank = w.words?.effectiveRank ?? 0;
    this.speed = f32(itemSpeed(w.pe, rank) * (opts.strong ? 1.5 : 1));
    this.target = this.frontOfCamera(w);
    this.angles[1] = toAngle(Math.atan2(this.target[0] - this.pos[0], this.target[2] - this.pos[2]));
  }

  /** FUN_004497a0: the point it flies to, 4 ahead of the camera (axes 1.5 lower). */
  private frontOfCamera(w: World): Vec3 {
    const p = transformPoint(invert(w.view), [0, isAxe(this.model) ? -1.5 : 0, -4]);
    return [p[0]!, p[1]!, p[2]!];
  }

  /** FUN_00445620: give the player's attack slot back. */
  private freeSlot(w: World) {
    w.attackSlots[this.player] = 0;
  }

  /** The word is complete: break off (behaviour 3). */
  wordDone() {
    if (this.behaviour === 3 || this.flags & 0x4000000) return;
    this.behaviour = 3;
    this.state = 0;
    this.wordFlags = ((this.wordFlags & ~0x200) | 0x400) >>> 0;
  }

  update(w: World) {
    if (this.behaviour === 1 || this.behaviour === 2) this.fly(w);
    else if (this.behaviour === 3) this.breakOff(w);
    if (this.dead) return;
    const v = transformPoint(w.view, this.pos);
    this.anchor = [v[0]!, v[1]!, v[2]!];
    this.worldAnchor = [...this.pos];
    if ((this.behaviour === 1 || this.behaviour === 2) && !(this.flags & 0x4000000)) {
      w.active++;
      w.aims?.push({ pos: [...this.pos], aim: [this.pos[0], this.pos[1] + (isAxe(this.model) ? 1.5 : 0), this.pos[2]], slot: this.player });
    }
  }

  /** FUN_00448cc0 (also used for other item types here). */
  private fly(w: World) {
    if (this.state === 0) {
      const d: Vec3 = [this.target[0] - this.pos[0], this.target[1] - this.pos[1], this.target[2] - this.pos[2]];
      this.frames = f32(Math.hypot(d[0], d[1], d[2]) / this.speed);
      this.vel = [f32(d[0] / this.frames), f32(d[1] / this.frames), f32(d[2] / this.frames)];
      this.state = 1;
    }
    if (this.state === 1) {
      this.angles[0] = (this.angles[0] + this.spin) & 0xffff;
      for (let k = 0; k < 3; k++) this.pos[k] = f32(this.pos[k]! + this.vel[k]!);
      this.frames = f32(this.frames - 1);
      if (this.frames > 0) return;
      w.hitPlayer(this.player, 1, 4); // FUN_004846d0(p, 1, 4)
      this.state = 2;
    }
    if (this.state === 2) {
      // stuck in front of the camera: no box, turned round, a random tilt
      this.flags = (this.flags | 0x4008000) >>> 0;
      this.wordFlags = ((this.wordFlags & ~0x200) | 0x400) >>> 0;
      this.angles[0] = 0;
      this.angles[1] = (toAngle(Math.atan2(this.target[0] - this.pos[0], this.target[2] - this.pos[2])) + 0x8000) & 0xffff;
      const sign = 1 - 2 * (w.rand() & 1);
      this.angles[0] = (this.angles[0] + sign * (w.rand() & 2) * 0x100) & 0xffff;
      this.timer = 30;
      this.state = 3;
    }
    if (this.state === 3) {
      this.pos = this.target = this.frontOfCamera(w);
      if (--this.timer >= 1) return;
      this.state = 4;
      this.timer = 60;
    }
    if (this.state === 4) {
      this.pos = this.target = this.frontOfCamera(w);
      this.visible = this.timer % 2 === 0;
      if (--this.timer >= 1) return;
      this.freeSlot(w);
      this.dead = true;
    }
  }

  /** FUN_004493f0: typed — free the slot and fly off to a random point near where it was. */
  private breakOff(w: World) {
    if (this.state === 0) {
      this.flags = (this.flags | 0x4008000) >>> 0;
      this.freeSlot(w);
      this.state = 1;
    }
    if (this.state === 1) {
      const v = transformPoint(w.view, this.pos);
      const off = () => {
        const sign = 1 - 2 * (w.rand() & 1);
        return ((w.rand() % 10) + 1) * 10 * sign;
      };
      const p = transformPoint(invert(w.view), [v[0]! + off(), v[1]! + off(), v[2]!]);
      this.target = [p[0]!, p[1]!, p[2]!];
      this.timer = 5;
      this.state = 2;
      return;
    }
    if (this.state === 2) {
      if (--this.timer > 0) return;
      this.state = 3;
      this.count = 0;
    }
    const d: Vec3 = [this.target[0] - this.pos[0], this.target[1] - this.pos[1], this.target[2] - this.pos[2]];
    const len = Math.hypot(d[0], d[1], d[2]) || 1;
    this.angles[0] = (this.angles[0] + this.spin) & 0xffff;
    for (let k = 0; k < 3; k++) this.pos[k] = f32(this.pos[k]! + (d[k]! / len) * 1.5);
    this.count++;
    if (this.count >= 0xb4 || d.every((x) => Math.abs(x) <= 1.5)) this.dead = true;
  }

  draw(): DrawItem[] {
    if (!this.visible || this.dead) return [];
    let m = translateLocal(identity(), this.pos[0], this.pos[1], this.pos[2]);
    m = rotateXLocal(rotateYLocal(rotateZLocal(m, this.angles[2]), this.angles[1]), this.angles[0]);
    return [{ model: this.model, world: m }];
  }
}
