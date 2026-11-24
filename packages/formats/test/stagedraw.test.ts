/** Stage areas and the sky table against the user's install (skipped unless TTOTD_DIR is set). */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PeImage } from '../src/pe.ts';
import { readSkyTable, readStageAreas } from '../src/stagedraw.ts';

const dir = process.env.TTOTD_DIR;

describe.skipIf(!dir)('stage areas & sky (real data)', () => {
  const pe = new PeImage(new Uint8Array(readFileSync(join(dir!, 'Tod_e.exe'))));

  it('Stage 1 has 13 areas; area 1 (the fly-over) draws st1_01 and st1_01b; no sky/library models in any area', () => {
    const { areas } = readStageAreas(pe, 1);
    expect(areas.length).toBe(13);
    expect(areas[1]!.map((m) => m.model)).toEqual([0x18b3, 0x18b2]);
    const all = areas.flat().map((m) => m.model);
    for (const sky of [0x1854, 0x1855, 0x1e44, 0x1e45]) expect(all).not.toContain(sky);
  });

  it('sky rows 4 and 5 (Stage 1) = dome 0x1854 + layer 0x1e44, spinning 4 per frame', () => {
    const rows = readSkyTable(pe);
    for (const r of [rows[4]!, rows[5]!]) expect([r.model, r.layer, r.height, r.spin]).toEqual([0x1854, 0x1e44, 0, 4]);
  });
});

import { readBuiltinWords, readWordFlags, readWordLevelTables, wordFileName, wordLevel } from '../src/words.ts';

describe.skipIf(!dir)('words for fights (real data)', () => {
  const pe = new PeImage(new Uint8Array(readFileSync(join(dir!, 'Tod_e.exe'))));
  const t = readWordLevelTables(pe);

  it('category 1 = the 41 built-in two-character words (Me, U2 … as in the original library fight)', () => {
    const w = readBuiltinWords(pe, 1).map((e) => e.text);
    expect(w.length).toBe(41);
    expect(w).toContain('Me');
    expect(w).toContain('U2');
    expect(readBuiltinWords(pe, 0).map((e) => e.text).join('')).toBe('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  });

  it('word level (FUN_004b16b0): level = trunc((p + 5) × 0.1) — the first civilian scene (100) at rank 1 is level 1 ("Foul", Z000L010)', () => {
    expect([25, 50, 100, 150, 200, 600].map((b) => wordLevel(t, b, 1))).toEqual([0, 0, 1, 1, 1, 3]);
    expect([25, 50, 100, 150, 200, 600].map((b) => wordLevel(t, b, 5))).toEqual([0, 1, 1, 2, 2, 6]);
    expect([25, 50, 100, 150, 200, 600].map((b) => wordLevel(t, b, 12))).toEqual([2, 2, 3, 3, 4, 8]);
    expect(wordFileName(pe, 0, 5)).toBe('Z000L050.bin');
    expect(wordFileName(pe, 0, 20)).toBe('Z000L200.bin');
    expect(wordFileName(pe, 0, 21)).toBeUndefined();
  });

  it('word flags per type (@005a2848): zombies 1, daemon 0x4000804, props none', () => {
    expect([0x30, 0x22, 0x41, 0x20].map((ty) => readWordFlags(pe, ty))).toEqual([1, 0x4000804, 0, 0]);
  });
});
