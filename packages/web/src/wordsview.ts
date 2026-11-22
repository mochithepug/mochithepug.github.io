/** Words tab (M6): every word list, rendered with the game's letter models; plus the Japanese font. */
import {
  decodeWordList,
  Font,
  identity,
  layoutWordLine,
  modelRef,
  mul,
  orthoOffCenterLH,
  readWordListNames,
  scaling,
  translation,
  type PolModel,
  type WordEntry,
} from '@ttotd/formats';
import { Assets } from './assets';
import type { GameFS } from './ingest/gamefs';
import { Renderer, type GpuModel, type TextureSource } from './gl/renderer';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const LINE_GAP = 34; // px between lines at 640×480 (measured from the boss screenshot; exact value comes with M8)

interface Ctx {
  assets: Assets;
  lists: { name: string; words: WordEntry[] }[];
  renderer: Renderer;
  letterModels: PolModel[];
  letterTex?: TextureSource;
  gpu: Map<number, GpuModel>;
  font: Font;
  list?: { name: string; words: WordEntry[] };
  word?: WordEntry;
}
let ctx: Ctx | undefined;

export async function initWords(fs: GameFS, params = new URLSearchParams()) {
  const assets = await Assets.open(fs);
  const lists = await Promise.all(
    readWordListNames(assets.pe)
      .filter((n) => fs.has(`word/${n}`))
      .map(async (name) => ({ name, words: decodeWordList(await assets.file(`word/${name}`)) })),
  );
  ctx = {
    assets,
    lists,
    renderer: new Renderer($<HTMLCanvasElement>('wrd-canvas')),
    letterModels: await assets.models('tod_boxetc.bin'),
    letterTex: await assets.textures('tod_boxetc.bin', true),
    gpu: new Map(),
    font: new Font(assets.pe, await assets.file('word/font.bin')),
  };
  $('wrd-lists-head').textContent = `${lists.length} word lists · ${lists.reduce((n, l) => n + l.words.length, 0)} words`;
  renderLists();
  const want = params.get('word');
  const list = lists.find((l) => l.name === params.get('list')) ?? lists[0];
  if (list) selectList(list, want ?? undefined);
  if (params.has('typed')) setTyped(Number(params.get('typed')));
  drawFont();
  new ResizeObserver(() => draw()).observe($('wrd-stage'));
}

function renderLists() {
  if (!ctx) return;
  const q = $<HTMLInputElement>('wrd-filter').value.trim().toLowerCase();
  const lists = q ? ctx.lists.filter((l) => l.words.some((w) => w.text.toLowerCase().includes(q))) : ctx.lists;
  $('wrd-list-list').replaceChildren(
    ...lists.map((l) => {
      const d = document.createElement('div');
      d.className = 'set-item' + (l === ctx!.list ? ' active' : '');
      d.dataset.name = l.name;
      const a = document.createElement('span');
      a.textContent = l.name.replace(/\.bin$/i, '');
      const b = document.createElement('span');
      b.className = 'n';
      b.textContent = String(q ? l.words.filter((w) => w.text.toLowerCase().includes(q)).length : l.words.length);
      d.append(a, b);
      d.onclick = () => selectList(l);
      return d;
    }),
  );
  if (q && ctx.list) renderWords();
}
$<HTMLInputElement>('wrd-filter').addEventListener('input', renderLists);

function selectList(l: { name: string; words: WordEntry[] }, word?: string) {
  if (!ctx) return;
  ctx.list = l;
  for (const el of document.querySelectorAll<HTMLElement>('#wrd-list-list .set-item')) el.classList.toggle('active', el.dataset.name === l.name);
  renderWords();
  const w = (word && l.words.find((x) => x.text === word)) || l.words.find((x) => x.text.length >= 4) || l.words[0];
  if (w) selectWord(w);
}

function renderWords() {
  if (!ctx?.list) return;
  const q = $<HTMLInputElement>('wrd-filter').value.trim().toLowerCase();
  const words = q ? ctx.list.words.filter((w) => w.text.toLowerCase().includes(q)) : ctx.list.words;
  $('wrd-words-head').textContent = `${ctx.list.name} · ${words.length} words`;
  $('wrd-word-list').replaceChildren(
    ...words.map((w) => {
      const d = document.createElement('div');
      d.className = 'set-item' + (w === ctx!.word ? ' active' : '');
      const a = document.createElement('span');
      a.textContent = w.text;
      const b = document.createElement('span');
      b.className = 'n';
      b.textContent = String(w.value);
      b.title = 'value field (meaning not yet known)';
      d.append(a, b);
      d.onclick = () => {
        selectWord(w);
        for (const el of document.querySelectorAll('#wrd-word-list .set-item')) el.classList.toggle('active', el === d);
      };
      return d;
    }),
  );
}

function selectWord(w: WordEntry) {
  if (!ctx) return;
  ctx.word = w;
  $('wrd-title').textContent = `“${w.text}”`;
  const t = $<HTMLInputElement>('wrd-typed');
  t.max = String(w.text.length);
  setTyped(0);
}

function setTyped(n: number) {
  $<HTMLInputElement>('wrd-typed').value = String(n);
  $('wrd-typed-label').textContent = `${n}`;
  draw();
}
$<HTMLInputElement>('wrd-typed').addEventListener('input', (e) => setTyped(Number((e.target as HTMLInputElement).value)));
$<HTMLInputElement>('wrd-size').addEventListener('input', () => draw());

function letterGpu(modelId: number): GpuModel | undefined {
  if (!ctx) return undefined;
  let g = ctx.gpu.get(modelId);
  if (!g) {
    const ref = modelRef(ctx.assets.pe, modelId);
    const m = ref && ref.file === 'tod_boxetc.bin' ? ctx.letterModels[ref.index] : undefined;
    if (!m) return undefined;
    g = ctx.renderer.upload([m]);
    ctx.gpu.set(modelId, g);
  }
  return g;
}

let pending = false;
function draw() {
  if (!ctx || pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    if (!ctx?.word || $('tab-words').hidden) return;
    const r = ctx.renderer, canvas = r.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    r.clear(0, 0, 0);
    const proj = orthoOffCenterLH(0, 640, 0, 480, -10, 10); // 640×480 screen, y up
    const size = Number($<HTMLInputElement>('wrd-size').value) || 23.75;
    const typed = Number($<HTMLInputElement>('wrd-typed').value);
    const text = ctx.word.text;
    const lines: { y: number; color: [number, number, number]; hidden: number }[] = [
      { y: 240 + LINE_GAP, color: [1, 1, 0], hidden: 0 },
      { y: 240, color: [1, 1, 1], hidden: typed },
      { y: 240 - LINE_GAP, color: [1, 1, 1], hidden: 0 },
    ];
    let minX = Infinity, maxX = -Infinity;
    for (const line of lines) {
      for (const L of layoutWordLine(ctx.assets.pe, text, size, 320, line.y + size * 0.4, line.hidden)) {
        minX = Math.min(minX, L.x - 0.38 * size);
        maxX = Math.max(maxX, L.x + 0.38 * size);
        if (L.hidden) continue;
        const g = letterGpu(L.modelId);
        if (!g) continue;
        const world = mul(scaling(L.scaleX, L.scaleY, L.scaleX), translation(L.x, L.y, 0));
        r.draw(g, ctx.letterTex, { world, view: identity(), proj, lit: false, culling: false, lightDir: [0, 0, 1], colorOverride: line.color });
      }
    }
    // Placeholder frame around the text block (CSS overlay, in 640×480 coordinates).
    const box = $('wrd-box'), sx = canvas.clientWidth / 640, sy = canvas.clientHeight / 480;
    // Letter quads span [baseline, baseline + size]; descenders drop 0.2 × size.
    const top = 480 - (240 + LINE_GAP + size + 6), bottom = 480 - (240 - LINE_GAP - size * 0.2 - 6);
    Object.assign(box.style, {
      left: `${(minX - 14) * sx}px`, width: `${(maxX - minX + 28) * sx}px`,
      top: `${top * sy}px`, height: `${(bottom - top) * sy}px`,
    });
  });
}
export const redrawWords = draw;

// --- Japanese system font -----------------------------------------------------------------------
$<HTMLSelectElement>('wrd-font-block').addEventListener('change', drawFont);

function drawFont() {
  if (!ctx) return;
  const start = parseInt($<HTMLSelectElement>('wrd-font-block').value, 16);
  const codes: number[] = [];
  for (let c = start; codes.length < 240 && c <= 0xeaa4; c++) {
    if ((c & 0xff) < 0x40 || (c & 0xff) === 0x7f || (c & 0xff) > 0xfc) continue; // valid SJIS trail bytes
    if (ctx.font.glyph(c)) codes.push(c);
  }
  const cols = 20, cell = 36, canvas = $<HTMLCanvasElement>('wrd-font');
  canvas.width = cols * cell;
  canvas.height = Math.ceil(codes.length / cols) * cell;
  canvas.style.width = `${canvas.width}px`;
  const g2 = canvas.getContext('2d')!;
  codes.forEach((c, k) => {
    const tex = ctx!.font.texture(c)!;
    const img = new ImageData(32, 32);
    for (let i = 0; i < 1024; i++) {
      const p = tex[i]!, v = Math.round((((p >> 10) & 31) * 255) / 31);
      img.data.set([v, v, v, p & 0x8000 ? 255 : 0], i * 4);
    }
    g2.putImageData(img, (k % cols) * cell + 2, Math.floor(k / cols) * cell + 2);
  });
}
