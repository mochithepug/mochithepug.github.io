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

/** One attack (16-byte row @005a258c[skeleton][set]). */
export interface AttackRow {
  /** Attack motion. */
  attack: number;
  /** Motion to walk in with until within `distance` of the target. */
  approach: number;
  distance: number;
  /** Frame of the attack motion on which it hits (FUN_00445590). */
  hitFrame: number;
  damage: number;
  /** Arms the attack needs (bits of the damage state obj +0x131c & 7): no hit if all are gone. */
  arms: number;
}

export interface AttackTable {
  /** Row to use: picks[(rand >> 4) % 10 + (damage state & 7) * 10] (@005a2434[skeleton][set], 4-byte stride). */
  picks: Int8Array;
  rows: AttackRow[];
}

const ATTACK_PICKS = 0x005a2434;
const ATTACK_ROWS = 0x005a258c;

export function readAttackTable(pe: PeImage, skeleton: number, set: number): AttackTable | undefined {
  const pt = pe.u32(ATTACK_PICKS + skeleton * 4), rt = pe.u32(ATTACK_ROWS + skeleton * 4);
  if (pt < 0x400000 || rt < 0x400000) return undefined;
  const pp = pe.u32(pt + set * 4), rp = pe.u32(rt + set * 4);
  if (pp < 0x400000 || rp < 0x400000) return undefined;
  const picks = Int8Array.from({ length: 80 }, (_, i) => (pe.u8(pp + i * 4) << 24) >> 24);
  const n = Math.max(0, ...picks) + 1;
  const rows = Array.from({ length: n }, (_, r) => {
    const a = rp + r * 16;
    return { attack: pe.i16(a), approach: pe.i16(a + 2), distance: pe.f32(a + 4), hitFrame: pe.i16(a + 8), damage: pe.i16(a + 10), arms: pe.u16(a + 12) };
  });
  return { picks, rows };
}
