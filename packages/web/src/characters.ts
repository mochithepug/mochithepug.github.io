/** Character viewer (M5): skeletons from the exe + motions from mot/, played at the game's 60 Hz. */
import {
  identity,
  Motion,
  motionFits,
  poseCharacter,
  readCharacterTypes,
  readMotionTable,
  type CharacterType,
  type MotionInfo,
  type PolModel,
} from '@ttotd/formats';
import { Assets } from './assets';
import type { GameFS } from './ingest/gamefs';
import { OrbitCamera } from './gl/orbit';
import { Renderer, type GpuModel, type TextureSource } from './gl/renderer';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

interface Ctx {
  assets: Assets;
  types: CharacterType[];
  motions: MotionInfo[];
  renderer: Renderer;
  cam: OrbitCamera;
  type?: CharacterType;
  motion?: Motion;
  /** Per drawable node: GPU model + textures (by node.model id). */
  parts: Map<number, { gpu: GpuModel; tex?: TextureSource }>;
  frame: number;
  playing: boolean;
  acc: number;
  last: number;
  token: number;
}
let ctx: Ctx | undefined;

export async function initCharacters(fs: GameFS, params = new URLSearchParams()) {
  const assets = await Assets.open(fs);
  const cam = new OrbitCamera();
  ctx = {
    assets,
    types: readCharacterTypes(assets.pe),
    motions: readMotionTable(assets.pe),
    renderer: new Renderer($<HTMLCanvasElement>('chr-canvas')),
    cam,
    parts: new Map(),
    frame: 0,
    playing: params.get('play') !== '0',
    acc: 0,
    last: performance.now(),
    token: 0,
  };
  cam.attach($<HTMLCanvasElement>('chr-canvas'));
  cam.onChange = () => redraw();
  renderTypeList();
  new ResizeObserver(() => redraw()).observe($('chr-canvas').parentElement!);
  const want = params.get('char');
  const type = (want && ctx.types.find((t) => t.name === want || String(t.index) === want)) || ctx.types.find((t) => t.name === 'player1')!;
  await selectType(type, params.get('motion') ?? undefined);
  if (params.has('frame')) setFrame(Number(params.get('frame')));
  if (params.has('yaw')) cam.yaw = Number(params.get('yaw'));
  updatePlayButton();
  requestAnimationFrame(tick);
}

function renderTypeList() {
  if (!ctx) return;
  const q = $<HTMLInputElement>('chr-filter').value.trim().toLowerCase();
  $('chr-type-list').replaceChildren(
    ...ctx.types
      .filter((t) => !q || t.name.toLowerCase().includes(q) || String(t.index) === q)
      .map((t) => {
        const d = document.createElement('div');
        d.className = 'set-item' + (t === ctx!.type ? ' active' : '');
        d.dataset.index = String(t.index);
        const a = document.createElement('span');
        a.textContent = t.name;
        const b = document.createElement('span');
        b.className = 'n';
        b.textContent = `#${t.index}`;
        d.title = `${t.joints} joints`;
        d.append(a, b);
        d.onclick = () => void selectType(t);
        return d;
      }),
  );
}
$<HTMLInputElement>('chr-filter').addEventListener('input', renderTypeList);

async function selectType(t: CharacterType, motionHint?: string) {
  if (!ctx) return;
  const token = ++ctx.token;
  ctx.type = t;
  for (const el of document.querySelectorAll<HTMLElement>('#chr-type-list .set-item')) el.classList.toggle('active', el.dataset.index === String(t.index));
  $('chr-title').textContent = `${t.name} (#${t.index})`;
  $('chr-info').textContent = 'loading…';

  // Upload every drawable part.
  for (const p of ctx.parts.values()) p.gpu.dispose();
  ctx.parts.clear();
  const nodes: { model: number; file: string; index: number }[] = [];
  const walk = (n: CharacterType['root']) => {
    if (n.ref) nodes.push({ model: n.model, file: n.ref.file, index: n.ref.index });
    n.children.forEach(walk);
  };
  walk(t.root);
  for (const n of nodes) {
    const models: PolModel[] = await ctx.assets.models(n.file);
    const m = models[n.index];
    if (!m || token !== ctx.token) continue;
    ctx.parts.set(n.model, { gpu: ctx.renderer.upload([m]), tex: await ctx.assets.textures(n.file) });
  }
  if (token !== ctx.token) return;

  // Motions with exactly this joint count; same-named mot file first.
  const fitting: MotionInfo[] = [];
  for (const m of ctx.motions) {
    if (!ctx.assets.fs.has(`mot/${m.file}`)) continue;
    if (motionFits(await ctx.assets.file(`mot/${m.file}`), m, t.joints)) fitting.push(m);
  }
  if (token !== ctx.token) return;
  const own = t.name.toLowerCase() + '.bin';
  fitting.sort((a, b) => Number(b.file === own) - Number(a.file === own) || a.file.localeCompare(b.file) || a.index - b.index);
  renderMotionList(fitting);
  $('chr-motions-head').textContent = `${fitting.length} motions (${t.joints} joints)`;
  const hinted = motionHint ? fitting.find((m) => String(m.id) === motionHint || `${m.file}#${m.index}` === motionHint) : undefined;
  if (hinted ?? fitting[0]) await selectMotion((hinted ?? fitting[0])!, true);
  else {
    ctx.motion = undefined;
    $('chr-info').textContent = `${t.joints} joints · ${ctx.parts.size} parts · no motions fit`;
    fitView();
    redraw();
  }
}

function renderMotionList(list: MotionInfo[]) {
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
    a.textContent = `#${m.index} · id ${m.id}`;
    const b = document.createElement('span');
    b.className = 'n';
    b.textContent = `${m.frames}f`;
    d.append(a, b);
    d.onclick = () => void selectMotion(m, false);
    items.push(d);
  }
  $('chr-motion-list').replaceChildren(...items);
}

async function selectMotion(info: MotionInfo, fit: boolean) {
  if (!ctx?.type) return;
  const file = await ctx.assets.file(`mot/${info.file}`);
  ctx.motion = new Motion(file, info, ctx.type.joints);
  for (const el of document.querySelectorAll<HTMLElement>('#chr-motion-list .set-item')) el.classList.toggle('active', el.dataset.id === String(info.id));
  const slider = $<HTMLInputElement>('chr-frame');
  slider.max = String(Math.max(0, info.frames - 1));
  $('chr-info').textContent = `${ctx.type.joints} joints · ${ctx.parts.size} parts · mot/${info.file} #${info.index} · ${info.frames} frames (${(info.frames / 60).toFixed(2)} s)`;
  setFrame(0);
  if (fit) fitView();
  redraw();
}

function currentPose() {
  if (!ctx?.type) return [];
  const s = ctx.motion ? ctx.motion.sample(ctx.frame) : { pos: [0, 0, 0], rot: new Int32Array(ctx.type.joints * 3) };
  if ($<HTMLInputElement>('chr-inplace').checked) s.pos = [0, s.pos[1]!, 0];
  return poseCharacter(ctx.type, s, identity());
}

/** Fit the camera to the whole motion (every 4th frame), so the character stays in view while it moves. */
function fitView() {
  if (!ctx?.type) return;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const inPlace = $<HTMLInputElement>('chr-inplace').checked;
  const frames = ctx.motion?.info.frames ?? 1;
  for (let f = 0; f < frames; f += 4) {
    const s = ctx.motion ? ctx.motion.sample(f) : { pos: [0, 0, 0], rot: new Int32Array(ctx.type.joints * 3) };
    if (inPlace) s.pos = [0, s.pos[1]!, 0];
    for (const { matrix } of poseCharacter(ctx.type, s, identity())) {
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k]!, matrix[12 + k]!);
        hi[k] = Math.max(hi[k]!, matrix[12 + k]!);
      }
    }
  }
  const c = lo.map((v, k) => (v + hi[k]!) / 2) as [number, number, number];
  ctx.cam.fit(c, Math.max(Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!) / 2 + 2, 3));
}

function setFrame(f: number) {
  if (!ctx) return;
  const n = ctx.motion?.info.frames ?? 1;
  ctx.frame = ((f % n) + n) % n;
  $<HTMLInputElement>('chr-frame').value = String(ctx.frame);
  $('chr-frame-label').textContent = `${ctx.frame} / ${n}`;
  redraw();
}

function updatePlayButton() {
  $('chr-play').textContent = ctx?.playing ? '❚❚ pause' : '▶ play';
}

// Fixed 60 Hz stepping, like the game's frame pacer.
function tick(now: number) {
  requestAnimationFrame(tick);
  if (!ctx) return;
  const dt = Math.min(now - ctx.last, 250);
  ctx.last = now;
  if (!ctx.playing || !ctx.motion || $('tab-chars').hidden) return;
  ctx.acc += dt * Number($<HTMLSelectElement>('chr-speed').value);
  const step = 1000 / 60;
  if (ctx.acc >= step) {
    const n = Math.floor(ctx.acc / step);
    ctx.acc -= n * step;
    setFrame(ctx.frame + n);
  }
}

let pending = false;
export function redraw() {
  if (!ctx || pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    if (!ctx || $('tab-chars').hidden) return;
    const r = ctx.renderer, canvas = r.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    r.clear();
    const { view, proj, lighting, eye } = ctx.cam.matrices(w / h);
    const lit = $<HTMLInputElement>('chr-lit').checked, culling = $<HTMLInputElement>('chr-cull').checked;
    for (const { node, matrix } of currentPose()) {
      const part = ctx.parts.get(node.model);
      if (part && node.ref) r.draw(part.gpu, part.tex, { world: matrix, view, proj, lit, culling, lighting, eye });
    }
  });
}

$('chr-play').addEventListener('click', () => {
  if (!ctx) return;
  ctx.playing = !ctx.playing;
  updatePlayButton();
});
$<HTMLInputElement>('chr-frame').addEventListener('input', (e) => {
  if (!ctx) return;
  ctx.playing = false;
  updatePlayButton();
  setFrame(Number((e.target as HTMLInputElement).value));
});
for (const id of ['chr-lit', 'chr-cull']) $(id).addEventListener('change', () => redraw());
$('chr-inplace').addEventListener('change', () => {
  fitView();
  redraw();
});
$('chr-reset').addEventListener('click', () => {
  if (!ctx) return;
  ctx.cam.yaw = 0.6;
  ctx.cam.pitch = 0.2;
  fitView();
  redraw();
});
document.addEventListener('keydown', (e) => {
  if (!ctx || $('tab-chars').hidden || (e.target as HTMLElement).tagName === 'INPUT') return;
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
