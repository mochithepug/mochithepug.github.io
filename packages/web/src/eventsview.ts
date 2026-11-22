/** Events tab (M9a): a stage's event script — blocks, their next-block rules, and every script's commands. */
import {
  EVT_OP_NAMES,
  EventFile,
  evtOpName,
  readBlockRules,
  readDialogue,
  STAGE_EVENT_FILES,
  type BlockRule,
  type EvtBlock,
  type EvtCommand,
  type PeImage,
} from '@ttotd/formats';
import { Assets } from './assets';
import type { GameFS } from './ingest/gamefs';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

interface Ctx {
  assets: Assets;
  file?: EventFile;
  blocks: EvtBlock[];
  rules: BlockRule[];
  block?: EvtBlock;
}
let ctx: Ctx | undefined;

export async function initEvents(fs: GameFS, params = new URLSearchParams()) {
  const assets = await Assets.open(fs);
  ctx = { assets, blocks: [], rules: [] };
  const sel = $<HTMLSelectElement>('evt-file');
  sel.replaceChildren(
    ...STAGE_EVENT_FILES.filter((f) => fs.has(`evt/${f}`)).map((f, i) => {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = `Stage ${i + 1} — evt/${f}`;
      return o;
    }),
  );
  sel.onchange = () => void openStage(Number(sel.value));
  const stage = Math.max(0, Number(params.get('evtstage') ?? 1) - 1);
  sel.value = String(stage);
  await openStage(stage, params.has('block') ? Number(params.get('block')) : 0);
}

async function openStage(stage: number, block = 0) {
  if (!ctx) return;
  const name = STAGE_EVENT_FILES[stage]!;
  ctx.file = new EventFile(await ctx.assets.file(`evt/${name}`));
  ctx.blocks = ctx.file.blocks();
  ctx.rules = readBlockRules(ctx.assets.pe, stage);
  $('evt-blocks-head').textContent = `${ctx.blocks.length} blocks · next-block rules from the exe`;
  $('evt-block-list').replaceChildren(
    ...ctx.blocks.map((b) => {
      const d = document.createElement('div');
      d.className = 'set-item';
      d.dataset.index = String(b.index);
      const a = document.createElement('span');
      a.innerHTML = `block ${b.index} <span class="rule">${ruleText(ctx!.rules[b.index], b.index)}</span>`;
      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = `${b.scripts.length} scripts`;
      d.append(a, n);
      d.onclick = () => selectBlock(b);
      return d;
    }),
  );
  const b = ctx.blocks[block] ?? ctx.blocks[0];
  if (b) selectBlock(b);
}

function ruleText(r: BlockRule | undefined, index: number): string {
  if (!r) return '';
  if (r.kind === 0) return `→ ${r.targets[0]}`;
  if (r.kind === 2) return `→ ${index + 1}`;
  if (r.kind === 1) return `→ ${r.targets.map((t, k) => (t < 0 ? null : `${t}`)).filter(Boolean).join(' | ')} (by choice)`;
  return `kind ${r.kind}`;
}

function selectBlock(b: EvtBlock) {
  if (!ctx?.file) return;
  ctx.block = b;
  for (const el of document.querySelectorAll<HTMLElement>('#evt-block-list .set-item')) el.classList.toggle('active', el.dataset.index === String(b.index));
  $('evt-title').textContent = `Block ${b.index}`;
  const setup = ctx.file.offsetOf(b.setup);
  $('evt-info').textContent =
    `${b.scripts.length} scripts · next: ${ruleText(ctx.rules[b.index], b.index)} · set-up entry ` +
    (setup !== undefined ? `@0x${setup.toString(16)}` : `0x${(b.setup >>> 0).toString(16)} (shared, comevtbl)`);
  render();
}

function render() {
  if (!ctx?.file || !ctx.block) return;
  const raw = $<HTMLInputElement>('evt-raw').checked;
  const pe = ctx.assets.pe;
  const rows: HTMLElement[] = [];
  ctx.block.scripts.forEach((s, k) => {
    const h = document.createElement('div');
    h.className = 'script-head';
    h.textContent = `script ${k + 1} @0x${s.toString(16)}`;
    rows.push(h);
    let cmds: EvtCommand[];
    try {
      cmds = ctx!.file!.script(s);
    } catch (e) {
      const err = document.createElement('div');
      err.textContent = `  ${String(e)}`;
      rows.push(err);
      return;
    }
    for (const c of cmds) rows.push(commandRow(c, raw, pe));
  });
  $('evt-listing').replaceChildren(...rows);
}

function commandRow(c: EvtCommand, raw: boolean, pe: PeImage): HTMLElement {
  const d = document.createElement('div');
  d.className = 'cmd';
  const off = document.createElement('span');
  off.className = 'off';
  off.textContent = c.offset.toString(16).padStart(5, '0');
  const op = document.createElement('span');
  op.className = 'op ' + (EVT_OP_NAMES[c.op] ? 'known' : 'unknown');
  op.textContent = evtOpName(c.op);
  op.title = `opcode 0x${c.op.toString(16)}`;
  const args = document.createElement('span');
  const hex = (v: number) => (Math.abs(v) < 0x10000 ? String(v) : `0x${(v >>> 0).toString(16)}`);
  const words = c.words.slice(1);
  let note = '';
  if (c.op === 0x2d) {
    const id = c.words[1]! & 0xffff;
    const sp = readDialogue(pe, id, 0) ?? readDialogue(pe, id, 2);
    note = `dialogue ${id}` + (sp ? ` · “${sp.lines.map((l) => l.text).join(' / ')}” · ${(sp.durationFrames / 60).toFixed(1)} s` : '');
    d.classList.add('say');
  } else if (c.op === 0x2c) {
    note = c.words[1] ? 'scene can be skipped (“Press the Enter key to skip” shown)' : 'scene skip off';
    d.classList.add('skip');
  } else if (c.op === 0x41 || c.op === 0x42) {
    const f = c.words[1]!;
    note = f === 0 ? 'wait for the timer to run out' : `wait until frame ${f} (${(f / 60).toFixed(2)} s into the segment)`;
  } else if (c.op === 0x4f) note = 'end of script → next script';
  else if (c.op === 0x4e) note = 'halt (stay here)';
  else if (c.op === 0x71) note = 'return';
  else if (c.op === 0x4d) note = 'segment start (resets the segment timer)';
  else if (c.op === 0x73) {
    const m = c.words[1]!;
    note = `if game mode ${m >= 100 ? '≠ ' + (m - 100) : '= ' + m} continue, else jump to 0x${(c.words[2]! >>> 0).toString(16)}`;
  } else if (c.op === 0x30 || c.op === 0x6c || c.op === 0x6d) note = `${words.length - 1} words of inline data`;
  const shown = raw ? words : words.slice(0, 6);
  args.innerHTML =
    shown.map(hex).join(' ') + (!raw && words.length > 6 ? ` … (+${words.length - 6})` : '') + (note ? ` <span class="note">— ${escape(note)}</span>` : '');
  d.append(off, op, args);
  return d;
}

const escape = (s: string) => s.replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]!);

$<HTMLInputElement>('evt-raw').addEventListener('change', render);
