/** The Stage 1 opening car against the user's install. Skipped unless TTOTD_DIR is set. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CameraFile, EventFile, EventPlayer, EVT_COM_BASE, pathLength, PeImage, readBlockRules, readCameraSlots, readDialogue } from '@ttotd/formats';
import { OpeningCar, OPENING_CAR_MODELS, TITLE_CARD_FLAG, TitleCard } from '../src/index.ts';

const dir = process.env.TTOTD_DIR;

describe('title card timing (FUN_00422c00)', () => {
  it('stays up 0xB4 frames; Enter ends it only once fewer than 0xA0 are left', () => {
    const t = new TitleCard();
    let n = 0;
    while (t.update(false)) n++;
    expect(n + 1).toBe(0xb4);
    const k = new TitleCard();
    for (let i = 0; i < 10; i++) k.update(true); // too early: ignored
    expect(k.done).toBe(false);
    for (let i = 0; i < 15; i++) k.update(false);
    k.update(true);
    expect(k.done).toBe(true);
  });
});

describe.skipIf(!dir)('opening car (real data)', () => {
  it('drives on camera paths 48–49, hides for the title card, parks with the doors open on path 50', () => {
    const pe = new PeImage(new Uint8Array(readFileSync(join(dir!, 'Tod_e.exe'))));
    const ef = new EventFile(new Uint8Array(readFileSync(join(dir!, 'evt', 'st1evtbl.bin'))));
    const common = new EventFile(new Uint8Array(readFileSync(join(dir!, 'evt', 'comevtbl.bin'))), EVT_COM_BASE);
    const slot = readCameraSlots(pe).find((s) => s.file === 'op_st1.bin')!;
    const op = new CameraFile(new Uint8Array(readFileSync(join(dir!, 'cam', slot.file))), slot.ids.length);
    const p = new EventPlayer(ef, { rules: readBlockRules(pe, 0), dialogue: (id) => readDialogue(pe, id, 0), common, followBlocks: false, holdFrames: 60 });
    p.start(0);
    let car: OpeningCar | undefined, title: TitleCard | undefined, seen = 0;
    const log: { path?: number; pos: number[]; moving: boolean; door: number; hidden: boolean }[] = [];
    for (let f = 0; f < 60 * 30 && !p.done; f++) {
      p.step();
      for (; seen < p.spawns.length; seen++) {
        const s = p.spawns[seen]!;
        if (s.type === 0x26 && s.hp === 1) car = new OpeningCar(s);
        if (s.type === 0x60) title = new TitleCard();
      }
      const hidden = title?.update(false) ?? false;
      if (title?.done) p.flags[TITLE_CARD_FLAG] = 1;
      car?.update({
        camPath: p.shot?.pathId ?? -1,
        camTime: p.timer,
        path: (id, t) => { const k = slot.ids.indexOf(id); return k < 0 ? undefined : op.objectSample(k, t); },
        length: (id) => pathLength(pe, id),
      });
      if (car) log.push({ path: p.shot?.pathId, pos: [...car.pos], moving: car.moving, door: car.door, hidden });
    }
    const on = (path: number) => log.filter((e) => e.path === path);
    // path 48: drives from far along −x towards the meeting point
    const p48 = on(48);
    expect(p48[0]!.moving).toBe(true);
    expect(p48[p48.length - 1]!.pos[0]! - p48[0]!.pos[0]!).toBeGreaterThan(400);
    // title card: hidden for 3 s right after the fly-over, and path 49 only starts once it is over
    expect(log.filter((e) => e.hidden).length).toBe(0xb4 - 1);
    const lastHidden = log.reduce((last, e, i) => (e.hidden ? i : last), -1), first49 = log.findIndex((e) => e.path === 49);
    expect(first49).toBeGreaterThan(lastHidden);
    expect(log[first49]!.pos[0]!).toBeLessThan(-500); // the car starts path 49 at the far end of its route
    // path 50: parked where path 0x120 ends, doors open
    const p50 = on(50);
    expect(p50.every((e) => !e.moving)).toBe(true);
    const [x, y, z] = p50[p50.length - 1]!.pos;
    expect(x).toBeCloseTo(-64, 0);
    expect(y).toBeCloseTo(0, 1);
    expect(z).toBeCloseTo(137.5, 0);
    expect(p50[p50.length - 1]!.door).toBeGreaterThan(0x3000);
    // draw list: body, figures, doors, wheels, plus dust while moving
    const parked = car!.draw(0).map((d) => d.model);
    expect(parked).toEqual([0x1603, 0x1608, 0x8c9, 0x8fd, 0x1606, 0x1607, 0x1604, 0x1605, 0x1609, 0x160a]);
    for (const m of parked) expect(OPENING_CAR_MODELS).toContain(m);
  });
});
