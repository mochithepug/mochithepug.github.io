/**
 * Word box: the task `FUN_004b2a30` that `spawn_record` adds to enemies with word flags (@005a2848). It takes a
 * word when it may first show, follows its owner's anchor (view-space point stored by the rig at joint 1,
 * owner +0x10c..+0x114) with smoothing, and is drawn by `FUN_004aec20` → `FUN_004b0c90`: a frame of nine
 * `tod_boxetc` models (FUN_004b01a0) coloured by danger (distance), the word in yellow and the line to type in
 * white (FUN_004b0890, letters FUN_004b2530). Everything is in game view space, drawn at one tenth of the
 * anchor (the screen position is unchanged, the box is in front of the scene).
 * Typing (one player, English rules of the matcher FUN_004013b0: one key per character, upper-cased; a space
 * may be skipped by typing the character after it): with no target, the first box whose next key matches takes
 * the key (FUN_004b3080) and becomes the target, then each key goes to the target (FUN_004b31f0 → FUN_004b32f0):
 * correct → a letter hit on the owner, the last letter → the word is done (owner hp 0) and the target is free;
 * wrong → a miss. Targeted boxes get the spinning red brackets (FUN_004b07f0 → FUN_004b0530).
 * Not ported yet: player 2, misses' effects (sound, flash, stats), flags 0x200 / 0x100 draws, the 0x800–0x2000
 * y offsets, the box's finishing animation (FUN_004b3b30).
 */
import { asciiToSjis, charMetrics, identity, letterModelId, readWordFlags, rotateYLocal, rotateZLocal, scaleLocal, translateLocal, type Mat4, type PeImage } from '@ttotd/formats';
import type { DrawItem, World } from '../core/object.ts';
import type { WordDeck } from '../core/words.ts';

type Vec3 = [number, number, number];
const f32 = Math.fround;
const K = f32(0.1); // _DAT_004de158

/** What a box needs from its owner. */
export interface WordOwner {
  /** View-space anchor (+0x10c..+0x114), set by the owner's draw; undefined before. */
  anchor?: Vec3;
  /** World-space anchor (+0x100..+0x108). */
  worldAnchor?: Vec3;
  /** Word flags (+0x194). */
  wordFlags: number;
  /** Words left (+0x11c, record hp). */
  hp: number;
  /** Object flags (+0x34). */
  flags: number;
  dead?: boolean;
  /** A correct letter from `player` reached it (the +0x34 hit bits, part +0x190). */
  letterHit?(w: World, player: number): void;
  /** The word is complete (hp 0, dead flag 0x4000000). */
  wordDone?(w: World, player: number): void;
}

/** Frame models @005ea738: corners / edges / centre, top to bottom. */
const FRAME = { tl: 0x129e, t: 0x1373, tr: 0x170c, l: 0x12a3, c: 0x19d, r: 0x1738, bl: 0x12c5, b: 0x13dd, br: 0x1769 };

/** Per-letter metrics and the line's centring offset (FUN_004b0b20 / FUN_004b0b80). */
function lineMetrics(pe: PeImage, text: string) {
  const m = [...text].map((c) => charMetrics(pe, asciiToSjis(pe, c.charCodeAt(0))));
  const width = m.length ? m[0]![1] + m.reduce((s, [adv, left]) => s + f32(adv - left), 0) : 0;
  const centre = m.length ? f32(m[0]![0] * 0.5 - width * 0.5) : 0;
  return { m, width, centre };
}

export class WordBox {
  readonly owner: WordOwner;
  /** Box slot (owner +0x3c) — one first letter per slot. */
  readonly slot: number;
  word?: string;
  /** Characters typed (+0x99). */
  typed = 0;
  /** Position (+0x34..+0x3c), size (+0x40), centre alpha (+0x44), danger (+0x48). */
  pos: Vec3 = [0, 0, 0];
  size = 1;
  alpha = f32(0.45);
  danger = 1;
  /** Frame width (+0xa4). */
  width = 0;
  /** Queued for drawing this frame (+0x4c & 8). */
  shown = false;
  /** Player 1 targets this box (+0x4c & 0x20). */
  targeted = false;
  /** Wrong keys while targeted (not used by the game logic yet). */
  misses = 0;
  dead?: boolean;
  private readonly pe: PeImage;
  private readonly deck: WordDeck;

  constructor(owner: WordOwner, slot: number, pe: PeImage, deck: WordDeck) {
    this.owner = owner;
    this.slot = slot;
    this.pe = pe;
    this.deck = deck;
  }

  /** FUN_004b2a30 for one player. */
  update(w: World) {
    const o = this.owner;
    this.shown = false;
    if (o.dead) {
      this.deck.release(this.slot);
      this.dead = true;
      return;
    }
    const f = o.wordFlags;
    const may = !(f & 0x400000) && !(f & 0x8000) && w.inFight && o.hp !== 0 && !(o.flags & 0x8100) && !(f & 0x400) && (o.flags & 1) !== 0;
    if (!may || !o.anchor) return;
    const a = o.anchor;
    if (this.word === undefined) {
      if (w.wordPickedFrame === w.frame) return; // one new word per frame (DAT_00839d24)
      const picked = this.deck.pick(this.slot, f, o.hp);
      if (!picked) return;
      this.word = picked.entry.text;
      this.width = Math.trunc(f32(lineMetrics(this.pe, this.word).width + f32(2.3)));
      this.pos = [a[0], a[1], a[2]];
      this.danger = 1;
      w.wordPickedFrame = w.frame;
      return;
    }
    if (!(f & 0x4000000)) this.danger = dangerOf(o, w);
    if (f & 0x508000) this.pos = [a[0], a[1], a[2]];
    const az = f32(a[2] + 5);
    const scale = this.pos[2] === 0 ? 1 : f32(f32(az - this.pos[2]) / az + 1);
    for (const k of [0, 1] as const) {
      let p = this.pos[k];
      const d = f32(a[k] - p), ad = Math.abs(d);
      if (ad > 10) p = f32(f32(ad - 10) * (a[k] <= p ? -1 : 1) + p);
      this.pos[k] = f32(f32(f32(a[k] - p) * f32(1 / 30) + p) * scale);
    }
    this.typing(w);
    this.alpha = f32(this.targeted ? 0.85 : 0.45);
    this.size = 1;
    this.pos[2] = az;
    this.shown = this.owner.hp !== 0;
  }

  /** FUN_004b3080 / FUN_004b31f0 for player 1 with this frame's key. */
  private typing(w: World) {
    const key = w.key;
    if (key !== undefined) {
      if (w.targets[0] === -1 && this.nextKeyMatches(key)) {
        w.targets[0] = this.slot;
        this.type(w, key);
        w.key = undefined; // one box takes the key (DAT_00839d10)
      } else if (w.targets[0] === this.slot) {
        this.type(w, key);
        w.key = undefined;
      }
    }
    this.targeted = w.targets[0] === this.slot;
  }

  private nextKeyMatches(key: string): boolean {
    const t = this.word ?? '';
    const c = t[this.typed];
    if (c === undefined) return false;
    return c.toUpperCase() === key || (c === ' ' && (t[this.typed + 1] ?? '').toUpperCase() === key);
  }

  /** The English matcher: 0x40 correct (a letter hit), 0x80 complete, 0x10 miss. */
  private type(w: World, key: string) {
    const t = this.word ?? '';
    if (!this.nextKeyMatches(key)) {
      this.misses++;
      return;
    }
    this.typed += t[this.typed] === ' ' && key !== ' ' ? 2 : 1; // a skipped space
    this.owner.letterHit?.(w, 0);
    if (this.typed >= t.length) {
      w.targets[0] = -1;
      this.owner.wordDone?.(w, 0);
      this.deck.release(this.slot); // FUN_004b23e0
    }
  }

  /** FUN_004b0c90 → items in game view space (`toWorld` turns them into world matrices). */
  draw(toWorld: (m: Mat4) => Mat4): DrawItem[] {
    if (!this.shown || this.word === undefined) return [];
    const items: DrawItem[] = [];
    const p = { x: this.pos[0], y: this.pos[1], z: this.pos[2], s: this.size };
    this.frame(p, items, toWorld);
    p.z = f32(p.z + 0.01);
    if (this.targeted) this.brackets(p, items, toWorld);
    const { centre } = lineMetrics(this.pe, this.word);
    const n = [...this.word].length;
    const x0 = p.x, y0 = p.y, s = p.s;
    if (n > 1) this.line(items, toWorld, this.word, f32(centre * s * 0.75 + x0), f32(s * f32(0.13) + y0), p.z, s, true, 0);
    if (n === 1) this.line(items, toWorld, this.word, x0, f32(y0 - s * f32(0.65)), p.z, f32(s * f32(1.2)), false, this.typed);
    else this.line(items, toWorld, this.word, f32(centre * s * 0.75 + x0), f32(y0 - s * f32(1.3)), p.z, s, false, this.typed);
    return items;
  }

  /** FUN_004b0890 / FUN_004b2530: one line of letter models; `word` line yellow, typing line white. */
  private line(items: DrawItem[], toWorld: (m: Mat4) => Mat4, text: string, x: number, y: number, z: number, s: number, word: boolean, hidden: number) {
    const { m } = lineMetrics(this.pe, text);
    [...text].forEach((ch, i) => {
      const [adv, left] = m[i]!;
      x = f32(x - left * s * 0.75);
      if (i >= hidden) {
        const c = ch.charCodeAt(0) & 0x7f;
        const model = letterModelId(this.pe, c);
        if (model) {
          const drop = c === 0x67 || c === 0x70 || c === 0x71 || c === 0x79 ? f32(s * -0.2) : c === 0x6a ? f32(s * -0.1) : 0;
          const local = scaleLocal(translateLocal(identity(), x * K, (drop + y) * K, z * K), s * K, s * K, s * K);
          items.push({ model, world: toWorld(local), color: [1, 1, word ? 0 : 1], overlay: true });
        }
      }
      x = f32(adv * s * 0.75 + x);
    });
  }

  /** FUN_004b01a0 (with FUN_004affd0 / FUN_004afd50 applied to `p`): the nine frame pieces. */
  private frame(p: { x: number; y: number; z: number; s: number }, items: DrawItem[], toWorld: (m: Mat4) => Mat4) {
    fitToScreen(p, this.width, this.projScale);
    const w = this.width, s = p.s;
    const span = f32((w - 2) * s), half = f32(span * 0.5);
    const left = f32(p.x - half), right = f32(left + span), mid = f32(half + left);
    let y = f32(p.y - s);
    const d = this.danger;
    const blink = (this.frameCounter & 4) !== 0 ? 1 : 0;
    const color: [number, number, number] = d === 0 ? [1, blink, 0] : d <= 0.5 ? [1, f32(d + d), 0] : [f32((1 - d) * 2), 1, 0];
    // The centre is set black once at start-up (FUN_004afd90) and left out of the danger colouring.
    const piece = (model: number, x: number, y: number, sx: number, sy: number, tint = true) => {
      const local = scaleLocal(translateLocal(identity(), x * K, y * K, p.z * K), sx * s * K, sy * s * K, s * K);
      items.push({ model, world: toWorld(local), color: tint ? color : [0, 0, 0], overlay: true });
    };
    const lh = 1;
    piece(FRAME.tl, left, y, 0.25, 0.25);
    piece(FRAME.t, mid, y, f32((w - 1) * 0.5 - 0.03), 0.25);
    piece(FRAME.tr, right, y, 0.25, 0.25);
    y = f32(lh * s + y);
    const h = f32(lh + 0.25);
    piece(FRAME.l, left, y, 0.25, h);
    piece(FRAME.c, mid, y, f32((f32((w - 0.5) * 0.5) - f32(w * 0.08) - 0.03) * 0.5), f32(h * 0.5 + 0.025), false); // FUN_004b0490 ignores the alpha (+0x44)
    piece(FRAME.r, right, y, 0.25, h);
    y = f32(lh * s + y);
    piece(FRAME.bl, left, y, 0.25, 0.25);
    piece(FRAME.b, mid, y, f32((w - 1) * 0.5 - 0.03), 0.25);
    piece(FRAME.br, right, y, 0.25, 0.25);
  }

  /** FUN_004b07f0 → FUN_004b0530: four bracket models 0x1ccb at the corners, spinning (frame × 1092), red. */
  private brackets(p: { x: number; y: number; z: number; s: number }, items: DrawItem[], toWorld: (m: Mat4) => Mat4) {
    const hw = f32(f32(this.width + 0.2) * p.s * 0.5), h = f32(p.s * f32(2.1)), sc = f32(p.s * f32(0.075));
    const spin = (this.frameCounter * 1092) | 0;
    for (const [sx, sy, rz] of [[-1, 1, 0xa000], [-1, -1, 0xe000], [1, 1, 0x6000], [1, -1, 0x2000]] as const) {
      let m = translateLocal(identity(), f32(p.x + sx * hw) * K, f32(p.y + sy * h) * K, p.z * K);
      m = scaleLocal(rotateYLocal(rotateZLocal(m, rz), spin), sc, sc, sc);
      items.push({ model: 0x1ccb, world: toWorld(m), color: [1, 0, 0], overlay: true });
    }
  }

  /** Set by the owner of the box list each frame (g_rng_counter for the blink, DAT_00a11a10). */
  frameCounter = 0;
  projScale = 1;
}

/** FUN_004b3bc0: 0 within 20 of the player, 1 beyond 60. */
function dangerOf(o: WordOwner, w: World): number {
  const a = o.worldAnchor;
  if (!a) return 1;
  const d = f32(Math.hypot(a[2] - w.eye[2], a[0] - w.eye[0]));
  if (d < 20) return 0;
  if (d > 60) return 1;
  return f32(f32(d - 20) * f32(0.025));
}

/** FUN_004afd50 + FUN_004affd0: bring a near box to depth 10, size by depth, keep it on screen. */
function fitToScreen(p: { x: number; y: number; z: number; s: number }, width: number, projScale: number) {
  if (-10 < p.z) {
    const z = p.z;
    p.z = -10;
    p.x = f32(f32(p.x / z) * -10);
    p.y = f32(f32(p.y / z) * -10);
  }
  const room = f32(270 - f32(width + width) * p.s * 4);
  if (p.z < -32) p.s = f32((f32(-32 - p.z) / 32 + 1) * p.s);
  if (-28 < p.z) p.s = f32((1 - f32(p.z + 28) / 28) * p.s);
  const r = f32(p.z / projScale);
  if (width > 25) p.x = 0;
  else {
    const lim = f32(r * room);
    if (p.x <= -lim) {
      if (p.x < lim) p.x = lim;
    } else p.x = -lim;
  }
  if (r * -150 < p.y) p.y = f32(r * -150);
  else if (p.y < r * 150) p.y = f32(r * 150);
}

/** FUN_004aec20's first pass: push overlapping boxes apart vertically (screen space, 96 px). */
export function separateBoxes(boxes: WordBox[], projScale: number) {
  const s = projScale;
  boxes.forEach((a, i) => {
    boxes.forEach((b, j) => {
      if (i === j || a.pos[2] === 0 || b.pos[2] === 0) return;
      const ra = f32(a.pos[2] / s), rb = f32(b.pos[2] / s);
      for (const [box, r] of [[a, ra], [b, rb]] as const) {
        box.pos[0] = Math.min(Math.max(box.pos[0], f32(r * 270)), f32(r * -270));
        box.pos[1] = Math.min(Math.max(box.pos[1], f32(r * 150)), f32(r * -150));
      }
      const ya = f32((s * a.pos[1]) / a.pos[2]), yb = f32((s * b.pos[1]) / b.pos[2]);
      const dy = Math.abs(ya - yb);
      if (dy >= 96) return;
      const dx = Math.abs(f32((s * a.pos[0]) / a.pos[2]) - f32((s * b.pos[0]) / b.pos[2]));
      if (dx < a.width * 25 || a.width > 8) a.pos[1] = f32(f32(96 - dy) * (ya <= yb ? -ra : ra) * f32(0.2) + a.pos[1]);
    });
  });
}

/** Key code the exe gives Esc (scan code 1 → ')' in the key table @008479f0): cancels the target. */
export const CANCEL_KEY = ')';

const isWordOwner = (o: unknown): o is WordOwner => typeof o === 'object' && o !== null && 'wordFlags' in o;

/** All word boxes: created with their owners (spawn_record), updated after the objects, drawn last. */
export class WordBoxes {
  boxes: WordBox[] = [];
  private readonly pe: PeImage;
  readonly deck: WordDeck;
  /** Word setups applied (EventPlayer.words.count). */
  private setups = 0;

  constructor(pe: PeImage, deck: WordDeck) {
    this.pe = pe;
    this.deck = deck;
  }

  /** spawn_record: a box for `obj` if its type has word flags (@005a2848; typing mode assumed). */
  add(obj: unknown, type: number) {
    if (!readWordFlags(this.pe, type) || !isWordOwner(obj)) return;
    const used = new Set(this.boxes.map((b) => b.slot));
    let slot = 0;
    while (used.has(slot) && slot < 13) slot++;
    this.boxes.push(new WordBox(obj, slot, this.pe, this.deck));
  }

  /** Event op 0x61 since the last frame → FUN_004b1510. */
  applySetup(words: { group: number; budget: number; count: number }) {
    for (; this.setups < words.count; this.setups++) this.deck.setup(words.group, words.budget);
  }

  update(w: World) {
    this.deck.tick(w.frame);
    // FUN_004b2a30: key ')' — Esc (scan code 1 → @008479f0) — with a target cancels it: the player's buffer is
    // emptied and the word starts again (FUN_00401310 / FUN_00401ce0; sound 0x3e16a9, FUN_00484d50 not ported).
    if (w.key === CANCEL_KEY) {
      const t = this.boxes.find((b) => b.slot === w.targets[0]);
      if (t) t.typed = 0;
      w.targets[0] = -1;
      w.key = undefined;
    }
    for (const b of this.boxes) b.update(w);
    this.boxes = this.boxes.filter((b) => !b.dead);
  }

  /** FUN_004aec20: separate, then draw each shown box. */
  draw(w: World, toWorld: (m: Mat4) => Mat4): DrawItem[] {
    const shown = this.boxes.filter((b) => b.shown);
    separateBoxes(shown, w.projScale);
    return shown.flatMap((b) => {
      b.frameCounter = w.frame;
      b.projScale = w.projScale;
      return b.draw(toWorld);
    });
  }
}
