/**
 * The daemon of the Stage 1 opening: object type 0x22 (`FUN_004b4330`), kind 0. Body = skeleton 0x45 with
 * the record's start motion; wings = a sub-object (obj +0x13b4), skeleton 0x46, carried by the body's
 * joint 1. Behaviours @005eb3b4: 0 `FUN_004b4510` (rooftop, fly-over), 1 `FUN_004b4680` (car scene).
 * Drawn by `FUN_004b6d70` with the per-node hook `FUN_004b6f80` (talking mouth, eyes).
 * Not ported: voices (FUN_00495660), kinds 1–3.
 */
import { translateLocal, rotateXLocal, rotateZLocal, type SpawnRecord } from '@ttotd/formats';
import { anglesFromMatrix } from '../core/angles.ts';
import type { DrawItem, GameObject, World } from '../core/object.ts';
import { CharacterRig, type Placement } from '../core/rig.ts';
import { TITLE_CARD_FLAG } from './t60-titlecard.ts';

/** Wing motion by wing state (@0058f970). */
const WING_MOTIONS = [18, 16, 15, 19, 20];
/** Mouth frames while talking (@0058fc78, @0058fc84), added to model 0x2d6. */
const TALK_1 = [4, 5, 6, 7, 6, 5, 4, 3, 2, 3];
const TALK_2 = [9, 10, 11, 12, 13, 14];
const F = (bits: number) => new Float32Array(new Uint32Array([bits]).buffer)[0]!;

const i16 = (b: Uint8Array | undefined, o: number) => (b && o + 2 <= b.length ? new DataView(b.buffer, b.byteOffset + o, 2).getInt16(0, true) : 0);

export class Daemon implements GameObject {
  readonly body: CharacterRig;
  readonly wings: CharacterRig;
  readonly place: Placement = { pos: [0, 0, 0], angles: [0, 0, 0] };
  private readonly wingPlace: Placement = { pos: [0, 0, 0], angles: [0, 0, 0] };
  behaviour = 0; // +0x1314
  state = 0; // +0x1316
  /** Wings flap (+0x1328, set at camera time 70). */
  awake = false;
  /** Talking: 0 no, 1/2 mouth tables (+0x133c); counter +0x1340. */
  talking = 0;
  private talkCount = 0;
  /** Wing state (+0x1354) and the one shown (+0x1358). */
  wingState = 1;
  private wingShown = 1;
  /** Disappears once camera path `endPath` reaches `endTime` (record +0x2a, +0x2c). */
  private readonly endPath: number;
  private readonly endTime: number;
  private items: DrawItem[] = [];
  dead?: boolean;

  constructor(rec: SpawnRecord, w: World) {
    const tail = rec.tail;
    const skel = 0x45;
    this.body = new CharacterRig(w.skeletons[skel]!, skel, i16(tail, 2), w.motions, w.skins[skel]);
    this.body.counter = i16(tail, 4);
    this.body.modelOverride.set(2, 0x2da); // obj +0x330: node 2 starts with the closed mouth
    this.wings = new CharacterRig(w.skeletons[0x46]!, 0x46, 0x10, w.motions, w.skins[0x46]);
    this.endPath = i16(tail, 6);
    this.endTime = i16(tail, 8);
  }

  private follow(w: World, id: number) {
    const s = w.path(id, w.camTime);
    if (!s) return;
    this.place.pos = [...s.pos];
    this.place.angles = [...s.angles];
  }

  update(w: World) {
    this.items = [];
    if (this.behaviour === 0) this.rooftop(w);
    else this.carScene(w);
  }

  /** Behaviour 0 (FUN_004b4510). */
  private rooftop(w: World) {
    const t = w.camTime;
    let advance = false;
    switch (this.state) {
      case 0:
        this.place.pos = [-406, 152.5, F(0x430e6666)];
        this.place.angles = [0, 0x717f, 0];
        this.awake = false;
        this.wingState = 2;
        this.state = 1;
      // falls through
      case 1:
        if (t === 70) {
          this.body.blendTo(0x448, 0, 5);
          this.awake = true;
          advance = true;
        }
        break;
      case 2:
        this.place.pos[0] = -406;
        this.place.pos[2] = F(0x430e6666);
        if (this.body.frame === w.motions.frames(this.body.motion) - 1) {
          this.body.play(0x444);
          advance = true;
        }
        break;
      case 3:
        if (t !== 170) return; // not drawn while waiting
        advance = true;
        break;
      case 4:
        this.follow(w, 0x122);
        if (w.flags[TITLE_CARD_FLAG] === 1) {
          this.wingState = 1;
          this.behaviour = 1;
          this.state = 0;
          return;
        }
        break;
    }
    if (advance) this.state++;
    if (!w.titleUp) {
      this.drawBoth(w);
      this.body.counter++;
    }
  }

  /** Behaviour 1 (FUN_004b4680). */
  private carScene(w: World) {
    const t = w.camTime, b = this.body;
    if (w.camPath === this.endPath && this.endTime <= t) {
      this.dead = true;
      return;
    }
    if (w.camPath === 0x31) {
      this.follow(w, 0x123);
      if (t === 250) b.blendTo(1098, 0, 8);
      if (t === 280) {
        this.talking = 1;
        this.talkCount = 0;
        b.blendTo(1103, 0, 3);
      }
    } else if (w.camPath === 0x32) {
      this.follow(w, 0x124);
      if (t === 180) this.talking = 0;
      if (t === 240) b.blendTo(1099, 0, 3);
    } else return;
    if (b.motion === 1103 && b.frame === w.motions.frames(1103) - 1) b.blendTo(1098, 0, 3);
    if (b.motion === 1099 && b.frame === w.motions.frames(1099) - 1) b.blendTo(1098, 0, 3);
    this.drawBoth(w);
    b.counter++;
  }

  /** FUN_004b6d70: body, then the wings on the body's joint 1. */
  private drawBoth(w: World) {
    const b = this.body;
    b.pose(this.place);
    const items: DrawItem[] = [];
    for (let j = 1; j < b.joints.length; j++) items.push(...this.drawNode(j));
    items.push(...b.skinItems());
    const j1 = b.joints[1]?.matrix;
    if (j1) {
      this.wingPlace.pos = [j1[12]!, j1[13]!, j1[14]!];
      this.wingPlace.angles = anglesFromMatrix(j1);
      this.wings.pose(this.wingPlace);
      items.push(...this.wings.draw());
    }
    if (this.wingShown !== this.wingState) this.wings.play(WING_MOTIONS[this.wingState]!);
    this.wingShown = this.wingState;
    if (this.awake) this.wings.counter++;
    this.items = items;
  }

  /** FUN_004b6f80: per-node draw (talking mouth on node 2, eyes on model 0x2ec). */
  private drawNode(j: number): DrawItem[] {
    const b = this.body, p = b.joints[j];
    if (!p) return [];
    const base = b.model(j);
    let model = base;
    if (j === 2) {
      this.talkCount++;
      if (this.talking === 1) model = TALK_1[this.talkCount % 10]! + 0x2d6;
      else if (this.talking === 2) model = TALK_2[this.talkCount % 6]! + 0x2d6;
    }
    const out: DrawItem[] = model > 0 ? [{ model, world: p.matrix }] : [];
    if (base === 0x2ec) {
      const eye = (x: number, j2: number, id: number) => {
        let m = translateLocal(p.matrix, x, F(0x3fbeab36), 0);
        m = rotateZLocal(m, Math.trunc((b.cur[j2 * 3 + 2]! * 0x238e) / 0x671c));
        const v = b.cur[j2 * 3]! * 0x5555;
        out.push({ model: id, world: rotateXLocal(m, (v + ((v >> 31) & 0x7fff)) >> 15) });
      };
      eye(F(0xbf47381d), 3, 0x2e6);
      eye(F(0x3f47381d), 6, 0x2e5);
    }
    return out;
  }

  draw(): DrawItem[] {
    return this.items;
  }
}
