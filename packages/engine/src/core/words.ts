/**
 * Which words enemies get — the exe's word state (re/notes/overview.md "Typing: words, word boxes, targeting").
 *
 *   setup(group, budget)  FUN_004b1510 via event op 0x61: level from the time budget and rank (FUN_004b16b0) →
 *                         0: category 1 (built-in two-letter words), n: the group's word file of level n;
 *                         budget −2: a random file of the group (and boxes then ignore their own categories).
 *   pick(slot, flags, hp) FUN_004b1f80: category by the owner's word flags / hp (FUN_004b2400), a random index
 *                         not among the last 16 picks (FUN_004b19f0), accepted when its first key differs from
 *                         every other box slot's (FUN_004b23a0 / FUN_004020a0; 14 slots).
 *   rank                  DAT_00a3b856 (FUN_00437c60 / FUN_00451ff0): starts at 1, +1 every 0x708 frames,
 *                         0–15, capped at 12 in Stage 1.
 * Not ported: category 0's special picks (FUN_004b1f80 for hp-1 enemies), the event-mode list (DAT_00a3bac0),
 * DAT_00839d08 filters, rank changes from play (DAT_00a11d14) and the +2 with four or more lives.
 */
import { readBuiltinWords, readWordLevelTables, wordFileName, wordLevel, type PeImage, type WordEntry } from '@ttotd/formats';
import type { CrtRand } from './rand.ts';

export interface PickedWord {
  entry: WordEntry;
  category: number;
}

/** First key of a word (FUN_00402120 for the English charset: the first character, upper-cased). */
const firstKey = (e: WordEntry) => (e.text[0] ?? '').toUpperCase();

export class WordDeck {
  /** Current default category (DAT_00839cc0) and its list. */
  category = 1;
  private file: WordEntry[] = [];
  /** DAT_00839c94: boxes keep the default category. */
  private forceDefault = false;
  /** Last 16 picked indexes (DAT_00839cc4) and the write position (DAT_00839d04). */
  private recent = new Int32Array(16).fill(-1);
  private recentPos = 0;
  /** First key per box slot (DAT_00839c80). */
  readonly slots: string[] = Array(14).fill('');
  rank = 1;
  private readonly tables;
  private readonly builtin = new Map<number, WordEntry[]>();
  private readonly pe: PeImage;
  private readonly loadFile: (name: string) => WordEntry[] | undefined;
  private readonly rng: CrtRand;
  /** Stage index DAT_00a10c08 (0 = Stage 1). */
  private readonly stageIndex: number;

  constructor(pe: PeImage, loadFile: (name: string) => WordEntry[] | undefined, rng: CrtRand, stageIndex = 0) {
    this.pe = pe;
    this.loadFile = loadFile;
    this.rng = rng;
    this.stageIndex = stageIndex;
    this.tables = readWordLevelTables(pe);
  }

  /** Rank as read by the word code (FUN_00437c60). */
  get effectiveRank() {
    const cap = this.stageIndex === 0 ? 12 : this.stageIndex === 1 ? 14 : 15;
    return Math.max(0, Math.min(cap, this.rank));
  }

  /** FUN_00451ff0's timer part, once per game frame. */
  tick(frame: number) {
    if (frame > 0 && frame % 0x708 === 0) this.rank = Math.min(15, this.rank + 1);
  }

  private list(category: number): WordEntry[] {
    if (category === 2) return this.file;
    let l = this.builtin.get(category);
    if (!l) this.builtin.set(category, (l = readBuiltinWords(this.pe, category)));
    return l;
  }

  /** FUN_004b19f0: random index in [lo, hi) avoiding the last 16 picks, remembered. */
  private randomIndex(lo: number, hi: number): number {
    let i = lo;
    for (let n = 0; n < 16; n++) {
      i = (this.rng.next() % Math.max(1, hi - lo)) + lo;
      if (!this.recent.includes(i)) break;
    }
    this.recentPos = (this.recentPos + 1) & 15;
    this.recent[this.recentPos] = i;
    return i;
  }

  /** FUN_004b1510(group, budget) for budget ≥ 0 or −2. */
  setup(group: number, budget: number) {
    this.forceDefault = false;
    if (budget === -2) {
      const files = this.groupSize(group);
      const level = this.randomIndex(0, files) + 1;
      if (group === 2) this.forceDefault = true;
      this.useFile(group, level);
      return;
    }
    const level = wordLevel(this.tables, budget, this.effectiveRank);
    if (level === 0) this.category = 1;
    else this.useFile(group, level);
  }

  private groupSize(group: number) {
    let n = 0;
    while (wordFileName(this.pe, group, n + 1)) n++;
    return n;
  }

  private useFile(group: number, level: number) {
    const name = wordFileName(this.pe, group, level);
    const words = name ? this.loadFile(name) : undefined;
    if (words?.length) {
      this.file = words;
      this.category = 2;
    } else this.category = 1;
  }

  /** FUN_004b2400: the owner's category (may set short-word flags from hp 1 / 2). */
  categoryFor(flags: number, hp: number): { category: number; flags: number } {
    if (flags === 0 || this.forceDefault) return { category: this.category, flags };
    if (hp === 1) flags |= 0x14;
    if (hp === 2) flags |= 0x24;
    if (flags & 0x10) return { category: 0, flags };
    if (flags & 0x20) return { category: 1, flags };
    if (flags & 0xc0 || flags & 0x100) return { category: 5, flags };
    return { category: this.category, flags };
  }

  /** FUN_004b23a0: claim `slot` for a word whose first key differs from every other slot's. */
  private claim(e: WordEntry, slot: number): boolean {
    const k = firstKey(e);
    for (let i = 0; i < this.slots.length; i++) if (i !== slot && this.slots[i] && this.slots[i] === k) return false;
    this.slots[slot] = k;
    return true;
  }

  release(slot: number) {
    if (slot >= 0 && slot < this.slots.length) this.slots[slot] = '';
  }

  /** FUN_004b1f80 for a box in `slot` whose owner has word flags `flags` and hp `hp`. */
  pick(slot: number, ownerFlags: number, hp: number): PickedWord | undefined {
    const { category, flags } = this.categoryFor(ownerFlags, hp);
    const list = this.list(category);
    if (!list.length) return undefined;
    let lo = 0, hi = list.length;
    if (flags & 0x40) [lo, hi] = [0, 0x1d];
    else if (flags & 0x80) [lo, hi] = [0x1c, 0x2d];
    else if (flags & 0x100) lo = 0x2c;
    else if (flags & 0x1000000) [lo, hi] = [1, 9];
    else if (flags & 0x800000) lo = 9;
    hi = Math.min(hi, list.length);
    lo = Math.min(lo, hi - 1);
    for (let n = 0; n < 16; n++) {
      const e = list[this.randomIndex(lo, hi)];
      if (e && this.claim(e, slot)) return { entry: e, category };
    }
    for (let i = hi - 1; i >= 0; i--) if (this.claim(list[i]!, slot)) return { entry: list[i]!, category };
    return { entry: list[0]!, category };
  }
}
