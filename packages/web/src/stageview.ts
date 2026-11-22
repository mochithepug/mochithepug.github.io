/** Stage tab (M7a): a stage's geometry files assembled in world space, explored with a fly camera. */
import { identity, type PolModel } from '@ttotd/formats';
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
  ctx = { assets, renderer: new Renderer($<HTMLCanvasElement>('stg-canvas')), cam, files: [], stage: '', last: performance.now(), token: 0 };
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
  updateInfo();
  redraw();
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
  if (!$('tab-stage').hidden && ctx.cam.update(dt)) redraw();
}

let pending = false;
export function redraw() {
  if (!ctx || pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    if (!ctx || $('tab-stage').hidden) return;
    const r = ctx.renderer, canvas = r.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    r.clear(0.05, 0.05, 0.07);
    const { view, proj, lightDir } = ctx.cam.matrices(w / h);
    const lit = $<HTMLInputElement>('stg-lit').checked, culling = $<HTMLInputElement>('stg-cull').checked;
    for (const f of ctx.files) if (f.on && f.gpu) r.draw(f.gpu, f.tex, { world: identity(), view, proj, lit, culling, lightDir });
    const p = ctx.cam.pos.map((v) => v.toFixed(0)).join(', ');
    $('stg-pos').textContent = `pos (${p}) yaw ${ctx.cam.yaw.toFixed(2)} pitch ${ctx.cam.pitch.toFixed(2)}`;
  });
}
for (const id of ['stg-lit', 'stg-cull']) $(id).addEventListener('change', () => redraw());
