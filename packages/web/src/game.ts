/**
 * Game screen (PLAY): runs a stage as the game does, at a fixed 60 Hz.
 * Each frame: the event script, then every live object in spawn order (objects ported in @ttotd/engine;
 * the registry picks the class for a spawn record's type, unported types are skipped), then drawing.
 * Fights last until their enemies are dead (typing kills them; damage to the player is not ported yet).
 */
import {
  CameraFile,
  cameraFromSample,
  cameraProjection,
  cameraView,
  D3D_VIEW_FLIP,
  d3dLighting,
  EventFile,
  EventPlayer,
  EVT_COM_BASE,
  identity,
  Motion,
  motionFits,
  modelRef,
  mul,
  pathLength,
  readBlockRules,
  readCameraSlots,
  readCharacterTypes,
  readSkins,
  readApproachBands,
  decodeWordList,
  invert,
  wordFileName,
  rotateXLocal,
  rotateYLocal,
  transformDir,
  type WordEntry,
  readMotionSet,
  readAttackTable,
  readSkyTable,
  readStageAreas,
  type StageAreas,
  readDialogue,
  readMotionTable,
  STAGE_EVENT_FILES,
  type Mat4,
  type PolModel,
} from '@ttotd/formats';
import { CANCEL_KEY, CrtRand, FrameStepper, hurtPlayer, startLives, OPENING_CAR_MODELS, Sky, TitleCard, WordBoxes, WordDeck, type GameObject, type MotionLib, type World } from '@ttotd/engine';
import { Assets } from './assets';
import type { GameFS } from './ingest/gamefs';
import { patchedModel } from './gl/patch';
import { Renderer, translucentDepth, type GpuModel, type TextureSource } from './gl/renderer';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Cut-scene letterbox bar height in 640×480 pixels (provisional, as in the Stage view). */
const CINE_BAR = 60;
/**
 * Frames the bars take to slide in or out (provisional: the exe's bar code is not found yet — see
 * re/notes/overview.md "Letterbox bars"; the user reports they slide out rather than vanish).
 */
const CINE_SLIDE = 20;

interface Game {
  stage: number;
  /** Stage scenery by area (FUN_004031b0's tables); the event script picks the area (op 0x29). */
  areas: StageAreas;
  sky: Sky;
  camFile: CameraFile;
  camIds: number[];
  player: EventPlayer;
  world: World;
  /** The frame step shared with the simulation tests (engine core/frame.ts). */
  stepper: FrameStepper;
  /** Live objects (the stepper's, without their record types). */
  readonly objects: GameObject[];

  acc: number;
  last: number;
  enter: boolean;
  /** Letterbox bars shown, 0 (gone) … 1 (in), stepped per game frame. */
  bars: number;
  /** Frozen on a frame (debug `at`): keep drawing, no stepping. */
  frozen?: boolean;
  /** A status line to keep showing (e.g. a debug start that fell back). */
  note?: string;
  view?: { view: Mat4; eye: [number, number, number]; game: Mat4 };
  /** Word boxes of the enemies. */
  boxes: WordBoxes;
}

let game: Game | undefined;
let renderer: Renderer | undefined;
let assets: { fs: GameFS; assets: Assets; motions: ReturnType<typeof motionLibrary> } | undefined;
let token = 0;
let raf = 0;
let skipSign: HTMLCanvasElement | undefined;
/** Chapter title textures (scr_chapter_stN, 2D palettes) by stage. */
const titleImages = new Map<number, (HTMLCanvasElement | undefined)[]>();
/** Models by global id (null while loading or missing). */
const modelCache = new Map<number, { gpu: GpuModel; tex?: TextureSource; model: PolModel } | null>();

async function loadModel(a: Assets, id: number) {
  if (modelCache.has(id)) return;
  modelCache.set(id, null);
  const ref = modelRef(a.pe, id);
  if (!ref) return;
  const m = (await a.models(ref.file))[ref.index];
  if (m && renderer) modelCache.set(id, { gpu: renderer.upload([m]), tex: await a.textures(ref.file), model: m });
}


/** Motion loads in flight (the debug fast-forward waits for them). */
const pendingLoads = new Set<Promise<unknown>>();

/**
 * Motions by id. Every mot/ file is read before play (`preload`, as the exe has its motion banks in memory), so a
 * motion is there on the frame it is first asked for — a late one would start its blend from stale root data and
 * snap the character back (the first civilian's fall). Files not preloaded still load on first use.
 */
function motionLibrary(a: Assets): MotionLib & { preload(): Promise<void> } {
  const infos = new Map(readMotionTable(a.pe).map((m) => [m.id, m]));
  const cache = new Map<string, Motion | null>();
  const files = new Map<string, Uint8Array>();
  return {
    async preload() {
      const names = [...new Set([...infos.values()].map((m) => m.file))].filter((f) => !files.has(f) && a.fs.has(`mot/${f}`));
      await Promise.all(names.map(async (f) => files.set(f, await a.file(`mot/${f}`))));
    },
    frames: (id) => infos.get(id)?.frames ?? 1,
    get(id, joints) {
      const key = `${id}/${joints}`;
      if (cache.has(key)) return cache.get(key) ?? undefined;
      cache.set(key, null);
      const info = infos.get(id);
      const ready = info && files.get(info.file);
      if (info && ready) {
        if (motionFits(ready, info, joints)) cache.set(key, new Motion(ready, info, joints));
        return cache.get(key) ?? undefined;
      }
      if (info && a.fs.has(`mot/${info.file}`)) {
        const load = a.file(`mot/${info.file}`).then((file) => {
          if (motionFits(file, info, joints)) cache.set(key, new Motion(file, info, joints));
        });
        pendingLoads.add(load);
        void load.finally(() => pendingLoads.delete(load));
      }
      return undefined;
    },
  };
}

/**
 * `at`: fast-forward this many 60 Hz frames before showing (for exact screenshots). `block`: start at this event
 * block (debug) — the blocks on the way are not played, only their lasting state is set (EventPlayer.prime).
 */
export async function startGame(fs: GameFS, stage = 1, at = 0, block = 0) {
  quitGame();
  const my = ++token;
  $('game').hidden = false;
  (document.activeElement as HTMLElement | null)?.blur();
  setStatus('Loading…');
  if (assets?.fs !== fs) {
    const a = await Assets.open(fs);
    assets = { fs, assets: a, motions: motionLibrary(a) };
  }
  const a = assets.assets;
  await assets.motions.preload();
  if (my !== token) return;
  renderer ??= new Renderer($<HTMLCanvasElement>('game-canvas'));

  const areas = readStageAreas(a.pe, stage);
  await Promise.all([...new Set(areas.areas.flat().map((m) => m.model))].map((id) => loadModel(a, id)));
  if (my !== token) return;

  const slot = readCameraSlots(a.pe).find((x) => x.file === `cp_st${stage}.bin`);
  const evtName = STAGE_EVENT_FILES[stage - 1];
  if (!slot || !evtName || !fs.has(`cam/${slot.file}`) || !fs.has(`evt/${evtName}`)) {
    setStatus(`Stage ${stage}: camera or event file missing`);
    return;
  }
  const camFile = new CameraFile(await a.file(`cam/${slot.file}`), slot.ids.length);
  const opSlot = readCameraSlots(a.pe).find((x) => x.file === `op_st${stage}.bin`);
  const objPaths = opSlot && fs.has(`cam/${opSlot.file}`) ? { file: new CameraFile(await a.file(`cam/${opSlot.file}`), opSlot.ids.length), ids: opSlot.ids } : undefined;
  await Promise.all(OPENING_CAR_MODELS.map((id) => loadModel(a, id)));
  const ef = new EventFile(await a.file(`evt/${evtName}`));
  const common = fs.has('evt/comevtbl.bin') ? new EventFile(await a.file('evt/comevtbl.bin'), EVT_COM_BASE) : undefined;
  const player = new EventPlayer(ef, {
    rules: readBlockRules(a.pe, stage - 1),
    dialogue: (id) => readDialogue(a.pe, id, 0) ?? readDialogue(a.pe, id, 2),
    common,
    holdFrames: Infinity, // the fight camera finishes by endFight() (FUN_0040cda0's rule)
    enemyCounts: () => ({ enemies: game?.world.enemies ?? 0, attackers: game?.world.attackers ?? 0, civilians: game?.world.civilians ?? 0 }),
  });
  await loadSkipSign(a);
  await loadTitle(a, stage);
  if (my !== token) return;
  player.bands = readApproachBands(a.pe);
  const rng = new CrtRand();
  const world: World = {
    camPath: -1,
    camTime: 0,
    frame: 0,
    enter: false,
    titleUp: false,
    flags: player.flags,
    path: (id, t) => {
      const k = objPaths ? objPaths.ids.indexOf(id) : -1;
      return k < 0 ? undefined : objPaths!.file.objectSample(k, t);
    },
    pathLength: (id) => pathLength(a.pe, id),
    skeletons: readCharacterTypes(a.pe),
    skins: readSkins(a.pe),
    motions: assets.motions,
    eye: [0, 0, 0],
    bands: player.bands,
    motionSet: (sk, kind) => readMotionSet(a.pe, sk, kind),
    rand: () => rng.next(),
    attackTable: (sk, set) => readAttackTable(a.pe, sk, set),
    attackSlots: [0, 0],
    hitPlayer: (p) => void hurtPlayer(world, p), // FUN_004846d0: a life, rank −2 (core/player.ts)
    players: [{ lives: startLives(a.pe), grace: 0, hits: 0 }],
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
    pe: a.pe,
    say: (id) => player.say(id, 'civilian: '),
    route: (n) => player.setRoute(n),
  };
  // Word files the stage's script can ask for (event op 0x61: groups 0 and 2), decoded up front.
  const wordFiles = new Map<string, WordEntry[]>();
  for (const group of [0, 2])
    for (let level = 1; ; level++) {
      const name = wordFileName(a.pe, group, level);
      if (!name) break;
      if (fs.has(`word/${name}`)) wordFiles.set(name, decodeWordList(await a.file(`word/${name}`)));
    }
  if (my !== token) return;
  const deck = new WordDeck(a.pe, (name) => wordFiles.get(name), rng, stage - 1);
  world.words = deck;
  let note = '';
  if (block > 0 && !player.prime(block).length) {
    note = `Stage ${stage} has no block ${block} reachable from the start — playing from the beginning.`;
    block = 0;
  }
  player.start(block);
  const boxes = new WordBoxes(a.pe, deck);
  const stepper = new FrameStepper(player, world, boxes, (id, t) => {
    const k = slot.ids.indexOf(id);
    return k < 0 ? undefined : camFile.sample(k, t);
  }, a.pe);
  game = {
    stage, areas, sky: new Sky(readSkyTable(a.pe)), camFile, camIds: slot.ids, player, world, stepper, boxes,
    get objects() {
      return stepper.objects.map((o) => o.obj);
    },
    acc: 0, last: performance.now(), enter: false, bars: 0, note,
  };
  // debug: the running game for inspection from the console / test scripts
  if (new URLSearchParams(location.search).has('dev')) (window as unknown as { ttotdGame?: Game }).ttotdGame = game;
  for (let i = 0; i < at; i++) {
    stepFrame(game, false);
    // a motion requested this frame: wait for it, as real-time play would have it a frame or two later
    if (pendingLoads.size) await Promise.all([...pendingLoads]);
    if (my !== token) return;
  }
  // models requested by the first draws load asynchronously; give them a moment
  if (at) {
    game.frozen = true;
    await new Promise((r) => setTimeout(r, 1500));
  }
  setStatus(note);
  raf = requestAnimationFrame(frame);
}

export function quitGame() {
  token++;
  cancelAnimationFrame(raf);
  game = undefined;
  $('game').hidden = true;
}

/** Copy a decoded texture (stored bottom-up) into a canvas the right way up. */
function textureCanvas(t: { width: number; height: number; rgba: Uint8ClampedArray }, cv = document.createElement('canvas')): HTMLCanvasElement {
  cv.width = t.width;
  cv.height = t.height;
  const img = new ImageData(t.width, t.height);
  for (let y = 0; y < t.height; y++) img.data.set(t.rgba.subarray((t.height - 1 - y) * t.width * 4, (t.height - y) * t.width * 4), y * t.width * 4);
  cv.getContext('2d')!.putImageData(img, 0, 0);
  return cv;
}

/** "Press the Enter key to skip": scr_common.bin texture 23 (sprite 0x20F), drawn at (384, 18). */
async function loadSkipSign(a: Assets) {
  if (skipSign) return;
  const t = (await a.textures('scr_common.bin', false))?.get(23);
  if (t) skipSign = textureCanvas(t, $<HTMLCanvasElement>('game-skip'));
}

/** Chapter title sprites 0x210–0x217 (Stage 1) = scr_chapter_stN textures 0–7. */
async function loadTitle(a: Assets, stage: number) {
  if (titleImages.has(stage)) return;
  const set = await a.textures(`scr_chapter_st${stage}.bin`, false);
  titleImages.set(stage, Array.from({ length: 8 }, (_, k) => {
    const t = set?.get(k);
    return t ? textureCanvas(t) : undefined;
  }));
}

// Fixed 60 Hz steps, like the game's frame pacer; input is read once per step.
function frame(now: number) {
  raf = requestAnimationFrame(frame);
  const g = game;
  if (!g) return;
  g.acc += Math.min(now - g.last, 250) * 0.06;
  g.last = now;
  for (let n = 0; g.acc >= 1 && n < 8 && !g.frozen; n++) {
    g.acc -= 1;
    const enter = g.enter;
    g.enter = false;
    stepFrame(g, enter);
  }
  draw(g);
}

/** One game frame (FrameStepper.step, shared with the tests), then what only PLAY needs: bars, sky, view. */
function stepFrame(g: Game, enter: boolean) {
  const p = g.player;
  g.bars = Math.min(1, Math.max(0, g.bars + (p.skippable ? 1 : -1) / CINE_SLIDE));
  g.stepper.step(enter);
  const c = g.stepper.camera;
  if (c) {
    g.view = { view: mul(g.world.view, D3D_VIEW_FLIP), eye: c.eye, game: g.world.view };
    g.sky.update(p.skyRow, p.skyMode, c.eye);
  }
}

function draw(g: Game) {
  const r = renderer!, canvas = r.canvas;
  // 640×480 picture, as large as fits the window.
  const cw = Math.min(window.innerWidth, (window.innerHeight * 4) / 3), ch = (cw * 3) / 4;
  canvas.style.width = `${cw}px`;
  canvas.style.height = `${ch}px`;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(cw * dpr)), h = Math.max(1, Math.round(ch * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }

  const p = g.player;
  const sl = p.light;
  const fog = sl.fog ? { color: sl.fogColor } : (false as const);
  // The exe clears every frame to black (ID3DXContext SetClearColor(0, 0, 0, 1) once at start-up, Clear(3)
  // after BeginScene, FUN_004bf3c0) — not the fog colour: the title card shows on black.
  r.clear(0, 0, 0);
  if (g.view) {
    const opts = { world: identity(), view: g.view.view, proj: cameraProjection(0x1d3b, w / h), lit: true, culling: true, lighting: d3dLighting(sl), eye: g.view.eye, fog };
    // Stage scenery for the current area — nothing while the title card is up (FUN_004031b0).
    const scenery = g.world.titleUp ? [] : (g.areas.areas[p.area] ?? []).map((m) => ({ model: m.model, world: identity() }));
    const temp: GpuModel[] = [];
    const deferred: { gpu: GpuModel; tex?: TextureSource; world: Mat4; depth: number }[] = [];
    for (const items of [g.sky.draw(), scenery, ...g.objects.map((o) => o.draw(g.world))]) {
      for (const d of items as { model: number; world: Mat4; patch?: Parameters<typeof patchedModel>[1] }[]) {
        const m = modelCache.get(d.model);
        if (!m) {
          if (m === undefined) void loadModel(assets!.assets, d.model);
          continue;
        }
        let gpu = m.gpu;
        if (d.patch?.length) temp.push((gpu = r.upload([patchedModel(m.model, d.patch)])));
        r.draw(gpu, m.tex, { ...opts, world: d.world, pass: 'opaque' });
        const depth = translucentDepth(gpu, mul(d.world, opts.view));
        if (depth > -Infinity) deferred.push({ gpu, tex: m.tex, world: d.world, depth });
      }
    }
    // The exe's deferred pass: every translucent mesh after all opaque ones, models far to near. This is
    // what lets the mirrored street under the wet road (st1_01b) show through the puddles.
    deferred.sort((a, b) => b.depth - a.depth);
    for (const d of deferred) r.draw(d.gpu, d.tex, { ...opts, world: d.world, pass: 'translucent' });
    // Word boxes (FUN_004aec20), in front of the scene: game view space at one tenth, tinted, lit by their own
    // white light (FUN_004c2b30) along rotY(0x2000)·rotX(0x2000)·(0, 0, 1) in view space (FUN_0046d780 → FUN_004c2b70).
    const inv = invert(g.view.game);
    const toWorld = (m: Mat4) => mul(m, inv);
    const dir = transformDir(inv, transformDir(rotateXLocal(rotateYLocal(identity(), 0x2000), 0x2000), [0, 0, 1]));
    const len = Math.hypot(...dir) || 1;
    const boxLight = { ...opts.lighting, lightDiffuse: [1, 1, 1] as [number, number, number], lightSpecular: [0, 0, 0] as [number, number, number], toLight: dir.map((v) => v / len) as [number, number, number] };
    for (const d of g.boxes.draw(g.world, toWorld)) {
      const m = modelCache.get(d.model);
      if (!m) {
        if (m === undefined) void loadModel(assets!.assets, d.model);
        continue;
      }
      r.draw(m.gpu, m.tex, { ...opts, world: d.world, lighting: boxLight, fog: false, colorOverride: d.color });
    }
    for (const t of temp) t.dispose();
  }
  placeOverlay(g, canvas);
}

function placeOverlay(g: Game, canvas: HTMLCanvasElement) {
  const ov = $('game-overlay');
  const rect = canvas.getBoundingClientRect();
  Object.assign(ov.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  const sx = rect.width / 640, sy = rect.height / 480;
  const p = g.player;
  const skip = $<HTMLCanvasElement>('game-skip');
  Object.assign(skip.style, { left: `${384 * sx}px`, top: `${18 * sy}px`, width: `${256 * sx}px`, height: `${32 * sy}px` });
  // skip_task @00423da0: visible while frame % 60 < 45
  skip.style.visibility = p.skippable && skipSign && p.frame % 60 < 45 ? 'visible' : 'hidden';
  // Letterbox bars slide in from / out to the screen edges.
  const off = (1 - g.bars) * CINE_BAR * sy;
  for (const [id, dir] of [['game-bar-top', -1], ['game-bar-bottom', 1]] as const)
    Object.assign($(id).style, { height: `${CINE_BAR * sy}px`, transform: `translateY(${dir * off}px)`, visibility: g.bars > 0 ? 'visible' : 'hidden' });
  drawTitle(g, rect);
  const sub = p.subtitle;
  $('game-subtitle').textContent = sub ? sub.speech.lines[sub.line]?.text ?? '' : '';
  // debug line until the real HUD (lives display, score) is ported
  const me = g.world.players?.[0], deck = g.world.words;
  $('game-debug').textContent = me && deck ? `lives ${me.lives}${me.lives <= 0 ? ' (game over not ported)' : ''} · rank ${deck.effectiveRank} · word level ${deck.level === 0 ? '0 (two-letter)' : deck.level}` : '';
  if (p.done) setStatus(`End of Stage ${g.stage} so far — Esc to quit`);
  else setStatus(g.note ?? '');
}

/** The chapter title card's sprites, centred on their 640×480 points (FUN_004ac0e0 with anchor flags 10). */
function drawTitle(g: Game, rect: DOMRect) {
  const cv = $<HTMLCanvasElement>('game-title');
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(rect.width * dpr), h = Math.round(rect.height * dpr);
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const ctx = cv.getContext('2d')!;
  ctx.clearRect(0, 0, w, h);
  const card = g.objects.find((o): o is TitleCard => o instanceof TitleCard);
  const images = titleImages.get(g.stage);
  if (!card || !images) return;
  const s = w / 640;
  for (const l of card.layers) {
    const img = images[l.k];
    if (!img || l.alpha <= 0) continue;
    const lw = img.width * l.sx * s, lh = img.height * l.sy * s;
    ctx.globalAlpha = Math.min(1, l.alpha);
    ctx.drawImage(img, l.x * s - lw / 2, l.y * s - lh / 2, lw, lh);
  }
  ctx.globalAlpha = 1;
}

function setStatus(text: string) {
  const el = $('game-status');
  if (el.textContent !== text) el.textContent = text;
}

window.addEventListener('keydown', (e) => {
  if ($('game').hidden) return;
  // Esc cancels the word being typed (the exe's key ')'); with nothing to cancel it leaves PLAY.
  if (e.key === 'Escape' && game && game.world.targets[0] !== -1) game.stepper.keys.push(CANCEL_KEY);
  else if (e.key === 'Escape') quitGame();
  else if (e.key === 'Enter' && game && !e.repeat) game.enter = true;
  // Typing: printable keys, one per game frame (the exe reads one key per frame, DAT_00818015)
  else if (game && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) game.stepper.keys.push(e.key.toUpperCase());
  else return;
  e.preventDefault();
});
