/**
 * Civilian scripts (type 0x10 — re/notes/overview.md "Civilians"). A civilian is driven by command lists in the
 * exe, run by `FUN_00481060`: a run starts at a segment command (0x2C, its flags = the wait conditions for the
 * next segment) and executes commands until the next one is > 0x2B (the next segment, or an end ≥ 0x2D), where it
 * stops and remembers the place. The start script comes from @00517ccc[kind] (record extra data byte +1).
 */
import type { PeImage } from './pe.ts';

/** Command lengths in words, op included (FUN_00481060's cases). 0x10 (callback) and 0x2B are variable. */
export const CIVILIAN_CMD_WORDS: Record<number, number> = {
  0x00: 3, 0x01: 4, 0x02: 2, 0x03: 2, 0x04: 2, 0x05: 3, 0x06: 2, 0x07: 2, 0x08: 2, 0x09: 2, 0x0a: 2, 0x0b: 2,
  0x0c: 2, 0x0d: 3, 0x0e: 2, 0x0f: 2, 0x11: 2, 0x12: 2, 0x13: 3, 0x14: 2, 0x15: 2, 0x16: 3, 0x17: 2, 0x18: 2,
  0x19: 2, 0x1a: 3, 0x1b: 2, 0x1c: 2, 0x1d: 2, 0x1e: 2, 0x1f: 3, 0x20: 2, 0x21: 3, 0x22: 2, 0x23: 2, 0x24: 3,
  0x25: 3, 0x26: 3, 0x27: 2, 0x28: 2, 0x29: 2, 0x2a: 2, 0x2c: 2,
};

export interface CivilianCommand {
  /** Exe address of the command. */
  addr: number;
  op: number;
  args: number[];
}

/** The command at `addr` (undefined for an end marker ≥ 0x2D, a callback 0x10 with a function, or 0x2B). */
export function readCivilianCommand(pe: PeImage, addr: number): CivilianCommand | undefined {
  const op = pe.i32(addr);
  if (op === 0x10 && pe.u32(addr + 4) === 0) return { addr, op, args: [0] };
  const n = CIVILIAN_CMD_WORDS[op];
  if (n === undefined) return undefined;
  return { addr, op, args: Array.from({ length: n - 1 }, (_, k) => pe.i32(addr + 4 + k * 4)) };
}

/** Start script address for a civilian kind (@00517ccc). */
export function civilianStartScript(pe: PeImage, kind: number): number {
  return pe.u32(0x00517ccc + kind * 4);
}

/** Rank percentages for the attackers' hp (@00512a24, FUN_0047fa70). */
export function civilianAttackerHpPercent(pe: PeImage, rank: number): number {
  return pe.u8(0x00512a24 + rank);
}
