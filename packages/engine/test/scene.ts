/** Test helper: runs a stage's event script with the ported objects, like the game loop, on the user's data. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CameraFile,
  cameraFromSample,
  cameraProjection,
  cameraView,
  decodeWordList,
  identity,
  invert,
  mul,
  EventFile,
  EventPlayer,
  EVT_COM_BASE,
  Motion,
  motionFits,
  pathLength,
  PeImage,
  readBlockRules,
  readApproachBands,
  readCameraSlots,
  readMotionSet,
  readAttackTable,
  readCharacterTypes,
  readSkins,
  readDialogue,
  readMotionTable,
  STAGE_EVENT_FILES,
} from '@ttotd/formats';
import { createObject, CrtRand, WordBoxes, WordDeck, type GameObject, type MotionLib, type World } from '../src/index.ts';

export function loadScene(dir: string, stage = 1, block = 0, holdFrames = 60) {
  const pe = new PeImage(new Uint8Array(readFileSync(join(dir, 'Tod_e.exe'))));
  const ef = new EventFile(new Uint8Array(readFileSync(join(dir, 'evt', STAGE_EVENT_FILES[stage - 1]!))));
  const common = new EventFile(new Uint8Array(readFileSync(join(dir, 'evt', 'comevtbl.bin'))), EVT_COM_BASE);
  const slot = readCameraSlots(pe).find((s) => s.file === `op_st${stage}.bin`)!;
  const op = new CameraFile(new Uint8Array(readFileSync(join(dir, 'cam', slot.file))), slot.ids.length);
  const camSlot = readCameraSlots(pe).find((s) => s.file === `cp_st${stage}.bin`)!;
  const cam = new CameraFile(new Uint8Array(readFileSync(join(dir, 'cam', camSlot.file))), camSlot.ids.length);
  const infos = readMotionTable(pe);
  const byId = new Map(infos.map((m) => [m.id, m]));
  const cache = new Map<string, Motion | null>();
  const motions: MotionLib = {
    frames: (id) => byId.get(id)?.frames ?? 1,
    get(id, joints) {
      const key = `${id}/${joints}`;
      if (!cache.has(key)) {
        const info = byId.get(id), p = info && join(dir, 'mot', info.file);
        const file = p && existsSync(p) ? new Uint8Array(readFileSync(p)) : undefined;
        cache.set(key, info && file && motionFits(file, info, joints) ? new Motion(file, info, joints) : null);
      }
      return cache.get(key) ?? undefined;
    },
  };
  const player = new EventPlayer(ef, { rules: readBlockRules(pe, stage - 1), dialogue: (id) => readDialogue(pe, id, 0), common, followBlocks: false, holdFrames });
  player.bands = readApproachBands(pe);
  const rng = new CrtRand();
  const hits: { frame: number; player: number; hit: number; damage: number }[] = [];
  const world: World = {
    camPath: -1,
    camTime: 0,
    frame: 0,
    enter: false,
    titleUp: false,
    flags: player.flags,
    path: (id, t) => {
      const k = slot.ids.indexOf(id);
      return k < 0 ? undefined : op.objectSample(k, t);
    },
    pathLength: (id) => pathLength(pe, id),
    skeletons: readCharacterTypes(pe),
    skins: readSkins(pe),
    motions,
    eye: [0, 0, 0],
    bands: player.bands,
    motionSet: (sk, kind) => readMotionSet(pe, sk, kind),
    rand: () => rng.next(),
    attackTable: (sk, set) => readAttackTable(pe, sk, set),
    attackSlots: [0, 0],
    hitPlayer: (player, hit, damage) => hits.push({ frame: world.frame, player, hit, damage }),
    view: identity(),
    projScale: 240 * cameraProjection(0x1d3b, 4 / 3)[5]!,
    inFight: false,
    wordPickedFrame: -1,
  };
  const deck = new WordDeck(pe, (name) => {
    const f = join(dir, 'word', name);
    return existsSync(f) ? decodeWordList(new Uint8Array(readFileSync(f))) : undefined;
  }, rng);
  world.words = deck;
  const boxes = new WordBoxes(pe, deck);
  const objects: { obj: GameObject; type: number }[] = [];
  let spawned = 0, fightsOver = 0;
  player.start(block);
  return {
    pe,
    player,
    world,
    objects,
    /** Attacks that reached a player (World.hitPlayer). */
    hits,
    boxes,
    /** Word box draw items (world matrices). */
    boxItems: () => boxes.draw(world, (m) => mul(m, invert(world.view))),
    /** One 60 Hz frame: script, then every object in spawn order. */
    step() {
      player.step();
      world.camPath = player.shot?.pathId ?? -1;
      world.camTime = player.timer;
      const k = player.shot ? camSlot.ids.indexOf(player.shot.pathId) : -1;
      if (k >= 0) {
        const c = cameraFromSample(cam.sample(k, player.shot!.t));
        world.eye = c.eye;
        world.view = cameraView(c);
      }
      world.inFight = player.shot?.fight !== undefined;
      boxes.applySetup(player.words);
      for (; spawned < player.spawns.length; spawned++) {
        const rec = player.spawns[spawned]!;
        const obj = createObject(rec, world);
        if (obj) {
          objects.push({ obj, type: rec.type });
          boxes.add(obj, rec.type);
        }
      }
      for (; fightsOver < player.fightsOver; fightsOver++) for (const o of objects) if (!o.obj.dead) o.obj.fightOver?.(world);
      for (const o of objects) if (!o.obj.dead) o.obj.update(world);
      boxes.update(world);
      world.frame++;
    },
  };
}
