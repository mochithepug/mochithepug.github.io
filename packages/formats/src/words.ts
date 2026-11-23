/**
 * Word lists (word/Z*.bin) and the typing character set. See re/notes/overview.md "Words & font".
 *
 * File (after XOR 0x41 on every byte, as load_word_list does): records of 12 bytes
 *   { i32 value, u32 textOffset, u32 codeOffset } until a record whose low 16 bits of `value` are
 *   0xFFFF; offsets are from the start of the file (the exe adds the buffer address).
 *   text = the word in ASCII; codes = the same word in the game's 1-byte character set:
 *   0–9 → A2–AB, A–Z → AC–C5, a–z → C6–DF, punctuation E3–F8 (verified for all 14 061 words).
 * Character set → Shift-JIS (full-width) via the u16 table @00595714 (codes 0x51..0xF8,
 * FUN_00402e90). Letter metrics (FUN_004b0a50): full-width Ａ–ｚ use advance @005ea80c and
 * left offset @005ea8f8 (f32, indexed by sjis − 0x8260); SJIS 0x8140–0x8144 and 0x8166 → (0.4, 0);
 * everything else → (0.9, 0). Distances are × quad size × 0.75 (@004dd6b8).
 */
import type { PeImage } from './pe.ts';

export interface WordEntry {
  value: number;
  text: string;
  codes: Uint8Array;
}

export function decodeWordList(file: Uint8Array): WordEntry[] {
  const d = file.map((b) => b ^ 0x41);
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const cstr = (o: number) => {
    let e = o;
    while (e < d.length && d[e] !== 0) e++;
    return d.subarray(o, e);
  };
  const out: WordEntry[] = [];
  for (let o = 0; o + 12 <= d.length; o += 12) {
    const value = v.getInt32(o, true);
    if ((value & 0xffff) === 0xffff) return out;
    const text = cstr(v.getUint32(o + 4, true));
    const codes = cstr(v.getUint32(o + 8, true));
    out.push({ value, text: String.fromCharCode(...text), codes: codes.slice() });
  }
  throw new Error('word list has no terminator');
}

const WORD_NAMES = 0x004f3bc8;

/** Word-list file names in the exe's order (index = the game's list number). */
export function readWordListNames(pe: PeImage): string[] {
  const names: string[] = [];
  for (let i = 0; ; i++) {
    let n: string;
    try {
      n = pe.cstr(pe.u32(WORD_NAMES + i * 4));
    } catch {
      break;
    }
    if (!/^Z\w+\.bin$/i.test(n)) break;
    names.push(n);
  }
  return names;
}

/** Game character code (0x51..0xF8) → Shift-JIS code, or 0 if out of range (FUN_00402e90). */
export function codeToSjis(pe: PeImage, code: number): number {
  if (code < 0x51 || code > 0xf8) return 0;
  const p = pe.u32(0x00595710);
  return (pe.u8(p + code * 2 - 0xa2) << 8) | pe.u8(p + code * 2 - 0xa1);
}

/** [advance, left offset] in quad-size units (before the × 0.75 scale), as FUN_004b0a50. */
export function charMetrics(pe: PeImage, sjis: number): [number, number] {
  if (sjis > 0x813f && (sjis < 0x8145 || sjis === 0x8166)) return [0.4, 0];
  if (sjis < 0x8260 || sjis > 0x829a) return [0.9, 0];
  const i = (sjis - 0x8260) * 4;
  return [pe.f32(0x005ea80c + i), pe.f32(0x005ea8f8 + i)];
}

/** Global model id of the letter quad for an ASCII character (table @0058efa8; control chars → 0x1BA0). */
export function letterModelId(pe: PeImage, ascii: number): number {
  const c = ascii & 0x7f;
  if (c < 0x20) return 0x1ba0;
  return pe.u16(0x0058efa8 + c * 2);
}

/** ASCII → the full-width Shift-JIS code the game stores in a word string (via the 1-byte charset). */
export function asciiToSjis(pe: PeImage, ascii: number): number {
  const code =
    ascii >= 48 && ascii <= 57 ? 0xa2 + ascii - 48
    : ascii >= 65 && ascii <= 90 ? 0xac + ascii - 65
    : ascii >= 97 && ascii <= 122 ? 0xc6 + ascii - 97
    : PUNCT_CODES[String.fromCharCode(ascii)] ?? 0xea;
  return codeToSjis(pe, code);
}
const PUNCT_CODES: Record<string, number> = {
  '?': 0xe3, '!': 0xe4, '%': 0xe9, ' ': 0xea, "'": 0xeb, $: 0xec, '#': 0xed, '@': 0xee, '.': 0xef,
  ',': 0xf0, '-': 0xf1, '"': 0xf2, '&': 0xf3, '/': 0xf4, '(': 0xf5, ')': 0xf6, ':': 0xf7, '*': 0xf8,
};

export interface PlacedLetter {
  ascii: number;
  modelId: number;
  /** Quad origin (centre-bottom of the 1×1 letter model), in the same units as `size`. */
  x: number;
  y: number;
  /** Scale applied to the letter model (x/z and y). */
  scaleX: number;
  scaleY: number;
  hidden: boolean;
}

/**
 * Lay out one word line exactly as FUN_004b1030 → FUN_004b0890 → FUN_004b2530 do (×0.1 world
 * scaling omitted): centred on (x, y) with x0 = x + (adv(first)/2 − width/2)·size·0.75, y −= 0.4·size;
 * per character: x −= left·size·0.75, draw, x += adv·size·0.75. Letter height factor is 1.0 for word
 * lines; g/p/q/y drop by 0.2·size, j by 0.1·size. The first `hidden` characters keep their space but are
 * not drawn (the typed part of a player's line).
 */
export function layoutWordLine(pe: PeImage, text: string, size: number, x: number, y: number, hidden = 0): PlacedLetter[] {
  const chars = [...text].map((c) => c.charCodeAt(0));
  if (!chars.length) return [];
  const m = chars.map((c) => charMetrics(pe, asciiToSjis(pe, c)));
  // FUN_004b0b20: width = left(first) + Σ (adv − left)
  const width = m[0]![1] + m.reduce((s, [adv, left]) => s + Math.fround(adv - left), 0);
  let px = Math.fround((m[0]![0] * 0.5 - width * 0.5) * size * 0.75 + x);
  const py = y - size * 0.4;
  const out: PlacedLetter[] = [];
  chars.forEach((c, i) => {
    const [adv, left] = m[i]!;
    px = Math.fround(px - left * size * 0.75);
    const lower = c & 0x7f;
    const drop = lower === 0x67 || lower === 0x70 || lower === 0x71 || lower === 0x79 ? -0.2 : lower === 0x6a ? -0.1 : 0;
    out.push({ ascii: c, modelId: letterModelId(pe, c), x: px, y: py + drop * size, scaleX: size, scaleY: size, hidden: i < hidden });
    px = Math.fround(adv * size * 0.75 + px);
  });
  return out;
}

/**
 * Word lists built into the exe (`FUN_004b3f80` categories 0, 1, 3, 4, 5; 2 = the loaded word file): 12-byte
 * records like the files' — i32 value (low i16 → box +0x9e, high u16 = flags → +0x9c), char* text, u8* codes.
 */
export function readBuiltinWords(pe: PeImage, category: number): WordEntry[] {
  const lists: Record<number, [number, number]> = {
    0: [0x0058f0e8, pe.u32(0x0058f928) & 0xff],
    1: [pe.u32(0x005eaaa0), pe.u32(0x005eaaa4) & 0xff],
    3: [0x0058f410, pe.u32(0x0058f928) >>> 24],
    4: [0x0058f510, pe.u32(0x0058f92c) & 0xff],
    5: [0x0058f658, (pe.u32(0x0058f92c) >>> 8) & 0xff],
  };
  const l = lists[category];
  if (!l) return [];
  const [at, n] = l;
  return Array.from({ length: n }, (_, i) => {
    const r = at + i * 12;
    const codes: number[] = [];
    for (let p = pe.u32(r + 8); pe.u8(p) !== 0 && codes.length < 64; p++) codes.push(pe.u8(p));
    return { value: pe.i32(r), text: pe.cstr(pe.u32(r + 4)), codes: Uint8Array.from(codes) };
  });
}

/** Word file of a group's level (`FUN_004b40b0`): names[@005eaaac[group] + level − 1]; undefined if out of range. */
export function wordFileName(pe: PeImage, group: number, level: number): string | undefined {
  const groups = pe.u32(0x005eaab0) & 0xffff;
  if (group < 0 || group >= groups || level < 1) return undefined;
  const table = pe.u32(0x005eaaac);
  const first = pe.u16(table + group * 2), next = pe.u16(table + (group + 1) * 2);
  if (level - 1 >= next - first) return undefined;
  return readWordListNames(pe)[first + level - 1];
}

/** Rank-dependent tables of `FUN_004b16b0` (@005ea6c8, @005ea6d8 i8; @005ea688 f32), indexed by rank 0–15. */
export function readWordLevelTables(pe: PeImage) {
  const i8 = (a: number) => (pe.u8(a) << 24) >> 24;
  return {
    short: Array.from({ length: 16 }, (_, r) => i8(0x005ea6c8 + r)),
    mid: Array.from({ length: 16 }, (_, r) => i8(0x005ea6d8 + r)),
    factor: Array.from({ length: 16 }, (_, r) => pe.f32(0x005ea688 + r * 4)),
  };
}

/**
 * `FUN_004b16b0(budget, 0)`: word level for a time budget (event op 0x61) at `rank`. < 0 never here; 0 →
 * category 1 (the built-in two-letter words); 1–19 → word file level. `scale` = DAT_005ea9e4 (0.1 by default),
 * language 'A' (no ×1.2).
 */
export function wordLevel(t: ReturnType<typeof readWordLevelTables>, budget: number, rank: number, scale = 0.1): number {
  const f32 = Math.fround;
  let p = f32(f32(Math.trunc(budget)) * f32(scale));
  if (p > 15) {
    if (p > 30) {
      const k = p > 240 ? 0.6 : p > 210 ? 0.7 : p > 180 ? 0.8 : p > 150 ? 0.9 : p > 120 ? 1 : p > 85 ? 1.2 : p > 65 ? 1.3 : p > 45 ? 1.4 : 1.5;
      p = f32((f32(t.factor[rank]! * f32(k)) + 1) * p);
    } else p = t.mid[rank]! + p;
  } else p = t.short[rank]! + p;
  if (p > 2000) p = 2000;
  if (p <= 0) p = 0; // DAT_00839ca8
  if (p < 3) return 0;
  return Math.min(19, Math.trunc(p));
}

/** Word flags of an object type (@005a2848): non-zero → `spawn_record` gives it a word box. */
export function readWordFlags(pe: PeImage, type: number): number {
  return pe.u32(0x005a2848 + type * 4);
}
