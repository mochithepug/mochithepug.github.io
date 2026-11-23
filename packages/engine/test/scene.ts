/** Test helper: runs a stage's event script with the ported objects, like the game loop, on the user's data. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CameraFile,
  EventFile,
  EventPlayer,
  EVT_COM_BASE,
  Motion,
  motionFits,
  pathLength,
  PeImage,
  readBlockRules,
  readCameraSlots,
  readCharacterTypes,
  readSkins,
  readDialogue,
  readMotionTable,
  STAGE_EVENT_FILES,
} from '@ttotd/formats';
import { createObject, type GameObject, type MotionLib, type World } from '../src/index.ts';

export function loadScene(dir: string, stage = 1, block = 0) {
  const pe = new PeImage(new Uint8Array(readFileSync(join(dir, 'Tod_e.exe'))));
  const ef = new EventFile(new Uint8Array(readFileSync(join(dir, 'evt', STAGE_EVENT_FILES[stage - 1]!))));
  const common = new EventFile(new Uint8Array(readFileSync(join(dir, 'evt', 'comevtbl.bin'))), EVT_COM_BASE);
  const slot = readCameraSlots(pe).find((s) => s.file === `op_st${stage}.bin`)!;
  const op = new CameraFile(new Uint8Array(readFileSync(join(dir, 'cam', slot.file))), slot.ids.length);
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
  const player = new EventPlayer(ef, { rules: readBlockRules(pe, stage - 1), dialogue: (id) => readDialogue(pe, id, 0), common, followBlocks: false, holdFrames: 60 });
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
  };
  const objects: { obj: GameObject; type: number }[] = [];
  let spawned = 0;
  player.start(block);
  return {
    pe,
    player,
    world,
    objects,
    /** One 60 Hz frame: script, then every object in spawn order. */
    step() {
      player.step();
      world.camPath = player.shot?.pathId ?? -1;
      world.camTime = player.timer;
      for (; spawned < player.spawns.length; spawned++) {
        const rec = player.spawns[spawned]!;
        const obj = createObject(rec, world);
        if (obj) objects.push({ obj, type: rec.type });
      }
      for (const o of objects) if (!o.obj.dead) o.obj.update(world);
      world.frame++;
    },
  };
}
