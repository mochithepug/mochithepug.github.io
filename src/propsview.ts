/** Props tab (M7d): the 30 animated prop types from the exe + their motions, played at 60 Hz. */
import {
  GAME_PROP_MOTIONS,
  identity,
  poseProp,
  propMotionFits,
  PropMotion,
  readMotionTable,
  readPropTypes,
  type MotionInfo,
  type PolModel,
  type PropNode,
  type PropType,
} from '@ttotd/formats';
import { Assets } from './assets';
import type { GameFS } from './ingest/gamefs';
import { OrbitCamera } from './gl/orbit';
import { Renderer, type GpuModel, type TextureSource } from './gl/renderer';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

interface Ctx {
  assets: Assets;
  types: PropType[];
  motions: MotionInfo[];
  renderer: Renderer;
  cam: OrbitCamera;
  type?: PropType;
  motion?: PropMotion;
  parts: Map<number, { gpu: GpuModel; tex?: TextureSource }>;
  frame: number;
  prev: number;
  playing: boolean;
  acc: number;
  last: number;
  token: number;
}
let ctx: Ctx | undefined;

export async function initProps(fs: GameFS, params = new URLSearchParams()) {
  const assets = await Assets.open(fs);
  const cam = new OrbitCamera();
  ctx = {
    assets,
    types: readPropTypes(assets.pe),
    motions: readMotionTable(assets.pe),
    renderer: new Renderer($<HTMLCanvasElement>('prp-canvas')),
    cam,
    parts: new Map(),
    frame: 0,
    prev: -1,
    playing: params.get('play') !== '0',
    acc: 0,
    last: performance.now(),
    token: 0,
  };
  cam.attach($<HTMLCanvasElement>('prp-canvas'));
  cam.onChange = () => redraw();
  renderTypeList();
  new ResizeObserver(() => redraw()).observe($('prp-canvas').parentElement!);
  const want = params.get('prop');
  const type = (want && ctx.types.find((t) => String(t.index) === want || t.name === want)) || ctx.types[12]!;
  await selectType(type, params.get('motion') ?? undefined);
  if (params.has('frame')) setFrame(Number(params.get('frame')));
  if (params.has('bg')) $<HTMLSelectElement>('prp-bg').value = params.get('bg')!;
  if (params.has('fitframe')) fitView(ctx.frame);
  updatePlayButton();
  requestAnimationFrame(tick);
}

function renderTypeList() {
  if (!ctx) return;
  const q = $<HTMLInputElement>('prp-filter').value.trim().toLowerCase();
  $('prp-type-list').replaceChildren(
    ...ctx.types
      .filter((t) => !q || t.files.some((f) => f.toLowerCase().includes(q)) || String(t.index) === q)
      .map((t) => {
        const d = document.createElement('div');
        d.className = 'set-item' + (t === ctx!.type ? ' active' : '');
        d.dataset.index = String(t.index);
        const a = document.createElement('span');
        a.textContent = t.files.map((f) => f.replace(/\.bin$/i, '')).join(' + ') || '(empty)';
        const b = document.createElement('span');
        b.className = 'n';
        b.textContent = `#${t.index}`;
        d.title = `${t.n - 1} joints · interpolation mode ${t.mode}`;
        d.append(a, b);
        d.onclick = () => void selectType(t);
        return d;
      }),
  );
}
$<HTMLInputElement>('prp-filter').addEventListener('input', renderTypeList);

async function selectType(t: PropType, motionHint?: string) {
  if (!ctx) return;
  const token = ++ctx.token;
  ctx.type = t;
  for (const el of document.querySelectorAll<HTMLElement>('#prp-type-list .set-item')) el.classList.toggle('active', el.dataset.index === String(t.index));
  $('prp-title').textContent = `${t.name} (prop #${t.index})`;
  $('prp-info').textContent = 'loading…';

  for (const p of ctx.parts.values()) p.gpu.dispose();
  ctx.parts.clear();
  const nodes: PropNode[] = [];
  const walk = (n: PropNode) => {
    if (n.ref) nodes.push(n);
    n.children.forEach(walk);
  };
  t.roots.forEach(walk);
  for (const n of nodes) {
    if (ctx.parts.has(n.model)) continue;
    const models: PolModel[] = await ctx.assets.models(n.ref!.file);
    const m = models[n.ref!.index];
    if (!m || token !== ctx.token) continue;
    ctx.parts.set(n.model, { gpu: ctx.renderer.upload([m]), tex: await ctx.assets.textures(n.ref!.file) });
  }
  if (token !== ctx.token) return;

  const paired = GAME_PROP_MOTIONS[t.index] ?? [];
  const fitting: MotionInfo[] = [];
  for (const m of ctx.motions) {
    if (!ctx.assets.fs.has(`mot/${m.file}`)) continue;
    if (propMotionFits(await ctx.assets.file(`mot/${m.file}`), m, t.n)) fitting.push(m);
  }
  if (token !== ctx.token) return;
  // Game-paired first, then komono* files (prop motions), then the rest (size matches only).
  const rank = (m: MotionInfo) => (paired.includes(m.id) ? 0 : m.file.startsWith('komono') ? 1 : 2);
  fitting.sort((a, b) => rank(a) - rank(b) || a.file.localeCompare(b.file) || a.index - b.index);
  renderMotionList(fitting, paired);
  $('prp-motions-head').textContent = `${fitting.length} motions fit (${t.n - 1} joints, mode ${t.mode})`;
  const hinted = motionHint ? fitting.find((m) => String(m.id) === motionHint) : undefined;
  const pick = hinted ?? fitting[0];
  if (pick) await selectMotion(pick, true);
  else {
    ctx.motion = undefined;
    $('prp-info').textContent = `${t.n - 1} joints · ${ctx.parts.size} parts · no motion fits`;
    redraw();
  }
}

function renderMotionList(list: MotionInfo[], paired: readonly number[]) {
  const items: HTMLElement[] = [];
  let group = '';
  for (const m of list) {
    if (m.file !== group) {
      group = m.file;
      const h = document.createElement('div');
      h.className = 'group-head';
      h.textContent = `mot/${m.file}`;
      items.push(h);
    }
    const d = document.createElement('div');
    d.className = 'set-item';
    d.dataset.id = String(m.id);
    const a = document.createElement('span');
    a.textContent = `${paired.includes(m.id) ? '★ ' : ''}#${m.index} · id ${m.id}`;
    const b = document.createElement('span');
    b.className = 'n';
    b.textContent = `${m.frames}f`;
    d.append(a, b);
    d.onclick = () => void selectMotion(m, false);
    items.push(d);
  }
  $('prp-motion-list').replaceChildren(...items);
}

async function selectMotion(info: MotionInfo, fit: boolean) {
  if (!ctx?.type) return;
  const file = await ctx.assets.file(`mot/${info.file}`);
  ctx.motion = new PropMotion(file, info, ctx.type);
  for (const el of document.querySelectorAll<HTMLElement>('#prp-motion-list .set-item')) el.classList.toggle('active', el.dataset.id === String(info.id));
  $<HTMLInputElement>('prp-frame').max = String(Math.max(0, ctx.motion.frames - 1));
  const paired = (GAME_PROP_MOTIONS[ctx.type.index] ?? []).includes(info.id);
  $('prp-info').textContent =
    `${ctx.type.n - 1} joints · ${ctx.parts.size} parts · mot/${info.file} #${info.index}` +
    ` · ${info.frames} frames (${(info.frames / 60).toFixed(2)} s)` +
    (paired ? ' · ★ game pairing' : ' · size match only') +
    (ctx.motion.readsPastEnd ? ' · ⚠ the exe would read past the stored frames' : '');
  ctx.prev = -1;
  setFrame(0);
  if (fit) fitView();
  redraw();
}

/** Fit the camera to the whole motion, or to the current frame only (`only`). */
function fitView(only?: number) {
  if (!ctx?.motion) return;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const frames = only === undefined ? [...Array(Math.ceil(ctx.motion.frames / 2)).keys()].map((k) => k * 2) : [only];
  for (const f of frames) {
    for (const { matrix } of poseProp(ctx.motion, f, identity(), f - 1, () => 5)) {
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k]!, matrix[12 + k]!);
        hi[k] = Math.max(hi[k]!, matrix[12 + k]!);
      }
    }
  }
  if (!Number.isFinite(lo[0]!)) return;
  const c = lo.map((v, k) => (v + hi[k]!) / 2) as [number, number, number];
  ctx.cam.fit(c, Math.max(Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!) / 2 + 4, 6));
}

function setFrame(f: number) {
  if (!ctx) return;
  const n = ctx.motion?.frames ?? 1;
  ctx.prev = ctx.frame;
  ctx.frame = ((f % n) + n) % n;
  $<HTMLInputElement>('prp-frame').value = String(ctx.frame);
  $('prp-frame-label').textContent = `${ctx.frame} / ${n}`;
  redraw();
}

function updatePlayButton() {
  $('prp-play').textContent = ctx?.playing ? '❚❚ pause' : '▶ play';
}

function tick(now: number) {
  requestAnimationFrame(tick);
  if (!ctx) return;
  const dt = Math.min(now - ctx.last, 250);
  ctx.last = now;
  if (!ctx.playing || !ctx.motion || $('tab-props').hidden) return;
  ctx.acc += dt * Number($<HTMLSelectElement>('prp-speed').value);
  const step = 1000 / 60;
  while (ctx.acc >= step) {
    ctx.acc -= step;
    setFrame(ctx.frame + 1);
  }
}

let pending = false;
export function redraw() {
  if (!ctx || pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    if (!ctx || $('tab-props').hidden) return;
    const r = ctx.renderer, canvas = r.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const bg = $<HTMLSelectElement>('prp-bg').value;
    if (bg === 'black') r.clear(0, 0, 0);
    else if (bg === 'light') r.clear(0.85, 0.85, 0.88);
    else r.clear();
    if (!ctx.motion) return;
    const { view, proj, lighting, eye } = ctx.cam.matrices(w / h);
    const lit = $<HTMLInputElement>('prp-lit').checked, culling = $<HTMLInputElement>('prp-cull').checked;
    for (const { node, matrix } of poseProp(ctx.motion, ctx.frame, identity(), ctx.prev)) {
      const part = ctx.parts.get(node.model);
      if (part) r.draw(part.gpu, part.tex, { world: matrix, view, proj, lit, culling, lighting, eye });
    }
  });
}

$('prp-play').addEventListener('click', () => {
  if (!ctx) return;
  ctx.playing = !ctx.playing;
  updatePlayButton();
});
$<HTMLInputElement>('prp-frame').addEventListener('input', (e) => {
  if (!ctx) return;
  ctx.playing = false;
  updatePlayButton();
  setFrame(Number((e.target as HTMLInputElement).value));
});
for (const id of ['prp-lit', 'prp-cull', 'prp-bg']) $(id).addEventListener('change', () => redraw());
$('prp-fitframe').addEventListener('click', () => {
  if (!ctx) return;
  fitView(ctx.frame);
  redraw();
});
$('prp-reset').addEventListener('click', () => {
  if (!ctx) return;
  ctx.cam.yaw = 0.6;
  ctx.cam.pitch = 0.2;
  fitView();
  redraw();
});
document.addEventListener('keydown', (e) => {
  if (!ctx || $('tab-props').hidden || (e.target as HTMLElement).tagName === 'INPUT') return;
  if (e.key === ' ') {
    e.preventDefault();
    ctx.playing = !ctx.playing;
    updatePlayButton();
  } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    e.preventDefault();
    ctx.playing = false;
    updatePlayButton();
    setFrame(ctx.frame + (e.key === 'ArrowRight' ? 1 : -1));
  }
});
