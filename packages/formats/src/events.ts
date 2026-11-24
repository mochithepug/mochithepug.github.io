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
  0x03: 'spawn_1p', 0x07: 'spawn_2p', 0x09: 'spawn', 0x0a: 'spawn_b', 0x0b: 'spawn_obj', 0x0c: 'spawn_light', 0x0e: 'approach_band', 0x61: 'word_setup', 0x20: 'light_fog', 0x24: 'light_fog_b', 0x21: 'param_c',
  0x25: 'param_d', 0x23: 'light_fog_fade', 0x27: 'param_f', 0x2c: 'skippable', 0x2d: 'say', 0x30: 'camera', 0x41: 'wait_camera_time',
  0x42: 'wait_frames', 0x45: 'wait_flag', 0x29: 'stage_area', 0x1b: 'sky_row', 0x1c: 'sky_mode', 0x40: 'wait_camera', 0x38: 'sound', 0x3a: 'sound_b', 0x39: 'sound_repeat', 0x3b: 'sound_repeat_b', 0x18: 'light_dir', 0x19: 'light_dir_b', 0x49: 'by_players_a', 0x4a: 'by_players_b', 0x4b: 'by_players_c', 0x4d: 'segment_start',
  0x4e: 'halt', 0x4f: 'next_script', 0x6c: 'camera_1p', 0x6d: 'camera_2p', 0x71: 'return', 0x72: 'spawn_c',
  0x73: 'branch_mode',
  // fight flow and others confirmed in the exe (re/notes/overview.md "Fight flow in the script")
  0x0f: 'attack_counts', 0x28: 'stage_area_load', 0x2e: 'stop_voice_if_skipping', 0x31: 'fight_over',
  0x33: 'camera_release', 0x43: 'wait_enemies_alive', 0x44: 'wait_enemies_fighting',
};

export const evtOpName = (op: number) => EVT_OP_NAMES[op] ?? `op_${op.toString(16).padStart(2, '0')}`;

/** A spawn record decoded from a 0x09 command's pointer list. */
export interface SpawnRecord {
  /** Object task type (indexes the task table; 0x41 = placed object dispatcher). */
  type: number;
  /** Setup parameter (record word 1). */
  param: number;
  /** World position (f32 xyz). Undefined for 0x0A records (no position). */
  pos?: [number, number, number];
  /** Sega angles (i32 xyz). */
  angles?: [number, number, number];
  /** i16 at record +0x22: hit points for characters (obj +0x11c/+0x11e); for placed objects (0x41), a lifetime in scene changes and, for some kinds, the model id. */
  hp: number;
  /** Sub-kind byte (record +0x25 → object +0x1310; selects the placed-object sub-type for type 0x41). */
  kind: number;
  /** Skeleton index into `g_chr_skeletons` (signed byte at record +0x24 → object +0x1f8). */
  skeleton: number;
  /** Source: which file the record came from. */
  source: 'stage' | 'common';
  /**
   * The record from +0x24 on (64 bytes or to the end of the file): the per-type parameters objects read
   * through obj +0x1394 (skeleton, kind, behaviour, motions, camera times, targets…).
   */
  tail?: Uint8Array;
  /**
   * Type 0x10 (civilian, FUN_0047fa70): the attackers it spawns with spawn_record — count at extra data +0xC,
   * record pointers from +0x10.
   */
  children?: SpawnRecord[];
  /**
   * Zombies (0x30): the step lists behind extra data +4 / +8 (behaviours 0x23 / 0x24 / 0x28, FUN_0044a310):
   * {motion, start frame, repeats, kill frame} until motion < 1. Undefined where the pointer leaves the file.
   */
  steps?: [StepEntry[] | undefined, StepEntry[] | undefined];
  /** Type 0x30: the raw data at extra +4 / +8 (up to 0x80 bytes) — behaviours 34 / 40 read their own layouts. */
  lists?: [Uint8Array | undefined, Uint8Array | undefined];
}

/** Behaviour 35's steps from raw bytes at `off`: 8-byte entries {motion, start, repeats, kill} until motion < 1. */
export function readSteps(b: Uint8Array, off: number): StepEntry[] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: StepEntry[] = [];
  for (let k = 0; k < 16 && off + k * 8 + 8 <= b.length; k++) {
    const e = [0, 2, 4, 6].map((x) => dv.getInt16(off + k * 8 + x, true));
    out.push({ motion: e[0]!, start: e[1]!, repeats: e[2]!, kill: e[3]! });
    if (e[0]! < 1) break;
  }
  return out;
}

export interface StepEntry {
  motion: number;
  start: number;
  repeats: number;
  /** Frame on which the attacked civilian dies; −1 none, −2 / −3 flag variants (FUN_0044c1e0). */
  kill: number;
}

/** One positioned spawn record at `off` (spawn_record layout); a civilian (0x10) also gets its attackers. */
function readPositionedRecord(src: EventFile, off: number, source: 'stage' | 'common', depth = 0): SpawnRecord {
  const w = (i: number) => src.word(off + i * 4);
  const dv = new DataView(src.data.buffer, src.data.byteOffset, src.data.byteLength);
  const f = (i: number) => dv.getFloat32(off + i * 4, true);
  const rec: SpawnRecord = {
    type: w(0), param: w(1),
    pos: [f(2), f(3), f(4)],
    angles: [w(5), w(6), w(7)],
    hp: dv.getInt16(off + 0x22, true), kind: src.data[off + 0x25]!, skeleton: dv.getInt8(off + 0x24), source,
    tail: src.data.slice(off + 0x24, Math.min(off + 0x64, src.data.length)),
  };
  if (rec.type === 0x30 && off + 0x24 + 0xc <= src.data.length) {
    const list = (p: number) => {
      const o = src.offsetOf(p);
      if (!p || o === undefined) return undefined;
      const out: StepEntry[] = [];
      for (let k = 0; k < 16 && o + k * 8 + 8 <= src.data.length; k++) {
        const e = [0, 2, 4, 6].map((x) => dv.getInt16(o + k * 8 + x, true));
        out.push({ motion: e[0]!, start: e[1]!, repeats: e[2]!, kill: e[3]! });
        if (e[0]! < 1) break;
      }
      return out;
    };
    rec.steps = [list(dv.getUint32(off + 0x24 + 4, true)), list(dv.getUint32(off + 0x24 + 8, true))];
    const raw = (p: number) => {
      const o = src.offsetOf(p);
      return p && o !== undefined ? src.data.slice(o, Math.min(o + 0x80, src.data.length)) : undefined;
    };
    rec.lists = [raw(dv.getUint32(off + 0x24 + 4, true)), raw(dv.getUint32(off + 0x24 + 8, true))];
  }
  if (rec.type === 0x10 && depth === 0 && off + 0x24 + 0x10 <= src.data.length) {
    const n = dv.getInt32(off + 0x24 + 0xc, true);
    rec.children = [];
    for (let k = 0; k < n && k < 8; k++) {
      const c = src.offsetOf(dv.getUint32(off + 0x24 + 0x10 + k * 4, true));
      if (c !== undefined) rec.children.push(readPositionedRecord(src, c, source, depth + 1));
    }
  }
  return rec;
}

/** Decode the spawn records in a positioned (0x09, 0x03, 0x07, 0x0B) or simple (0x0A) command's −1-terminated pointer list. */
export function readSpawnRecords(ef: EventFile, common: EventFile | undefined, cmdOffset: number): SpawnRecord[] {
  const op = ef.word(cmdOffset);
  // 0x0B (FUN_00420120) creates each record with spawn_record @00420050 — same layout as 0x09; 0x0C
  // (FUN_00420300 → FUN_00420240) the same layout into a lighter object
  const positioned = op === 0x09 || op === 0x03 || op === 0x07 || op === 0x0b || op === 0x0c;
  const out: SpawnRecord[] = [];
  let k = 1;
  while (true) {
    const ptr = ef.word(cmdOffset + k * 4);
    if (ptr === -1) break;
    const uptr = ptr >>> 0;
    let off = ef.offsetOf(uptr);
    let src: EventFile | undefined = ef;
    let source: 'stage' | 'common' = 'stage';
    if (off === undefined && common) {
      off = common.offsetOf(uptr);
      src = common;
      source = 'common';
    }
    if (off === undefined || !src) { k++; continue; }
    if (positioned) {
      out.push(readPositionedRecord(src, off, source));
    } else {
      out.push({
        type: src.word(off), param: src.word(off + 4),
        hp: 0, kind: 0, skeleton: 0, source,
      });
    }
    k++;
  }
  return out;
}

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
