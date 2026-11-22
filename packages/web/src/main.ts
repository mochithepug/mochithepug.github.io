import {
  canPickDirectory,
  hasReadPermission,
  requestReadPermission,
  fsFromDirectoryHandle,
  fsFromFileList,
  loadHandle,
  pickDirectory,
  saveHandle,
  type GameFile,
  type GameFS,
} from './ingest/gamefs';
import { buildReport, type CategoryReport, type Report, type Status } from './ingest/inventory';
import { Previewer } from './audio';
import { initTextures } from './textures';

// --- tiny DOM helpers --------------------------------------------------------------------
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { cls?: string } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const { cls, ...rest } = props;
  const e = Object.assign(document.createElement(tag), rest);
  if (cls) e.className = cls;
  e.append(...children);
  return e;
}
const fmtBytes = (n: number) =>
  n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;
const fmtTime = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
const mark = (s: Status) => el('span', { cls: `status ${s}`, textContent: s === 'ok' ? '✓' : s === 'warn' ? '!' : '✗' });

// --- state ---------------------------------------------------------------------------------
let gamefs: GameFS | undefined;
let report: Report | undefined;
const previewer = new Previewer();
let playingRow: HTMLTableRowElement | undefined;

// --- loading -------------------------------------------------------------------------------
async function load(fs: GameFS) {
  $('busy').textContent = `Reading ${fs.files.length} files…`;
  gamefs = fs;
  report = await buildReport(fs);
  $('busy').textContent = '';
  renderReport(fs, report);
  renderBrowser();
  $('tabs').hidden = false;
  if (fs.has('Tod_e.exe')) initTextures(fs).catch(showError);
}

// --- tabs ------------------------------------------------------------------------------------
for (const b of document.querySelectorAll<HTMLButtonElement>('#tabs .tab')) {
  b.addEventListener('click', () => {
    for (const t of document.querySelectorAll<HTMLButtonElement>('#tabs .tab')) t.classList.toggle('active', t === b);
    for (const id of ['files', 'textures']) $(`tab-${id}`).hidden = id !== b.dataset.tab;
  });
}

async function loadFromHandle(h: FileSystemDirectoryHandle) {
  $('busy').textContent = `Scanning ${h.name}…`;
  await load(await fsFromDirectoryHandle(h));
  await saveHandle(h);
}

$('pick').addEventListener('click', async () => {
  if (!canPickDirectory()) return $<HTMLInputElement>('dirinput').click(); // Safari / Firefox
  try {
    await loadFromHandle(await pickDirectory());
  } catch (e) {
    if ((e as DOMException).name !== 'AbortError') showError(e);
  }
});

$<HTMLInputElement>('dirinput').addEventListener('change', (ev) => {
  const files = (ev.target as HTMLInputElement).files;
  if (files?.length) load(fsFromFileList(files)).catch(showError);
});

// Remember the folder between visits (Chromium only).
(async () => {
  if (!canPickDirectory()) {
    $('busy').textContent = 'This browser asks for the folder on every visit (Chrome/Edge can remember it).';
    return;
  }
  let h: FileSystemDirectoryHandle | undefined;
  try {
    h = await loadHandle();
  } catch (e) {
    console.warn('could not read remembered folder', e);
  }
  if (!h) return;
  const handle = h;
  // Already allowed (e.g. "Allow on every visit")? Then just reopen.
  if (await hasReadPermission(handle).catch(() => false)) {
    loadFromHandle(handle).catch(showError);
    return;
  }
  const b = $<HTMLButtonElement>('reopen');
  b.textContent = `Reopen “${handle.name}”`;
  b.className = 'secondary';
  b.hidden = false;
  b.onclick = () => {
    // No await before this call: see requestReadPermission.
    requestReadPermission(handle)
      .then((state) => {
        if (state !== 'granted') {
          $('busy').textContent = 'Permission not granted. Click Reopen again and choose Allow, or use Open game folder….';
          return;
        }
        b.hidden = true;
        return loadFromHandle(handle);
      })
      .catch(showError);
  };
})();

function showError(e: unknown) {
  console.error(e);
  $('busy').textContent = '';
  const r = $('report');
  r.hidden = false;
  r.replaceChildren(el('div', { cls: 'error', textContent: `Error: ${(e as Error).message ?? e}` }));
}

// --- install check -------------------------------------------------------------------------
function renderReport(fs: GameFS, r: Report) {
  const total = fs.files.reduce((n, f) => n + f.size, 0);
  const rows = [
    el('div', { cls: 'row' }, mark(r.exe.status), el('span', { cls: 'label', textContent: 'Tod_e.exe' }), el('span', { textContent: r.exe.note })),
    ...r.categories.map((c) =>
      el(
        'div',
        { cls: 'row' },
        mark(c.status),
        el('span', { cls: 'label', textContent: `${c.category.label}` }),
        el('span', { cls: 'num', textContent: `${c.files.length} files · ${fmtBytes(c.bytes)}` }),
        el('span', { cls: c.status, textContent: c.note }),
      ),
    ),
  ];
  const worst = [r.exe, ...r.categories].some((x) => x.status === 'error')
    ? 'error'
    : [r.exe, ...r.categories].some((x) => x.status === 'warn')
      ? 'warn'
      : 'ok';
  const headline =
    worst === 'ok' ? 'Game files look complete.' : worst === 'warn' ? 'Usable, with notes below.' : 'Something is missing.';
  const sec = $('report');
  sec.hidden = false;
  sec.replaceChildren(
    el('h3', {}, mark(worst), `${headline} `, el('span', { cls: 'muted', textContent: `“${fs.name}” · ${fs.files.length} files · ${fmtBytes(total)}` })),
    ...rows,
  );
}

// --- file browser --------------------------------------------------------------------------
$<HTMLInputElement>('filter').addEventListener('input', () => renderBrowser());

function renderBrowser() {
  if (!report) return;
  const q = $<HTMLInputElement>('filter').value.trim().toLowerCase();
  const open = new Set([...document.querySelectorAll<HTMLDetailsElement>('#categories details[open]')].map((d) => d.dataset.id));
  const list = [...report.categories, report.other].filter((c) => c.files.length);
  $('categories').replaceChildren(
    ...list.map((c) => {
      const files = q ? c.files.filter((f) => f.key.includes(q)) : c.files;
      const d = el('details', {}, el('summary', { textContent: `${c.category.label} — ${files.length}${q ? ` / ${c.files.length}` : ''} files${c.category.prefix ? `  (${c.category.prefix})` : ''}` }));
      d.dataset.id = c.category.id;
      // Build rows lazily: thousands of rows are cheap, but only when someone looks.
      const fill = () => d.querySelector('table') || d.append(fileTable(c, files));
      d.addEventListener('toggle', () => d.open && fill());
      if (open.has(c.category.id) || (q && files.length && files.length <= 200)) {
        d.open = true;
        fill();
      }
      return d;
    }),
  );
  $('browser').hidden = false;
}

function fileTable(c: CategoryReport, files: GameFile[]) {
  const isWav = (f: GameFile) => f.key.endsWith('.wav');
  return el(
    'table',
    {},
    ...files.map((f) => {
      const info = el('td', { cls: 'muted' });
      const tr = el('tr', {});
      const btn = el('button', {
        cls: 'small secondary',
        textContent: isWav(f) ? '▶ play' : 'hex',
        onclick: () => (isWav(f) ? playRow(f, tr, info, c.category.id === 'bgm') : showHex(f)),
      });
      tr.append(el('td', { cls: 'act' }, btn), el('td', { textContent: f.path }), info, el('td', { cls: 'size', textContent: fmtBytes(f.size) }));
      return tr;
    }),
  );
}

async function playRow(f: GameFile, tr: HTMLTableRowElement, info: HTMLElement, loop: boolean) {
  if (!gamefs) return;
  playingRow?.classList.remove('playing');
  try {
    const w = await previewer.play(await gamefs.read(f.path), loop);
    playingRow = tr;
    tr.classList.add('playing');
    const desc = `${w.channels === 1 ? 'mono' : 'stereo'} ${w.sampleRate} Hz ${w.bitsPerSample}-bit · ${fmtTime(w.durationSec)}${w.loops.length ? ` · loop ${w.loops[0]!.start}–${w.loops[0]!.end}` : ''}`;
    info.textContent = desc;
    const p = $('player');
    p.hidden = false;
    p.replaceChildren(
      el('strong', { textContent: '♪ ' + f.path }),
      el('span', { cls: 'muted', textContent: '  ' + desc + '  ' }),
      el('button', { cls: 'small secondary', textContent: '■ stop', onclick: () => stopPlayback() }),
    );
  } catch (e) {
    info.textContent = `cannot play: ${(e as Error).message}`;
    info.className = 'error';
  }
}

function stopPlayback() {
  previewer.stop();
  previewer.onEnded?.();
}
previewer.onEnded = () => {
  playingRow?.classList.remove('playing');
  playingRow = undefined;
  $('player').hidden = true;
};

async function showHex(f: GameFile) {
  if (!gamefs) return;
  const bytes = new Uint8Array(await gamefs.read(f.path)).subarray(0, 256);
  const lines: string[] = [];
  for (let o = 0; o < bytes.length; o += 16) {
    const row = bytes.subarray(o, o + 16);
    const hex = Array.from(row, (b) => b.toString(16).padStart(2, '0')).join(' ');
    const asc = Array.from(row, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${o.toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  ${asc}`);
  }
  const s = $('hex');
  s.hidden = false;
  s.replaceChildren(
    el('strong', { textContent: f.path }),
    el('span', { cls: 'muted', textContent: `  ${fmtBytes(f.size)} · first ${bytes.length} bytes  ` }),
    el('button', { cls: 'small secondary', textContent: 'close', onclick: () => (s.hidden = true) }),
    el('pre', { textContent: lines.join('\n') }),
  );
  s.scrollIntoView({ block: 'nearest' });
}
