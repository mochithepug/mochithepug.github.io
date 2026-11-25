/**
 * One 60 Hz game frame, shared by PLAY (packages/web/src/game.ts) and the simulation tests
 * (packages/engine/test/scene.ts), so both run the same code: the event script (Enter skips), the camera (the
 * fight camera aims and turns back, core/fightcam.ts), new spawns, every object in spawn order, word boxes, lives
 * and rank (core/player.ts), then FUN_0040cda0's fight-end rule. Drawing, the sky and the letterbox stay with the
 * caller.
 */
import { cameraFromSample, cameraView, segmentHit, type CameraSample, type CollisionFiles, type CollisionHit, type EventPlayer, type GameCamera, type PeImage, type SpawnRecord } from '@ttotd/formats';
import { FightCamera, type AimEntry } from './fightcam.ts';
import type { GameObject, World } from './object.ts';
import { tickPlayers } from './player.ts';
import { createObject } from '../registry.ts';
import type { WordBoxes } from '../objects/wordbox.ts';

export interface FrameObject {
  obj: GameObject;
  /** Spawn record type. */
  type: number;
}

/**
 * FUN_004207c0 (+ the radix sort FUN_004208a0): last frame's queue sorted nearest first (stable); each zombie's
 * place +0x1321 = its index, +0x1322 = its index among those not backing off (flag 0x20000000), else 0xE.
 */
export function rankQueue(w: World) {
  const q = (w.queue ?? []).map((e, i) => ({ e, i })).sort((a, b) => a.e.key - b.e.key || a.i - b.i);
  let ready = 0;
  q.forEach(({ e }, i) => e.setPlaces(i, e.backingOff ? 0xe : ready++));
  w.queue = [];
}

/**
 * FUN_00437100: the floor under (x, y, z) — the segment (x, y − 1000, z) → (x, y, z) against the area's collision
 * meshes (FUN_0040fad0; props with collision are not ported), nearest hit below; none, or material 5 / 0x37 → the
 * default floor (event op 0x1A).
 */
export function floorAt(p: EventPlayer, coli: CollisionFiles | undefined, x: number, y: number, z: number): number {
  let hit: CollisionHit | undefined;
  for (const ptr of p.collision) {
    const m = coli?.mesh(ptr);
    if (m) hit = segmentHit(m, [x, y - 1000, z], [x, y, z], hit);
  }
  if (!hit || hit.material === 0 || hit.material === 5 || hit.material === 0x37) return p.defaultFloor;
  return hit.point[1];
}

export class FrameStepper {
  /** Live objects in spawn order (finished ones are dropped at the end of each frame). */
  objects: FrameObject[] = [];
  /** Keys typed and not yet read (one per frame, as `world.key`). */
  readonly keys: string[] = [];
  /** The camera of the last frame (undefined until the first shot). */
  camera?: GameCamera;
  private spawned = 0;
  private readonly fightCam: FightCamera;
  /** Last frame's registrations and whether its fight had no enemies left (FUN_0040cda0). */
  private aims: AimEntry[] = [];
  private over = false;

  readonly player: EventPlayer;
  readonly world: World;
  readonly boxes: WordBoxes;
  /** The path camera at (path id, time), or undefined when the path is not in this stage's file. */
  private readonly sample: (pathId: number, t: number) => CameraSample | undefined;

  /** The stage's collision files (coli0 + the stage's), for floors. */
  private readonly coli?: CollisionFiles;

  constructor(player: EventPlayer, world: World, boxes: WordBoxes, sample: (pathId: number, t: number) => CameraSample | undefined, pe?: PeImage, coli?: CollisionFiles) {
    this.coli = coli;
    this.player = player;
    this.world = world;
    this.boxes = boxes;
    this.sample = sample;
    this.fightCam = new FightCamera(pe);
    world.spawn = (rec, parent) => this.add(rec, parent);
    world.addObject = (obj) => {
      this.objects.push({ obj, type: -1 });
      this.boxes.attach(obj);
    };
  }

  /** Create an object for a spawn record (also civilians' attackers, via `world.spawn`). */
  add(rec: SpawnRecord, parent?: GameObject): GameObject | undefined {
    const obj = createObject(rec, this.world, parent);
    if (obj) {
      this.objects.push({ obj, type: rec.type });
      this.boxes.add(obj, rec.type);
    }
    return obj;
  }

  /** One frame. `enter`: Enter was pressed (skips a skippable scene, ends the title card early). */
  step(enter = false) {
    const p = this.player, w = this.world;
    if (enter) p.skip();
    p.step();
    this.updateCamera();
    w.inFight = p.shot?.fight !== undefined;
    this.boxes.applySetup(p.words);
    w.key = this.keys.shift();
    w.camPath = p.shot?.pathId ?? -1;
    w.camTime = p.timer;
    w.enter = enter;
    for (; this.spawned < p.spawns.length; this.spawned++) this.add(p.spawns[this.spawned]!);
    rankQueue(w);
    w.attackCounts = p.attackCounts;
    w.floorAt ??= (x, y, z) => floorAt(this.player, this.coli, x, y, z);
    w.active = 0;
    w.aims = [];
    for (const o of this.objects) if (!o.obj.dead) o.obj.update(w);
    this.boxes.update(w);
    tickPlayers(w); // FUN_00451f20: rank update, grace timers
    // FUN_0040cda0: the fight is over once no enemy is left (not dying, nothing registered) — the camera then turns
    // back to the path and ends the fight (updateCamera)
    this.aims = w.aims;
    this.over = w.inFight && w.attackers === 0 && w.active === 0;
    this.objects = this.objects.filter((o) => !o.obj.dead);
    w.frame++;
  }

  private updateCamera() {
    const p = this.player, shot = p.shot, w = this.world;
    const s = shot ? this.sample(shot.pathId, shot.t) : undefined;
    if (!shot || !s) return;
    const mode = shot.fight !== undefined && !p.fightDone ? (this.over ? 'return' : 'fight') : 'path';
    const r = this.fightCam.step(s, mode, this.aims);
    if (mode === 'return' && r.back) p.endFight();
    const c = cameraFromSample(r.cam);
    this.camera = c;
    w.eye = c.eye;
    w.view = cameraView(c);
    w.camYaw = c.yaw;
  }
}
