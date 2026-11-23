/**
 * Chapter title card: object type 0x60 (`FUN_00422c00`), spawned at the end of the opening scene.
 * It sets DAT_00a14048 bit 0x20 (objects such as the opening car hide) for 0xB4 frames, or until Enter once
 * fewer than 0xA0 frames are left; then it clears the bit, sets TITLE_CARD_FLAG and ends.
 * Each frame it animates the title (`FUN_004241b0`): 2D sprites 0x210–0x217 for Stage 1 (= scr_chapter_st1
 * textures 0–7), drawn centred on (x, y) in 640×480 (`FUN_004ac0e0`, anchor flags 10), size = texture × scale.
 * Not ported: the extra sprite 0x498 shown when DAT_00a3bb40 (high word) = 1; stages 2–6 (other sprites/points).
 */
import type { DrawItem, GameObject, World } from '../core/object.ts';

/** Flag the card sets when it ends (DAT_00a397b8 = DAT_00a396c0[248]); event op 0x45 248 waits for it. */
export const TITLE_CARD_FLAG = 248;

/** One title sprite this frame: texture k of scr_chapter_stN, centred at (x, y) in 640×480. */
export interface TitleLayer {
  k: number;
  x: number;
  y: number;
  sx: number;
  sy: number;
  alpha: number;
}

const f = Math.fround;
/** The constants FUN_004241b0 uses (f32 @004dec44, @004dee4c, …). */
const C30 = f(1 / 30), C233 = f(0.23333333), C067 = f(0.06666667), C333 = f(1 / 3), C025 = f(0.025), C01 = f(0.1);
const C022 = f(0.02222222), C012 = f(0.12), C16 = f(1.6), C198 = f(0.198), C32 = f(3.2), C07 = f(0.7);

export class TitleCard implements GameObject {
  /** Frames left (obj +0x11c); undefined before the first update. */
  count?: number;
  done = false;
  dead?: boolean;
  /** What the card draws this frame. */
  layers: TitleLayer[] = [];
  // FUN_00424110 set-up: @005fa4b0… records
  private t = 0; // @005fa4c0
  private st = 0; // @005fa4cc
  private s1 = [f(1.5), f(1.5)]; // @005fa4b8/bc
  private s2 = [f(4.5), f(4.5)]; // @005fa4d8/dc
  private a2 = 1; // @005fa4e8
  private s3 = [2, 2]; // @005fa4f8/fc
  private s4 = [6, 6]; // @005fa518/1c
  private a4 = 1; // @005fa528
  private a5 = 0; // @005fa548
  private a6 = 0; // @005fa568
  private a = 1; // @005fa4c8

  /** As a game object: sets DAT_00a14048 bit 0x20 while up and the flag when over. */
  update(w: Pick<World, 'enter' | 'titleUp' | 'flags'>) {
    w.titleUp = this.tick(w.enter);
    if (this.done) {
      w.flags[TITLE_CARD_FLAG] = 1;
      this.dead = true;
    }
  }

  draw(): DrawItem[] {
    return [];
  }

  /** One frame; `enter` = Enter pressed this frame (input bits 0x80008). Returns whether the card is up. */
  tick(enter: boolean): boolean {
    if (this.done) {
      this.layers = [];
      return false;
    }
    this.count ??= 0xb4;
    this.layers = this.animate(190, 80, 400, 350);
    if (this.count < 0xa0 && enter) this.count = 1;
    this.count--;
    if (this.count < 1) this.done = true;
    return !this.done;
  }

  /** FUN_004241b0(p1, p2, p3, p4): one frame of the title animation (Stage 1: 190, 80, 400, 350). */
  private animate(p1: number, p2: number, p3: number, p4: number): TitleLayer[] {
    const L: TitleLayer[] = [];
    const d = (k: number, x: number, y: number, sx: number, sy: number, alpha: number) => L.push({ k, x, y, sx, sy, alpha });
    const t = this.t;
    switch (this.st) {
      case 0:
        if (t === 0xe) this.st = 1;
        if (t <= 0xe) {
          this.s1 = this.s1.map((v) => f(v - C30));
          this.s2 = this.s2.map((v) => f(v - C233));
          this.s3 = this.s3.map((v) => f(v - C067));
          this.s4 = this.s4.map((v) => f(v - C333));
        }
        d(0, p1, p2, this.s1[0]!, this.s1[1]!, 1);
        d(0, p1 + 10, p2 + 10, this.s2[0]!, this.s2[1]!, 1);
        d(1, p3, p4, this.s3[0]!, this.s3[1]!, 1);
        d(1, p3 + 10, p4 + 10, this.s4[0]!, this.s4[1]!, 1);
        this.t++;
        return L;
      case 1: {
        if (t >= 0xf && t <= 0x2d) {
          this.s2 = this.s2.map((v) => f(v + C30));
          this.a2 = t === 0x2d ? 0 : f(this.a2 - C30);
          this.s4 = this.s4.map((v) => f(v + C30));
          this.a4 = t === 0x2d ? 0 : f(this.a4 - C30);
        }
        if (t > 0x18 && t < 0x2e) {
          this.a5 = f(this.a5 + C025);
          this.a6 = f(this.a6 + C025);
        }
        d(0, p1, p2, this.s1[0]!, this.s1[1]!, 1);
        d(0, p1 + 10, p2 + 10, this.s2[0]!, this.s2[1]!, this.a2);
        d(1, p3, p4, this.s3[0]!, this.s3[1]!, 1);
        d(1, p3 + 10, p4 + 10, this.s4[0]!, this.s4[1]!, this.a4);
        d(7, p1 + 40, p2 + 40, 1, 1, this.a5);
        d(4, p3 + 50, p4 - 30, 1, 1, this.a6);
        if (t === 0x2d) {
          this.st = 2;
          this.t = 0x2e;
          return L;
        }
        break;
      }
      case 2: {
        if (t < 0x33) {
          d(5, p1, p2 + 20, this.s1[0]!, this.s1[1]!, 1);
          d(2, p3, p4 - 25, this.s3[0]!, this.s3[1]!, 1);
          d(7, p1 + 40, p2 + 40, 1, 1, this.a5);
          d(4, p3 + 50, p2 - 30, 1, 1, this.a6); // p2, as in the exe
        }
        if (t > 0x32 && t < 0x38) {
          d(5, p1, p2 + 20, this.s1[0]!, this.s1[1]!, 1);
          d(2, p3, 325, this.s3[0]!, this.s3[1]!, 1);
          d(6, p1 + 30, p2 + 40, 1, 1, 1);
          d(3, p3 + 20, p4 - 5, 1, 1, 1);
        }
        if (t > 0x37 && t < 0x3d) {
          d(0, p1 + 20, p2 + 30, 1, 1, 1);
          d(1, p3 + 10, p4 - 15, 1, 1, 1);
          d(6, p1 + 30, p2 + 40, 1, 1, 1);
          d(3, p3 + 20, p4 - 5, 1, 1, 1);
        }
        if (t > 0x3c && t < 0x42) {
          d(0, p1 + 20, p2 + 30, 1, 1, 1);
          d(1, p3 + 10, p4 - 15, 1, 1, 1);
          d(6, p1, p2 + 30, 1, 1, 0.5);
          d(3, p3, p4 - 15, 1, 1, 0.5);
        }
        if (t > 0x41 && t < 0x47) {
          d(5, p1, p2 + 30, 1, 1, 1);
          d(2, p3, p4 - 15, 1, 1, 1);
          d(6, p1, p2 + 30, 1, 1, 0.5);
          d(3, p3, p4 - 15, 1, 1, 0.5);
        }
        if (t > 0x46 && t < 0x4c) {
          d(5, p1, p2 + 30, 1, 1, 1);
          d(2, p3, p4 - 15, 1, 1, 1);
          d(7, p1 + 3, p2 + 33, C07, C07, 1);
          d(4, p3 + 3, p4 - 12, C07, C07, 1);
        }
        if (t === 0x4c) this.a = 1;
        if (t >= 0x4c && t <= 0x55) {
          d(0, p1 + 20, p2 + 40, 1, 1, this.a);
          d(1, p3 + 10, p4 - 5, 1, 1, this.a);
          d(7, p1 + 3, p2 + 33, C07, C07, this.a);
          d(4, p3 + 3, p4 - 12, C07, C07, this.a);
          this.a = f(this.a - C01);
        }
        if (t === 0x55) {
          this.st = 3;
          this.t = 0x56;
          return L;
        }
        break;
      }
      case 3:
        if (t === 0x73) {
          this.st = 4;
          this.s1 = [1, 1];
          this.a = 1;
          this.t = 0x74;
          return L;
        }
        break;
      case 4: {
        if (t > 0x73 && t < 0xa1) {
          this.s1 = this.s1.map((v) => f(v + C067));
          this.a = f(this.a - C022);
          d(6, p1 + 20, p2 + 40, this.s1[0]!, this.s1[1]!, this.a);
          d(3, p3 + 10, p4 - 5, this.s1[0]!, this.s1[1]!, this.a);
          d(7, p1 + 10, p2 + 30, 1, 1, 1 - this.a);
          d(4, p3, p4 - 20, 1, 1, 1 - this.a);
          if (t > 0x95) {
            d(0, p1 + 10, p2 + 30, 1, 1, 1);
            d(1, p3, p4 - 20, 1, 1, 1);
          }
        }
        if (t === 0xa1) this.s1 = [1, 1];
        if (t >= 0xa1 && t < 0xa6) {
          d(7, p1 + 10, p2 + 30, this.s1[0]!, this.s1[1]!, 1);
          d(4, p3, p4 - 20, this.s1[0]!, this.s1[1]!, 1);
          d(0, p1 + 10, p2 + 30, 1, 1, 1);
          d(1, p3, p4 - 20, 1, 1, 1);
          this.s1 = [f(this.s1[0]! - C012), f(this.s1[1]! + C16)];
        }
        if (t === 0xa6) this.s1 = [1, 1];
        if (t >= 0xa6 && t <= 0xaa) {
          d(0, p1 + 10, p2 + 30, this.s1[0]!, this.s1[1]!, 1);
          d(1, p3, p4 - 20, this.s1[0]!, this.s1[1]!, 1);
          this.s1 = [f(this.s1[0]! - C198), f(this.s1[1]! + C32)];
        }
        break;
      }
    }
    this.t++;
    return L;
  }
}
