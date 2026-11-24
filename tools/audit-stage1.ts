// Stage 1 audit: what the data uses vs what the port handles (docs/stage1-unported.md).
// Run: TTOTD_DIR=<game folder> npx tsx tools/audit-stage1.ts
import { readFileSync } from 'fs'; import { join } from 'path';
import { PeImage, EventFile, EVT_COM_BASE, STAGE_EVENT_FILES, evtOpName, readCivilianCommand, civilianStartScript, readSpawnRecords } from '../packages/formats/src/index.ts';
const dir = process.env.TTOTD_DIR!;
const pe = new PeImage(new Uint8Array(readFileSync(join(dir, 'Tod_e.exe'))));
const ef = new EventFile(new Uint8Array(readFileSync(join(dir, 'evt', STAGE_EVENT_FILES[0]!))));
const com = new EventFile(new Uint8Array(readFileSync(join(dir, 'evt', 'comevtbl.bin'))), EVT_COM_BASE);
const src = readFileSync(new URL('../packages/formats/src/evtplayer.ts', import.meta.url), 'utf8');
const interp = src.slice(src.indexOf('private interpret()'));
const evHandled = new Set([...interp.slice(0, interp.indexOf('default: {')).matchAll(/case (0x[0-9a-f]+)/g)].map((m) => Number(m[1])));
const hex = (n: number) => '0x' + (n >>> 0).toString(16);

// --- event ops, camera modes, spawn records
const ops = new Map<number, { n: number; blocks: Set<number>; ex: string }>();
const cams = new Map<string, Set<number>>();
const spawnOffs: { rec: any; block: number }[] = [];
ef.blocks().forEach((b, bi) => {
  for (const sc of b.scripts) {
    let cmds; try { cmds = ef.script(sc); } catch { continue; }
    for (const c of cmds) {
      const e = ops.get(c.op) ?? { n: 0, blocks: new Set(), ex: c.words.slice(1, 5).map((w) => (Math.abs(w) < 0x10000 ? w : hex(w))).join(' ') };
      e.n++; e.blocks.add(bi); ops.set(c.op, e);
      if (c.op === 0x30 || c.op === 0x6c || c.op === 0x6d) {
        const mode = c.words[1]!; const key = mode === 0x21 ? `0x21 fight kind ${c.words[2]}` : mode === 0x40 ? `0x40 path (flag ${c.words[5] ?? 0})` : `${hex(mode)} [${c.words.slice(2, 6).join(', ')}]`;
        (cams.get(key) ?? cams.set(key, new Set()).get(key)!).add(bi);
      }
    }
  }
});
console.log('=== EVENT OPS (Stage 1) — handled = has its own code in the player; else only logged');
for (const [op, e] of [...ops].sort((a, b) => a[0] - b[0])) console.log(evHandled.has(op) ? '  ok ' : '  -- ', hex(op).padEnd(5), evtOpName(op).padEnd(26), 'x' + String(e.n).padEnd(4), 'blocks', [...e.blocks].join(','), ' e.g.', e.ex);
console.log('=== CAMERA MODES');
for (const [k, b] of [...cams].sort()) console.log('  ', k.padEnd(40), 'blocks', [...b].join(','));

// --- spawn records
const recs: { rec: any; block: number; child?: boolean }[] = [];
ef.blocks().forEach((b, bi) => { for (const sc of b.scripts) { let cmds; try { cmds = ef.script(sc); } catch { continue; }
  for (const c of cmds) if ([0x03, 0x07, 0x09, 0x0a, 0x0b, 0x0c].includes(c.op)) { let rs; try { rs = readSpawnRecords(ef, com, c.offset); } catch { continue; }
    for (const r of rs) { recs.push({ rec: r, block: bi }); for (const ch of r.children ?? []) recs.push({ rec: ch, block: bi, child: true }); } } } });
const byType = new Map<number, { n: number; blocks: Set<number>; kinds: Set<string> }>();
for (const { rec, block } of recs) { const e = byType.get(rec.type) ?? { n: 0, blocks: new Set(), kinds: new Set() }; e.n++; e.blocks.add(block); e.kinds.add(`kind ${rec.kind} hp ${rec.hp}`); byType.set(rec.type, e); }
console.log('=== SPAWN TYPES (records incl. civilian attackers)');
for (const [t, e] of [...byType].sort((a, b) => a[0] - b[0])) console.log('  ', hex(t).padEnd(5), 'x' + String(e.n).padEnd(4), 'blocks', [...e.blocks].join(','), ' ', [...e.kinds].slice(0, 4).join('; '));
console.log('=== ZOMBIES (0x30): behaviour → next, skeleton, param flags');
const zb = new Map<string, Set<number>>();
for (const { rec, block, child } of recs) if (rec.type === 0x30) { const t = rec.tail as Uint8Array; const k = `beh ${(t[2]! << 24) >> 24} → next ${(t[3]! << 24) >> 24}  skel ${(t[0]! << 24) >> 24} kind ${(t[1]! << 24) >> 24}  param ${hex(rec.param)}${child ? '  (civilian attacker)' : ''}`; (zb.get(k) ?? zb.set(k, new Set()).get(k)!).add(block); }
for (const [k, b] of [...zb].sort()) console.log('   ', k, ' blocks', [...b].join(','));
// civilians
console.log('=== CIVILIANS (0x10): kind → skeleton, blocks');
const kinds = new Map<number, Set<number>>();
for (const { rec, block } of recs) if (rec.type === 0x10) { const t = rec.tail as Uint8Array; const k = (t[1]! << 24) >> 24; (kinds.get(k) ?? kinds.set(k, new Set()).get(k)!).add(block); console.log('    kind', k, 'skel', (t[0]! << 24) >> 24, 'block', block, 'attackers', rec.children?.length ?? 0); }
const cOps = new Map<number, number>(), segBits = new Map<number, number>();
const seen = new Set<number>(); const todo = [...kinds.keys()].map((k) => civilianStartScript(pe, k));
while (todo.length) { let a = todo.shift()! >>> 0; if (!a || seen.has(a)) continue; seen.add(a);
  for (let g = 0; g < 200; g++) { const op = pe.i32(a); const c = readCivilianCommand(pe, a);
    if (!c) { if (op !== 0x2d && op <= 0x2d) cOps.set(op, (cOps.get(op) ?? 0) + 1); break; }
    cOps.set(c.op, (cOps.get(c.op) ?? 0) + 1);
    if (c.op === 0x2c) for (let bit = 0; bit < 32; bit++) if ((c.args[0]! >>> bit) & 1) segBits.set(1 << bit >>> 0, (segBits.get(1 << bit >>> 0) ?? 0) + 1);
    for (const v of c.args) if (v >>> 0 > 0x500000 && v >>> 0 < 0x520000 && [0x0e, 0x0f].includes(c.op)) todo.push(v >>> 0);
    a += (c.args.length + 1) * 4; } }
const civSrc = readFileSync(new URL('../packages/engine/src/objects/t10-civilian.ts', import.meta.url), 'utf8');
const ex = civSrc.slice(civSrc.indexOf('private exec('));
const civHandled = new Set([...ex.slice(0, ex.indexOf('default:')).matchAll(/case (0x[0-9a-f]+)/g)].map((m) => Number(m[1])));
console.log('=== CIVILIAN SCRIPT OPS (scripts reachable from the kinds above)');
for (const [op, n] of [...cOps].sort((a, b) => a[0] - b[0])) console.log(civHandled.has(op) ? '  ok ' : '  -- ', hex(op).padEnd(5), 'x' + n);
console.log('=== CIVILIAN SEGMENT FLAG BITS');
for (const [bit, n] of [...segBits].sort((a, b) => a[0] - b[0])) console.log('   ', hex(bit).padEnd(11), 'x' + n);
