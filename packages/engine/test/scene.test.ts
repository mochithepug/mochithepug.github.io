/** Ported objects in Stage 1 against the user's install (skipped unless TTOTD_DIR is set). */
import { describe, expect, it } from 'vitest';
import { blendAngles, Civilian, hurtPlayer, ThrownItem, Daemon, heading, OpeningCar, OPENING_CAR_MODELS, TitleCard, turnTowards, Zombie } from '../src/index.ts';
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
    const { s, daemon } = run(60 * 30);
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
    // gone at path 50 time 400: dropped from the objects (as in PLAY) well before the end of the run
    expect(daemon[daemon.length - 1]!.f).toBeLessThan(60 * 30 - 1);
    expect(s.objects.some((o) => o.obj instanceof Daemon)).toBe(false);
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

  it('the attack timer (DAT_005ea728): no zombie starts an attack until it runs out after the last word appears', () => {
    const s = loadScene(dir!, 1, 0, Infinity);
    let lastPick = -1, firstAttack = -1;
    for (let f = 0; f < 60 * 45 && firstAttack < 0; f++) {
      s.step();
      if (s.world.wordPickedFrame === s.world.frame - 1) lastPick = f;
      if (s.objects.some((o) => (o.obj as unknown as { behaviour?: number }).behaviour === 3)) firstAttack = f;
    }
    expect(lastPick).toBeGreaterThan(0);
    expect(firstAttack - lastPick).toBeGreaterThanOrEqual(360); // 390 at rank 0–1, 360 at rank 2 (@005ea674[2])
  });

  it('the first wave (event op 0x0F 1 2 3): only the nearest comes in to attack, the others wait (behaviour 5) further out; the next comes in once it is typed', () => {
    const s = loadScene(dir!, 1, 0, Infinity);
    const zombies = () => s.objects.map((o) => o.obj).filter((o): o is Zombie => o instanceof Zombie);
    let first: Zombie | undefined, maxAttackers = 0;
    for (let f = 0; f < 60 * 45 && !first; f++) {
      s.step();
      first = zombies().find((z) => z.behaviour === 3);
    }
    expect(first).toBeDefined();
    expect(s.world.attackCounts).toEqual([1, 2, 3]);
    for (let f = 0; f < 120; f++) s.step();
    const e = s.world.eye;
    const others = zombies().filter((z) => z !== first);
    expect(others.length).toBe(2);
    for (const z of others) {
      expect(z.behaviour).toBe(5); // wait: too far back in the queue for the near band (allowance 1)
      expect(Math.hypot(z.place.pos[0] - e[0], z.place.pos[2] - e[2])).toBeGreaterThan(30);
    }
    s.type(s.boxes.boxes.find((b) => b.owner === (first as unknown))!.word!);
    let next: Zombie | undefined;
    for (let f = 0; f < 60 * 20 && !next; f++) {
      s.step();
      const zs = zombies();
      maxAttackers = Math.max(maxAttackers, zs.filter((z) => z.behaviour === 3 || z.behaviour === 4).length);
      next = zs.find((z) => z !== first && z.behaviour === 3);
    }
    expect(next).toBeDefined(); // the queue moved up
    expect(maxAttackers).toBeLessThanOrEqual(1); // one attack slot for the player
    expect(s.hits.length).toBeGreaterThanOrEqual(1);
    for (const h of s.hits) expect([h.player, h.hit, h.damage]).toEqual([0, 1, 9]);
  });

  it('hits cost a life and lower the word rank by 2 (FUN_004846d0 / FUN_00451ff0); 0x5A frames of grace', () => {
    const s = loadScene(dir!, 1, 0, Infinity);
    const me = s.world.players![0]!;
    expect(me.lives).toBe(3); // @004f2ba0[2]
    const counted: { frame: number; rank: number }[] = [];
    let lastHits = 0, rankBefore = 0;
    for (let f = 0; f < 60 * 120 && me.lives > 0; f++) {
      rankBefore = s.world.words!.rank;
      s.step(); // nobody types: the zombies keep hitting
      if (me.hits > lastHits) {
        counted.push({ frame: f, rank: rankBefore });
        lastHits = me.hits;
      }
    }
    expect(counted.length).toBe(3); // three lives, then 0 (game over not ported)
    expect(me.lives).toBe(0);
    // after a hit the attack timer restarts (≥ 150 frames at any rank, FUN_004b1410(2)) before the next attack can start
    for (let i = 1; i < counted.length; i++) expect(counted[i]!.frame - counted[i - 1]!.frame).toBeGreaterThanOrEqual(150);
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
    let lastKilled: Zombie | undefined;
    for (let f = 0; f < 60 * 70 && over < 0; f++) {
      s.step();
      if (s.world.inFight) fightFrames++;
      const shown = s.boxes.boxes.filter((b) => b.shown);
      if (!words.length && shown.length === 3 && fightFrames > 60 * 20) {
        words = shown.map((b) => b.word!);
        lastKilled = shown[shown.length - 1]!.owner as unknown as Zombie; // its word is typed last
        s.type(words.join('')); // after 20 s of fighting: no hold ends it any more
      }
      const zs = s.objects.map((o) => o.obj).filter((o): o is Zombie => o instanceof Zombie);
      // the last one killed (flag 0x800000, the last enemy) keeps the fight going until its body has sunk and it is
      // dropped from the objects; bodies that started dying earlier may still be sinking
      if (lastKilled && lastSunk < 0 && !zs.includes(lastKilled)) lastSunk = f;
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

  /** Block 3 with a bot that types everything except the thrower; `typeAxes`: the thrown axes too. */
  const throwerRun = (typeAxes: boolean) => {
    const s = loadScene(dir!, 1, 3, Infinity);
    let busy = 0, thrower: Zombie | undefined, maxItems = 0, left = false;
    const axes = new Set<ThrownItem>(), words = new Set<string>();
    for (let f = 0, after = 0; f < 60 * 60 && after < 2; f++) {
      s.step();
      if (busy > 0) busy--;
      const objs = s.objects.map((o) => o.obj);
      if (left && !objs.some((o) => o instanceof ThrownItem)) after++; // the last axe is gone too
      thrower ??= objs.find((o): o is Zombie => o instanceof Zombie && o.behaviour === 33);
      const items = objs.filter((o): o is ThrownItem => o instanceof ThrownItem);
      items.forEach((i) => axes.add(i));
      maxItems = Math.max(maxItems, items.length);
      for (const b of s.boxes.boxes) if (b.shown && b.owner instanceof ThrownItem && b.word) words.add(b.word);
      if (s.world.inFight && s.world.targets[0] === -1 && !busy) {
        const b = s.boxes.boxes.find((x) => x.shown && x.typed === 0 && x.owner !== thrower && (typeAxes || !(x.owner instanceof ThrownItem)));
        if (b) {
          s.type(b.word!);
          busy = b.word!.length + 2;
        }
      }
      if (thrower && !objs.includes(thrower)) left = true;
    }
    return { s, thrower, axes: [...axes], maxItems, words: [...words], left };
  };

  it('the thrower (behaviour 33, block 3): two axes, one at a time, each a one-letter word; untyped ones hit for 4; then it backs off and leaves', () => {
    const { s, thrower, axes, maxItems, words, left } = throwerRun(false);
    expect(thrower).toBeDefined();
    expect(axes.length).toBe(2);
    expect(maxItems).toBe(1); // the axe keeps the attack slot until it is gone
    expect(axes.every((a) => a.model === 0x271)).toBe(true);
    expect(words.length).toBeGreaterThan(0);
    for (const w of words) expect(w).toMatch(/^[A-Z]$/);
    expect(s.hits.filter((h) => h.damage === 4).length).toBe(2);
    expect(left).toBe(true); // backed off (behaviour 15, flag 0x20000000) and left the fight
  });

  it('the thrower: a typed axe breaks off — no hit, the attack slot is free again', () => {
    const { s, axes } = throwerRun(true);
    expect(axes.length).toBeGreaterThanOrEqual(1);
    expect(axes.every((a) => a.behaviour === 3)).toBe(true);
    expect(s.hits.filter((h) => h.damage === 4).length).toBe(0);
  });

  it('the thrower typed on its ledge falls (behaviour 9): a small pop, gravity, lands on the default floor (op 0x1A), sinks', () => {
    const s = loadScene(dir!, 1, 3, Infinity);
    let busy = 0, th: Zombie | undefined, top = -Infinity, fromY = 0, landed: number | undefined;
    for (let f = 0; f < 60 * 40 && landed === undefined; f++) {
      s.step();
      if (busy > 0) busy--;
      th ??= s.objects.map((o) => o.obj).find((o): o is Zombie => o instanceof Zombie && o.behaviour === 33);
      const thrown = th && (th as unknown as { rig: { modelOverride: Map<number, number> } }).rig.modelOverride.size > 0;
      if (s.world.inFight && s.world.targets[0] === -1 && !busy) {
        const b = s.boxes.boxes.find((x) => x.shown && x.typed === 0 && !(x.owner instanceof ThrownItem) && (x.owner !== th || thrown));
        if (b) {
          s.type(b.word!);
          busy = b.word!.length + 2;
        }
      }
      if (th?.behaviour === 9) {
        if (top === -Infinity) fromY = th.place.pos[1];
        top = Math.max(top, th.place.pos[1]);
      }
      if (th?.behaviour === 7 && top > -Infinity) landed = th.place.pos[1];
    }
    expect(top).toBeGreaterThan(fromY); // knocked up a little …
    expect(top - fromY).toBeLessThan(6); // … not thrown into the air
    expect(landed).toBeCloseTo(s.player.defaultFloor, 1); // no collision meshes yet: the default floor
  });

  it('a bridge thrower typed (block 4, flag 0x1000000): death motion 0x432 over the railing, then falls into the canal (behaviour 12)', () => {
    const s = loadScene(dir!, 1, 4, Infinity);
    let busy = 0, th: Zombie | undefined, motion = 0, fromY = 0, landed: number | undefined;
    for (let f = 0; f < 60 * 60 && landed === undefined; f++) {
      s.step();
      if (busy > 0) busy--;
      th ??= s.objects.map((o) => o.obj).find((o): o is Zombie => o instanceof Zombie && o.behaviour === 33);
      const thrown = th && (th as unknown as { rig: { modelOverride: Map<number, number> } }).rig.modelOverride.size > 0;
      if (s.world.inFight && s.world.targets[0] === -1 && !busy) {
        const b = s.boxes.boxes.find((x) => x.shown && x.typed === 0 && !(x.owner instanceof ThrownItem) && (x.owner !== th || thrown));
        if (b) {
          s.type(b.word!);
          busy = b.word!.length + 2;
        }
      }
      if (th?.behaviour === 12 && !motion) {
        motion = th.rig.motion;
        fromY = th.place.pos[1];
      }
      if (motion && th?.behaviour === 7) landed = th.place.pos[1];
    }
    expect(motion).toBe(0x432);
    expect(landed).toBeCloseTo(s.player.defaultFloor, 1); // the canal (block 3's default floor, carried on)
    expect(fromY - landed!).toBeGreaterThan(10);
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

  it('the first wave walks up (behaviour 1, walk 0x437); the nearest stands at the near band facing the player, the others wait facing it', () => {
    const s = loadScene(dir!, 1, 0, Infinity);
    const seen = new Set<number>();
    let stander: Zombie | undefined;
    for (let f = 0; f < 60 * 45 && !stander; f++) {
      s.step();
      const zs = s.objects.map((o) => o.obj).filter((o): o is Zombie => o instanceof Zombie);
      for (const z of zs) if (z.behaviour === 1) seen.add(z.rig.motion);
      stander = zs.find((z) => z.behaviour === 2);
    }
    expect(seen.has(0x437)).toBe(true);
    expect(stander).toBeDefined();
    for (let f = 0; f < 30; f++) s.step();
    const e = s.world.eye;
    const facing = (z: Zombie) => {
      const off = (heading(z.place.pos[0] - e[0], z.place.pos[2] - e[2]) - z.place.angles[1]) & 0xffff;
      return Math.min(off, 0x10000 - off);
    };
    const d = Math.hypot(stander!.place.pos[0] - e[0], stander!.place.pos[2] - e[2]);
    expect(d).toBeGreaterThan(10);
    expect(d).toBeLessThan(27); // inside the near band (25)
    for (const z of s.objects.map((o) => o.obj).filter((o): o is Zombie => o instanceof Zombie && o.behaviour === 5))
      expect(facing(z)).toBeLessThan(0x400); // waiting ones turn to the player (FUN_00437250)
  });
});
