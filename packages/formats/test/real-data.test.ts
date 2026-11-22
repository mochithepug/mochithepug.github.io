/**
 * Optional checks against the user's own game install. Skipped unless TTOTD_DIR is set:
 *   TTOTD_DIR=~/Downloads/TTOTD npm test
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseWav } from '../src/wav.ts';
import { classifyBin, type StorageKind } from '../src/container.ts';

const dir = process.env.TTOTD_DIR;

function* walk(d: string): Generator<string> {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

describe.skipIf(!dir)('real game data', () => {
  it('every WAV is 16-bit PCM the browser can decode', () => {
    const wavs = [...walk(join(dir!, 'sound'))].filter((p) => p.toLowerCase().endsWith('.wav'));
    expect(wavs.length).toBe(1314);
    const bad: string[] = [];
    for (const p of wavs) {
      const b = readFileSync(p);
      const w = parseWav(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
      if (w.formatTag !== 1 || w.bitsPerSample !== 16 || w.frames === 0) bad.push(p);
    }
    expect(bad).toEqual([]);
  });

  it('every pol/ and tex/ file is accounted for, and every LZ file decompresses exactly', () => {
    const tally = (folder: string) => {
      const t: Partial<Record<StorageKind, number>> = {};
      for (const n of readdirSync(join(dir!, folder))) {
        const b = new Uint8Array(readFileSync(join(dir!, folder, n)));
        const k = classifyBin(`${folder}/${n}`.toLowerCase(), b).kind;
        t[k] = (t[k] ?? 0) + 1;
      }
      return t;
    };
    expect(tally('pol')).toEqual({ lz: 257, raw: 98, save: 3 });
    expect(tally('tex')).toEqual({ lz: 438, raw: 87, save: 1, bmp: 3, stub: 24 });
  });
});
