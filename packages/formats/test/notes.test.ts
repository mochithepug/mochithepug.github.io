/**
 * Executable checks of the claims in re/notes/overview.md, against the user's own install.
 * Skipped unless TTOTD_DIR is set:  TTOTD_DIR=~/Downloads/TTOTD npm test
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PeImage } from '../src/pe.ts';

const dir = process.env.TTOTD_DIR;
const read = (p: string) => new Uint8Array(readFileSync(join(dir!, p)));
const u32s = (b: Uint8Array) => new Uint32Array(b.buffer.slice(b.byteOffset, b.byteOffset + (b.length & ~3)));

describe.skipIf(!dir)('re/notes/overview.md claims', () => {
  const exe = () => new PeImage(read('Tod_e.exe'));

  it('frame pacing: 16.667 ms target (60 Hz), max 4 skipped frames, 20 frames per 333 ms', () => {
    const pe = exe();
    expect(pe.f32(0x005eb640)).toBeCloseTo(1000 / 60, 4);
    expect(pe.u32(0x005eb638)).toBe(4);
    expect(pe.u32(0x005eb64c)).toBe(333);
    expect(pe.u32(0x005eb648)).toBe(20);
  });

  it('rand() uses the MSVC LCG constants', () => {
    // imul eax, [..], 0x343fd ; add eax, 0x269ec3 — look for both immediates inside crt_rand.
    const pe = exe();
    const o = pe.offsetOf(0x004c62cc);
    const code = Array.from(pe.bytes.subarray(o, o + 34), (b) => b.toString(16).padStart(2, '0')).join('');
    expect(code).toContain('fd430300'); // 0x000343fd LE
    expect(code).toContain('c39e2600'); // 0x00269ec3 LE
  });

  it('path formats and save-file table are where the notes say', () => {
    const pe = exe();
    expect(pe.cstr(pe.u32(0x005b9168))).toBe('evt\\%s');
    expect(pe.cstr(0x005b9174)).toBe('coli\\%s');
    expect(pe.cstr(0x005b5180)).toBe('word\\font.bin');
    const saves = [0, 1, 2, 3].map((i) => pe.cstr(pe.u32(0x005ea000 + i * 4)));
    expect(saves).toEqual(['pol/bg_adv19.bin', 'tex/scr_tod_itm_itamidome2.bin', 'pol/komono_0.bin', 'pol/tv2.bin']);
    expect(pe.cstr(0x005ea064)).toBe('pol/zstin.bin');
    for (const s of saves) expect(statSync(join(dir!, s)).size).toBe(0xb00);
  });

  it('word lists are XOR 0x41 and fit the 0xD000 buffer; font fits 0x138000', () => {
    const words = readdirSync(join(dir!, 'word')).filter((n) => /^Z.*\.bin$/i.test(n));
    expect(words.length).toBe(488);
    const asciiWords = (b: Uint8Array) => (new TextDecoder('latin1').decode(b).match(/[A-Za-z]{3,}\0/g) ?? []).length;
    let decoded = 0, raw = 0;
    for (const n of words) {
      const b = read(join('word', n));
      expect(b.length).toBeLessThanOrEqual(0xd000);
      raw += asciiWords(b);
      decoded += asciiWords(b.map((x) => x ^ 0x41));
    }
    expect(decoded).toBeGreaterThan(20 * raw); // XOR-decoded files are full of NUL-terminated words
    expect(read('word/font.bin').length).toBeLessThanOrEqual(0x138000);
  });

  it('evt pointers: 0x0CE8xxxx rebased by +0xF3B30C00 land in their own table (@0x9E6600) or comevtbl (@0x9E6400)', () => {
    const COM = 0x009e6400, STAGE = 0x009e6600;
    const comLen = read('evt/comevtbl.bin').length;
    for (const n of readdirSync(join(dir!, 'evt'))) {
      const b = read(join('evt', n));
      const isCom = n === 'comevtbl.bin';
      const ptrs = [...u32s(b)].filter((w) => (w & 0xfff80000) === 0x0ce80000).map((w) => (w + 0xf3b30c00) >>> 0);
      const inCom = (p: number) => p >= COM && p < COM + comLen;
      // comevtbl may only point into itself or at the start of whichever stage table is loaded.
      const hit = ptrs.filter((p) => inCom(p) || (isCom ? p === STAGE : p >= STAGE && p <= STAGE + b.length));
      expect(ptrs.length, n).toBeGreaterThan(0);
      if (isCom) expect(hit.length, n).toBe(ptrs.length);
      else expect(hit.length / ptrs.length, n).toBeGreaterThan(0.9);
    }
  });
});
