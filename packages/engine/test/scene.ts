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
import { CrtRand, FrameStepper, hurtPlayer, startLives, WordBoxes, WordDeck, type MotionLib, type World } from '../src/index.ts';

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
  const player = new EventPlayer(ef, { rules: readBlockRules(pe, stage - 1), dialogue: (id) => readDialogue(pe, id, 0), common, followBlocks: false, holdFrames, enemyCounts: () => ({ enemies: world.enemies, attackers: world.attackers, civilians: world.civilians ?? 0 }) });
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
    hitPlayer: (player, hit, damage) => {
      hits.push({ frame: world.frame, player, hit, damage });
      hurtPlayer(world, player);
    },
    players: [{ lives: startLives(pe), grace: 0, hits: 0 }],
    civilians: 0,
    view: identity(),
    projScale: 240 * cameraProjection(0x1d3b, 4 / 3)[5]!,
    inFight: false,
    wordPickedFrame: -1,
    targets: [-1, -1],
    camYaw: 0,
    enemies: 0,
    attackers: 0,
    active: 0,
    pe,
    say: (id) => player.say(id, 'civilian: '),
    route: (n) => player.setRoute(n),
  };
  const deck = new WordDeck(pe, (name) => {
    const f = join(dir, 'word', name);
    return existsSync(f) ? decodeWordList(new Uint8Array(readFileSync(f))) : undefined;
  }, rng);
  world.words = deck;
  const boxes = new WordBoxes(pe, deck);
  // the same frame step as PLAY (core/frame.ts)
  const stepper = new FrameStepper(player, world, boxes, (id, t) => {
    const k = camSlot.ids.indexOf(id);
    return k < 0 ? undefined : cam.sample(k, t);
  }, pe);
  player.start(block);
  return {
    pe,
    player,
    world,
    /** Live objects in spawn order (finished ones are dropped each frame, as in PLAY). */
    get objects() {
      return stepper.objects;
    },
    /** Attacks that reached a player (World.hitPlayer). */
    hits,
    boxes,
    /** Queue keys to type, one per frame (upper-cased like the game). */
    type: (text: string) => stepper.keys.push(...[...text].map((c) => c.toUpperCase())),
    /** Word box draw items (world matrices). */
    boxItems: () => boxes.draw(world, (m) => mul(m, invert(world.view))),
    /** One 60 Hz frame — FrameStepper.step, exactly as PLAY runs it. */
    step: (enter = false) => stepper.step(enter),
  };
}
