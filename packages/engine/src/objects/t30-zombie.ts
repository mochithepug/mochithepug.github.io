/**
 * Zombie: object type 0x30 (set-up `FUN_00441d80`, task `FUN_00442460`). The spawn record's tail
 * (obj +0x1394 → record +0x24) gives skeleton, kind, behaviour and each behaviour's parameters.
 * Per frame: behaviour @005a215c[obj +0x1314], position += velocity, pose + draw (FUN_004438b0), then the
 * motion counter advances unless frozen (obj +0x34 & 0x4000).
 * Behaviours ported: 18 `FUN_00446700` (play a motion, wait for a camera time, then the next behaviour),
 * 26 `FUN_00447380` (wait, leap along an arc to a target, land), 1 `FUN_00444520` (walk to the player, turning
 * towards them; within the near band → 2), 2 `FUN_00444770` (stand facing the player; when the player's attack
 * slot is free take it → 3; too close → 4), 3 `FUN_00444ac0` (pick an attack, walk in, swing, hit on the row's
 * frame) and 4 `FUN_00444ce0` (back off past the near band, free the slot → 2). Others hold still.
 * Behaviours 13 `FUN_00446080` (lie frozen with no word box — flags 0x4100 — until a camera time, get up with 0x411,
 * then 15 or 1), 14 `FUN_00446290` (walk for a number of frames, then 1) and 15 `FUN_00446350` (walk a set
 * distance, then 1). Not ported: 33 `FUN_00448310` (throw a held item: a projectile with its own word box).
 * Behaviour 35 (0x23) `FUN_0044a310`: a scripted attack on its civilian (parent, +0x1398) — steps from the record
 * (extra data +4, or +8 when re-entered as the next behaviour, FUN_0044c1c0): {motion, start, repeats, kill frame};
 * on the kill frame the civilian gets the dead flag 0x4000000 (FUN_0044c380: scream); after the last step, or
 * once the civilian is dead, the next behaviour (FUN_0044c080). Not ported: 0x22 / 0x24 / 0x28 / 0x2d, the
 * per-motion flags (0x1ca / 0x1ce / 0x1d2 / 0xb4 …).
 * Typed letters (FUN_004b32f0 → FUN_00442f30): each correct letter hits a body part (FUN_004b3a60) and shows the
 * impact effect (FUN_004430d0 → FUN_00411bc0 / FUN_00411ae0); the finished word kills: behaviour 6
 * `FUN_00443d70` (death motion by direction, FUN_00445320; attack slot freed) → 7 `FUN_00443f70` (sinks 0.04 a
 * frame for 120 frames, then gone); the live-enemy count (DAT_00a39546) drops when the death motion ends.
 * Not ported: hit flinches of other skeletons, lost arms / part models, blood and score (FUN_00411df0), voices,
 * the corpse twitch (FUN_00443e50).
 * One-player rules only. Not ported: the off-screen attacker lock (FUN_00436fa0 / DAT_00a11a78), lost arms
 * (FUN_00444970), the attack cool-down (+0x1340 / +0x136c), being hit, word box, head turning to the player
 * (FUN_00442c60), special part models (FUN_00442510), kind-6 effects, groans and other sounds.
 */
import { identity, invert, mul, scaleLocal, transformDir, transformPoint, translateLocal, readSteps, type SpawnRecord, type StepEntry } from '@ttotd/formats';
import { rotationMatrix, toAngle } from '../core/angles.ts';
import type { DrawItem, GameObject, World } from '../core/object.ts';
import { ThrownItem } from './thrown-item.ts';
import type { WordOwner } from './wordbox.ts';
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

/** Thrower hands (FUN_00448310 / FUN_00449980): item model ranges on joints 5 / 8 (exclusive), the empty-hand models,
 * and what to subtract from the hand model to get the thrown item's model. (Skeleton 0x14's items: not ported.) */
const HANDS: Record<number, { j5: [number, number]; j8: [number, number]; empty5: number; empty8: number; item5: number; item8: number }> = {
  1: { j5: [0x1ef3, 0x1ef7], j8: [0x1eed, 0x1ef1], empty5: 0x1ef9, empty8: 0x1ef3, item5: 0x20, item8: 0x1d },
  0x13: { j5: [0x221e, 0x2224], j8: [0x2216, 0x221c], empty5: 0x221c, empty8: 0x2214, item5: 0x1fae, item8: 0x1fa6 },
};

export class Zombie implements GameObject, WordOwner {
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
  /** Word box anchor: joint 1 in view space (+0x10c) and world space (+0x100, y + 4 by FUN_00436f00). */
  anchor?: Vec3;
  worldAnchor?: Vec3;
  /** Word flags (+0x194 = @005a2848[0x30] | 0x30000000). */
  wordFlags = 0x30000001;
  dead?: boolean;
  /** Player being attacked (+0x121), −1 none. */
  victim = -1;
  /** Attack row in use (+0x131e). */
  private attackRow = 0;
  /** Damage state (+0x131c; low 3 bits: arms lost). */
  private damage = 0;
  /** Second flag word (+0x1370). */
  private flags2 = 0;
  /** Queue places (+0x1321 among all queued zombies, −1 until ranked; +0x1322 among those not backing off) and the
   * band's allowance (+0x135c, FUN_00445750 from event op 0x0F's counts). */
  private queuePlace = -1;
  private queueReady = 0;
  private allowance = 0;
  /** Where it stood when the attack began (+0x13dc) and the point it attacks (+0x13e8). */
  private spot: Vec3 = [0, 0, 0];
  private attackPoint: Vec3 = [0, 0, 0];
  /** Back-off frames (+0x1338). */
  private backTimer = 0;
  /** Body part hit per player (+0x190), parts already hit (+0x284 + part·0x90, bit 0x100). */
  private hitPart = [0, 0];
  private partsHit = new Set<number>();
  /** Impact effects (FUN_00411ae0 tasks): body part, frame 0–24. */
  private sparks: { part: number; frame: number }[] = [];
  /** Sink timer of behaviour 7 (+0x1334). */
  private sinkTimer = 0;
  /** Behaviour 15: distance to walk (+0x1374) and where it started (+0x13c4). */
  private walkDistance = 0;
  private walkStart: Vec3 = [0, 0, 0];
  private readonly tail?: Uint8Array;
  private items: DrawItem[] = [];

  /** The object that created it (+0x1398): a civilian it attacks. */
  readonly parent?: GameObject;
  /** Behaviour 35: step lists (+4 / +8), the list in use and the current step (+0x139c), motion (+0x1324),
   * repeats (+0x1354), kill frame (+0x1358). */
  private readonly steps?: [StepEntry[] | undefined, StepEntry[] | undefined];
  /** Raw data lists (+4 / +8) for behaviours 34 / 40. */
  private readonly lists?: [Uint8Array | undefined, Uint8Array | undefined];
  /** Behaviour 34: reach distance (+0x1374) and signal flag (+0x1354); behaviour 40: the point (+0x13c4). */
  private reach = 0;
  /** Behaviour 39: not drawn, and the flags to restore when released (+0x1354). */
  private hidden = false;
  private savedFlags = 0;
  private reachSignal = 0;
  private walkTo: Vec3 = [0, 0, 0];
  private stepList: StepEntry[] = [];
  private stepIdx = 0;
  private stepMotion = 0;
  private stepRepeats = 0;
  private killFrame = -1;

  constructor(rec: SpawnRecord, w: World, parent?: GameObject) {
    this.parent = parent;
    this.steps = rec.steps;
    this.lists = rec.lists;
    this.tail = rec.tail;
    const t = rec.tail ?? new Uint8Array(4);
    this.skeleton = (t[0]! << 24) >> 24;
    this.kind = (t[1]! << 24) >> 24;
    this.behaviour = (t[2]! << 24) >> 24;
    this.hp = rec.hp;
    // FUN_00441d80: +0x1370 = (short) record word 8 (+0x131a) | 0x60000000
    this.flags2 = ((rec.flagsWord ?? 0) | 0x60000000) >>> 0;
    this.flags = (rec.param | 1) >>> 0;
    this.place = { pos: [...(rec.pos ?? [0, 0, 0])], angles: [...(rec.angles ?? [0, 0, 0])] };
    this.rig = new CharacterRig(w.skeletons[this.skeleton]!, this.skeleton, 0x3f5, w.motions, w.skins[this.skeleton]);
    this.rig.order = 1; // obj +0x200 = 1: rotX, rotZ, rotY
    w.enemies++; // FUN_00441d80: DAT_00a39546 + 1, DAT_00a3ba4a + 1 (not for behaviour 0x1f)
    if (this.behaviour !== 0x1f) w.attackers++;
  }

  /** Parts by pair (@005ea9fc): head, arms, legs. */
  private static readonly PART_PAIRS = [[2, 1], [3, 4], [6, 7], [10, 11], [13, 14]] as const;

  /** FUN_004b32f0 (word flag 1 branch) for a correct letter: hit bits, part (FUN_004b3a60). */
  letterHit(w: World, player: number) {
    this.flags = (this.flags | (1 << (player + 1)) | 0x1008) >>> 0;
    const pair = Zombie.PART_PAIRS[w.rand() % (this.kind === 4 ? 3 : 5)]!;
    let i = 1;
    while (i > 0 && this.partsHit.has(pair[i]!)) i--;
    this.partsHit.add(pair[i]!);
    this.hitPart[player] = pair[i]!;
  }

  /** The word is complete: head hit, hp 0, dead flag. */
  wordDone(_w: World, player: number) {
    this.hitPart[player] = 2;
    this.hp = 0;
    this.flags = ((this.flags & ~0x1001) | 0x4000000) >>> 0;
  }

  /** FUN_00442f30 (with FUN_00436750): process this frame's hits; a dead flag starts the death. */
  private takeHits(w: World) {
    if (!(this.flags & 8)) return;
    const shots = [0, 1].map((p) => (this.flags & (1 << (p + 1)) ? this.hitPart[p]! : 0));
    this.flags = (this.flags & ~(8 | 2 | 4)) >>> 0;
    if (this.flags & 0x100) return;
    for (const part of shots) {
      if (part <= 0) continue;
      this.flags2 &= ~0x400;
      this.sparks.push({ part, frame: 0 }); // FUN_004430d0 weapon 1 → FUN_00411bc0(obj, part, 0.75)
      if (this.flags2 & 0x80000000) continue;
      if (!(this.flags & 0x4000000)) continue; // FUN_004434a0: nothing more for this skeleton
      this.flags2 = (this.flags2 | 0x80000000) >>> 0;
      w.rand(); // death voice choice (FUN_00437ab0), not played
      if (!(this.flags2 & 0x4000)) {
        this.state = 0;
        this.behaviour = this.behaviour === 0x34 || this.flags2 & 0x100000 || this.kind === 5 || this.kind === 6 ? 9 : 6;
      }
    }
  }

  /** FUN_00437410: angle `a` within ±range of `centre`. */
  private static within(a: number, centre: number, range: number) {
    const d = (((a - centre) & 0xffff) + 0x8000) % 0x10000 - 0x8000;
    return Math.abs(d) <= range;
  }

  /**
   * FUN_00445170 (kinds other than 4–6; the 0x136c special cases are not ported): flag 0x1000000 — a zombie on a
   * ledge — falls over it with motion 0x432 (then behaviour 12), else FUN_00445320 by direction.
   */
  private pickDeathMotion(w: World) {
    if (this.flags & 0x1000000 && (this.kind < 4 || this.kind > 6)) {
      this.rig.blendTo(0x432, 0, 1);
      this.flags &= ~0x4000;
      return;
    }
    this.pickDeathByDirection(w);
  }

  /** FUN_00445320: the death motion by the angle between the player's view and the zombie's facing. */
  private pickDeathByDirection(w: World) {
    const u = (w.camYaw - this.place.angles[1]) & 0xffff;
    let m: number | undefined;
    if (Zombie.within(u, 0x4000, 0x2000)) m = 0x419;
    if (Zombie.within(u, 0xc000, 0x2000)) m = 0x418;
    if (Zombie.within(u, 0, 0x2000)) m = [0x412, 0x413, 0x415, 0x417][w.rand() & 3];
    if (Zombie.within(u, 0x8000, 0x2000)) m = [0x412, 0x416, 0x414, 0x415, 0x416, 0x417][w.rand() % 6];
    // +0x1370 bits swap the motion (the exe changes the playing motion id after starting it): 4 — a side fall becomes
    // one of the back-fall list; 1 — 0x412/0x413/0x417 → 0x414/0x415/0x416 (the thrower sets it: it falls forward out
    // of its window); 2 — the reverse
    if (this.flags2 & 4 && (m === 0x418 || m === 0x419)) m = [0x412, 0x416, 0x414, 0x415, 0x416, 0x417][w.rand() % 6];
    if (this.flags2 & 1) m = m === 0x412 ? 0x414 : m === 0x413 ? 0x415 : m === 0x417 ? 0x416 : m;
    if (this.flags2 & 2) m = m === 0x414 ? 0x412 : m === 0x415 ? 0x413 : m === 0x416 ? 0x417 : m;
    if (m !== undefined) this.rig.blendTo(m, 0, 5);
    this.flags &= ~0x4000;
  }

  /**
   * FUN_004456a0 (death start): attack slot freed; leaves the active table (flag 0x10000) unless it is the last enemy
   * and flagged 0x800000 (then the fight waits for its body); DAT_00a3ba4a − 1 (FUN_00445660).
   */
  private deathStart(w: World) {
    this.flags = (this.flags | 0x22000) >>> 0;
    this.flags2 = ((this.flags2 & ~0x200) | 0x60000000) >>> 0;
    this.releaseAttack(w);
    if (!(this.flags & 0x800000) || w.attackers !== 1) this.flags = (this.flags | 0x10000) >>> 0;
    w.attackers--;
    this.flags2 &= ~0x10000;
  }

  /** FUN_00445840 (death end): the live-enemy count drops; on to sinking (7). */
  private deathEnd(w: World) {
    this.flags2 &= ~0x60000000;
    this.flags = ((this.flags & ~0x20001) | 0xc000) >>> 0;
    w.enemies--; // FUN_00445680
    this.rig.counter--;
    this.behaviour = 7;
    this.state = 0;
  }

  /** Behaviour 6 (FUN_00443d70): death motion, then behaviour 7. */
  private die(w: World) {
    const r = this.rig;
    if (this.state === 0) {
      this.pickDeathMotion(w);
      this.state = 1;
    }
    if (this.state === 1) {
      this.deathStart(w);
      this.state = 2;
    }
    if (r.frame >= w.motions.frames(r.motion) - 1 || this.flags & 0x1000000) {
      this.flags2 &= ~0x200;
      if (this.flags & 0x1000000) {
        this.behaviour = 12; // over the ledge
        this.state = 0;
        return;
      }
      this.deathEnd(w);
    }
  }

  /**
   * Behaviour 12 (FUN_00445f20): falling off a ledge after death (flag 0x1000000, motion 0x432). The motion tips it
   * over until frame 60; then gravity −0.03675 a frame to the floor (FUN_00437100); on landing (not in water) the
   * lying motion 0x431, bounce ×−0.25; once slower than 0.15 the death ends (sinking). (Landing effects — dust,
   * splash, blood — not ported.)
   */
  private fallOffLedge(w: World) {
    const r = this.rig;
    if (this.state === 0) {
      this.flags2 = (this.flags2 & ~0x20000000) >>> 0;
      this.flags &= ~0x4000;
      this.fallGravity = f32(-0.0367500);
      this.state = 1;
    }
    if (this.state === 1) {
      if (r.frame < 0x3c) return;
      this.state = 2;
      this.flags2 = ((this.flags2 & ~0x10000) | 0x20000000) >>> 0;
    }
    if (r.frame >= w.motions.frames(r.motion) - 1 && r.motion === 0x432) this.flags = (this.flags | 0x4000) >>> 0;
    this.vel[1] = f32(this.vel[1] + this.fallGravity);
    const p = this.place.pos;
    const floor = w.floorAt?.(p[0], p[1], p[2]) ?? -Infinity;
    if (p[1] + this.vel[1] > floor) return;
    p[1] = floor;
    this.vel[1] = f32(this.vel[1] * -0.25);
    if (!(this.flags2 & 0x10000)) {
      r.blendTo(0x431, w.rand() % 10, 10);
      this.flags &= ~0x4000;
    }
    if (Math.abs(this.vel[1]) <= 0.15) {
      this.vel = [0, 0, 0];
      this.acc = [0, 0, 0];
      this.deathEnd(w);
    }
  }

  /** Behaviour 9: fling frames (+0x1338), counter (+0x1334), from / to (+0x13c4 / +0x13d0), gravity (+0x5c). */
  private flingFrames = 0;
  private flingCount = 0;
  private flingFrom: Vec3 = [0, 0, 0];
  private flingTo: Vec3 = [0, 0, 0];
  private fallGravity = 0;

  /**
   * Behaviour 9 (FUN_00444130): knocked off — kinds 4–6, flag +0x1370 0x100000 (throwers on a ledge), behaviour 0x34.
   * A target near its view-space aim point (kind 4: z +1.5 / −5 by distance, ±tilt; 5: z −7; 6: z −7, y −7; others:
   * all ÷ 4), a parabola to it over max(horizontal distance × m / 30, m) frames (FUN_0043c950 / FUN_0043cbe0; m 10 or
   * 15), the death motion; then gravity (−0.0368, kinds 4–5 −0.0272) until the floor (FUN_00437100), bouncing at
   * −0.25 while faster than 0.15 (for up to 120 frames), then the usual death end and sinking.
   */
  private knockedOff(w: World) {
    const r = this.rig;
    if (this.state === 0) {
      this.flags = (this.flags | 0x20000) >>> 0;
      this.deathStart(w);
      let div = 1, yOff = 0, zOff: number;
      // +0x70: the view-space aim point (+0x100, y + 4). Taken here as the feet + 4 — from the hips the target would be
      // ~13 units up; the camera aim uses the hips (where the exe sets +0x100 is still not found)
      const pp = this.place.pos;
      const view = transformPoint(w.view, [pp[0], pp[1] + 4, pp[2]]);
      const far = view[2]! <= -25;
      if (this.kind === 4) {
        const sign = 1 - 2 * (w.rand() & 1);
        this.place.angles[0] = (this.place.angles[0] + sign * (w.rand() % 5) * 0x100) & 0xffff;
        zOff = far ? 1.5 : -5;
      } else if (this.kind === 5) zOff = -7;
      else if (this.kind === 6) {
        yOff = 7;
        this.flags2 = (this.flags2 & ~0x20000000) >>> 0;
        zOff = -7;
      } else {
        div = 4;
        zOff = far ? 1.5 : -5;
      }
      const sign = 1 - 2 * (w.rand() & 1);
      const t = transformPoint(invert(w.view), [
        f32((sign * 0.5) / div + view[0]!),
        f32(view[1]! - (((w.rand() % 5) + 1) * 0.5 + yOff + 3) / div),
        f32(zOff / div + view[2]!),
      ]);
      this.flingFrom = [...this.place.pos];
      this.flingTo = [t[0]!, t[1]!, t[2]!];
      this.flingCount = 0;
      const m = this.flags2 & 0x2000000 && !(this.flags & 0x44000000) ? 10 : 15;
      const d = Math.hypot(this.flingFrom[0] - this.flingTo[0], this.flingFrom[2] - this.flingTo[2]);
      this.flingFrames = Math.max(Math.trunc(d / f32(30 / m)), m);
      this.pickDeathMotion(w); // FUN_00445170 → FUN_00445320 for these
      this.vel = [0, 0, 0]; // FUN_0043cf20
      this.acc = [0, 0, 0];
      this.state = 1;
      this.flags2 &= ~0x10000;
    }
    if (r.frame >= w.motions.frames(r.motion) - 1) this.flags = (this.flags | 0x4000) >>> 0;
    if (this.state === 1) {
      // FUN_0043cbe0: the velocity for this frame of the parabola
      const c = this.flingCount++, n = this.flingFrames, G = f32(0.027222222);
      if (c < n) {
        const dy = this.flingTo[1] - this.flingFrom[1];
        this.vel = [
          f32((this.flingTo[0] - this.flingFrom[0]) / n),
          f32((c + 1) * -G + (n * n * G + dy + dy) / (n * 2)),
          f32((this.flingTo[2] - this.flingFrom[2]) / n),
        ];
        return;
      }
      this.fallGravity = this.kind === 4 || this.kind === 5 ? -G : f32(-0.0367500);
      this.state = 2;
      this.flingCount = 0;
    }
    // falling (state 2)
    this.flingCount++;
    this.vel[1] = f32(this.vel[1] + this.fallGravity);
    const p = this.place.pos;
    const floor = w.floorAt?.(p[0], p[1], p[2]) ?? -Infinity;
    if (floor < p[1] + this.vel[1]) return;
    p[1] = floor;
    if (this.flingCount < 0x78 && Math.abs(this.vel[1]) > 0.15) {
      this.vel[1] = f32(this.vel[1] * -0.25); // bounce
      return;
    }
    this.vel = [0, 0, 0];
    this.deathEnd(w);
  }

  /** Behaviour 7 (FUN_00443f70): sink 0.04 a frame for 120 frames, then end. */
  private sink() {
    if (this.state === 0) {
      this.flags2 &= ~0x20000200;
      this.flags = (this.flags | 0xa0000) >>> 0;
      this.sinkTimer = 0x78;
      this.state = 1;
    }
    this.place.pos[1] = f32(this.place.pos[1] - f32(0.04));
    if (--this.sinkTimer < 1) {
      this.flags = (this.flags | 0x10000) >>> 0;
      this.dead = true;
    }
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
    this.takeHits(w);
    this.runBehaviour(w);
    for (let k = 0; k < 3; k++) this.place.pos[k] = f32(this.place.pos[k]! + this.vel[k]!);
    this.rig.pose(this.place);
    this.items = this.hidden ? [] : this.rig.draw();
    this.afterPose(w);
  }

  /** The behaviour table @005a215c for the ported behaviours (others hold still). */
  private runBehaviour(w: World) {
    if (this.behaviour === 18) this.waitFor(w);
    else if (this.behaviour === 26) this.leap(w);
    else if (this.behaviour === 1) this.approach(w);
    else if (this.behaviour === 2) this.stand(w);
    else if (this.behaviour === 3) this.attack(w);
    else if (this.behaviour === 4) this.backOff(w);
    else if (this.behaviour === 0x23) this.attackCivilian(w);
    else if (this.behaviour === 0x22) this.chaseCivilian(w);
    else if (this.behaviour === 0x28) this.walkToPoint(w);
    else if (this.behaviour === 13) this.riseUp(w);
    else if (this.behaviour === 15) this.walkDistanceThenApproach(w);
    else if (this.behaviour === 14) this.walkFrames(w);
    else if (this.behaviour === 6) this.die(w);
    else if (this.behaviour === 9) this.knockedOff(w);
    else if (this.behaviour === 12) this.fallOffLedge(w);
    else if (this.behaviour === 7) this.sink();
    else if (this.behaviour === 39) this.waitRelease(w);
    else if (this.behaviour === 5) this.waitTurn(w);
    else if (this.behaviour === 33) this.throwItems(w);
    else if (this.behaviour === 0x2d) this.pauseOverVictim(w);
  }

  /** Behaviour and state to go back to after behaviour 45 (+0x1358 / +0x135c). */
  private resumeBehaviour = 1;
  private resumeState = 0;
  private pauseTimer = 0;

  /** Save the current behaviour / state and pause in behaviour 45 (the exe's switch to 0x2d). */
  private pauseThenResume() {
    this.resumeBehaviour = this.behaviour;
    this.resumeState = this.state;
    this.behaviour = 0x2d;
    this.state = 0;
  }

  /**
   * Behaviour 45 (0x2D, FUN_0044bf80): after its civilian died — stand in the idle motion (motion set entry 0) for
   * 10–20 frames, then go back to the saved behaviour. From behaviour 35 with a step list ending in −1 that is 35
   * again, which replays the last step and pauses again: the zombie stays over the body until it is typed.
   */
  private pauseOverVictim(w: World) {
    const r = this.rig;
    if (this.state === 0) {
      this.pauseTimer = (w.rand() % 0xb) + 10;
      const idle = w.motionSet(this.skeleton, this.kind)?.[0];
      if (idle !== undefined && r.motion !== idle) r.blendTo(idle, 0, 10);
      this.state = 1;
      this.stepMotion = r.motion;
    } else if (this.state === 1 && --this.pauseTimer === 0) {
      this.behaviour = this.resumeBehaviour;
      this.state = this.resumeState;
    }
    if (!(this.flags & 0x40000000) && r.motion !== this.stepMotion && this.stepMotion > 0) r.blendTo(this.stepMotion, 0, 10);
  }

  /**
   * Behaviour 39 (FUN_0044b280): hidden (flags | 0x18000: no box, not registered; not drawn — +0x1fc bit 1, rig
   * +0x1d8) until its civilian releases attackers (civilian op 0x1A: behaviour +0x2c, count +0x2e). Released: that
   * behaviour from state 0 (run at once), flags back; behaviour 0x31: dead flag, the enemy counts drop (FUN_00445660 /
   * FUN_00445680) and it is removed (FUN_00437090) the next frame.
   */
  private waitRelease(w: World) {
    const civ = this.parent as { release?: { behaviour: number; count: number } } | undefined;
    if (this.state === 2) {
      this.dead = true;
      return;
    }
    if (this.state === 0) {
      this.savedFlags = this.flags;
      this.flags = (this.flags | 0x18000) >>> 0;
      this.hidden = true;
      this.state = 1;
    }
    const rel = civ?.release;
    if (!rel || rel.count === 0) return;
    rel.count--;
    if (rel.behaviour === 0x31) {
      this.flags = (this.flags | 0x4000000) >>> 0;
      w.attackers--;
      w.enemies--;
      this.state = 2;
      return;
    }
    this.behaviour = rel.behaviour;
    this.state = 0;
    this.flags = this.savedFlags;
    this.hidden = false;
    this.runBehaviour(w);
  }

  /** After posing: anchors, sparks, registration, motion counter. */
  private afterPose(w: World) {
    // FUN_00420720: join the queue (shown, not dead, +0x1370 bit 0x8000000 clear), key = trunc(distance × 10)
    if (this.flags & 1 && !(this.flags & 0x4000000) && !(this.flags2 & 0x8000000) && !this.dead)
      w.queue?.push({
        key: Math.trunc(this.playerDistance(w) * 10),
        backingOff: (this.flags & 0x20000000) !== 0,
        setPlaces: (all, ready) => {
          this.queuePlace = all;
          this.queueReady = ready;
        },
      });
    // FUN_00475420 at joint 1: view- and world-space position; FUN_00436f00(4): world y + 4
    const j = this.rig.joints[1]?.matrix;
    if (j) {
      const world: Vec3 = [j[12]!, j[13]!, j[14]!];
      this.anchor = transformPoint(w.view, world) as Vec3;
      this.worldAnchor = [world[0], f32(world[1] + 4), world[2]];
    }
    this.drawSparks(w);
    if (!(this.flags & 0x10000) && !this.dead) {
      // FUN_00436f00(4.0) → FUN_004205d0. Aim point +0x100: taken as the hips (where the exe sets it is not found)
      w.active++;
      const h = this.rig.rootPosition();
      w.aims?.push({ pos: [...this.place.pos], aim: [h[0], h[1] + 4, h[2]], slot: this.victim });
    }
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

  /**
   * FUN_00445750: 1 within near, 2 near–mid, 3 mid–far, 4 beyond far; sets the allowance +0x135c — how many zombies
   * may be ahead of this one: counts[0] (bands 1–2), counts[0] + counts[1] (3), all three (4).
   */
  private band(w: World): number {
    const d = this.playerDistance(w), [near, mid, far] = w.bands[this.bandRow] ?? [25, 38, 51];
    const [a, b, c] = w.attackCounts ?? [2, 3, 4];
    if (d > far!) {
      this.allowance = a! + b! + c!;
      return 4;
    }
    if (d > mid!) {
      this.allowance = a! + b!;
      return 3;
    }
    this.allowance = a!;
    return d > near! ? 2 : 1;
  }

  /** Behaviour 33: frames left (+0x1334), the hand being thrown from (+0x1360) and the attack row (+0x131e). */
  private throwTimer = 0;
  private throwHand = 0;
  private throwRow = 0;

  /** Items in hand: joints 5 / 8 holding an item model (the hand model ranges per skeleton, FUN_00448310). */
  private handItems(): [boolean, boolean] {
    const H = HANDS[this.skeleton];
    if (!H) return [false, false];
    const m5 = this.rig.model(5), m8 = this.rig.model(8);
    return [m5 > H.j5[0] && m5 < H.j5[1], m8 > H.j8[0] && m8 < H.j8[1]];
  }

  /** FUN_00448110: which hand throws — both full: by a random bit; sets the attack row (hand 5 → row 0, else 1). */
  private chooseHand(w: World): number {
    const [h5, h8] = this.handItems();
    const even = (w.rand() & 1) === 0;
    const hand = even ? (h5 ? 5 : h8 ? 8 : 0) : h8 ? 8 : h5 ? 5 : 0;
    this.throwRow = hand === 5 ? 0 : 1;
    return hand;
  }

  /** FUN_00449980: let go of the item in `hand` — the hand shows empty, the item flies as its own object. */
  private throwFromHand(w: World, hand: number) {
    const H = HANDS[this.skeleton];
    if (!H) return;
    const cur = this.rig.model(hand);
    const model = hand === 5 ? cur - H.item5 : cur - H.item8;
    this.rig.modelOverride.set(hand, hand === 5 ? H.empty5 : H.empty8);
    const j = this.rig.joints[hand]?.matrix;
    const p = j ? transformPoint(j, [0, 0, 0]) : this.place.pos;
    w.addObject?.(new ThrownItem(w, { pos: [p[0]!, p[1]!, p[2]!], model, player: this.victim, strong: this.kind === 7 }));
  }

  /** FUN_004444e0: leave the fight at once (counts, attack slot) and end. */
  private removeSelf(w: World) {
    w.attackers--; // FUN_00445660
    w.enemies--; // FUN_00445680
    this.releaseAttack(w); // FUN_00445620
    this.dead = true;
  }

  /**
   * Behaviour 33 (FUN_00448310): the thrower (kind 7). Idle for record +4 (two items) / +8 (one) frames; then the
   * attack timer is cleared (FUN_004b1410(0)) and it asks for the attack slot; the throw motion (attack row by hand,
   * blend 4); at the row's frame the item is launched (FUN_00449980). Items left → again; none → idle record +0xC
   * frames, then (record next 0) back off — flag 0x20000000, distance = record +0x10 (float) — with behaviour 15,
   * which ends by leaving the fight. Other kinds throw once and approach (1). No items at the start → it leaves.
   */
  private throwItems(w: World) {
    const r = this.rig, kind7 = this.kind === 7;
    const idle = w.motionSet(this.skeleton, this.kind)?.[0];
    const holdIdle = () => {
      if (idle !== undefined && r.motion !== idle) r.blendTo(idle, w.rand() % w.motions.frames(idle), 5);
    };
    const row = () => w.attackTable(this.skeleton, this.kind)?.rows[this.throwRow];
    if (this.state === 0) {
      if (kind7) {
        if (!(this.flags & 0x1000000)) this.flags2 = (this.flags2 | (this.flags & 0x20000 ? 0x100001 : 1)) >>> 0;
        const n = this.handItems().filter(Boolean).length;
        if (n === 0) return this.removeSelf(w);
        this.throwTimer = this.i32(n === 2 ? 4 : 8);
      }
      this.state = 1;
    }
    if (this.state === 1) {
      if (kind7) {
        holdIdle();
        if (--this.throwTimer > 0) return;
      }
      this.state = 2;
    }
    if (this.state === 2) {
      if (kind7) {
        w.attackTimer = 0; // FUN_004b1410(0)
        if (!this.requestAttack(w)) return holdIdle();
      }
      this.flags = (this.flags | 0x10000000) >>> 0;
      this.throwHand = this.chooseHand(w);
      const a = row();
      if (a) r.blendTo(a.attack, 0, 4);
      w.rand(); // attack voice (FUN_00437ab0 case 3), not played
      this.state = 3;
    }
    if (this.state === 3) {
      const a = row();
      if (a && r.frame !== a.hitFrame) return;
      if (this.throwHand) this.throwFromHand(w, this.throwHand);
      this.state = 4;
    }
    if (this.state === 4) {
      if (r.frame < w.motions.frames(r.motion) - 1) return;
      this.flags = (this.flags & ~0x10000000) >>> 0;
      this.flags2 = (this.flags2 & ~0x20000) >>> 0;
      if (!kind7) {
        this.behaviour = 1;
        this.state = 0;
        return;
      }
      if (this.handItems().some(Boolean)) {
        this.state = 0;
        return;
      }
      this.throwTimer = this.i32(0xc);
      this.state = 5;
    }
    if (this.state === 5) {
      holdIdle();
      if (--this.throwTimer > 0) return;
      this.flags = (this.flags & ~0x1000000) >>> 0;
      if ((((this.tail?.[3] ?? 0) << 24) >> 24) === 0) {
        this.flags = (this.flags | 0x20000000) >>> 0; // back off …
        this.walkDistance = this.f(0x10); // … this far (raw float, +0x1374)
        this.behaviour = 15;
        this.state = 1;
      } else {
        this.behaviour = 0x1a; // leap with record +0x10.. (not used by Stage 1's throwers)
        this.state = 1;
      }
    }
  }

  /** Behaviour 5 (FUN_004446c0): wait (idle motion by flag +0x1370 bit 21), facing the player, until the queue moves. */
  private waitTurn(w: World) {
    if (this.state === 0) this.state = 1;
    else if (this.state !== 1) return;
    const m = w.motionSet(this.skeleton, this.kind)?.[(this.flags2 >>> 21) & 1];
    if (m !== undefined && this.rig.motion !== m) this.rig.blendTo(m, w.rand() % 5, 10);
    const target = heading(this.place.pos[0] - w.eye[0], this.place.pos[2] - w.eye[2]);
    this.place.angles[1] = turnTowards(this.place.angles[1], target, 0x40); // FUN_00437250
    if (this.queuePlace < this.allowance) {
      this.behaviour = 1;
      this.state = 0;
    }
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
    // too far back in the queue for this band → wait (5); the idle variant from @004f1334[(rand >> 4) % 10]
    if (this.allowance <= this.queuePlace) {
      const variant = [1, 1, 1, 1, 1, 1, 1, 0, 0, 0][(w.rand() >> 4) % 10]!;
      this.behaviour = 5;
      this.state = 0;
      this.flags2 = (this.flags2 | (variant << 21)) >>> 0;
    }
    // (band 3–4, kind 8: FUN_00447ff0 may switch to 0x21 — not used by these zombies)
  }

  /** Behaviour 2 (FUN_00444770): stand facing the player; take the attack slot → 3; too close → 4. */
  private stand(w: World) {
    const near = (w.bands[this.bandRow] ?? [25])[0]!;
    if (this.skeleton !== 0 && !(this.flags2 & 0x40400) && this.playerDistance(w) < near - 1) {
      this.behaviour = 4;
      this.state = 0;
      return;
    }
    // Allowed to ask: no +0x400 flag, within the queue allowance, fewer than 3 ready ahead (cool-down +0x1340 not ported)
    if (!(this.flags2 & 0x400) && this.queuePlace < this.allowance && this.queueReady < 3 && this.requestAttack(w)) {
      this.behaviour = this.kind === 4 ? 0x34 : 3;
      this.state = 0;
      return;
    }
    const set = w.motionSet(this.skeleton, this.kind);
    if (set && this.rig.motion !== set[0]) this.rig.blendTo(set[0]!, w.rand() % 5, 10); // + voice 0x1917a9
    const target = heading(this.place.pos[0] - w.eye[0], this.place.pos[2] - w.eye[2]);
    this.place.angles[1] = turnTowards(this.place.angles[1], target, 0x40); // FUN_00437250
  }

  /** FUN_00444e90, one player: take the player's attack slot if it is free. */
  private requestAttack(w: World): boolean {
    this.victim = -1;
    if ((w.attackTimer ?? 0) !== 0) return false; // FUN_004b14c0: the attack timer has not run out
    if (w.attackSlots[0]) return false;
    this.victim = 0; // FUN_00437180: the player is in the fight
    w.attackSlots[0] = 1;
    return true;
  }

  /** FUN_00445620: give the attack slot back. */
  private releaseAttack(w: World) {
    if (this.victim !== -1) {
      w.attackSlots[this.victim] = 0;
      this.victim = -1;
    }
  }

  /** FUN_00445000, one player: face the player at once; the attack point is the player. */
  private aim(w: World) {
    const e = w.eye;
    this.place.angles[1] = heading(this.place.pos[0] - e[0], this.place.pos[2] - e[2]);
    this.attackPoint = [e[0], e[1], e[2]];
  }

  /** Ground distance to the attack point. */
  private attackDistance() {
    const dz = this.place.pos[2] - this.attackPoint[2], dx = this.place.pos[0] - this.attackPoint[0];
    return f32(Math.sqrt(dz * dz + dx * dx));
  }

  /** Behaviour 3 (FUN_00444ac0): walk in, swing, hit on the row's frame, then back off (4). */
  private attack(w: World) {
    const table = w.attackTable(this.skeleton, this.kind);
    const r = this.rig;
    if (this.state === 0) {
      this.flags = ((this.flags & ~0x100) | 0x10000000) >>> 0;
      const n = w.rand();
      this.attackRow = table?.picks[((n >> 4) % 10) + (this.damage & 7) * 10] ?? 0;
      this.state = 1;
    }
    const row = table?.rows[this.attackRow];
    if (this.state === 1) {
      this.aim(w);
      if (row && this.attackDistance() > row.distance) {
        if (r.motion !== row.approach) r.blendTo(row.approach, 0, 10);
        return;
      }
      if (row) r.blendTo(row.attack, 0, 5);
      this.flags2 = ((this.flags2 & ~0x10000) | 0x80000) >>> 0;
      w.rand(); // attack voice (FUN_00437ab0 case 3), not played
      if (!(this.flags2 & 0x40000)) {
        this.spot = [...this.place.pos];
        this.flags2 |= 0x40000;
      }
      this.state = 2;
    }
    if (this.state !== 2) return;
    this.aim(w);
    if (row && r.frame === row.hitFrame && (this.victim === 0 || this.victim === 1) && ((this.damage & 7) & row.arms) !== row.arms)
      w.hitPlayer(this.victim, this.flags & 0x2000000 ? 0 : 1, row.damage); // FUN_00445590
    if (r.frame >= w.motions.frames(r.motion) - 1) {
      this.behaviour = 4;
      this.state = 0;
    }
  }

  /** Behaviour 4 (FUN_00444ce0): back off from the attack point, then free the slot and stand (2). */
  private backOff(w: World) {
    const d = this.attackDistance();
    const near = (w.bands[this.bandRow] ?? [25])[0]!;
    const set = w.motionSet(this.skeleton, this.kind);
    if (this.state === 0) {
      this.backTimer = 0;
      this.flags = ((this.flags & ~0x10000000) | 0x20000000) >>> 0;
      this.flags2 &= ~0x400000;
      this.state = 1;
    } else if (this.state !== 1) return;
    const start = w.rand();
    if (set) this.setMotion(set[4]!, start % 5, 10);
    // FUN_00437360 towards the spot it came from with a negative step: it keeps its back to it
    const target = heading(this.place.pos[0] - this.spot[0], this.place.pos[2] - this.spot[2]);
    this.place.angles[1] = turnTowards(this.place.angles[1], target, this.flags2 & 0x400000 ? 0x40 : -0x40);
    this.backTimer++;
    const far = this.backTimer > 0xf0 || near < d || (this.kind === 4 && near * Math.fround(0.7) < d);
    const r = this.rig;
    if (far && (r.motion !== 0x11d || r.frame >= w.motions.frames(0x11d) - 1)) {
      this.flags = (this.flags & ~0x20000000) >>> 0;
      this.releaseAttack(w);
      this.behaviour = 2;
      this.state = 0;
    }
  }

  private get parentDead(): boolean {
    const p = this.parent as { flags?: number } | undefined;
    return !!p && ((p.flags ?? 0) & 0x4000000) !== 0;
  }

  /** FUN_0044c1c0: the step list — +8 when the current behaviour is the record's next one, else +4. */
  private listFor(): StepEntry[] {
    const next = ((this.tail?.[3] ?? 0) << 24) >> 24;
    return (this.behaviour === next ? this.steps?.[1] : this.steps?.[0]) ?? [];
  }

  /** FUN_0044c1e0: flags by the step's kill value. */
  private killFlags(kill: number) {
    if (kill === -3) this.flags = (this.flags | 0x100) >>> 0;
    else if (kill === -2) this.flags = ((this.flags & ~0x2000) | 0x400) >>> 0;
    else this.flags = (this.flags | 0x2400) >>> 0;
  }

  /**
   * FUN_0044c080: the next behaviour (the record's next; back to 1 if that was it), with its start state:
   * 34 → 1 unless the civilian is already dead (then on again); 35 / 36 → 1 with the step list; 40 → 1, or 1 (the
   * behaviour) at once when the point is already behind; 41 → 1. Flags 0x2000 / 0x400 / 0x100 cleared unless 34.
   * Behaviour 1 with record +0xC ≠ −1 becomes 42 in the exe (not ported; Stage 1 has −1).
   */
  private nextBehaviour() {
    const next = ((this.tail?.[3] ?? 0) << 24) >> 24;
    this.behaviour = this.behaviour === next ? 1 : next;
    this.state = 0;
    if (this.behaviour === 0x22) {
      if (!this.civilianGone()) this.state = 1;
    } else if (this.behaviour === 0x23 || this.behaviour === 0x24) {
      this.stepList = this.listFor();
      this.stepIdx = 0;
      this.state = 1;
    } else if (this.behaviour === 0x28) {
      const L = this.rawList();
      if (L && this.pointBehind([L.getFloat32(0, true), L.getFloat32(4, true), L.getFloat32(8, true)])) this.behaviour = 1;
      else this.state = 1;
    } else if (this.behaviour === 0x29) this.state = 1;
    // (behaviour 1 with record +0xC ≠ −1 → 42 in the exe: not ported; Stage 1 records have −1)
    if (this.behaviour !== 0x22) this.flags = (this.flags & 0xffffdaff) >>> 0;
  }

  /** FUN_0044b3c0: `p` is behind the object (local z > 0). */
  private pointBehind(p: Vec3): boolean {
    const d: Vec3 = [p[0] - this.place.pos[0], p[1] - this.place.pos[1], p[2] - this.place.pos[2]];
    return transformDir(invert(rotationMatrix(this.place.angles)), d)[2]! > 0;
  }

  /** Load step `stepIdx` (states 0 / 1 of FUN_0044a310). */
  private loadStep(w: World, first: boolean) {
    const s = this.stepList[this.stepIdx]!;
    this.killFlags(s.kill);
    if (first) this.rig.blendTo(s.motion, s.start, 0);
    else if (this.rig.motion !== s.motion) this.rig.blendTo(s.motion, s.start, 10);
    this.stepMotion = s.motion;
    this.stepRepeats = s.repeats;
    this.killFrame = s.kill;
    this.stepIdx++;
    if (s.kill < 0) this.flags = (this.flags & ~0x10000000) >>> 0;
    else {
      w.rand(); // attack voice (FUN_00437ab0 case 3)
      this.flags = (this.flags | 0x10000000) >>> 0;
    }
    this.state = 2;
  }

  /** FUN_0044c1c0 on the raw lists: +8 when the current behaviour is the record's next one, else +4. */
  private rawList(): DataView | undefined {
    const next = ((this.tail?.[3] ?? 0) << 24) >> 24;
    const b = this.behaviour === next ? this.lists?.[1] : this.lists?.[0];
    return b ? new DataView(b.buffer, b.byteOffset, b.byteLength) : undefined;
  }

  /** Steps from the raw list at `off` (behaviour 35 continues with them: +0x139c). */
  private rawSteps(off: number): StepEntry[] {
    const next = ((this.tail?.[3] ?? 0) << 24) >> 24;
    const b = this.behaviour === next ? this.lists?.[1] : this.lists?.[0];
    return b ? readSteps(b, off) : [];
  }

  /** FUN_0044c050: once the civilian is dead, the next behaviour (the exe then goes to 0x2d unless that is 0x28). */
  private civilianGone(): boolean {
    if (!this.parentDead) return false;
    this.nextBehaviour();
    return true;
  }

  /**
   * Behaviour 34 (0x22, FUN_0044a100): chase the civilian. List: f32 reach distance, u16 signal, u16 motion,
   * u16 start frame, then behaviour 35's steps. Steer at her (FUN_00437360, at most 0x1a0 a frame) with the
   * motion's root motion until within reach → 35 from its first step (and her segment bit 0x800 if signalled).
   */
  private chaseCivilian(w: World) {
    const r = this.rig;
    const civ = this.parent as (GameObject & { place?: { pos: Vec3 }; signal?(b: number): void }) | undefined;
    if (this.state === 0 || this.state === 1) {
      this.flags = (this.flags | 0x400) >>> 0;
      const L = this.rawList();
      if (!L) return this.nextBehaviour();
      this.reach = L.getFloat32(0, true);
      this.reachSignal = L.getUint16(4, true);
      const m = L.getUint16(6, true), start = L.getUint16(8, true);
      if (this.state === 0) r.blendTo(m, start, 0);
      else if (r.motion !== m) r.blendTo(m, start, 10);
      this.stepMotion = r.motion;
      this.stepList = this.rawSteps(10);
      this.state = 2;
    } else if (this.state === 2 && civ?.place) {
      const p = this.place.pos, c = civ.place.pos;
      if (Math.hypot(p[2] - c[2], p[0] - c[0]) <= this.reach) {
        if ((this.stepList[0]?.motion ?? 0) < 1) this.nextBehaviour();
        else {
          this.behaviour = 0x23;
          this.state = 1;
          this.stepIdx = 0;
          if (this.reachSignal) civ.signal?.(0x800);
        }
      } else this.place.angles[1] = turnTowards(this.place.angles[1], heading(p[0] - c[0], p[2] - c[2]), 0x1a0);
    }
    if (!(this.flags & 0x40000000) && r.motion !== this.stepMotion && this.stepMotion > 0) r.blendTo(this.stepMotion, 0, 10);
    // FUN_0044c050: civilian dead → next behaviour, then a pause first (45) unless that is 40
    if (this.civilianGone() && this.behaviour !== 0x28) this.pauseThenResume();
  }

  /**
   * Behaviour 40 (0x28, FUN_0044b460): walk to a point. List: f32 x, y, z, i16 motion, i16 start frame, then
   * behaviour 35's steps. Once the point is behind it (FUN_0044b3c0: local z > 0): no steps → the next behaviour;
   * else (civilian alive) → 35 from its first step. (The exe does not steer here: the record faces it there.)
   */
  private walkToPoint(w: World) {
    const r = this.rig;
    if (this.state === 0 || this.state === 1) {
      this.flags = (this.flags | 0x2400) >>> 0;
      const L = this.rawList();
      if (!L) return this.nextBehaviour();
      this.walkTo = [L.getFloat32(0, true), L.getFloat32(4, true), L.getFloat32(8, true)];
      const m = L.getInt16(12, true), start = L.getInt16(14, true);
      if (r.motion !== m) r.blendTo(m, start, this.state === 0 ? 0 : 10);
      this.stepMotion = m;
      this.stepList = this.rawSteps(16);
      this.state = 2;
    }
    if (this.pointBehind(this.walkTo)) {
      if ((this.stepList[0]?.motion ?? 0) < 1) this.nextBehaviour();
      else if (!this.civilianGone()) {
        this.behaviour = 0x23;
        this.state = 1;
        this.stepIdx = 0;
      }
    }
    if (!(this.flags & 0x40000000) && r.motion !== this.stepMotion && this.stepMotion > 0) r.blendTo(this.stepMotion, 0, 10);
  }

  /** Behaviour 35 (0x23, FUN_0044a310): the scripted attack on the civilian. */
  private attackCivilian(w: World) {
    const r = this.rig;
    if (this.state === 0) {
      this.stepList = this.listFor();
      this.stepIdx = 0;
      if (!this.stepList.length || this.stepList[0]!.motion < 1) return this.nextBehaviour();
      this.loadStep(w, true);
    } else if (this.state === 1) {
      if (!this.stepList[this.stepIdx] || this.stepList[this.stepIdx]!.motion < 1) return this.nextBehaviour();
      this.loadStep(w, false);
    } else if (this.state === 2) {
      const p = this.parent as { flags?: number } | undefined;
      if (p && r.frame === this.killFrame && !this.parentDead) p.flags = ((p.flags ?? 0) | 0x4000000) >>> 0; // + scream
      const m = r.motion;
      if ((m === 0x1d2 || m === 0x1ca || m === 0x1ce) && this.parentDead) return this.nextBehaviour();
      if (r.frame === w.motions.frames(m) - 1) {
        if (!this.parentDead) {
          if (--this.stepRepeats === 0) {
            if ((this.stepList[this.stepIdx]?.motion ?? 0) >= 1) this.state = 1;
            else this.nextBehaviour();
          }
        } else {
          // FUN_0044c050 was called above: the victim is dead → already the next behaviour; with a list ending in −1
          // a short pause (45) first, unless that next behaviour is 40
          this.nextBehaviour();
          if (this.behaviour !== 0x28 && (this.stepList[this.stepIdx]?.motion ?? -1) === -1) this.pauseThenResume();
        }
      }
    }
    // keep the step's motion running (FUN_0044a310's tail)
    if (this.behaviour === 0x23 && !(this.flags & 0x40000000) && r.motion !== this.stepMotion && this.stepMotion > 0) {
      if (this.stepRepeats < 2) r.blendTo(this.stepMotion, w.motions.frames(r.motion) - 1, 1);
      else {
        r.blendTo(this.stepMotion, 0, 10);
        this.stepRepeats--;
      }
    }
  }

  /** Behaviour 13 (FUN_00446080): frozen and box-less until camera time i32(+4), then the get-up motion. */
  private riseUp(w: World) {
    const r = this.rig;
    if (this.state === 0) {
      this.flags = (this.flags | 0x4100) >>> 0;
      r.play(this.skeleton >= 0xf && this.skeleton <= 0x11 ? 0xba : 0x411);
      this.state = 1;
    }
    if (this.state === 1) {
      if (w.camTime < (this.i32(4) >>> 0)) return;
      this.state = 2;
      this.flags = (this.flags & ~0x4100) >>> 0;
    }
    // (motion 0xba: dust at frames 0x15 / 0x1b — FUN_00412010, not ported)
    if (r.frame >= w.motions.frames(r.motion) - 1) {
      if (((this.tail?.[3] ?? 0) << 24) >> 24 === 0x0f) {
        this.walkDistance = f32(this.i32(8) >>> 0);
        this.behaviour = 0x0f;
        this.state = 1;
      } else {
        this.behaviour = 1;
        this.state = 0;
      }
    }
  }

  /** Behaviour 14 (FUN_00446290): walk for i32(+4) frames, remember the spot, then approach (1). */
  private walkFrames(w: World) {
    const set = w.motionSet(this.skeleton, this.kind);
    if (this.state === 0) {
      this.sinkTimer = this.i32(4); // obj +0x1334 (shared with behaviour 7's timer)
      this.state = 1;
    }
    const m = set ? set[2 + ((this.flags >>> 27) & 1)]! : this.rig.motion;
    const start = w.rand();
    this.setMotion(m, start % w.motions.frames(m), 5);
    if (--this.sinkTimer < 1) {
      this.spot = [...this.place.pos];
      this.behaviour = 1;
      this.state = 0;
    }
  }

  /** Behaviour 15 (FUN_00446350): walk until `walkDistance` from where it started, then approach (1). */
  private walkDistanceThenApproach(w: World) {
    if (this.state === 0) {
      this.walkDistance = f32(this.i32(4) >>> 0);
      this.state = 1;
    }
    if (this.state === 1) {
      this.state = 2;
      this.walkStart = [...this.place.pos];
    }
    const set = w.motionSet(this.skeleton, this.kind);
    const m = set ? (this.flags & 0x20000000 ? set[4]! : set[2 + ((this.flags >>> 27) & 1)]!) : this.rig.motion;
    const start = w.rand();
    this.setMotion(m, start % w.motions.frames(m), 5);
    const d = f32(Math.hypot(this.walkStart[2] - this.place.pos[2], this.walkStart[0] - this.place.pos[0]));
    if (this.walkDistance <= d) {
      this.spot = [...this.place.pos];
      if (this.flags & 0x20000000) return this.removeSelf(w); // backed off: leaves the fight (FUN_004444e0)
      this.behaviour = 1;
      this.state = 0;
    }
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

  /** FUN_00411ae0: model 0x3a + frame at the hit part, in view space, sized by depth; 25 frames. */
  private drawSparks(w: World) {
    if (!this.sparks.length) return;
    const inv = invert(w.view);
    for (const s of this.sparks) {
      const j = this.rig.joints[s.part]?.matrix;
      if (!j) continue;
      const [x, y, z] = transformPoint(w.view, [j[12]!, j[13]!, j[14]!]); // part radius (+0x288) taken as 0
      const k = f32((z < -20 ? 1 : f32(-z * f32(0.0375)) + 0.25) * 0.3 * 0.75); // ×0.3: DAT_005fa150 set (assumed)
      const local = scaleLocal(translateLocal(identity(), x, y, z), k, k, k);
      this.items.push({ model: 0x3a + s.frame, world: mul(local, inv) });
      s.frame++;
    }
    this.sparks = this.sparks.filter((s) => s.frame <= 0x18);
  }

  draw(): DrawItem[] {
    return this.items;
  }
}
