/** Decode every texture of the user's install. Skipped unless TTOTD_DIR is set. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyBin } from '../src/container.ts';
import { PeImage } from '../src/pe.ts';
import { decodeTexture, layoutOf } from '../src/pvr.ts';
import { paletteBankFn, paletteBankFor, readPalettes, readTextureSets } from '../src/texsets.ts';

const dir = process.env.TTOTD_DIR;

describe.skipIf(!dir)('textures (real data)', () => {
  const pe = () => new PeImage(new Uint8Array(readFileSync(join(dir!, 'Tod_e.exe'))));

  it('reads 548 texture sets / 11913 descriptors and 59 palette banks from the exe', () => {
    const p = pe();
    const sets = readTextureSets(p);
    expect(sets.length).toBe(548);
    expect(sets.reduce((n, s) => n + s.textures.length, 0)).toBe(11913);
    expect(readPalettes(p).length).toBe(59);
  });

  it('palette switch: every jump-table entry maps to a known handler', () => {
    const p = pe();
    for (let set = 0x164; set <= 0x164 + 0xbe; set++) for (const i of [-1, 0, 1, 0x11, 0x17, 0x40, 0x100, 0x200]) paletteBankFn(p, set, i);
  });

  it('decodes every texture', () => {
    const p = pe();
    const palettes = readPalettes(p);
    const layouts = new Map<number, number>();
    let decoded = 0;
    const errors: string[] = [];
    for (const set of readTextureSets(p)) {
      if (!set.textures.length) continue;
      const path = join(dir!, 'tex', set.name);
      if (!existsSync(path)) { errors.push(`${set.name}: missing file`); continue; }
      const { data } = classifyBin(`tex/${set.name}`.toLowerCase(), new Uint8Array(readFileSync(path)));
      set.textures.forEach((t, i) => {
        try {
          const bank = paletteBankFor(p, set, i);
          expect(bank).toBeLessThan(palettes.length);
          const rgba = decodeTexture(t, data, palettes[bank]);
          expect(rgba.length).toBe(t.width * t.height * 4);
          layouts.set(layoutOf(t.type), (layouts.get(layoutOf(t.type)) ?? 0) + 1);
          decoded++;
        } catch (e) {
          errors.push(`${set.name}#${i}: ${(e as Error).message}`);
        }
      });
    }
    expect(errors.slice(0, 10)).toEqual([]);
    expect(decoded).toBe(11913);
  });
});
