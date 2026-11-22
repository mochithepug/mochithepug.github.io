/** Parse every model of the user's install. Skipped unless TTOTD_DIR is set. */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyBin } from '../src/container.ts';
import { PeImage } from '../src/pe.ts';
import { parsePolFile } from '../src/pol.ts';
import { ADDRESS_TABLE, CULL_TABLE, DESTBLEND_TABLE, SRCBLEND_TABLE, ZFUNC_TABLE } from '../src/renderstate.ts';
import { readTextureSets } from '../src/texsets.ts';

const dir = process.env.TTOTD_DIR;

describe.skipIf(!dir)('models (real data)', () => {
  it('parses every model; mesh sizes match exactly; texture indices fit the paired set', () => {
    const pe = new PeImage(new Uint8Array(readFileSync(join(dir!, 'Tod_e.exe'))));
    const sets = new Map(readTextureSets(pe).map((s) => [s.name.toLowerCase(), s]));
    let files = 0, models = 0, meshes = 0, verts = 0, badTex = 0;
    const errors: string[] = [];
    for (const n of readdirSync(join(dir!, 'pol'))) {
      const key = `pol/${n}`.toLowerCase();
      const c = classifyBin(key, new Uint8Array(readFileSync(join(dir!, 'pol', n))));
      if (c.kind !== 'lz' && c.kind !== 'raw') continue;
      try {
        const ms = parsePolFile(c.data);
        const set = sets.get(n.toLowerCase());
        files++;
        models += ms.length;
        for (const m of ms) for (const mesh of m.meshes) {
          meshes++;
          for (const p of mesh.prims) verts += p.vertices.length / 8;
          if (set?.textures.length && mesh.texture >= set.textures.length) badTex++;
        }
      } catch (e) {
        errors.push(`${n}: ${(e as Error).message}`);
      }
    }
    expect(errors).toEqual([]);
    expect({ files, models, meshes, verts, badTex }).toEqual({ files: 355, models: 10022, meshes: 44817, verts: 2080932, badTex: 0 });
  });

  it('render-state tables match the exe', () => {
    const pe = new PeImage(new Uint8Array(readFileSync(join(dir!, 'Tod_e.exe'))));
    const read = (a: number, n: number) => Array.from({ length: n }, (_, i) => pe.u32(a + i * 4));
    expect(read(0x005eb8c0, 8)).toEqual([...ZFUNC_TABLE]);
    expect(read(0x005eb870, 8)).toEqual([...SRCBLEND_TABLE]);
    expect(read(0x005eb890, 8)).toEqual([...DESTBLEND_TABLE]);
    expect(read(0x005eb8b0, 4)).toEqual([...ADDRESS_TABLE]);
    expect(read(0x005eb8e0, 4)).toEqual([...CULL_TABLE]);
  });
});
