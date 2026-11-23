/** Skin pieces against the user's install (skipped unless TTOTD_DIR is set). */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyBin } from '../src/container.ts';
import { modelRef } from '../src/character.ts';
import { parsePolFile } from '../src/pol.ts';
import { PeImage } from '../src/pe.ts';
import { readSkins } from '../src/skin.ts';

const dir = process.env.TTOTD_DIR;

describe.skipIf(!dir)('skin pieces (real data)', () => {
  const pe = new PeImage(new Uint8Array(readFileSync(join(dir!, 'Tod_e.exe'))));
  const skins = readSkins(pe);

  it('znsam2 has the belly piece: model 0x2298, torso (joint 1) → reference waist (joint 9), 8 of 16 slots moved', () => {
    const [belly] = skins[7]!;
    expect(belly!.model).toBe(0x2298);
    expect(belly!.joints).toEqual([1, 1, 9, 0, 9]);
    expect(belly!.apply).toEqual([0]);
    expect(belly!.slots.length).toBe(16);
    expect(Array.from(belly!.groups[0]!.slotEntry).filter((e) => e >= 0).length).toBe(8);
  });

  it('zskamere (skeleton 0x17) has its belly piece (draw function 0x490290 = the standard A0 one), model 0x2378', () => {
    const pieces = skins[0x17]!;
    expect(pieces.map((p) => p.model)).toEqual([0x2378]);
    expect(pieces[0]!.apply).toEqual([0]);
  });

  it('every slot of every skin piece writes vertex records that exist in its model', () => {
    let checked = 0;
    for (const pieces of skins) for (const p of pieces) {
      const ref = modelRef(pe, p.model)!;
      const m = parsePolFile(classifyBin(`pol/${ref.file}`, new Uint8Array(readFileSync(join(dir!, 'pol', ref.file)))).data)[ref.index]!;
      const sources = new Set<number>();
      for (const me of m.meshes) for (const pr of me.prims) pr.sources.forEach((s) => sources.add(s));
      for (const offs of p.slots) for (const o of offs) {
        expect(sources.has(o)).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(2000);
  });
});
