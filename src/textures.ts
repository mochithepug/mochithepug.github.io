/** Texture viewer (M3): browse every texture set, decoded exactly as Tod_e.exe uploads it. */
import {
  classifyBin,
  decodeTexels,
  FORMAT_NAMES,
  formatOf,
  LAYOUT_NAMES,
  layoutOf,
  paletteBankFor,
  PeImage,
  readPalettes,
  readTextureSets,
  texelsToRgba,
  type TextureSet,
} from '@ttotd/formats';
import type { GameFS } from './ingest/gamefs';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

interface State {
  fs: GameFS;
  pe: PeImage;
  sets: TextureSet[];
  palettes: Uint16Array[];
  current?: TextureSet;
  token: number;
}
let state: State | undefined;

export async function initTextures(fs: GameFS) {
  const pe = new PeImage(new Uint8Array(await fs.read('Tod_e.exe')));
  state = { fs, pe, sets: readTextureSets(pe), palettes: readPalettes(pe), token: 0 };
  renderList();
  const first = state.sets.find((s) => s.name === 'common.bin');
  if (first) void showSet(first);
}

function renderList() {
  if (!state) return;
  const q = $<HTMLInputElement>('tex-filter').value.trim().toLowerCase();
  const items = state.sets
    .filter((s) => !q || s.name.toLowerCase().includes(q))
    .map((s) => {
      const div = document.createElement('div');
      div.className = 'set-item' + (s.textures.length ? '' : ' empty') + (s === state!.current ? ' active' : '');
      div.dataset.index = String(s.index);
      const name = document.createElement('span');
      name.textContent = s.name.replace(/\.bin$/i, '');
      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = s.textures.length ? String(s.textures.length) : '–';
      div.append(name, n);
      if (s.textures.length) div.onclick = () => void showSet(s);
      return div;
    });
  $('tex-set-list').replaceChildren(...items);
}

$<HTMLInputElement>('tex-filter').addEventListener('input', renderList);
$<HTMLSelectElement>('tex-zoom').addEventListener('change', applyZoom);
for (const id of ['tex-alpha', 'tex-flip']) $<HTMLInputElement>(id).addEventListener('change', () => state?.current && void showSet(state.current));

// Up/down arrows step through sets while the viewer is visible.
document.addEventListener('keydown', (e) => {
  if (!state?.current || $('tab-textures').hidden || (e.target as HTMLElement).tagName === 'INPUT') return;
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const visible = [...document.querySelectorAll<HTMLElement>('#tex-set-list .set-item:not(.empty)')];
  const i = visible.findIndex((el) => el.dataset.index === String(state!.current!.index));
  const next = visible[i + (e.key === 'ArrowDown' ? 1 : -1)];
  if (next) {
    e.preventDefault();
    next.click();
    next.scrollIntoView({ block: 'nearest' });
  }
});

function applyZoom() {
  const z = Number($<HTMLSelectElement>('tex-zoom').value);
  for (const c of document.querySelectorAll<HTMLCanvasElement>('#tex-grid canvas')) {
    c.style.width = `${c.width * z}px`;
    c.style.height = `${c.height * z}px`;
  }
}

async function showSet(set: TextureSet) {
  if (!state) return;
  const token = ++state.token;
  state.current = set;
  for (const el of document.querySelectorAll('#tex-set-list .set-item')) {
    el.classList.toggle('active', (el as HTMLElement).dataset.index === String(set.index));
  }
  $('tex-title').textContent = set.name;
  $('tex-info').textContent = 'loading…';
  const path = `tex/${set.name}`;
  if (!state.fs.has(path)) {
    $('tex-info').textContent = 'file missing';
    $('tex-grid').replaceChildren();
    return;
  }
  const file = new Uint8Array(await state.fs.read(path));
  if (token !== state.token) return; // user moved on
  const { kind, data } = classifyBin(path.toLowerCase(), file);
  // Sets with a same-named model file are loaded for models → palette bank 0 (see paletteBankFor).
  const forModels = state.fs.has(`pol/${set.name}`) && (state.fs.files.find((f) => f.key === `pol/${set.name}`.toLowerCase())?.size ?? 0) >= 32;
  const alpha = $<HTMLInputElement>('tex-alpha').checked;
  const flip = $<HTMLInputElement>('tex-flip').checked;

  let overruns = 0;
  const cards = set.textures.map((t, i) => {
    const card = document.createElement('div');
    card.className = 'tex' + (alpha ? ' checker' : '');
    const canvas = document.createElement('canvas');
    canvas.width = t.width;
    canvas.height = t.height;
    const label = document.createElement('div');
    const bank = paletteBankFor(state!.pe, set, i, forModels);
    const lay = layoutOf(t.type);
    label.textContent = `#${i} · ${t.width}×${t.height} · ${LAYOUT_NAMES[lay] ?? lay.toString(16)} ${FORMAT_NAMES[formatOf(t.type)]}${lay === 0x500 ? ` · pal ${bank}` : ''} · id ${t.id}`;
    try {
      const d = decodeTexels(t, data, state!.palettes[bank]);
      const rgba = texelsToRgba(d.texels, d.format);
      if (!alpha) for (let k = 3; k < rgba.length; k += 4) rgba[k] = 255;
      const img = flip ? flipRows(rgba, t.width, t.height) : rgba;
      canvas.getContext('2d')!.putImageData(new ImageData(img, t.width, t.height), 0, 0);
      if (d.overrun) {
        overruns++;
        const w = document.createElement('div');
        w.className = 'warn';
        w.textContent = '⚠ exe reads past this texture (tall 4-bit quirk)';
        label.append(document.createElement('br'), w);
      }
    } catch (e) {
      const err = document.createElement('div');
      err.className = 'err';
      err.textContent = `✗ ${(e as Error).message}`;
      label.append(err);
    }
    card.append(canvas, label);
    return card;
  });
  $('tex-grid').replaceChildren(...cards);
  applyZoom();
  $('tex-info').textContent =
    `${set.textures.length} textures · ${kind === 'lz' ? 'compressed' : kind} file · ${(file.length / 1024).toFixed(0)} KB` +
    (overruns ? ` · ${overruns} with read-past quirk` : '') +
    (set.textures.some((t) => (t.type & 0xff00) === 0x500) ? (forModels ? ' · palette bank 0 (model set)' : ' · palette per set (2D set)') : '');
}

/** Display helper only: the decoder output stays in the exe's memory order (row 0 first). */
function flipRows(rgba: Uint8ClampedArray<ArrayBuffer>, w: number, h: number): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(rgba.length);
  const row = w * 4;
  for (let y = 0; y < h; y++) out.set(rgba.subarray(y * row, (y + 1) * row), (h - 1 - y) * row);
  return out;
}
