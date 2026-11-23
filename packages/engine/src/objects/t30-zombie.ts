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
 * then 15 or 1) and 15 `FUN_00446350` (walk a set distance, then 1).
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
import { identity, invert, mul, scaleLocal, transformDir, transformPoint, translateLocal, type SpawnRecord } from '@ttotd/formats';
import { rotationMatrix, toAngle } from '../core/angles.ts';
import type { DrawItem, GameObject, World } from '../core/object.ts';
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

  /** Behaviour 6 (FUN_00443d70): death motion, then behaviour 7. */
  private die(w: World) {
    const r = this.rig;
    if (this.state === 0) {
      // FUN_00445320: by the angle between the player's view and the zombie's facing
      const u = (w.camYaw - this.place.angles[1]) & 0xffff;
      let m: number | undefined;
      if (Zombie.within(u, 0x4000, 0x2000)) m = 0x419;
      if (Zombie.within(u, 0xc000, 0x2000)) m = 0x418;
      if (Zombie.within(u, 0, 0x2000)) m = [0x412, 0x413, 0x415, 0x417][w.rand() & 3];
      if (Zombie.within(u, 0x8000, 0x2000)) m = [0x412, 0x416, 0x414, 0x415, 0x416, 0x417][w.rand() % 6];
      if (m !== undefined) r.blendTo(m, 0, 5);
      this.flags &= ~0x4000;
      this.state = 1;
    }
    if (this.state === 1) {
      this.flags = (this.flags | 0x22000) >>> 0;
      this.flags2 = ((this.flags2 & ~0x200) | 0x60000000) >>> 0;
      // FUN_004456a0: attack slot freed; leaves the active table (flag 0x10000) unless it is the last enemy and
      // flagged 0x800000 (then the fight waits for its body); DAT_00a3ba4a − 1 (FUN_00445660)
      this.releaseAttack(w);
      if (!(this.flags & 0x800000) || w.attackers !== 1) this.flags = (this.flags | 0x10000) >>> 0;
      w.attackers--;
      this.state = 2;
      this.flags2 &= ~0x10000;
    }
    if (r.frame >= w.motions.frames(r.motion) - 1 || this.flags & 0x1000000) {
      // FUN_00445840
      this.flags2 &= ~0x60000000;
      this.flags = ((this.flags & ~0x20001) | 0xc000) >>> 0;
      w.enemies--; // FUN_00445680
      r.counter--;
      this.behaviour = 7;
      this.state = 0;
    }
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
    if (this.behaviour === 18) this.waitFor(w);
    else if (this.behaviour === 26) this.leap(w);
    else if (this.behaviour === 1) this.approach(w);
    else if (this.behaviour === 2) this.stand(w);
    else if (this.behaviour === 3) this.attack(w);
    else if (this.behaviour === 4) this.backOff(w);
    else if (this.behaviour === 13) this.riseUp(w);
    else if (this.behaviour === 15) this.walkDistanceThenApproach(w);
    else if (this.behaviour === 6) this.die(w);
    else if (this.behaviour === 7) this.sink();
    for (let k = 0; k < 3; k++) this.place.pos[k] = f32(this.place.pos[k]! + this.vel[k]!);
    this.rig.pose(this.place);
    this.items = this.rig.draw();
    // FUN_00475420 at joint 1: view- and world-space position; FUN_00436f00(4): world y + 4
    const j = this.rig.joints[1]?.matrix;
    if (j) {
      const world: Vec3 = [j[12]!, j[13]!, j[14]!];
      this.anchor = transformPoint(w.view, world) as Vec3;
      this.worldAnchor = [world[0], f32(world[1] + 4), world[2]];
    }
    this.drawSparks(w);
    if (!(this.flags & 0x10000) && !this.dead) w.active++; // FUN_00436f00 → FUN_004205d0
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

  /** Behaviour 2 (FUN_00444770): stand facing the player; take the attack slot → 3; too close → 4. */
  private stand(w: World) {
    const near = (w.bands[this.bandRow] ?? [25])[0]!;
    if (this.skeleton !== 0 && !(this.flags2 & 0x40400) && this.playerDistance(w) < near - 1) {
      this.behaviour = 4;
      this.state = 0;
      return;
    }
    // Allowed to ask (no +0x400 flag; +0x135c = DAT_00a3b7f0.. ≥ 2 > +0x1321 = −1; +0x1322 < 3; no cool-down).
    if (!(this.flags2 & 0x400) && this.requestAttack(w)) {
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
      this.behaviour = 1; // (flag 0x20000000: FUN_004444e0, not ported)
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
