/**
 * Classify and unpack every pol/ and tex/ file of a game install, and report.
 *   node --experimental-strip-types tools/unpack.ts ~/Downloads/TTOTD [--out dumps]
 * With --out, writes decompressed files to <out>/<folder>/<name> (gitignored; never commit).
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyBin, type StorageKind } from '../packages/formats/src/container.ts';

const [dir, flag, outDir] = process.argv.slice(2);
if (!dir) {
  console.error('usage: tools/unpack.ts <game dir> [--out <dir>]');
  process.exit(2);
}
const out = flag === '--out' ? outDir : undefined;

let failures = 0;
for (const folder of ['pol', 'tex']) {
  const names = readdirSync(join(dir, folder)).filter((n) => n.toLowerCase().endsWith('.bin')).sort();
  const kinds = new Map<StorageKind, { n: number; bytes: number; out: number }>();
  for (const n of names) {
    const file = new Uint8Array(readFileSync(join(dir, folder, n)));
    try {
      const c = classifyBin(`${folder}/${n}`.toLowerCase(), file);
      const k = kinds.get(c.kind) ?? { n: 0, bytes: 0, out: 0 };
      kinds.set(c.kind, { n: k.n + 1, bytes: k.bytes + file.length, out: k.out + c.data.length });
      if (out && c.kind !== 'save' && c.kind !== 'stub') {
        mkdirSync(join(out, folder), { recursive: true });
        writeFileSync(join(out, folder, n), c.data);
      }
    } catch (e) {
      failures++;
      console.log(`FAIL ${folder}/${n}: ${(e as Error).message}`);
    }
  }
  const mb = (n: number) => (n / 2 ** 20).toFixed(1) + ' MB';
  console.log(`${folder}: ${names.length} files`);
  for (const [k, v] of [...kinds].sort()) {
    console.log(`  ${k.padEnd(5)} ${String(v.n).padStart(4)}  ${mb(v.bytes)}${k === 'lz' ? ` → ${mb(v.out)} decompressed` : ''}`);
  }
}
console.log(failures ? `${failures} unrecognised files` : 'all files accounted for');
process.exit(failures ? 1 : 0);
