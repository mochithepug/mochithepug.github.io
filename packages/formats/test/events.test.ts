import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVT_TERMINATORS, EventFile, readBlockRules, readSpawnRecords, STAGE_EVENT_FILES } from '../src/events.ts';
import { PeImage } from '../src/pe.ts';

const dir = process.env.TTOTD_DIR;
describe.skipIf(!dir)('event scripts (real evt/ + exe)', () => {
  const pe = new PeImage(new Uint8Array(readFileSync(join(dir!, 'Tod_e.exe'))));
  const load = (f: string) => new EventFile(new Uint8Array(readFileSync(join(dir!, 'evt', f))));

  it('every script of every stage decodes into whole commands ending on a terminator, before the next script', () => {
    for (const f of STAGE_EVENT_FILES) {
      const ef = load(f);
      const starts = [...new Set(ef.blocks().flatMap((b) => b.scripts))].sort((a, b) => a - b);
      expect(starts.length, f).toBeGreaterThan(20);
      starts.forEach((s, i) => {
        const cmds = ef.script(s);
        const last = cmds[cmds.length - 1]!;
        expect(EVT_TERMINATORS.has(last.op), `${f} script 0x${s.toString(16)}`).toBe(true);
        const end = last.offset + last.words.length * 4;
        expect(end, `${f} script 0x${s.toString(16)}`).toBeLessThanOrEqual(starts[i + 1] ?? ef.data.length);
      });
    }
  });

  it('stage n uses block-rule table n − 1 (one rule per block)', () => {
    STAGE_EVENT_FILES.forEach((f, i) => expect(readBlockRules(pe, i).length, f).toBe(load(f).blocks().length));
    expect(readBlockRules(pe, 0)[1]).toEqual({ kind: 1, targets: [10, 9, -1] }); // Stage 1 block 1 branches
  });

  it('spawn records decode from Stage 1 (op 0x09 and 0x0A)', () => {
    const ef = load('st1evtbl.bin');
    const common = new EventFile(new Uint8Array(readFileSync(join(dir!, 'evt', 'comevtbl.bin'))), 0x0ceb5800);
    const cmds = ef.blocks().flatMap((b) => b.scripts.flatMap((s) => ef.script(s)));
    const spawns09 = cmds.filter((c) => c.op === 0x09);
    const spawns0a = cmds.filter((c) => c.op === 0x0a);
    expect(spawns09.length).toBeGreaterThan(10);
    expect(spawns0a.length).toBeGreaterThan(2);
    for (const c of spawns09) {
      const recs = readSpawnRecords(ef, common, c.offset);
      expect(recs.length).toBeGreaterThan(0);
      for (const r of recs) {
        expect(r.pos).toBeDefined();
        expect(r.type).toBeGreaterThanOrEqual(0);
      }
    }
    // 0x0A records (simple, no position)
    for (const c of spawns0a) {
      const recs = readSpawnRecords(ef, common, c.offset);
      expect(recs.length).toBeGreaterThan(0);
      for (const r of recs) expect(r.pos).toBeUndefined();
    }
    // Block 0's first 0x09 is a placed object with type 0x41
    const first09 = spawns09[0]!;
    const firstRecs = readSpawnRecords(ef, common, first09.offset);
    expect(firstRecs[0]!.type).toBe(0x41);
    // The opening's first wave (op 0x07, two-player): type 0x30, skeleton 7 (znsam2), 100 HP
    const wave = readSpawnRecords(ef, common, cmds.find((c) => c.op === 0x07)!.offset);
    expect(wave.map((r) => [r.type, r.skeleton, r.hp])).toEqual([[0x30, 7, 100], [0x30, 7, 100], [0x30, 7, 100]]);
  });

  it('Stage 1 has five skippable scenes and opens with dialogue 1 after the first one', () => {
    const ef = load('st1evtbl.bin');
    const cmds = ef.blocks().flatMap((b) => b.scripts.flatMap((s) => ef.script(s)));
    const skips = cmds.filter((c) => c.op === 0x2c).map((c) => c.words[1]);
    expect(skips).toEqual([1, 0, 1, 0, 1, 0, 1, 0, 1, 0]);
    const firstOff = cmds.findIndex((c) => c.op === 0x2c && c.words[1] === 0);
    const firstSay = cmds.findIndex((c) => c.op === 0x2d);
    expect(firstSay).toBeGreaterThan(firstOff);
    expect(cmds[firstSay]!.words[1]! & 0xffff).toBe(1); // "We're meeting G over there."
  });
});

describe.skipIf(!dir)('event player (Stage 1 block 0)', async () => {
  const { EventPlayer } = await import('../src/evtplayer.ts');
  const { readDialogue } = await import('../src/dialogue.ts');
  const { EVT_COM_BASE } = await import('../src/events.ts');
  it('plays the opening in the order the user saw: path 0, then path 1 with line 1, then lines 2–6, then the first fight', () => {
    const pe = new PeImage(new Uint8Array(readFileSync(join(dir!, 'Tod_e.exe'))));
    const ef = new EventFile(new Uint8Array(readFileSync(join(dir!, 'evt', 'st1evtbl.bin'))));
    const common = new EventFile(new Uint8Array(readFileSync(join(dir!, 'evt', 'comevtbl.bin'))), EVT_COM_BASE);
    const p = new EventPlayer(ef, { rules: readBlockRules(pe, 0), dialogue: (id) => readDialogue(pe, id, 0) ?? readDialogue(pe, id, 2), common, followBlocks: false, holdFrames: 60 });
    p.start(0);
    for (let i = 0; i < 60 * 120 && !p.done; i++) p.step();
    expect(p.done).toBe(true);
    const order = p.log.filter((e) => e.kind === 'say' || /^camera path|^fight \d/.test(e.text)).map((e) => (e.kind === 'say' ? e.text.split(':')[0] : e.text.split(',')[0]));
    expect(order).toEqual(['camera path 48', 'camera path 49', 'say 1', 'say 2', 'say 3', 'camera path 50', 'say 4', 'camera path 50', 'say 5', 'camera path 50', 'say 6', expect.stringMatching(/^fight 4/)]);
    const say1 = p.log.find((e) => e.text.startsWith('say 1'))!;
    expect(say1.timer).toBe(6);
    expect(say1.frame).toBeGreaterThan(230);
    // spawns should include both positioned (0x09) and system (0x0A) records
    expect(p.spawns.length).toBeGreaterThan(2);
    const positioned = p.spawns.filter((s) => s.pos !== undefined);
    const system = p.spawns.filter((s) => s.pos === undefined);
    expect(positioned.length).toBeGreaterThan(0);
    expect(system.length).toBeGreaterThan(0);
    expect(positioned[0]!.type).toBe(0x41); // first placed object
  });
});
