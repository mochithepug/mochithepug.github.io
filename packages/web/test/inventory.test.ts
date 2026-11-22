/** Install check against the user's own copy. Skipped unless TTOTD_DIR is set. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normPath, type GameFS } from '../src/ingest/gamefs';
import { buildReport } from '../src/ingest/inventory';

const dir = process.env.TTOTD_DIR;

function nodeFS(root: string): GameFS {
  const files: { key: string; path: string; size: number }[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (n === '.DS_Store') continue;
      if (statSync(p).isDirectory()) walk(p);
      else files.push({ key: normPath(relative(root, p)), path: relative(root, p), size: statSync(p).size });
    }
  };
  walk(root);
  const byKey = new Map(files.map((f) => [f.key, f]));
  return {
    name: 'TTOTD',
    files,
    has: (p) => byKey.has(normPath(p)),
    read: async (p) => {
      const b = readFileSync(join(root, byKey.get(normPath(p))!.path));
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    },
  };
}

describe.skipIf(!dir)('install check on real data', () => {
  it('recognises a complete English v1.0 install', async () => {
    const r = await buildReport(nodeFS(dir!));
    expect(r.exe.status).toBe('ok');
    expect(r.categories.filter((c) => c.status !== 'ok').map((c) => `${c.category.id}: ${c.note}`)).toEqual([]);
    expect(r.other.files.map((f) => f.key).sort()).toEqual(
      ['mscache.sys', 'myth.acm', 'mythxpak.exe', 'setup.bat', 'tod.reg', 'tod_e.exe', 'sound/se/etc/mscache.sys', 'sound/se/mscache.sys', 'sound/voice/st1/mscache.sys'].sort(),
    );
  });
});
