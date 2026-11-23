/**
 * Game screen (PLAY): runs a stage as the game does, at a fixed 60 Hz.
 * Each frame: the event script, then every live object in spawn order (objects ported in @ttotd/engine;
 * the registry picks the class for a spawn record's type, unported types are skipped), then drawing.
 * Fights are held for a few seconds — typing and damage are not ported yet.
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
  readSkyTable,
  readStageAreas,
  type StageAreas,
  readDialogue,
  readMotionTable,
  STAGE_EVENT_FILES,
  type Mat4,
  type PolModel,
} from '@ttotd/formats';
import { createObject, OPENING_CAR_MODELS, Sky, TitleCard, type GameObject, type MotionLib, type World } from '@ttotd/engine';
import { Assets } from './assets';
import type { GameFS } from './ingest/gamefs';
import { patchedModel } from './gl/patch';
import { Renderer, translucentDepth, type GpuModel, type TextureSource } from './gl/renderer';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Frames a fight is held until gameplay is ported. */
const FIGHT_HOLD = 180;
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
  objects: GameObject[];
  /** Spawn records already turned into objects. */
  spawned: number;
  acc: number;
  last: number;
  enter: boolean;
  /** Letterbox bars shown, 0 (gone) … 1 (in), stepped per game frame. */
  bars: number;
  /** Frozen on a frame (debug `at`): keep drawing, no stepping. */
  frozen?: boolean;
  view?: { view: Mat4; eye: [number, number, number] };
}

let game: Game | undefined;
let renderer: Renderer | undefined;
let assets: { fs: GameFS; assets: Assets; motions: MotionLib } | undefined;
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


/** Motions by id, loaded from mot/ on first use (undefined until loaded; rigs hold their pose meanwhile). */
function motionLibrary(a: Assets): MotionLib {
  const infos = new Map(readMotionTable(a.pe).map((m) => [m.id, m]));
  const cache = new Map<string, Motion | null>();
  return {
    frames: (id) => infos.get(id)?.frames ?? 1,
    get(id, joints) {
      const key = `${id}/${joints}`;
      if (cache.has(key)) return cache.get(key) ?? undefined;
      cache.set(key, null);
      const info = infos.get(id);
      if (info && a.fs.has(`mot/${info.file}`)) {
        void a.file(`mot/${info.file}`).then((file) => {
          if (motionFits(file, info, joints)) cache.set(key, new Motion(file, info, joints));
        });
      }
      return undefined;
    },
  };
}

/** `at`: fast-forward this many 60 Hz frames before showing (for exact screenshots). */
export async function startGame(fs: GameFS, stage = 1, at = 0) {
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
    holdFrames: FIGHT_HOLD,
  });
  await loadSkipSign(a);
  await loadTitle(a, stage);
  if (my !== token) return;
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
  };
  player.start(0);
  game = { stage, areas, sky: new Sky(readSkyTable(a.pe)), camFile, camIds: slot.ids, player, world, objects: [], spawned: 0, acc: 0, last: performance.now(), enter: false, bars: 0 };
  for (let i = 0; i < at; i++) {
    player.step();
    stepObjects(game, false);
  }
  // models and motions requested while fast-forwarding load asynchronously; give them a moment
  if (at) {
    game.frozen = true;
    await new Promise((r) => setTimeout(r, 1500));
  }
  setStatus('');
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
    if (enter) g.player.skip();
    g.player.step();
    stepObjects(g, enter);
  }
  draw(g);
}

/** The game camera for the current shot (keeps the last one between shots). */
function updateCamera(g: Game) {
  const shot = g.player.shot;
  const local = shot ? g.camIds.indexOf(shot.pathId) : -1;
  if (local < 0) return;
  const c = cameraFromSample(g.camFile.sample(local, shot!.t));
  g.view = { view: mul(cameraView(c), D3D_VIEW_FLIP), eye: c.eye };
}

/** Object tasks after the event script, once per frame, in spawn order; the sky task first. */
function stepObjects(g: Game, enter: boolean) {
  const p = g.player, w = g.world;
  g.bars = Math.min(1, Math.max(0, g.bars + (p.skippable ? 1 : -1) / CINE_SLIDE));
  updateCamera(g);
  if (g.view) g.sky.update(p.skyRow, p.skyMode, g.view.eye);
  w.camPath = p.shot?.pathId ?? -1;
  w.camTime = p.timer;
  w.enter = enter;
  for (; g.spawned < p.spawns.length; g.spawned++) {
    const obj = createObject(p.spawns[g.spawned]!, w);
    if (obj) g.objects.push(obj);
  }
  for (const o of g.objects) if (!o.dead) o.update(w);
  g.objects = g.objects.filter((o) => !o.dead);
  w.frame++;
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
  updateCamera(g);
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
  if (p.done) setStatus(`End of Stage ${g.stage} so far — Esc to quit`);
  else if (p.shot?.fight !== undefined) setStatus('Fight — not ported yet');
  else setStatus('');
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
  if (e.key === 'Escape') quitGame();
  else if (e.key === 'Enter' && game && !e.repeat) game.enter = true;
  else return;
  e.preventDefault();
});
