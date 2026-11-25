import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CollisionFiles, coliFileName, segmentHit } from '../src/coli.ts';
import { PeImage } from '../src/pe.ts';

const dir = process.env.TTOTD_DIR;
describe.skipIf(!dir)('collision meshes (real coli/ + exe)', () => {
  const pe = () => new PeImage(new Uint8Array(readFileSync(join(dir!, 'Tod_e.exe'))));
  const files = () => {
    const p = pe(), read = (n: string) => new Uint8Array(readFileSync(join(dir!, 'coli', n)));
    return new CollisionFiles(read(coliFileName(p, 0)), read(coliFileName(p, 1)));
  };
  const floor = (c: CollisionFiles, ptr: number, x: number, y: number, z: number) => {
    const m = c.mesh(ptr);
    return m && segmentHit(m, [x, y - 1000, z], [x, y, z]);
  };

  it('load_coli names: coli0.bin always, coli1.bin for Stage 1', () => {
    expect([coliFileName(pe(), 0), coliFileName(pe(), 1)]).toEqual(['coli0.bin', 'coli1.bin']);
  });

  it('a mesh at a DC pointer (event op 0x10): groups, box, 18-word faces; the first face of coli1 is a floor', () => {
    const m = files().mesh(0x0cecf000)!;
    expect(m.length).toBe(1);
    expect(m[0]!.faces.length).toBe(4);
    const f = m[0]!.faces[0]!;
    expect(f.plane[1]).toBeCloseTo(1, 3); // facing up
    expect(f.plane[3]).toBeCloseTo(-6.19, 1);
    expect(f.axis).toBe(1); // tested in x–z
  });

  it('FUN_004c3620: a downward segment finds block 1’s floor; block 3’s mesh is only the window wall (no floor)', () => {
    const c = files();
    const hit = floor(c, 0x0cecf000, 0, 10, -150);
    expect(hit?.material).toBe(52);
    expect(hit!.point[1]).toBeGreaterThan(6);
    expect(hit!.point[1]).toBeLessThan(10);
    expect(floor(c, 0x0ced0368, -305.7, 47.5, -535.3)).toBeUndefined();
  });
});
