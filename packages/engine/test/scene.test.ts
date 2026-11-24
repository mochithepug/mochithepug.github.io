/** Ported objects in Stage 1 against the user's install (skipped unless TTOTD_DIR is set). */
import { describe, expect, it } from 'vitest';
import { blendAngles, Civilian, hurtPlayer, Daemon, heading, OpeningCar, OPENING_CAR_MODELS, TitleCard, turnTowards, Zombie } from '../src/index.ts';
import { loadScene } from './scene.ts';

const dir = process.env.TTOTD_DIR;

describe('title card timing (FUN_00422c00)', () => {
  it('stays up 0xB4 frames; Enter ends it only once fewer than 0xA0 are left', () => {
    const t = new TitleCard();
    let n = 0;
    while (t.tick(false)) n++;
    expect(n + 1).toBe(0xb4);
    const k = new TitleCard();
    for (let i = 0; i < 10; i++) k.tick(true); // too early: ignored
    expect(k.done).toBe(false);
    for (let i = 0; i < 15; i++) k.tick(false);
    k.tick(true);
    expect(k.done).toBe(true);
  });
});

describe('rotation blend (FUN_00476550)', () => {
  it('starts at A, ends at B, and goes the short way between', () => {
    const a = [0x1000, -0x2000, 0x0800], b = [-0x0800, 0x1800, 0x3000];
    const close = (x: number[], y: number[]) => x.every((v, i) => Math.abs(((v - y[i]! + 0x18000) % 0x10000) - 0x8000) <= 3);
    expect(close(blendAngles(a, b, 0), a)).toBe(true);
    expect(close(blendAngles(a, b, 1), b)).toBe(true);
    expect(close(blendAngles([0, 0, 0], [0, 0x2000, 0], 0.5), [0, 0x1000, 0])).toBe(true);
  });
});

describe('turning (FUN_004371d0)', () => {
  it('steps towards the target the short way, and lands on it when close', () => {
    expect(turnTowards(0x1000, 0x2000, 0x100)).toBe(0x1100);
    expect(turnTowards(0x2000, 0x1000, 0x100)).toBe(0x1f00);
    expect(turnTowards(0xff00, 0x0100, 0x100)).toBe(0x10000); // across 0: up, not all the way round
    expect(turnTowards(0x1000, 0x1050, 0x100)).toBe(0x1050);
  });
});

describe.skipIf(!dir)('Stage 1 opening with the ported objects (real data)', () => {
  const run = (frames: number, block = 0) => {
    const s = loadScene(dir!, 1, block);
    const log: { f: number; path: number; t: number; title: boolean }[] = [];
    const daemon: { f: number; behaviour: number; motion: number; pos: number[]; items: number; dead?: boolean }[] = [];
    for (let f = 0; f < frames; f++) {
      s.step();
      log.push({ f, path: s.world.camPath, t: s.world.camTime, title: s.world.titleUp });
      const d = s.objects.find((o) => o.obj instanceof Daemon)?.obj as Daemon | undefined;
      if (d) daemon.push({ f, behaviour: d.behaviour, motion: d.body.motion, pos: [...d.place.pos], items: d.draw().length, dead: d.dead });
    }
    return { s, log, daemon };
  };

  it('the car drives on paths 48–49, hides for the title card, parks with the doors open on path 50', () => {
    const { s, log } = run(60 * 30);
    const car = s.objects.find((o) => o.obj instanceof OpeningCar)!.obj as OpeningCar;
    expect(log.filter((e) => e.title).length).toBe(0xb4 - 1);
    expect(car.moving).toBe(false);
    expect(car.pos[0]).toBeCloseTo(-64, 0);
    expect(car.pos[2]).toBeCloseTo(137.5, 0);
    expect(car.door).toBeGreaterThan(0x3000);
    const parked = car.draw({ frame: 0, titleUp: false }).map((d) => d.model);
    expect(parked).toEqual([0x1603, 0x1608, 0x8c9, 0x8fd, 0x1606, 0x1607, 0x1604, 0x1605, 0x1609, 0x160a]);
    for (const m of parked) expect(OPENING_CAR_MODELS).toContain(m);
    expect(car.draw({ frame: 0, titleUp: true })).toEqual([]);
  });

  it('the daemon: rooftop, motion 0x448 at camera time 70, hidden for the title card, path 1, flies off, gone at path 50 time 400', () => {
    const { daemon } = run(60 * 30);
    const first = daemon[0]!;
    expect(first.pos.map(Math.round)).toEqual([-406, 153, 142]); // on the rooftop
    expect(first.motion).toBe(1102); // record +0x26
    expect(first.items).toBe(26); // body 15 parts + 2 eyes + body skin + wings 6 + 2 wing skins
    expect(daemon.some((d) => d.motion === 0x448)).toBe(true);
    expect(daemon.some((d) => d.motion === 1092)).toBe(true); // after 0x448 ends
    const b1 = daemon.filter((d) => d.behaviour === 1 && d.items > 0);
    expect(b1.length).toBeGreaterThan(0);
    expect(daemon.some((d) => d.motion === 1103)).toBe(true); // talking, camera time 280 on path 49
    expect(daemon.some((d) => d.motion === 1099)).toBe(true); // camera time 240 on path 50
    const flying = b1.filter((d) => d.pos[1]! > 100);
    expect(flying.length).toBeGreaterThan(0); // rises on path 50
    expect(daemon[daemon.length - 1]!.dead).toBe(true);
  });

  it('the first wave: three znsam2 zombies (one-player list), waiting motions, feet on the ground', () => {
    const s = loadScene(dir!, 1, 0);
    let zombies: Zombie[] = [];
    for (let f = 0; f < 60 * 30 && zombies.length === 0; f++) {
      s.step();
      zombies = s.objects.map((o) => o.obj).filter((o): o is Zombie => o instanceof Zombie);
    }
    for (let f = 0; f < 10; f++) s.step();
    expect(zombies.length).toBe(3);
    expect(zombies.map((z) => z.skeleton)).toEqual([7, 7, 7]);
    expect(zombies.map((z) => z.rig.motion).sort()).toEqual([1052, 1053, 1064]);
    for (const z of zombies) {
      const feet = Math.min(...z.rig.joints.filter(Boolean).map((j) => j!.matrix[13]!));
      expect(Math.abs(feet - z.place.pos[1])).toBeLessThan(1.5);
      expect(z.draw().length).toBe(16); // 15 parts + the belly skin
      expect(z.draw()[15]!.patch!.length).toBe(8);
    }
  });

  it('the first wave takes turns attacking: one at a time, swing 0x42e hits for 9, back off 0x429, slot freed', () => {
    const s = loadScene(dir!, 1, 0, 60 * 40);
    let maxAttackers = 0;
    const swung = new Set<number>();
    for (let f = 0; f < 60 * 60; f++) {
      s.step();
      const zs = s.objects.map((o) => o.obj).filter((o): o is Zombie => o instanceof Zombie);
      const attacking = zs.filter((z) => z.behaviour === 3 || z.behaviour === 4);
      maxAttackers = Math.max(maxAttackers, attacking.length);
      zs.forEach((z, i) => z.behaviour === 3 && z.rig.motion === 0x42e && swung.add(i));
    }
    expect(maxAttackers).toBe(1); // one attack slot for the player
    expect(swung.size).toBe(3); // every zombie gets a turn
    expect(s.hits.length).toBeGreaterThanOrEqual(3);
    for (const h of s.hits) expect([h.player, h.hit, h.damage]).toEqual([0, 1, 9]);
  });

  it('hits cost a life and lower the word rank by 2 (FUN_004846d0 / FUN_00451ff0); 0x5A frames of grace', () => {
    const s = loadScene(dir!, 1, 0, Infinity);
    const me = s.world.players![0]!;
    expect(me.lives).toBe(3); // @004f2ba0[2]
    const counted: { frame: number; rank: number }[] = [];
    let lastHits = 0, rankBefore = 0;
    for (let f = 0; f < 60 * 40 && me.lives > 0; f++) {
      rankBefore = s.world.words!.rank;
      s.step(); // nobody types: the zombies keep hitting
      if (me.hits > lastHits) {
        counted.push({ frame: f, rank: rankBefore });
        lastHits = me.hits;
      }
    }
    expect(counted.length).toBe(3); // three lives, then 0 (game over not ported)
    expect(me.lives).toBe(0);
    for (let i = 1; i < counted.length; i++) expect(counted[i]!.frame - counted[i - 1]!.frame).toBeGreaterThanOrEqual(0x5a);
    // a second hit within the grace time does not count
    const t = loadScene(dir!, 1, 0, Infinity), p = t.world.players![0]!;
    expect([hurtPlayer(t.world, 0), hurtPlayer(t.world, 0), p.lives]).toEqual([true, false, 2]);
    for (let i = 0; i < 0x5a; i++) t.step();
    expect(hurtPlayer(t.world, 0)).toBe(true);
    // each counted hit: rank −2 on the next update (never below 0)
    expect(s.world.words!.rank).toBeLessThanOrEqual(Math.max(0, counted[0]!.rank - 2 * 3 + 2));
  });

  it('the fight ends when its enemies are dead (FUN_0040cda0), not before — last body sinks first (flag 0x800000)', () => {
    const s = loadScene(dir!, 1, 0, Infinity);
    let fightFrames = 0, words: string[] = [], over = -1, lastSunk = -1;
    for (let f = 0; f < 60 * 70 && over < 0; f++) {
      s.step();
      if (s.world.inFight) fightFrames++;
      const shown = s.boxes.boxes.filter((b) => b.shown);
      if (!words.length && shown.length === 3 && fightFrames > 60 * 20) {
        words = shown.map((b) => b.word!);
        s.type(words.join('')); // after 20 s of fighting: no hold ends it any more
      }
      const zs = s.objects.map((o) => o.obj).filter((o): o is Zombie => o instanceof Zombie);
      if (words.length && lastSunk < 0 && zs.length && zs.every((z) => z.dead)) lastSunk = f;
      if (s.player.log.some((e) => e.text.startsWith('fight over'))) over = f;
    }
    expect(fightFrames).toBeGreaterThan(60 * 20);
    expect(over).toBeGreaterThan(0);
    expect(lastSunk).toBeGreaterThan(0);
    expect(over - lastSunk).toBeGreaterThan(0); // not before the last body is gone …
    expect(over - lastSunk).toBeLessThanOrEqual(120); // … then the camera turns back to the path (FUN_0040ce90)
    expect([s.world.attackers, s.world.enemies]).toEqual([0, 0]);
  });

  it('typing the first wave: first key targets, letters hide, words kill — death motions, sink, enemies 3 → 0', () => {
    const s = loadScene(dir!, 1, 0, 60 * 40);
    let words: string[] = [];
    let partly = false;
    const deaths = new Set<number>();
    for (let f = 0; f < 60 * 45; f++) {
      s.step();
      const shown = s.boxes.boxes.filter((b) => b.shown);
      if (!words.length && shown.length === 3) {
        words = shown.map((b) => b.word!);
        expect(s.world.enemies).toBe(3);
        s.type(words[0]![0]!); // one key: target + first letter
      } else if (words.length && !partly) {
        partly = true;
        const b = s.boxes.boxes.find((x) => x.word === words[0])!;
        expect(b.targeted).toBe(true);
        expect(b.typed).toBe(1);
        expect(s.world.targets[0]).toBe(b.slot);
        s.type(words[0]!.slice(1) + words[1] + words[2]);
      }
      for (const o of s.objects) if (o.obj instanceof Zombie && o.obj.behaviour === 6) deaths.add(o.obj.rig.motion);
    }
    expect(words.length).toBe(3);
    expect(s.world.enemies).toBe(0);
    expect(s.world.targets[0]).toBe(-1);
    expect(s.objects.filter((o) => o.obj instanceof Zombie && !o.obj.dead).length).toBe(0);
    expect(s.boxes.boxes.length).toBe(0);
    for (const m of deaths) expect([0x412, 0x413, 0x414, 0x415, 0x416, 0x417, 0x418, 0x419]).toContain(m);
  });

  it('Esc (key ")") cancels the target: the word starts again and another zombie can be picked', () => {
    const s = loadScene(dir!, 1, 0, 60 * 40);
    let step = 0;
    let words: string[] = [];
    for (let f = 0; f < 60 * 35 && step < 4; f++) {
      s.step();
      const shown = s.boxes.boxes.filter((b) => b.shown);
      const box = (w: string) => s.boxes.boxes.find((b) => b.word === w)!;
      if (step === 0 && shown.length === 3) {
        words = shown.map((b) => b.word!);
        s.type(words[0]![0]!);
        step = 1;
      } else if (step === 1 && box(words[0]!).typed === 1) {
        s.type(')');
        step = 2;
      } else if (step === 2 && s.world.targets[0] === -1) {
        expect(box(words[0]!).typed).toBe(0);
        expect(box(words[0]!).targeted).toBe(false);
        s.type(words[1]![0]!);
        step = 3;
      } else if (step === 3 && s.world.targets[0] !== -1) {
        expect(s.world.targets[0]).toBe(box(words[1]!).slot);
        expect(box(words[1]!).typed).toBe(1);
        step = 4;
      }
    }
    expect(step).toBe(4);
  });

  it('third wave (block 1): one zombie, then op 0x44/0x31, two rise at camera times 265 / 304 in moving fight 6', () => {
    const s = loadScene(dir!, 1, 1, Infinity);
    let busy = 0;
    const rose: { t: number; fight?: number }[] = [];
    const spawned: number[] = [];
    const seen = new Set<Zombie>();
    for (let f = 0; f < 1300 && !s.player.done; f++) {
      s.step();
      if (busy > 0) busy--;
      if (s.world.inFight && s.world.targets[0] === -1 && !busy) {
        const b = s.boxes.boxes.find((x) => x.shown && x.typed === 0);
        if (b) {
          s.type(b.word!);
          busy = b.word!.length + 2;
        }
      }
      for (const o of s.objects) {
        const z = o.obj;
        if (!(z instanceof Zombie) || z.skeleton !== 8 || seen.has(z)) continue;
        if (z.behaviour === 13 && !spawned.includes(f)) spawned.push(f);
        const box = s.boxes.boxes.find((b) => b.owner === z);
        if (z.behaviour === 13 && z.state === 1) expect(box?.shown ?? false).toBe(false); // lying: no word box
        if (z.behaviour === 13 && z.state === 2) {
          rose.push({ t: s.world.camTime, fight: s.player.shot?.fightKind });
          seen.add(z);
        }
      }
    }
    const ops = s.player.log.map((e) => e.text);
    const firstFightOver = s.player.log.find((e) => e.text.startsWith('fight ends') && e.frame > 400)!.frame;
    expect(Math.min(...spawned)).toBeGreaterThanOrEqual(firstFightOver); // spawned after the first zombie
    expect(rose.length).toBe(2);
    expect(rose[0]!.t).toBeGreaterThanOrEqual(265); // record cues: camera time 265 and 304
    expect(rose[0]!.t).toBeLessThanOrEqual(267);
    expect(rose[1]!.t).toBeGreaterThanOrEqual(304);
    expect(rose[1]!.t).toBeLessThanOrEqual(306);
    expect(rose.every((r) => r.fight === 6 && r.t >= 265)).toBe(true);
    expect(ops.some((t) => t.startsWith('camera path 52, time 306'))).toBe(true); // the stage moves on
  });

  /** Block 1 with a typing bot; `saveHer`: type the second civilian's zombie as soon as it shows. */
  const civilianRun = (saveHer: boolean) => {
    const s = loadScene(dir!, 1, 1, Infinity);
    let busy = 0;
    let killedAt = -1, firstAt = -1, secondKind = -1, herLog: string[] = [];
    let chased = false;
    for (let f = 0; f < 5200 && !s.player.done; f++) {
      s.step();
      if (busy > 0) busy--;
      if (s.world.inFight && s.world.targets[0] === -1 && !busy) {
        // ordinary zombies at once; a civilian's attacker once she is dead (or the second one's at once if saving)
        const b = s.boxes.boxes.find((x) => {
          if (!x.shown || x.typed !== 0) return false;
          const p = (x.owner as Zombie).parent as Civilian | undefined;
          return !p || (p.flags & 0x4000000) !== 0 || (saveHer && p.kind === 1);
        });
        if (b) {
          s.type(b.word!);
          busy = b.word!.length + 2;
        }
      }
      for (const o of s.objects) {
        if (o.obj instanceof Zombie && (o.obj as unknown as { behaviour: number }).behaviour === 0x22 && o.obj.place.pos[0] > -79) chased = true;
        if (!(o.obj instanceof Civilian)) continue;
        const c = o.obj;
        if (c.kind === 0) {
          if (firstAt < 0) firstAt = f;
          if (killedAt < 0 && c.log.includes('killed')) killedAt = f;
        } else {
          secondKind = c.kind;
          herLog = c.log;
        }
      }
    }
    return { s, firstAt, killedAt, secondKind, herLog, chased };
  };

  it('civilians (block 1): the first is killed by her zombie (behaviour 35, kill frame 64); the second dies if her zombie is not typed', () => {
    const { s, firstAt, killedAt, secondKind, herLog, chased } = civilianRun(false);
    expect(firstAt).toBeGreaterThan(0);
    expect(killedAt - firstAt).toBeGreaterThan(40); // the lunge reaches her on frame 64 of motion 0x33d
    expect(killedAt - firstAt).toBeLessThan(90);
    expect(secondKind).toBe(1);
    expect(chased).toBe(true); // behaviour 34: her zombie runs after her
    expect(herLog).toContain('segment 0x140100 passed over'); // FUN_00480860: her "if hit" script is kept …
    expect(herLog).toContain('killed'); // … so the grab kills her
    expect(s.player.log.some((e) => e.text === 'block 1 done → block 10')).toBe(true); // route 0
  });

  it('civilians (block 1): the second is saved when her zombie is typed in time — route 1 (block 9)', () => {
    const { s, herLog } = civilianRun(true);
    expect(herLog.some((l) => l.startsWith('rescued'))).toBe(true);
    expect(herLog).not.toContain('killed');
    expect(herLog).toContain('route 1');
    expect(s.player.log.some((e) => e.text === 'block 1 done → block 9')).toBe(true);
  });

  /** Block 9 (the man at the well) with a typing bot; `saveHim`: type his zombies too. */
  const manRun = (saveHim: boolean) => {
    const s = loadScene(dir!, 1, 9, Infinity);
    let busy = 0, log: string[] = [];
    const seen = { hidden: false, chased: false, paused: false, attackedPlayer: false };
    for (let f = 0; f < 1200 && !s.player.done; f++) {
      s.step();
      if (busy > 0) busy--;
      if (s.world.inFight && s.world.targets[0] === -1 && !busy) {
        const b = s.boxes.boxes.find((x) => x.shown && x.typed === 0 && (saveHim || !(x.owner as Zombie).parent));
        if (b) {
          s.type(b.word!);
          busy = b.word!.length + 2;
        }
      }
      const c = s.objects.map((o) => o.obj).find((o): o is Civilian => o instanceof Civilian);
      if (!c) continue;
      log = c.log;
      for (const z of c.attackers as unknown as { behaviour: number; hidden: boolean }[]) {
        if (z.behaviour === 39 && z.hidden) seen.hidden = true;
        if (z.behaviour === 0x22) seen.chased = true;
        if (z.behaviour === 0x2d) seen.paused = true;
        if (z.behaviour === 3) seen.attackedPlayer = true;
      }
    }
    return { s, log, seen };
  };

  it('the man at the well (block 9): hidden zombies (39) released by his script into the chase (op 0x1A 34 2); killed if not typed — a short pause (45), then they come for the player', () => {
    const { s, log, seen } = manRun(false);
    expect(seen).toEqual({ hidden: true, chased: true, paused: true, attackedPlayer: true });
    expect(log).toContain('release 2 attacker(s) as behaviour 34');
    expect(log).toContain('killed');
    expect(s.player.flags[35]).toBe(1); // his "if hit" script sets the flag block 9 waits for
  });

  it('the man at the well (block 9): typed in time → rescued, route 1, block 9 goes on', () => {
    const { s, log } = manRun(true);
    expect(log.some((l) => l.startsWith('rescued'))).toBe(true);
    expect(log).not.toContain('killed');
    expect(s.player.log.some((e) => /^block 9 done/.test(e.text))).toBe(true);
  });

  it('word boxes: the first wave gets three category-1 words with different first letters, shown in the fight', () => {
    const s = loadScene(dir!, 1, 0, 60 * 20);
    for (let f = 0; f < 60 * 30; f++) s.step();
    const shown = s.boxes.boxes.filter((b) => b.shown);
    expect(shown.length).toBe(3);
    const words = shown.map((b) => b.word!);
    expect(new Set(words.map((w) => w[0]!.toUpperCase())).size).toBe(3);
    for (const w of words) expect(w.length).toBe(2); // category 1 (time budget 25 at rank 1)
    for (const b of shown) expect(b.pos[2]).toBeLessThan(0); // in front of the camera (view z < 0)
    expect(s.boxItems().length).toBe(3 * (9 + 4)); // frame pieces + two lines of two letters
  });

  it('the first wave walks up to the player (behaviour 1, walk 0x437) and stands at the near band facing them', () => {
    const s = loadScene(dir!, 1, 0, 60 * 30);
    const seen = new Set<number>();
    let zombies: Zombie[] = [];
    for (let f = 0; f < 60 * 45; f++) {
      s.step();
      zombies = s.objects.map((o) => o.obj).filter((o): o is Zombie => o instanceof Zombie);
      for (const z of zombies) if (z.behaviour === 1) seen.add(z.rig.motion);
      if (zombies.length && zombies.every((z) => z.behaviour >= 2 && z.behaviour <= 4)) break; // all arrived (one may attack at once)
    }
    for (let f = 0; f < 30; f++) s.step();
    zombies = zombies.filter((z) => z.behaviour === 2);
    expect(zombies.length).toBeGreaterThanOrEqual(2);
    expect(seen.has(0x437)).toBe(true); // (the waiting motion is still reported while blending out)
    const e = s.world.eye;
    for (const z of zombies) {
      expect(z.behaviour).toBe(2);
      expect(z.rig.motion).toBe(0x408); // idle of znsam2's set
      const d = Math.hypot(z.place.pos[0] - e[0], z.place.pos[2] - e[2]);
      expect(d).toBeGreaterThan(24);
      expect(d).toBeLessThan(27); // near band 25
      const off = (heading(z.place.pos[0] - e[0], z.place.pos[2] - e[2]) - z.place.angles[1]) & 0xffff;
      expect(Math.min(off, 0x10000 - off)).toBeLessThan(0x400); // facing the player (within ~6°)
    }
  });
});
