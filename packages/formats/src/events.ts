/**
 * Event scripts (`evt/*.bin`), as Tod_e.exe runs them. See re/notes/overview.md "Event scripts (M9)".
 *
 * Files are stored raw and hold Dreamcast RAM pointers (0x0CE80000–0x0CEFFFFF window). `comevtbl.bin` loads at
 * DC 0x0CEB5800 and the current stage/mode table at DC 0x0CEB5A00 (PC 0x009E6400 / 0x009E6600 after
 * `evt_rebase_pointers`).
 *
 * Layout of a stage file: u32 block pointers, −1-terminated. A block is a −1-terminated list: entry 0 (set-up
 * script) and the scripts run in order from entry 1 (`evt_next_script` @0044ec10, opcode 0x4F). When a block's
 * list runs out, the per-mode rule table `g_evt_block_rules` @005e98b8 picks the next block:
 * {i16 kind, i16 a, i16 b, i16 c}: kind 0 → a; kind 1 → [a, b, c][choice]; kind 2 → current + 1.
 *
 * Interpreter (`evt_run` @0044e8b0): op = u32 at the script pointer, `g_evt_ops[op]` @005a2a4c (117 handlers)
 * runs and moves the pointer past its arguments; repeat until a handler sets the yield flag (DAT_00a3b860).
 * Command lengths below come from the handlers (x86, checked by walking every script of every stage file).
 */
import type { PeImage } from './pe.ts';

export const EVT_COM_BASE = 0x0ceb5800;
export const EVT_STAGE_BASE = 0x0ceb5a00;
const BLOCK_RULES = 0x005e98b8;

/** Fixed command sizes in bytes (op word included). */
const FIXED: Record<number, number> = {
  0x0e: 24, 0x14: 8, 0x15: 8, 0x16: 16, 0x17: 16, 0x18: 12, 0x19: 12,
  0x21: 16, 0x23: 16, 0x25: 16, 0x27: 16, 0x28: 8, 0x29: 8, 0x2b: 4, 0x2c: 8, 0x2d: 8, 0x2e: 4, 0x2f: 8,
  0x31: 8, 0x32: 8, 0x33: 12, 0x35: 8, 0x36: 8, 0x37: 8, 0x38: 8, 0x39: 16, 0x3a: 8, 0x3b: 16, 0x3d: 16,
  0x3e: 8, 0x3f: 4, 0x40: 4, 0x41: 8, 0x42: 8, 0x43: 8, 0x44: 8, 0x45: 8, 0x46: 8, 0x47: 4, 0x48: 8,
  0x4d: 4, 0x4e: 4, 0x4f: 4, 0x58: 4, 0x59: 4, 0x5a: 4, 0x5b: 4, 0x5c: 4, 0x5d: 12, 0x5e: 8, 0x5f: 20,
  0x61: 12, 0x62: 12, 0x63: 8, 0x64: 12, 0x65: 12, 0x66: 8, 0x67: 4, 0x68: 12, 0x6a: 8, 0x6b: 8, 0x6e: 8,
  0x6f: 8, 0x70: 4, 0x71: 4, 0x73: 12, 0x74: 8,
};
for (let o = 0x1a; o <= 0x1f; o++) FIXED[o] = 8;
for (let o = 0x50; o <= 0x57; o++) FIXED[o] = 8;
/** Commands followed by a −1-terminated word list. */
const LIST = new Set([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x72]);
/** Commands whose handler never advances (unused in the data). */
const NOP = new Set([0x00, 0x2a, 0x34, 0x3c, 0x4c]);
/** Script ends: next script (0x4F), halt (0x4E), return from call (0x71). */
export const EVT_TERMINATORS = new Set([0x4f, 0x4e, 0x71]);

/** Names for the commands identified so far (others print as op_XX). */
export const EVT_OP_NAMES: Record<number, string> = {
  0x09: 'spawn', 0x0a: 'spawn_b', 0x0e: 'set_slot_xyz', 0x20: 'light_fog', 0x24: 'light_fog_b', 0x21: 'param_c',
  0x25: 'param_d', 0x23: 'light_fog_fade', 0x27: 'param_f', 0x2c: 'skippable', 0x2d: 'say', 0x30: 'camera', 0x41: 'wait_frame',
  0x42: 'wait_frames', 0x40: 'wait_camera', 0x38: 'sound', 0x3a: 'sound_b', 0x39: 'sound_repeat', 0x3b: 'sound_repeat_b', 0x18: 'light_dir', 0x19: 'light_dir_b', 0x61: 'screen_mode', 0x49: 'by_players_a', 0x4a: 'by_players_b', 0x4b: 'by_players_c', 0x4d: 'segment_start',
  0x4e: 'halt', 0x4f: 'next_script', 0x6c: 'camera_1p', 0x6d: 'camera_2p', 0x71: 'return', 0x72: 'spawn_c',
  0x73: 'branch_mode',
};

export const evtOpName = (op: number) => EVT_OP_NAMES[op] ?? `op_${op.toString(16).padStart(2, '0')}`;

export interface EvtCommand {
  /** Byte offset in the file. */
  offset: number;
  op: number;
  /** All words of the command (op first), signed. */
  words: number[];
}

export interface EvtBlock {
  index: number;
  /** Byte offset of the block's list. */
  offset: number;
  /** Entry 0 (set-up), as a DC pointer. */
  setup: number;
  /** Script start offsets in this file (entries 1…; pointers outside the file are left out). */
  scripts: number[];
  /** Raw entries (DC pointers), entry 0 included. */
  entries: number[];
}

export interface BlockRule {
  kind: number;
  targets: number[];
}

export class EventFile {
  readonly data: Uint8Array;
  readonly base: number;
  private readonly v: DataView;

  constructor(data: Uint8Array, base = EVT_STAGE_BASE) {
    this.data = data;
    this.base = base;
    this.v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  word(o: number): number {
    return this.v.getInt32(o, true);
  }

  /** File offset of a DC pointer, or undefined if it points outside this file. */
  offsetOf(ptr: number): number | undefined {
    const o = (ptr >>> 0) - this.base;
    return o >= 0 && o < this.data.length ? o : undefined;
  }

  blocks(): EvtBlock[] {
    const out: EvtBlock[] = [];
    for (let i = 0; ; i++) {
      const p = this.word(i * 4) >>> 0;
      if (p === 0xffffffff) break;
      const offset = this.offsetOf(p);
      if (offset === undefined) break;
      const entries: number[] = [];
      for (let k = 0; ; k++) {
        const e = this.word(offset + k * 4) >>> 0;
        if (e === 0xffffffff) break;
        entries.push(e);
      }
      const scripts = entries.slice(1).map((e) => this.offsetOf(e)).filter((o): o is number => o !== undefined);
      out.push({ index: i, offset, setup: entries[0] ?? 0, scripts, entries });
    }
    return out;
  }

  /** Size in bytes of the command at `o`. */
  commandLength(o: number): number {
    const w = (k: number) => this.word(o + k * 4);
    const op = w(0);
    const fixed = FIXED[op];
    if (fixed !== undefined) return fixed;
    if (LIST.has(op)) {
      let k = 1;
      while (w(k) !== -1) k++;
      return 4 * (k + 1);
    }
    if (op === 0x60) {
      let k = 5;
      while (w(k) !== -1) k += 2;
      return 4 * (k + 1);
    }
    if (op === 0x49 || op === 0x4a || op === 0x4b) {
      let k = 1;
      while (w(k) !== -2) k++;
      return 4 * (k + 1);
    }
    if (op === 0x30 || op === 0x6c || op === 0x6d) return 8 + Math.trunc(w(1) / 16) * 4;
    if (op === 0x20 || op === 0x24) {
      const sub = w(1);
      return sub === 5 || sub === 9 ? 20 : sub >= 0 && sub <= 10 ? 12 : 8;
    }
    if (op === 0x69) return w(1) !== 0 ? 8 : 12;
    if (NOP.has(op)) throw new Error(`event op 0x${op.toString(16)} never advances (@0x${o.toString(16)})`);
    throw new Error(`unknown event op 0x${op.toString(16)} @0x${o.toString(16)}`);
  }

  /** Commands of the script at `offset`, up to and including its terminator. */
  script(offset: number, limit = 4096): EvtCommand[] {
    const out: EvtCommand[] = [];
    let o = offset;
    for (let n = 0; n < limit && o + 4 <= this.data.length; n++) {
      const op = this.word(o);
      if (op < 0 || op > 0x74) throw new Error(`bad event op 0x${(op >>> 0).toString(16)} @0x${o.toString(16)}`);
      const len = this.commandLength(o);
      out.push({ offset: o, op, words: Array.from({ length: len / 4 }, (_, k) => this.word(o + k * 4)) });
      o += len;
      if (EVT_TERMINATORS.has(op)) break;
    }
    return out;
  }
}

/** Block transition rules for mode `mode` (`g_evt_block_rules` @005e98b8), up to the {−1,…} terminator. */
export function readBlockRules(pe: PeImage, mode: number, max = 64): BlockRule[] {
  const p = pe.u32(BLOCK_RULES + mode * 4);
  const out: BlockRule[] = [];
  for (let k = 0; k < max; k++) {
    const kind = pe.i16(p + k * 8);
    if (kind === -1) break;
    out.push({ kind, targets: [1, 2, 3].map((j) => pe.i16(p + k * 8 + j * 2)) });
  }
  return out;
}

/** Event file of each stage (1-based) and the rule-table mode it uses (stage n → mode n − 1; checked for Stage 1). */
export const STAGE_EVENT_FILES = ['st1evtbl.bin', 'st2evtbl.bin', 'st3evtbl.bin', 'st4evtbl.bin', 'st5evtbl.bin', 'st6evtbl.bin'];
