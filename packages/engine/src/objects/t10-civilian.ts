/**
 * Civilian in danger: object type 0x10, spawned by event op 0x0C (set-up `FUN_0047fa70`, task `FUN_0047ffc0`).
 * Record extra data: skeleton (byte +0), kind (byte +1 → start script @00517ccc), count +0xC and record pointers
 * +0x10 of the **attackers** it creates with spawn_record (linked back, obj +0x1398; hp × @00512a24[rank] / 100).
 * The civilian is driven by a script (FUN_00481060, see formats/civilian.ts): each run starts at a segment (0x2C,
 * flags = this segment's wait conditions) and stops before the next; `FUN_00480860` moves on when any flagged
 * condition holds (0x100 loops done, 0x200 frame reached, 0x400 timer, 0x4 attackers down to a count, 0x1 / 0x2 /
 * 0x8 enemy / attacker / civilian counts, 0x2000 an event flag) or the segment timer runs out. Each frame:
 * attackers whose dead flag (0x4000000) is set leave the list (FUN_004820c0); the motion counter advances by the
 * loop rules; the segment check runs.
 * Movement: a target (op 5 point / player, op 6 point list, op 7 direction, op 0x26 glide over N frames); each frame
 * she turns towards it by at most 0x100 (FUN_00481eb0 → FUN_00481ff0) and her motion's root motion walks her;
 * flags 0x10 (within a distance), 0x20 (facing it), 0x40 (walked past it). She leaves (FUN_00437090) a countdown
 * (record i16 +6) after the camera reaches record path +2 / time +4, once no attacker is left.
 * Not yet: being hit / killed (0x13 / 0x14 scripts — steps 2–3), the off-screen exit (flag 0x2000000),
 * the rescue reward (segment flag 0x10000000: +400, rescue count), sounds, voice lines (0x1D), callbacks (0x10),
 * the motion start's root alignment (FUN_00481970).
 */
import { civilianAttackerHpPercent, civilianStartScript, identity, readCivilianCommand, rotateXLocal, rotateYLocal, rotateZLocal, transformDir, type SpawnRecord } from '@ttotd/formats';
import { toAngle } from '../core/angles.ts';
import type { DrawItem, GameObject, World } from '../core/object.ts';
import { CharacterRig, type Placement } from '../core/rig.ts';

export class Civilian implements GameObject {
  readonly rig: CharacterRig;
  readonly place: Placement;
  readonly skeleton: number;
  readonly kind: number;
  /** Object flags (+0x34). */
  flags = 0;
  /** Script state (DAT_00818d98 block). */
  segFlags = 0; // [0]
  private loops = 0; // [3] low
  private frameLimit = 0; // [2]
  private frameTarget = 0; // +0x16
  private timer = -1; // [5] (op 9)
  private countLimit = 0; // +0x22 (op 0xA)
  /** Attackers-left threshold for condition 0x4 ([8], op 0xB) and attackers left (+0x1e). */
  private attackersAt = 0;
  attackersLeft = 0;
  private civiliansAt = 0; // [9] (op 0xC)
  private flagIndex = 0; // +0x1a (op 0x20)
  /** Camera cue for segment flag 0x80 (op 0xD: path [4], time +0x12). */
  private cuePath = 0;
  private cueTime = 0;
  /** Scripts for being hit ([0x13], op 0xE) and the alternative ([0x14], op 0xF). */
  onHit = 0;
  onHitAlt = 0;
  /** Where the next run starts ([0x12]). */
  private next = 0;
  /** Movement ([0x10]: 0 none, −1 the player, −2 mirrored, >0 a point), target ([0xc..0xe]), distance ([0xf]). */
  private moving = 0;
  private target: [number, number, number] = [0, 0, 0];
  private moveDist = 0;
  /** op 0x26 glide: frames left and the step. */
  private glide = 0;
  private glideStep: [number, number, number] = [0, 0, 0];
  private glideEnd: [number, number, number] = [0, 0, 0];
  /** Exit cue (record +2 path, +4 time, +6 countdown) and the countdown (+0x2a). */
  private exitPath: number;
  private exitTime: number;
  private exitCount: number;
  private leaving = 0;
  readonly attackers: GameObject[] = [];
  /** Op 0x1A: behaviour for her hidden attackers (+0x2c) and how many are still to go (+0x2e). */
  release = { behaviour: 0, count: 0 };
  dead?: boolean;
  /** Script log (for tests and the dev tools). */
  readonly log: string[] = [];
  private items: DrawItem[] = [];

  constructor(rec: SpawnRecord, w: World) {
    const t = rec.tail ?? new Uint8Array(16);
    this.skeleton = (t[0]! << 24) >> 24;
    this.kind = (t[1]! << 24) >> 24;
    this.place = { pos: [...(rec.pos ?? [0, 0, 0])], angles: [...(rec.angles ?? [0, 0, 0])] };
    this.rig = new CharacterRig(w.skeletons[this.skeleton]!, this.skeleton, 0x2bd, w.motions, w.skins[this.skeleton]);
    this.rig.order = 1; // DAT_00818d94 + 0x68 (obj +0x200) = 1
    this.flags = (rec.param | 0) >>> 0;
    const dv = new DataView(t.buffer, t.byteOffset, t.byteLength);
    this.exitPath = dv.getInt16(2, true);
    this.exitTime = dv.getInt16(4, true);
    this.exitCount = dv.getInt16(6, true);
    const pe = w.pe;
    w.civilians = (w.civilians ?? 0) + 1; // FUN_0047fa70: DAT_00a3e7a8 + 1
    if (pe) this.run(w, civilianStartScript(pe, this.kind));
    // attackers (FUN_00420050 each), hp scaled by rank
    for (const c of rec.children ?? []) {
      const pct = pe ? civilianAttackerHpPercent(pe, w.words?.effectiveRank ?? 0) : 100;
      const hp = Math.max(1, Math.trunc((pct * c.hp) / 100));
      const obj = w.spawn?.({ ...c, hp }, this);
      if (obj) this.attackers.push(obj);
    }
    this.attackersLeft = this.attackers.length;
  }

  /** FUN_00481060: run commands from `addr` until the next segment / end. */
  run(w: World, addr: number) {
    const pe = w.pe;
    if (!pe || !addr) return;
    const old = this.segFlags;
    let a = addr;
    for (let guard = 0; guard < 64; guard++) {
      const c = readCivilianCommand(pe, a);
      if (!c) break; // end marker (≥ 0x2D) or an unknown callback: stay here
      this.exec(w, c.op, c.args);
      a += (c.args.length + 1) * 4;
      const nextOp = pe.i32(a);
      if (nextOp > 0x2b) {
        this.next = a;
        this.segFlags = (this.segFlags | (old & 0x8000000)) >>> 0;
        return;
      }
    }
    this.next = a;
  }

  private exec(w: World, op: number, a: number[]) {
    const r = this.rig;
    switch (op) {
      case 0x00:
      case 0x01: {
        // play a motion (loops a[1]; op 1: from frame a[2]) — FUN_00481970's root alignment not ported
        this.loops = (a[1]! << 16) >> 16;
        this.frameLimit = 0;
        if (r.motion !== a[0]) {
          if (op === 1) r.blendTo(a[0]!, a[2]! >> 1, 4);
          else r.blendTo(a[0]!, 0, 4);
        }
        this.log.push(`motion ${a[0]} ×${this.loops}`);
        break;
      }
      case 0x02: this.frameLimit = a[0]!; break;
      case 0x05:
        this.moving = a[0]!;
        this.moveDist = a[1]!;
        if (a[0]! > 0) this.target = this.point(w, a[0]!);
        break;
      case 0x06:
        this.target = this.point(w, a[0]!);
        break;
      case 0x07: {
        // a direction: a point 100 ahead (DAT_004dd8a0) at angle a[0]
        const r = (a[0]! * Math.PI) / 0x8000, k = 100;
        this.moving = 1;
        this.target = [this.place.pos[0] - Math.sin(r) * k, this.place.pos[1], this.place.pos[2] - Math.cos(r) * k];
        break;
      }
      case 0x26: {
        const to = a[0]! < 1 ? [...w.eye] as [number, number, number] : this.point(w, a[0]!);
        this.glide = (a[1]! << 16) >> 16;
        this.glideEnd = to;
        this.glideStep = [0, 1, 2].map((k) => (to[k]! - this.place.pos[k]!) / Math.max(1, this.glide)) as [number, number, number];
        break;
      }
      case 0x04: this.frameTarget = (a[0]! << 16) >> 16; break;
      case 0x09: this.timer = (a[0]! << 16) >> 16; break;
      case 0x0a: this.countLimit = (a[0]! << 16) >> 16; break;
      case 0x0b: this.attackersAt = (a[0]! << 16) >> 16; break;
      case 0x0c: this.civiliansAt = (a[0]! << 16) >> 16; break;
      case 0x0d:
        this.cuePath = (a[0]! << 16) >> 16;
        this.cueTime = (a[1]! << 16) >> 16;
        break;
      case 0x0e: this.onHit = a[0]! >>> 0; break;
      case 0x0f: this.onHitAlt = a[0]! >>> 0; break;
      case 0x1c: w.flags[a[0]!] = 1; break;
      case 0x20: this.flagIndex = (a[0]! << 16) >> 16; break;
      case 0x19: // DAT_00a3b264: the route after a branching block (the second civilian: 1 when killed)
        w.route?.((a[0]! << 16) >> 16);
        this.log.push(`route ${(a[0]! << 16) >> 16}`);
        break;
      case 0x1a: // her hidden attackers (behaviour 39) take behaviour a[0] — a[1] of them — while any are left
        if (this.attackersLeft !== 0) this.release = { behaviour: (a[0]! << 16) >> 16, count: (a[1]! << 16) >> 16 };
        this.log.push(`release ${a[1]} attacker(s) as behaviour ${a[0]}`);
        break;
      case 0x1d: // FUN_004239a0: her line (shown unless +0x2a is set — not modelled; voice not ported)
        w.say?.((a[0]! << 16) >> 16);
        this.log.push(`say ${(a[0]! << 16) >> 16}`);
        break;
      case 0x29: this.flags = (this.flags | a[0]!) >>> 0; break;
      case 0x2c: {
        this.segFlags = (a[0]! & ~0x4000000) >>> 0;
        // 0x80000: no longer counted as in play (DAT_00a3e7a8 − 1, state [1] | 1)
        if (this.segFlags & 0x80000) this.leaveCount(w);
        if (this.segFlags & 0x4000) this.frameLimit = 0;
        this.flags = this.segFlags & 0x40000 ? (this.flags & ~0x10000) >>> 0 : (this.flags | 0x10000) >>> 0;
        if (this.segFlags & 0x10000000) {
          this.log.push('rescued (+400, rescue count — not ported)');
          this.segFlags = (this.segFlags & ~0x10000000) >>> 0;
        }
        this.log.push(`segment 0x${this.segFlags.toString(16)}`);
        break;
      }
      default:
        this.log.push(`op 0x${op.toString(16)} ${a.join(' ')} (not ported)`);
    }
  }

  /** Three floats at an exe address (a point in a script). */
  private point(w: World, addr: number): [number, number, number] {
    const pe = w.pe!;
    return [pe.f32(addr), pe.f32(addr + 4), pe.f32(addr + 8)];
  }

  /** Vector `v` in her own frame (rotY(−y)·rotZ(−z)·rotX(−x)). */
  private local(v: [number, number, number]): [number, number, number] {
    const a = this.place.angles;
    const m = rotateXLocal(rotateZLocal(rotateYLocal(identity(), -a[1]), -a[2]), -a[0]);
    return transformDir(m, v) as [number, number, number];
  }

  private currentTarget(w: World): [number, number, number] {
    if (this.moving === -1) return [w.eye[0], w.eye[1], w.eye[2]];
    if (this.moving < 0) return [this.place.pos[0] * 2 - w.eye[0], w.eye[1], this.place.pos[2] * 2 - w.eye[2]];
    return this.target;
  }

  /** FUN_00480860's movement part: true = this condition is met (advance). */
  private movementDone(w: World): boolean {
    const f = this.segFlags, p = this.place.pos;
    if (f & 0x30) {
      const t = this.moving < 0 ? this.currentTarget(w) : this.target;
      if (!(f & 0x10)) {
        const l = this.local([p[0] - t[0], p[1] - t[1], p[2] - t[2]]);
        if (toAngle(Math.atan2(l[0], l[2])) === 0) {
          this.moving = 0;
          return true;
        }
      } else if (Math.hypot(p[2] - t[2], p[0] - t[0]) <= this.moveDist) {
        if (this.moving > 0 && this.moveDist <= 1) [p[0], p[2]] = [t[0], t[2]];
        this.moving = 0;
        return true;
      }
    }
    if (f & 0x40) {
      const l = this.local([this.target[0] - p[0], this.target[1] - p[1], this.target[2] - p[2]]);
      if (l[2] > 0) {
        this.moving = 0;
        return true;
      }
    }
    // 0x80: the camera at path / time (op 0xD); 0x40000000: at once with any player
    if (f & 0x80 && w.camPath === this.cuePath && w.camTime === this.cueTime) return true;
    if (f & 0x40000000) return true;
    return false;
  }

  /** FUN_00480860: has any of this segment's wait conditions been met? */
  private segmentDone(w: World): boolean {
    const f = this.segFlags;
    if (!((f & 0x40003fff) !== 0 || this.timer >= 0) || f & 0x14000000) return false;
    const waiting =
      (!(f & 1) || this.countLimit < w.enemies) &&
      (!(f & 2) || this.countLimit < w.attackers) &&
      (!(f & 8) || this.civiliansAt < (w.civilians ?? 0)) &&
      (!(f & 4) || this.attackersAt < this.attackersLeft) &&
      (!(f & 0x100) || this.loops !== 0) &&
      (!(f & 0x200) || this.rig.frame !== this.frameTarget) &&
      !(f & 0x800) &&
      (!(f & 0x2000) || !w.flags[this.flagIndex]) &&
      !this.movementDone(w);
    if (waiting) {
      if (this.timer < 0) return false;
      if (this.timer-- !== 0) return false;
    }
    this.timer = -1;
    return true;
  }

  /**
   * FUN_00480860's loop after the current segment's wait is over: look at the next segment — apply only the state
   * parts of its commands (FUN_00480de0: loop counts, targets, timer, counters, camera cue, flag index; not motions,
   * "if hit" scripts, voices …) and test its own wait conditions; if those are met already, it is passed over without
   * running and the one after is tried. Returns the segment to run. The counters are put back afterwards (the run
   * sets its own). The second civilian keeps her "if hit" script this way: the segment that clears it is skipped.
   */
  private advance(w: World): number {
    const pe = w.pe;
    if (!pe) return this.next;
    const saved = [this.loops, this.attackersAt, this.countLimit, this.civiliansAt, this.cuePath, this.cueTime, this.frameTarget, this.flagIndex] as const;
    let seg = this.next;
    for (let guard = 0; guard < 32; guard++) {
      if (pe.i32(seg) !== 0x2c) break;
      const flags = pe.i32(seg + 4) >>> 0;
      this.timer = -1;
      const after = this.skipSegment(w, seg);
      if (after === undefined || pe.i32(after) === 0x2d) break;
      this.segFlags = (flags & ~0x4000000) >>> 0;
      if (!this.segmentDone(w)) break;
      this.log.push(`segment 0x${this.segFlags.toString(16)} passed over`);
      seg = after;
    }
    [this.loops, this.attackersAt, this.countLimit, this.civiliansAt, this.cuePath, this.cueTime, this.frameTarget, this.flagIndex] = saved;
    this.timer = -1;
    return seg;
  }

  /** FUN_00480de0: the state parts of a segment's commands; returns the next segment / end (undefined: a callback). */
  private skipSegment(w: World, seg: number): number | undefined {
    const pe = w.pe!;
    let a = seg + 8;
    for (let guard = 0; guard < 64 && pe.i32(a) <= 0x2b; guard++) {
      const c = readCivilianCommand(pe, a);
      if (!c) return undefined;
      if (c.op === 0 || c.op === 1) this.loops = (c.args[1]! << 16) >> 16; // (and the rig frame: not modelled)
      else if ([0x04, 0x05, 0x06, 0x07, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20].includes(c.op)) this.exec(w, c.op, c.args);
      a += (c.args.length + 1) * 4;
    }
    return a;
  }

  /** Killed (dead flag 0x4000000, set by her attacker on its kill frame): her "if hit" script has started. */
  private dying = false;

  /** DAT_00a3e7a8 − 1, once (state [1] bit 1). */
  private counted = true;
  private leaveCount(w: World) {
    if (!this.counted) return;
    this.counted = false;
    w.civilians = (w.civilians ?? 1) - 1;
  }

  /** An attacker sets segment bits (behaviour 34 sets 0x800 on reaching her: "met" for a 0x800 segment). */
  signal(bits: number) {
    this.segFlags = (this.segFlags | bits) >>> 0;
  }

  update(w: World) {
    // FUN_0047ffc0: dead flag in a fight → the "if hit" script ([0x13]) once; both players −100 (not ported)
    if (this.flags & 0x4000000 && !this.dying && this.onHit && w.inFight) {
      this.dying = true;
      this.log.push('killed');
      const s = this.onHit;
      this.onHit = 0;
      this.loops = 0;
      this.run(w, s);
    }
    // FUN_004820c0: attackers marked dead leave the list
    for (let i = this.attackers.length - 1; i >= 0; i--) {
      const z = this.attackers[i] as { flags?: number };
      if ((z.flags ?? 0) & 0x4000000) {
        this.attackers.splice(i, 1);
        this.attackersLeft--;
      }
    }
    // movement (FUN_00481eb0): turn towards the target, at most 0x100 a frame
    if (this.moving !== 0) {
      const t = this.currentTarget(w), p = this.place.pos;
      const l = this.local([p[0] - t[0], p[1] - t[1], p[2] - t[2]]);
      const h = toAngle(Math.atan2(l[0], l[2]));
      this.place.angles[1] += Math.max(-0x100, Math.min(0x100, h));
    }
    if (this.glide > 0) {
      if (--this.glide === 0) this.place.pos = [...this.glideEnd];
      else for (let k = 0; k < 3; k++) this.place.pos[k]! += this.glideStep[k]!;
    }
    this.rig.pose(this.place);
    this.items = this.rig.draw();
    // motion counter by the loop rules (FUN_0047ffc0)
    const r = this.rig, len = w.motions.frames(r.motion);
    if (this.loops < 0) r.counter++;
    else if (this.loops > 0) {
      if (this.frameLimit === 0) {
        if (r.frame < len) r.counter++;
        else if (--this.loops !== 0) r.counter++;
      } else if (r.frame < this.frameLimit) r.counter++;
      else if (this.segFlags & 0x100 && --this.loops !== 0) r.counter = 0;
    }
    if (this.segmentDone(w)) this.run(w, this.advance(w));
    if (!(this.flags & 0x10000)) {
      // FUN_00436f00(4.0) → FUN_004205d0 (aim point: the hips + 4, as for zombies)
      w.active++;
      const h = this.rig.rootPosition();
      w.aims?.push({ pos: [...this.place.pos], aim: [h[0], h[1] + 4, h[2]], slot: -1 });
    }
    // leaving (FUN_0047ffc0's end): a countdown from the record's camera cue, once no attacker is left
    if (this.leaving === 0) {
      if (w.camPath === this.exitPath && w.camTime === this.exitTime) this.leaving = Math.max(1, this.exitCount);
    } else if (--this.leaving === 0) {
      if (this.attackersLeft !== 0) this.leaving = 1;
      else {
        this.leaveCount(w);
        this.dead = true;
      }
    }
  }

  draw(): DrawItem[] {
    return this.items;
  }
}
