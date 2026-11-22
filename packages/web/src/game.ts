/**
 * Game screen (PLAY): runs a stage as the game does, at a fixed 60 Hz.
 * Ported so far: the event script (camera shots, subtitles, light & fog, skippable scenes with Enter), the
 * opening car (type 0x26) and the chapter title card's timing (type 0x60, graphics not yet).
 * Fights are held for a few seconds — enemies, typing and damage are not ported yet.
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
  modelRef,
  mul,
  pathLength,
  readBlockRules,
  readCameraSlots,
  readDialogue,
  STAGE_EVENT_FILES,
  type Mat4,
} from '@ttotd/formats';
import { OpeningCar, OPENING_CAR_MODELS, TITLE_CARD_FLAG, TitleCard } from '@ttotd/engine';
import { Assets } from './assets';
import type { GameFS } from './ingest/gamefs';
import { Renderer, type GpuModel, type TextureSource } from './gl/renderer';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Frames a fight is held until gameplay is ported. */
const FIGHT_HOLD = 180;
/** Cut-scene letterbox bar height in 640×480 pixels (provisional, as in the Stage view). */
const CINE_BAR = 60;

interface Game {
  stage: number;
  files: { gpu: GpuModel; tex?: TextureSource }[];
  camFile: CameraFile;
  camIds: number[];
  /** Object paths (cam/op_stN.bin) and their global ids. */
  objPaths?: { file: CameraFile; ids: number[] };
  player: EventPlayer;
  /** Spawn records already turned into objects. */
  spawned: number;
  car?: OpeningCar;
  title?: TitleCard;
  titleUp: boolean;
  acc: number;
  last: number;
  enter: boolean;
  view?: { view: Mat4; eye: [number, number, number] };
}

let game: Game | undefined;
let renderer: Renderer | undefined;
let assets: { fs: GameFS; assets: Assets } | undefined;
let token = 0;
let raf = 0;
let skipSign: HTMLCanvasElement | undefined;
/** Models by global id (null while loading or missing). */
const modelCache = new Map<number, { gpu: GpuModel; tex?: TextureSource } | null>();

async function loadModel(a: Assets, id: number) {
  if (modelCache.has(id)) return;
  modelCache.set(id, null);
  const ref = modelRef(a.pe, id);
  if (!ref) return;
  const m = (await a.models(ref.file))[ref.index];
  if (m && renderer) modelCache.set(id, { gpu: renderer.upload([m]), tex: await a.textures(ref.file) });
}

export async function startGame(fs: GameFS, stage = 1) {
  quitGame();
  const my = ++token;
  $('game').hidden = false;
  (document.activeElement as HTMLElement | null)?.blur();
  setStatus('Loading…');
  if (assets?.fs !== fs) assets = { fs, assets: await Assets.open(fs) };
  const a = assets.assets;
  renderer ??= new Renderer($<HTMLCanvasElement>('game-canvas'));

  const names = fs.files
    .filter((f) => f.size >= 32 && new RegExp(`^pol/st${stage}(_[0-9a-z]+)?\\.bin$`, 'i').test(f.key))
    .map((f) => f.path.slice(4))
    .sort();
  const files: Game['files'] = [];
  for (const name of names) {
    const models = await a.models(name);
    const tex = await a.textures(name, true);
    if (my !== token) return;
    files.push({ gpu: renderer.upload(models), tex });
  }

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
  if (my !== token) {
    for (const f of files) f.gpu.dispose();
    return;
  }
  player.start(0);
  game = { stage, files, camFile, camIds: slot.ids, objPaths, player, spawned: 0, titleUp: false, acc: 0, last: performance.now(), enter: false };
  setStatus('');
  raf = requestAnimationFrame(frame);
}

export function quitGame() {
  token++;
  cancelAnimationFrame(raf);
  for (const f of game?.files ?? []) f.gpu.dispose();
  game = undefined;
  $('game').hidden = true;
}

/** "Press the Enter key to skip": scr_common.bin texture 23 (sprite 0x20F), drawn at (384, 18). */
async function loadSkipSign(a: Assets) {
  if (skipSign) return;
  const t = (await a.textures('scr_common.bin', false))?.get(23);
  if (!t) return;
  const cv = $<HTMLCanvasElement>('game-skip');
  cv.width = t.width;
  cv.height = t.height;
  const img = new ImageData(t.width, t.height);
  for (let y = 0; y < t.height; y++) img.data.set(t.rgba.subarray((t.height - 1 - y) * t.width * 4, (t.height - y) * t.width * 4), y * t.width * 4);
  cv.getContext('2d')!.putImageData(img, 0, 0);
  skipSign = cv;
}

// Fixed 60 Hz steps, like the game's frame pacer; input is read once per step.
function frame(now: number) {
  raf = requestAnimationFrame(frame);
  const g = game;
  if (!g) return;
  g.acc += Math.min(now - g.last, 250) * 0.06;
  g.last = now;
  for (let n = 0; g.acc >= 1 && n < 8; n++) {
    g.acc -= 1;
    const enter = g.enter;
    g.enter = false;
    if (enter) g.player.skip();
    g.player.step();
    stepObjects(g, enter);
  }
  draw(g);
}

/** Object tasks after the event script, once per frame. */
function stepObjects(g: Game, enter: boolean) {
  const p = g.player;
  for (; g.spawned < p.spawns.length; g.spawned++) {
    const s = p.spawns[g.spawned]!;
    if (s.type === 0x26 && s.hp === 1) g.car = new OpeningCar(s);
    else if (s.type === 0x60) g.title = new TitleCard();
  }
  g.titleUp = g.title?.update(enter) ?? false;
  if (g.title?.done) p.flags[TITLE_CARD_FLAG] = 1;
  const op = g.objPaths;
  g.car?.update({
    camPath: p.shot?.pathId ?? -1,
    camTime: p.timer,
    path: (id, t) => {
      const k = op ? op.ids.indexOf(id) : -1;
      return k < 0 ? undefined : op!.file.objectSample(k, t);
    },
    length: (id) => pathLength(assets!.assets.pe, id),
  });
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
  const shot = p.shot;
  const local = shot ? g.camIds.indexOf(shot.pathId) : -1;
  if (local >= 0) {
    const c = cameraFromSample(g.camFile.sample(local, shot!.t));
    g.view = { view: mul(cameraView(c), D3D_VIEW_FLIP), eye: c.eye };
  }
  const sl = p.light;
  const fog = sl.fog ? { color: sl.fogColor } : (false as const);
  r.clear(...(sl.fog ? sl.fogColor : ([0, 0, 0] as [number, number, number])));
  if (g.view) {
    const opts = { world: identity(), view: g.view.view, proj: cameraProjection(0x1d3b, w / h), lit: true, culling: true, lighting: d3dLighting(sl), eye: g.view.eye, fog };
    for (const f of g.files) r.draw(f.gpu, f.tex, opts);
    // The car hides while the title card is up (DAT_00a14048 & 0x20).
    if (g.car && !g.titleUp) {
      for (const d of g.car.draw(g.player.frame)) {
        const m = modelCache.get(d.model);
        if (m) r.draw(m.gpu, m.tex, { ...opts, world: d.world });
      }
    }
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
  for (const id of ['game-bar-top', 'game-bar-bottom']) Object.assign($(id).style, { height: `${CINE_BAR * sy}px`, visibility: p.skippable ? 'visible' : 'hidden' });
  const sub = p.subtitle;
  $('game-subtitle').textContent = sub ? sub.speech.lines[sub.line]?.text ?? '' : '';
  if (p.done) setStatus(`End of Stage ${g.stage} so far — Esc to quit`);
  else if (p.shot?.fight !== undefined) setStatus('Fight — not ported yet');
  else setStatus('');
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
