/** Model viewer (M4): every pol/ model, rendered with the game's own render-state mapping. */
import {
  classifyBin,
  decodeTexels,
  paletteBankFor,
  parsePolFile,
  PeImage,
  readPalettes,
  readTextureSets,
  texelsToRgba,
  type PolModel,
  type TextureSet,
} from '@ttotd/formats';
import type { GameFS } from './ingest/gamefs';
import { gameLookAt, identity, perspectiveFovLH } from '@ttotd/formats';
import { Renderer, type GpuModel, type TextureSource } from './gl/renderer';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

interface Ctx {
  fs: GameFS;
  pe: PeImage;
  sets: TextureSet[];
  palettes: Uint16Array[];
  renderer: Renderer;
  texCache: Map<string, TextureSource>;
  file?: string;
  models: PolModel[];
  selected: number; // model index
  gpu?: GpuModel;
  texSource?: TextureSource;
  cam: { yaw: number; pitch: number; dist: number; target: [number, number, number]; radius: number };
  token: number;
}
let ctx: Ctx | undefined;

export async function initModels(fs: GameFS, params = new URLSearchParams()) {
  const pe = new PeImage(new Uint8Array(await fs.read('Tod_e.exe')));
  const renderer = new Renderer($<HTMLCanvasElement>('mdl-canvas'));
  ctx = {
    fs,
    pe,
    sets: readTextureSets(pe),
    palettes: readPalettes(pe),
    renderer,
    texCache: new Map(),
    models: [],
    selected: 0,
    cam: { yaw: 0.6, pitch: 0.35, dist: 10, target: [0, 0, 0], radius: 1 },
    token: 0,
  };
  const sel = $<HTMLSelectElement>('mdl-texset');
  sel.replaceChildren(new Option('(none)', ''), ...ctx.sets.filter((s) => s.textures.length).map((s) => new Option(s.name, s.name)));
  renderFileList();
  new ResizeObserver(() => draw()).observe($('mdl-canvas-wrap'));
  if (params.get('all') === '1') $<HTMLInputElement>('mdl-all').checked = true;
  await openFile(params.get('pol') ?? 'zom.bin', Number(params.get('model') ?? 0));
  if (params.has('yaw')) ctx.cam.yaw = Number(params.get('yaw'));
  if (params.has('pitch')) ctx.cam.pitch = Number(params.get('pitch'));
  if (params.has('zoom')) ctx.cam.dist /= Number(params.get('zoom'));
  draw();
}

const modelFiles = () =>
  ctx!.fs.files.filter((f) => f.key.startsWith('pol/') && f.key.endsWith('.bin') && f.size >= 32).map((f) => f.path.slice(4));

function renderFileList() {
  if (!ctx) return;
  const q = $<HTMLInputElement>('mdl-filter').value.trim().toLowerCase();
  $('mdl-file-list').replaceChildren(
    ...modelFiles()
      .filter((n) => !q || n.toLowerCase().includes(q))
      .map((n) => {
        const d = document.createElement('div');
        d.className = 'set-item' + (n === ctx!.file ? ' active' : '');
        d.dataset.name = n;
        d.textContent = n.replace(/\.bin$/i, '');
        d.onclick = () => void openFile(n, 0);
        return d;
      }),
  );
}
$<HTMLInputElement>('mdl-filter').addEventListener('input', renderFileList);

/** Same-name texture set, else the nearest shorter name (etc_1_06 → etc_1), else none. */
function guessTextureSet(file: string): string {
  const byName = new Map(ctx!.sets.filter((s) => s.textures.length).map((s) => [s.name.toLowerCase(), s.name]));
  let base = file.toLowerCase().replace(/\.bin$/, '');
  while (base) {
    const hit = byName.get(base + '.bin');
    if (hit) return hit;
    const cut = base.lastIndexOf('_');
    if (cut < 0) break;
    base = base.slice(0, cut);
  }
  return '';
}

async function textureSource(name: string): Promise<TextureSource | undefined> {
  if (!ctx || !name) return undefined;
  const cached = ctx.texCache.get(name);
  if (cached) return cached;
  const set = ctx.sets.find((s) => s.name === name);
  const path = `tex/${name}`;
  if (!set || !ctx.fs.has(path)) return undefined;
  const { data } = classifyBin(path.toLowerCase(), new Uint8Array(await ctx.fs.read(path)));
  const decoded = new Map<number, ReturnType<TextureSource['get']>>();
  const pe = ctx.pe, palettes = ctx.palettes;
  const src: TextureSource = {
    key: name,
    get(i) {
      if (decoded.has(i)) return decoded.get(i);
      const t = set.textures[i];
      let out: ReturnType<TextureSource['get']>;
      if (t) {
        try {
          const d = decodeTexels(t, data, palettes[paletteBankFor(pe, set, i, true)]);
          out = { width: t.width, height: t.height, rgba: texelsToRgba(d.texels, d.format) };
        } catch {
          out = undefined;
        }
      }
      decoded.set(i, out);
      return out;
    },
  };
  ctx.texCache.set(name, src);
  return src;
}

async function openFile(name: string, model: number) {
  if (!ctx) return;
  const token = ++ctx.token;
  const path = `pol/${name}`;
  $('mdl-title').textContent = name;
  $('mdl-info').textContent = 'loading…';
  if (!ctx.fs.has(path)) {
    $('mdl-info').textContent = 'file missing';
    return;
  }
  const { kind, data } = classifyBin(path.toLowerCase(), new Uint8Array(await ctx.fs.read(path)));
  if (token !== ctx.token) return;
  try {
    ctx.models = kind === 'lz' || kind === 'raw' ? parsePolFile(data) : [];
  } catch (e) {
    ctx.models = [];
    $('mdl-info').textContent = `✗ ${(e as Error).message}`;
    return;
  }
  ctx.file = name;
  for (const el of document.querySelectorAll<HTMLElement>('#mdl-file-list .set-item')) el.classList.toggle('active', el.dataset.name === name);
  const tex = guessTextureSet(name);
  $<HTMLSelectElement>('mdl-texset').value = tex;
  ctx.texSource = await textureSource(tex);
  $('mdl-models-head').textContent = `${ctx.models.length} models`;
  $('mdl-model-list').replaceChildren(
    ...ctx.models.map((m) => {
      const d = document.createElement('div');
      d.className = 'set-item';
      d.dataset.index = String(m.index);
      const a = document.createElement('span');
      a.textContent = `#${m.index}`;
      const b = document.createElement('span');
      b.className = 'n';
      b.textContent = `${m.meshes.length}`;
      d.title = `${m.meshes.length} meshes`;
      d.append(a, b);
      d.onclick = () => selectModel(m.index, true);
      return d;
    }),
  );
  selectModel(Math.min(model, Math.max(0, ctx.models.length - 1)), true);
}

function shown(): PolModel[] {
  if (!ctx) return [];
  return $<HTMLInputElement>('mdl-all').checked ? ctx.models : ctx.models.filter((m) => m.index === ctx!.selected);
}

function selectModel(i: number, fit: boolean) {
  if (!ctx) return;
  ctx.selected = i;
  for (const el of document.querySelectorAll<HTMLElement>('#mdl-model-list .set-item')) {
    el.classList.toggle('active', el.dataset.index === String(i));
  }
  const models = shown();
  ctx.gpu?.dispose();
  ctx.gpu = ctx.renderer.upload(models);
  if (fit) fitCamera(models);
  let meshes = 0, prims = 0, verts = 0, translucent = 0, untextured = 0;
  for (const m of models) for (const mesh of m.meshes) {
    meshes++;
    if (mesh.texture < 0) untextured++;
    if ((mesh.tsp & 0x180000) !== 0x80000) translucent++;
    for (const p of mesh.prims) { prims++; verts += p.vertices.length / 8; }
  }
  $('mdl-info').textContent =
    `${$<HTMLInputElement>('mdl-all').checked ? `all ${models.length} models` : `model #${i}`} · ${meshes} meshes · ${prims} primitives · ${verts} vertices` +
    (translucent ? ` · ${translucent} translucent` : '') + (untextured ? ` · ${untextured} untextured` : '');
  draw();
}

function fitCamera(models: PolModel[]) {
  if (!ctx || !models.length) return;
  // Bounding box of the model bounding spheres.
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const m of models) for (let k = 0; k < 3; k++) {
    lo[k] = Math.min(lo[k]!, m.center[k]! - m.radius);
    hi[k] = Math.max(hi[k]!, m.center[k]! + m.radius);
  }
  const target = lo.map((v, k) => (v + hi[k]!) / 2) as [number, number, number];
  const radius = Math.max(Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!) / 2, 0.01);
  ctx.cam.target = target;
  ctx.cam.radius = radius;
  ctx.cam.dist = radius / Math.sin(FOV / 2) * 1.05;
}

const FOV = (45 * Math.PI) / 180;

function eyePos() {
  const c = ctx!.cam;
  return [
    c.target[0] + Math.sin(c.yaw) * Math.cos(c.pitch) * c.dist,
    c.target[1] + Math.sin(c.pitch) * c.dist,
    c.target[2] - Math.cos(c.yaw) * Math.cos(c.pitch) * c.dist,
  ];
}

let pending = false;
function draw() {
  if (!ctx || pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    if (!ctx || $('tab-models').hidden) return;
    const canvas = ctx.renderer.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    ctx.renderer.clear();
    if (!ctx.gpu) return;
    const c = ctx.cam;
    const eye = eyePos();
    const view = gameLookAt(eye as [number, number, number], c.target);
    const proj = perspectiveFovLH(FOV, w / h, Math.max(c.dist - c.radius * 4, c.dist / 1000), c.dist + c.radius * 4);
    const dir = c.target.map((v, k) => v - eye[k]!);
    ctx.renderer.draw(ctx.gpu, ctx.texSource, {
      world: identity(),
      view,
      proj,
      lit: $<HTMLInputElement>('mdl-lit').checked,
      culling: $<HTMLInputElement>('mdl-cull').checked,
      lightDir: [dir[0]! + c.dist * 0.3, dir[1]! - c.dist * 0.5, dir[2]!],
    });
  });
}
export const redrawModels = draw;

$<HTMLSelectElement>('mdl-texset').addEventListener('change', async (e) => {
  if (!ctx) return;
  ctx.texSource = await textureSource((e.target as HTMLSelectElement).value);
  draw();
});
$<HTMLInputElement>('mdl-all').addEventListener('change', () => ctx && selectModel(ctx.selected, true));
for (const id of ['mdl-lit', 'mdl-cull']) $<HTMLInputElement>(id).addEventListener('change', draw);
$('mdl-reset').addEventListener('click', () => {
  if (!ctx) return;
  ctx.cam.yaw = 0.6;
  ctx.cam.pitch = 0.35;
  fitCamera(shown());
  draw();
});

// --- mouse orbit -----------------------------------------------------------------------------
{
  const canvas = $<HTMLCanvasElement>('mdl-canvas');
  let drag: { x: number; y: number; pan: boolean } | undefined;
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointerup', () => (drag = undefined));
  canvas.addEventListener('pointermove', (e) => {
    if (!drag || !ctx) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX;
    drag.y = e.clientY;
    const c = ctx.cam;
    if (drag.pan) {
      const s = (c.dist * Math.tan(FOV / 2) * 2) / canvas.clientHeight;
      // camera right / up vectors (left-handed, yaw around +Y)
      const right = [-Math.cos(c.yaw), 0, -Math.sin(c.yaw)]; // screen-right in the game's view
      const up = [-Math.sin(c.pitch) * Math.sin(c.yaw), Math.cos(c.pitch), Math.sin(c.pitch) * Math.cos(c.yaw)];
      for (let k = 0; k < 3; k++) c.target[k] = c.target[k]! - right[k]! * dx * s + up[k]! * dy * s;
    } else {
      c.yaw += dx * 0.01;
      c.pitch = Math.max(-1.55, Math.min(1.55, c.pitch + dy * 0.01));
    }
    draw();
  });
  canvas.addEventListener('wheel', (e) => {
    if (!ctx) return;
    e.preventDefault();
    ctx.cam.dist *= Math.exp(e.deltaY * 0.001);
    draw();
  }, { passive: false });
}
