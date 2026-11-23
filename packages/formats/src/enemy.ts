/**
 * Enemy behaviour data from Tod_e.exe. See re/notes/overview.md "Zombie behaviours".
 *
 *   approach bands  @004dec80: 4 rows × 3 f32 (near, mid, far) distances from the player on the ground plane,
 *                   copied to DAT_00a11880 at stage start (FUN_0044eab0); event op 0x0E (FUN_00420430) changes a
 *                   row. A zombie uses row obj +0x1323 (2 for skeleton 0, else 0). Within `near` it stops
 *                   walking (behaviour 1 → 2).
 *   motion sets     @005a2330[skeleton] → [kind] → i32 motions: [0] idle, [2] walk, [3] fast walk (obj +0x34
 *                   bit 27), [4] back off, …
 */
import type { PeImage } from './pe.ts';

const APPROACH_BANDS = 0x004dec80;
const MOTION_SETS = 0x005a2330;

export type Band = [near: number, mid: number, far: number];

export function readApproachBands(pe: PeImage): Band[] {
  return Array.from({ length: 4 }, (_, r) => [0, 1, 2].map((k) => pe.f32(APPROACH_BANDS + r * 12 + k * 4)) as Band);
}

/** The motion set of a skeleton's kind (6 entries), or undefined if the table has none. */
export function readMotionSet(pe: PeImage, skeleton: number, kind: number): number[] | undefined {
  const t = pe.u32(MOTION_SETS + skeleton * 4);
  if (t < 0x400000) return undefined;
  const p = pe.u32(t + kind * 4);
  if (p < 0x400000) return undefined;
  return Array.from({ length: 6 }, (_, k) => pe.i32(p + k * 4));
}
