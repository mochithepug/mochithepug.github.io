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
  type PolModel,
} from '@ttotd/formats';
import { Assets } from './assets';
import type { GameFS } from './ingest/gamefs';
import { FlyCamera } from './gl/fly';
import { Renderer, type GpuModel, type TextureSource } from './gl/renderer';

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
  ctx = { assets, renderer: new Renderer($<HTMLCanvasElement>('stg-canvas')), cam, files: [], stage: '', last: performance.now(), token: 0, camIds: [], camNext: [], playing: false };
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

function tick(now: number) {
  requestAnimationFrame(tick);
  if (!ctx) return;
  const dt = Math.min((now - ctx.last) / 1000, 0.1);
  ctx.last = now;
  if ($('tab-stage').hidden) return;
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
    if (ctx.path) {
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
    const lit = $<HTMLInputElement>('stg-lit').checked, culling = $<HTMLInputElement>('stg-cull').checked;
    const sl = sceneLight();
    const lighting = d3dLighting(sl);
    const fog = sl.fog ? { color: sl.fogColor } : (false as const);
    if (sl.fog) r.clear(...sl.fogColor);
    for (const f of ctx.files) if (f.on && f.gpu) r.draw(f.gpu, f.tex, { world: identity(), view, proj, lit, culling, lighting, eye, fog });
    if (ctx.path) {
      const s = ctx.path.file.sample(ctx.path.index, ctx.path.t);
      const c = cameraFromSample(s);
      $<HTMLInputElement>('stg-time').value = String(Math.floor(ctx.path.t));
      $('stg-time-label').textContent = `${Math.floor(ctx.path.t)} / ${Math.round(ctx.path.file.duration(ctx.path.index))}`;
      $('stg-pos').textContent = `eye (${s.eye.map((v) => v.toFixed(0)).join(', ')}) pitch ${c.pitch} yaw ${c.yaw}`;
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
