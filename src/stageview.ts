/** Stage tab (M7a): a stage's geometry files assembled in world space, explored with a fly camera. */
import {
  CameraFile,
  d3dLighting,
  DEFAULT_SCENE_LIGHT,
  type SceneLight,
  pathContinuations,
  cameraFromSample,
  cameraProjection,
  cameraView,
  D3D_VIEW_FLIP,
  identity,
  mul,
  readCameraSlots,
  EventFile,
  EventPlayer,
  EVT_COM_BASE,
  readBlockRules,
  readDialogue,
  STAGE_EVENT_FILES,
  readCharacterTypes,
  type PolModel,
  type SpawnRecord,
  type Mat4,
} from '@ttotd/formats';
import { TITLE_CARD_FLAG, TitleCard } from '@ttotd/engine';
import { Assets } from './assets';
import type { GameFS } from './ingest/gamefs';
import { FlyCamera } from './gl/fly';
import { Renderer, type GpuModel, type Marker3D, type TextureSource } from './gl/renderer';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

interface StageFile {
  name: string;
  models?: PolModel[];
  gpu?: GpuModel;
  tex?: TextureSource;
  on: boolean;
}

interface Ctx {
  assets: Assets;
  renderer: Renderer;
  cam: FlyCamera;
  files: StageFile[];
  stage: string;
  last: number;
  token: number;
  /** When set, render through the game camera (path index, time in path units). */
  path?: { file: CameraFile; index: number; t: number; ids: number[] };
  camFile?: CameraFile;
  camIds: number[];
  /** Paths that start where each path ends (route continuity). */
  camNext: number[][];
  playing: boolean;
  /** Event script playback (camera mode "event script"). */
  evt?: { player: EventPlayer; playing: boolean; acc: number; logShown: number; spawned: number; title?: TitleCard };
  skipSign?: boolean;
  /** Skeleton names for spawn labels. */
  charNames: string[];
}
let ctx: Ctx | undefined;

/** Stage file groups by name: st1_*, st2_*, st3/st3_*, … */
function stageGroups(fs: GameFS): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const f of fs.files) {
    const m = /^pol\/(st(\d)(?:_[0-9a-z]+)?\.bin)$/i.exec(f.key);
    if (!m || f.size < 32) continue;
    const key = `Stage ${m[2]}`;
    const name = f.path.slice(4);
    groups.set(key, [...(groups.get(key) ?? []), name]);
  }
  for (const v of groups.values()) v.sort();
  return new Map([...groups].sort());
}

export async function initStage(fs: GameFS, params = new URLSearchParams()) {
  const assets = await Assets.open(fs);
  const cam = new FlyCamera();
  ctx = { assets, renderer: new Renderer($<HTMLCanvasElement>('stg-canvas')), cam, files: [], stage: '', last: performance.now(), token: 0, camIds: [], camNext: [], playing: false, charNames: readCharacterTypes(assets.pe).map((t) => t.name) };
  cam.attach($<HTMLCanvasElement>('stg-canvas'), () => !$('tab-stage').hidden);
  cam.onChange = () => redraw();
  const groups = stageGroups(fs);
  const sel = $<HTMLSelectElement>('stg-select');
  sel.replaceChildren(...[...groups.keys()].map((k) => new Option(k, k)));
  sel.onchange = () => void openStage(sel.value, groups.get(sel.value) ?? []);
  const first = params.get('stage') ? `Stage ${params.get('stage')}` : [...groups.keys()][0]!;
  sel.value = first;
  await openStage(first, groups.get(first) ?? []);
  const off = (params.get('off') ?? '').split(',').filter(Boolean);
  for (const f of ctx.files) if (off.some((o) => f.name.toLowerCase() === `${o.toLowerCase()}.bin`)) f.on = false;
  renderFileList();
  updateInfo();
  for (const [k, n] of [['x', 0], ['y', 1], ['z', 2]] as const) if (params.has(k)) cam.pos[n] = Number(params.get(k));
  if (params.has('yaw')) cam.yaw = Number(params.get('yaw'));
  if (params.has('pitch')) cam.pitch = Number(params.get('pitch'));
  if (params.has('evt')) {
    $<HTMLSelectElement>('stg-cammode').value = 'events';
    await startEvents(Number(params.get('evt')), params.get('play') !== '0');
    setCameraModeEventsUi();
    if (params.has('frames') && ctx.evt) for (let i = 0; i < Number(params.get('frames')); i++) stepEvents(ctx.evt);
    renderEventLog();
    redraw();
  }
  if (params.has('campath')) {
    $<HTMLSelectElement>('stg-cammode').value = 'path';
    setCameraMode('path', Number(params.get('campath')), Number(params.get('camt') ?? 0));
    ctx.playing = params.get('play') === '1';
    updatePlayButton();
  }
  requestAnimationFrame(tick);
}

async function openStage(stage: string, names: string[]) {
  if (!ctx) return;
  const token = ++ctx.token;
  for (const f of ctx.files) f.gpu?.dispose();
  ctx.stage = stage;
  ctx.files = names.map((name) => ({ name, on: true }));
  $('stg-title').textContent = stage;
  renderFileList();
  $('stg-info').textContent = 'loading…';
  for (const f of ctx.files) {
    f.models = await ctx.assets.models(f.name);
    f.tex = await ctx.assets.textures(f.name, true);
    if (token !== ctx.token) return;
    f.gpu = ctx.renderer.upload(f.models);
  }
  renderFileList();
  placeCamera();
  await loadStageCamera(stage);
  updateInfo();
  redraw();
}

/** Load cam/cp_stN.bin for the stage (path list in the exe's order). */
async function loadStageCamera(stage: string) {
  if (!ctx) return;
  const n = stage.replace(/\D/g, '');
  const slot = readCameraSlots(ctx.assets.pe).find((x) => x.file === `cp_st${n}.bin`);
  ctx.camFile = slot && ctx.assets.fs.has(`cam/${slot.file}`) ? new CameraFile(await ctx.assets.file(`cam/${slot.file}`), slot.ids.length) : undefined;
  ctx.camIds = slot?.ids ?? [];
  ctx.camNext = ctx.camFile ? pathContinuations(ctx.camFile) : [];
  const hasPrev = new Set(ctx.camNext.flat());
  const sel = $<HTMLSelectElement>('stg-path');
  sel.replaceChildren(
    ...ctx.camIds.map((id, k) => {
      const nx = ctx!.camNext[k]!;
      const label = `${hasPrev.has(k) ? '' : '▶ '}path ${k} · ${Math.round(ctx!.camFile!.duration(k))}f → ${nx.length ? nx.join(' | ') : 'end'}`;
      const o = new Option(label, String(k));
      o.title = `id ${id}${nx.length > 1 ? ' — branch point' : ''}`;
      return o;
    }),
  );
  if (ctx.path) setCameraMode('path', 0, 0);
}

function setCameraMode(mode: string, index = 0, t = 0) {
  if (!ctx) return;
  const wrap = $('stg-canvas').parentElement!;
  const events = mode === 'events' && !!ctx.camFile;
  $('stg-evt-controls').hidden = !events;
  $('stg-evt-log').hidden = !events;
  $('stg-overlay').hidden = !events;
  if (!events) ctx.evt = undefined;
  if (events) {
    ctx.path = undefined;
    ctx.playing = false;
    $('stg-path-controls').hidden = true;
    wrap.classList.add('letterbox');
    void startEvents(Number($<HTMLSelectElement>('stg-evt-block').value || 0));
    updatePlayButton();
    return;
  }
  if (mode === 'path' && ctx.camFile) {
    ctx.path = { file: ctx.camFile, index: Math.min(index, ctx.camIds.length - 1), t, ids: ctx.camIds };
    $<HTMLSelectElement>('stg-path').value = String(ctx.path.index);
    const slider = $<HTMLInputElement>('stg-time');
    slider.max = String(Math.floor(ctx.camFile.duration(ctx.path.index)));
    $('stg-path-controls').hidden = false;
    wrap.classList.add('letterbox');
  } else {
    ctx.path = undefined;
    ctx.playing = false;
    $('stg-path-controls').hidden = true;
    wrap.classList.remove('letterbox');
  }
  updatePlayButton();
  redraw();
}

function updatePlayButton() {
  $('stg-play').textContent = ctx?.playing ? '❚❚ pause' : '▶ play';
  $('stg-evt-play').textContent = ctx?.evt?.playing ? '❚❚ pause' : '▶ play';
}

// --- event script playback (M9) -----------------------------------------------------------------
function setCameraModeEventsUi() {
  if (!ctx) return;
  $('stg-evt-controls').hidden = false;
  $('stg-evt-log').hidden = false;
  $('stg-overlay').hidden = false;
  $('stg-path-controls').hidden = true;
  $('stg-canvas').parentElement!.classList.add('letterbox');
}
const stageNumber = () => Number(ctx?.stage.replace(/\D/g, '') || 1);

async function startEvents(block: number, play = true) {
  if (!ctx) return;
  const n = stageNumber();
  const name = STAGE_EVENT_FILES[n - 1];
  if (!name || !ctx.assets.fs.has(`evt/${name}`)) return;
  const ef = new EventFile(await ctx.assets.file(`evt/${name}`));
  const common = ctx.assets.fs.has('evt/comevtbl.bin') ? new EventFile(await ctx.assets.file('evt/comevtbl.bin'), EVT_COM_BASE) : undefined;
  const pe = ctx.assets.pe;
  const sel = $<HTMLSelectElement>('stg-evt-block');
  if (sel.dataset.stage !== String(n)) {
    sel.replaceChildren(...ef.blocks().map((b) => new Option(`block ${b.index}`, String(b.index))));
    sel.dataset.stage = String(n);
  }
  sel.value = String(block);
  const player = new EventPlayer(ef, {
    rules: readBlockRules(pe, n - 1),
    dialogue: (id) => readDialogue(pe, id, 0) ?? readDialogue(pe, id, 2),
    common,
    holdFrames: Number($<HTMLSelectElement>('stg-evt-hold').value),
  });
  player.start(block);
  ctx.evt = { player, playing: play, acc: 0, logShown: 0, spawned: 0 };
  $('stg-evt-log').replaceChildren();
  await loadSkipSign();
  updatePlayButton();
  redraw();
}

/** The "Press the Enter key to skip" sprite: scr_common.bin texture 23 (sprite 0x20F), drawn at (384, 18). */
async function loadSkipSign() {
  if (!ctx || ctx.skipSign !== undefined) return;
  const tex = await ctx.assets.textures('scr_common.bin', false);
  const t = tex?.get(23);
  const cv = $<HTMLCanvasElement>('stg-skip');
  if (!t) {
    ctx.skipSign = false;
    return;
  }
  cv.width = t.width;
  cv.height = t.height;
  const img = new ImageData(t.width, t.height);
  for (let y = 0; y < t.height; y++) img.data.set(t.rgba.subarray((t.height - 1 - y) * t.width * 4, (t.height - y) * t.width * 4), y * t.width * 4);
  cv.getContext('2d')!.putImageData(img, 0, 0);
  ctx.skipSign = true;
}

function renderEventLog() {
  if (!ctx?.evt) return;
  const { player } = ctx.evt;
  const box = $('stg-evt-log');
  const fresh = player.log.slice(ctx.evt.logShown);
  if (!fresh.length) return;
  ctx.evt.logShown = player.log.length;
  for (const e of fresh) {
    const d = document.createElement('div');
    d.className = e.kind;
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = `${(e.frame / 60).toFixed(2)}s  ${e.timer}`;
    d.append(t, document.createTextNode(e.text));
    box.append(d);
  }
  while (box.childElementCount > 400) box.firstElementChild!.remove();
  box.scrollTop = box.scrollHeight;
}

/** Letterbox bar height in 640×480 pixels (provisional, see placeOverlay). */
const CINE_BAR = 60;

/** Overlays sit exactly on the 4:3 game picture (640×480 coordinates). */
function placeOverlay() {
  if (!ctx?.evt) return;
  const canvas = $<HTMLCanvasElement>('stg-canvas'), ov = $('stg-overlay');
  Object.assign(ov.style, { left: `${canvas.offsetLeft}px`, top: `${canvas.offsetTop}px`, width: `${canvas.clientWidth}px`, height: `${canvas.clientHeight}px` });
  const sx = canvas.clientWidth / 640, sy = canvas.clientHeight / 480;
  const p = ctx.evt.player;
  const skip = $<HTMLCanvasElement>('stg-skip');
  Object.assign(skip.style, { left: `${384 * sx}px`, top: `${18 * sy}px`, width: `${256 * sx}px`, height: `${32 * sy}px` });
  // skip_task @00423da0: visible while frame % 60 < 45 (visibility, not [hidden]: a stylesheet rule forces
  // canvases in .canvas-wrap to display:block, which defeated the hidden attribute)
  skip.style.visibility = p.skippable && ctx.skipSign && p.frame % 60 < 45 ? 'visible' : 'hidden';
  // Cut-scene letterbox: shown while the scene is skippable. Bar height is provisional (60 px of 480 → a
  // 640×360 picture) until measured against the original / traced in the exe.
  const bar = CINE_BAR * sy;
  for (const id of ['stg-bar-top', 'stg-bar-bottom']) Object.assign($(id).style, { height: `${bar}px`, visibility: p.skippable ? 'visible' : 'hidden' });
  const sub = p.subtitle;
  $('stg-subtitle').textContent = sub ? sub.speech.lines[sub.line]?.text ?? '' : '';
  // Keep the block dropdown on the block being played (unless the user is using it).
  const sel = $<HTMLSelectElement>('stg-evt-block');
  if (document.activeElement !== sel && sel.value !== String(p.block)) sel.value = String(p.block);
  const sh = p.shot;
  $('stg-evt-clock').textContent = `block ${p.block} · ${(p.frame / 60).toFixed(1)} s · ${sh ? `path ${ctx.camIds.indexOf(sh.pathId)} t ${sh.t}` : 'no shot'}${sh?.fight ? ' · fight' : ''}${p.done ? ' · end' : ''}`;
}

function renderFileList() {
  if (!ctx) return;
  $('stg-files-head').textContent = `${ctx.files.length} files`;
  const files = ctx.files;

  // Select / deselect all: checked when all are on, indeterminate when some are.
  const all = document.createElement('label');
  all.className = 'select-all';
  const allCb = document.createElement('input');
  allCb.type = 'checkbox';
  const syncAll = () => {
    const on = files.filter((f) => f.on).length;
    allCb.checked = on === files.length;
    allCb.indeterminate = on > 0 && on < files.length;
  };
  allCb.onchange = () => {
    const turnOn = !files.every((f) => f.on);
    for (const f of files) f.on = turnOn;
    renderFileList();
    updateInfo();
    redraw();
  };
  const allName = document.createElement('span');
  allName.textContent = 'all files';
  all.append(allCb, allName);
  syncAll();

  $('stg-file-list').replaceChildren(
    all,
    ...files.map((f) => {
      const l = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = f.on;
      cb.onchange = () => { f.on = cb.checked; syncAll(); updateInfo(); redraw(); };
      const name = document.createElement('span');
      name.textContent = f.name.replace(/\.bin$/i, '');
      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = f.models ? `${f.models.reduce((s, m) => s + m.meshes.length, 0)}` : '…';
      n.title = 'meshes';
      l.append(cb, name, n);
      return l;
    }),
  );
}

/** Start above the centre of the playable area (the st?_0x files, not the huge backdrop), looking along +z. */
function placeCamera() {
  if (!ctx) return;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const f of ctx.files) {
    if (!/_0\d/.test(f.name) || !f.models) continue;
    for (const m of f.models) for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k]!, m.center[k]! - m.radius);
      hi[k] = Math.max(hi[k]!, m.center[k]! + m.radius);
    }
  }
  if (!Number.isFinite(lo[0]!)) return;
  ctx.cam.pos = [(lo[0]! + hi[0]!) / 2, hi[1]! + 150, lo[2]! - 200];
  ctx.cam.yaw = 0;
  ctx.cam.pitch = -0.35;
}

function updateInfo() {
  if (!ctx) return;
  const on = ctx.files.filter((f) => f.on && f.models);
  const meshes = on.reduce((s, f) => s + f.models!.reduce((t, m) => t + m.meshes.length, 0), 0);
  $('stg-info').textContent = `${on.length} files · ${meshes} meshes`;
}

/** One frame of the script, plus the chapter title card (it releases the script's op 0x45 248 wait). */
function stepEvents(e: NonNullable<Ctx['evt']>) {
  const p = e.player;
  p.step();
  for (; e.spawned < p.spawns.length; e.spawned++) if (p.spawns[e.spawned]!.type === 0x60) e.title = new TitleCard();
  e.title?.tick(false);
  if (e.title?.done) p.flags[TITLE_CARD_FLAG] = 1;
}

function tick(now: number) {
  requestAnimationFrame(tick);
  if (!ctx) return;
  const dt = Math.min((now - ctx.last) / 1000, 0.1);
  ctx.last = now;
  if ($('tab-stage').hidden) return;
  if (ctx.evt) {
    const e = ctx.evt;
    if (e.playing && !e.player.done) {
      e.acc += dt * 60 * Number($<HTMLSelectElement>('stg-evt-speed').value);
      let n = 0;
      while (e.acc >= 1 && n++ < 16) {
        e.acc -= 1;
        stepEvents(e);
      }
      renderEventLog();
      redraw();
    }
    return;
  }
  if (ctx.path) {
    if (ctx.playing) {
      const p = ctx.path, dur = p.file.duration(p.index);
      p.t += dt * 60 * Number($<HTMLSelectElement>('stg-speed').value);
      if (p.t > dur) {
        const nx = ctx.camNext[p.index] ?? [];
        if ($<HTMLInputElement>('stg-chain').checked && nx.length) setCameraMode('path', nx[0]!, 0);
        else {
          // end of a run (or chain off): stop on the last frame instead of jumping elsewhere
          p.t = dur;
          ctx.playing = false;
          updatePlayButton();
        }
      }
      redraw();
    }
  } else if (ctx.cam.update(dt)) redraw();
}

let pending = false;
export function redraw() {
  if (!ctx || pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    if (!ctx || $('tab-stage').hidden) return;
    const r = ctx.renderer, canvas = r.canvas;
    if (ctx.path || ctx.evt) {
      // The game renders 640×480: show the game camera at 4:3, letterboxed.
      const wrap = canvas.parentElement!;
      const cw = Math.min(wrap.clientWidth, (wrap.clientHeight * 4) / 3);
      canvas.style.width = `${cw}px`;
      canvas.style.height = `${(cw * 3) / 4}px`;
    } else {
      canvas.style.width = '';
      canvas.style.height = '';
    }
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    r.clear(0.05, 0.05, 0.07);
    let { view, proj } = ctx.cam.matrices(w / h);
    let eye: [number, number, number] = [...ctx.cam.pos];
    if (ctx.path) {
      const c = cameraFromSample(ctx.path.file.sample(ctx.path.index, ctx.path.t));
      view = mul(cameraView(c), D3D_VIEW_FLIP);
      eye = c.eye;
      proj = cameraProjection(0x1d3b, w / h);
    }
    const shot = ctx.evt?.player.shot;
    const local = shot ? ctx.camIds.indexOf(shot.pathId) : -1;
    if (ctx.evt && ctx.camFile && local >= 0) {
      const c = cameraFromSample(ctx.camFile.sample(local, shot!.t));
      view = mul(cameraView(c), D3D_VIEW_FLIP);
      eye = c.eye;
      proj = cameraProjection(0x1d3b, w / h);
    }
    const lit = $<HTMLInputElement>('stg-lit').checked, culling = $<HTMLInputElement>('stg-cull').checked;
    const sl = ctx.evt ? ctx.evt.player.light : sceneLight();
    const lighting = d3dLighting(sl);
    const fog = sl.fog ? { color: sl.fogColor } : (false as const);
    if (sl.fog) r.clear(...sl.fogColor);
    for (const f of ctx.files) if (f.on && f.gpu) r.draw(f.gpu, f.tex, { world: identity(), view, proj, lit, culling, lighting, eye, fog });
    if (ctx.evt) {
      const spawns = ctx.evt.player.spawns;
      const markers = spawnMarkers(spawns);
      r.drawMarkers(markers, view, proj);
      placeOverlay();
      placeSpawnLabels(markers, view, proj);
    }
    if (ctx.path) {
      const s = ctx.path.file.sample(ctx.path.index, ctx.path.t);
      const c = cameraFromSample(s);
      $<HTMLInputElement>('stg-time').value = String(Math.floor(ctx.path.t));
      $('stg-time-label').textContent = `${Math.floor(ctx.path.t)} / ${Math.round(ctx.path.file.duration(ctx.path.index))}`;
      $('stg-pos').textContent = `eye (${s.eye.map((v) => v.toFixed(0)).join(', ')}) pitch ${c.pitch} yaw ${c.yaw}`;
    } else if (ctx.evt) {
      $('stg-pos').textContent = `eye (${eye.map((v) => v.toFixed(0)).join(', ')})`;
    } else {
      const p = ctx.cam.pos.map((v) => v.toFixed(0)).join(', ');
      $('stg-pos').textContent = `pos (${p}) yaw ${ctx.cam.yaw.toFixed(2)} pitch ${ctx.cam.pitch.toFixed(2)}`;
    }
  });
}
for (const id of ['stg-lit', 'stg-cull']) $(id).addEventListener('change', () => redraw());

$<HTMLSelectElement>('stg-cammode').addEventListener('change', (e) => setCameraMode((e.target as HTMLSelectElement).value));
$<HTMLSelectElement>('stg-path').addEventListener('change', (e) => setCameraMode('path', Number((e.target as HTMLSelectElement).value), 0));
$('stg-play').addEventListener('click', () => {
  if (!ctx) return;
  ctx.playing = !ctx.playing;
  updatePlayButton();
});
$<HTMLInputElement>('stg-time').addEventListener('input', (e) => {
  if (!ctx?.path) return;
  ctx.playing = false;
  updatePlayButton();
  ctx.path.t = Number((e.target as HTMLInputElement).value);
  redraw();
});

// --- scene light & fog controls (the game's inputs; real per-scene values come from M9) ---------
const SL_IDS = ['sl-r', 'sl-g', 'sl-b', 'sl-i', 'sl-p', 'sl-y', 'sl-fs', 'sl-fe'];
function sceneLight(): SceneLight {
  const v = (id: string) => Number($<HTMLInputElement>(id).value);
  const hex = $<HTMLInputElement>('sl-fc').value;
  const fc = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  for (const id of SL_IDS) $(`${id}-v`).textContent = $<HTMLInputElement>(id).value;
  return {
    color: [v('sl-r'), v('sl-g'), v('sl-b')],
    intensity: v('sl-i'),
    pitch: Math.round((v('sl-p') / 360) * 65536),
    yaw: Math.round((v('sl-y') / 360) * 65536),
    fogStart: v('sl-fs'),
    fogEnd: v('sl-fe'),
    fogColor: fc,
    fog: $<HTMLInputElement>('sl-fog').checked,
  };
}
for (const id of [...SL_IDS, 'sl-fog', 'sl-fc']) $(id).addEventListener('input', () => redraw());
$('sl-reset').addEventListener('click', () => {
  const d = DEFAULT_SCENE_LIGHT;
  const set = (id: string, v: number) => ($<HTMLInputElement>(id).value = String(v));
  set('sl-r', d.color[0]); set('sl-g', d.color[1]); set('sl-b', d.color[2]); set('sl-i', d.intensity);
  set('sl-p', 0); set('sl-y', 0); set('sl-fs', 0); set('sl-fe', 1000);
  $<HTMLInputElement>('sl-fog').checked = d.fog;
  $<HTMLInputElement>('sl-fc').value = '#000000';
  redraw();
});

$('stg-evt-play').addEventListener('click', () => {
  if (!ctx?.evt) return;
  ctx.evt.playing = !ctx.evt.playing;
  updatePlayButton();
});
$('stg-evt-restart').addEventListener('click', () => void startEvents(Number($<HTMLSelectElement>('stg-evt-block').value || 0)));
$<HTMLSelectElement>('stg-evt-block').addEventListener('change', (e) => void startEvents(Number((e.target as HTMLSelectElement).value)));
$<HTMLSelectElement>('stg-evt-hold').addEventListener('change', () => {
  if (ctx?.evt) ctx.evt.player.opts.holdFrames = Number($<HTMLSelectElement>('stg-evt-hold').value);
});

// --- spawn markers (M9b) -----------------------------------------------------------------------

function spawnColor(r: SpawnRecord): [number, number, number] {
  if (r.type === 0x63) return [0.5, 0.5, 0.5]; // skip_task
  if (r.type === 0x60) return [0.4, 0.4, 0.6]; // title card
  if (r.type === 0x41) {
    // placed objects: colour by kind range
    if (r.kind >= 0x04 && r.kind <= 0x0b) return [1, 0.3, 0.2]; // enemies
    if (r.kind >= 0x12 && r.kind <= 0x14) return [1, 0.2, 0.4]; // bosses
    if (r.kind >= 0x19 && r.kind <= 0x1c) return [0.8, 0.1, 0.5]; // bosses b
    if (r.kind === 0x22) return [0.2, 0.7, 1]; // player characters
    if (r.kind >= 0x26 && r.kind <= 0x2c) return [1, 0.5, 0.1]; // scene objects
    if (r.kind >= 0x38) return [1, 0.6, 0.6]; // late enemies
    return [1, 1, 0.3]; // other placed
  }
  if (r.type >= 0x10 && r.type <= 0x17) return [1, 0.2, 0.2]; // zombies
  if (r.type >= 0x20 && r.type <= 0x23) return [0.8, 0.1, 0.5]; // bosses
  if (r.type >= 0x27 && r.type <= 0x2a) return [0.3, 0.6, 1]; // cars
  if (r.type === 0x30 || r.type === 0x31) return [0.2, 0.9, 0.5]; // first-wave enemies
  return [0.9, 0.9, 0.3]; // other
}

function spawnLabel(r: SpawnRecord): string {
  if (r.type === 0x63) return 'skip';
  if (r.type === 0x60) return 'HUD';
  if (r.type === 0x41) {
    if (r.kind >= 0x27 && r.kind <= 0x2a) return `car[${r.kind - 0x27}]`;
    return `obj[${r.kind}]`;
  }
  const name = ctx?.charNames[r.skeleton] ?? `skel${r.skeleton}`;
  return `t${r.type.toString(16)} ${name} hp${r.hp}`;
}

function spawnMarkers(spawns: SpawnRecord[]): Marker3D[] {
  const out: Marker3D[] = [];
  for (const s of spawns) {
    if (!s.pos) continue;
    // Skip zero-position records for placed objects that inherit their parent's position
    const [x, y, z] = s.pos;
    out.push({ pos: [x, y, z], color: spawnColor(s), size: 4, label: spawnLabel(s) });
  }
  return out;
}

function placeSpawnLabels(markers: Marker3D[], view: Mat4, proj: Mat4) {
  if (!ctx) return;
  const container = $('stg-spawn-labels');
  while (container.children.length > markers.length) container.lastElementChild!.remove();
  while (container.children.length < markers.length) {
    const el = document.createElement('div');
    el.className = 'spawn-label';
    container.append(el);
  }
  for (let i = 0; i < markers.length; i++) {
    const m = markers[i]!;
    const el = container.children[i] as HTMLElement;
    const p = ctx.renderer.project(m.pos, view, proj);
    if (!p) { el.style.display = 'none'; continue; }
    el.style.display = '';
    el.style.left = `${p[0]}px`;
    el.style.top = `${p[1] - 16}px`;
    el.style.color = `rgb(${m.color.map((c) => Math.round(c * 255)).join(',')})`;
    el.textContent = m.label ?? '';
  }
}
