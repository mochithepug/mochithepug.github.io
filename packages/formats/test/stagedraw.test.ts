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
