/**
 * Skin pieces: extra character models whose vertices follow two joints, filling the joins between rigid
 * parts (e.g. a zombie's belly between torso and jeans). Read from Tod_e.exe; see re/notes/overview.md
 * "Skin pieces".
 *
 *   @0055ac90  per skeleton → {u32 count, ptr → piece*[count]}           (FUN_004742a0, FUN_0048f910)
 *   piece      u32 model id, ptr skin data, then 4 groups {u32 count, ptr entries, ptr slot→entry bytes}
 *              (order A0, A1 at +8; B0, B1 at +0x20). Entry = f32 position xyz + f32 normal xyz (0x18 bytes)
 *              in the group joint's space.
 *   joints     5 i32 per piece index [A0, A1, B0, B1, reference] @0051916c (other tables for skeletons
 *              0x0e, 0x1f/0x46/0x4e, 0x41, 0x4c, 0x53)
 *   skin data  (FUN_00490710) i32 [?, vertOff, vertSize, slotOff, slotSize], i16 headerHalf, i16 n;
 *              slot = headerHalf·2 bytes then −1-terminated i32 offsets of vertex records in the model
 *   drawing    @00519a78 per skeleton → fn per piece: 0x490280 group A0, 0x490230 group B0, 0x48fca0
 *              A0 A1 B0 B1 (FUN_0048fd70 each, then FUN_0048ff30 draws the model at the reference joint).
 */
import type { PeImage } from './pe.ts';

const SKIN_TABLE = 0x0055ac90;
const DRAW_TABLE = 0x00519a78;
const JOINT_TABLES: Record<number, number> = { 0x0e: 0x005192d4, 0x1f: 0x0051943c, 0x46: 0x0051943c, 0x4e: 0x0051943c, 0x41: 0x0051970c, 0x4c: 0x005195a4, 0x53: 0x00519874 };
const DEFAULT_JOINTS = 0x0051916c;

export interface SkinGroup {
  /** Entries: position xyz + normal xyz each, in the group joint's space. */
  entries: Float32Array;
  /** Per slot: entry index, or −1 when this group leaves the slot alone. */
  slotEntry: Int8Array;
}

export interface SkinPiece {
  index: number;
  /** Global model id of the skin model. */
  model: number;
  /** Groups A0, A1, B0, B1 (undefined when empty). */
  groups: (SkinGroup | undefined)[];
  /** Joints of A0, A1, B0, B1 and the reference joint the model is drawn at. */
  joints: [number, number, number, number, number];
  /** Which groups this skeleton's draw function applies (indexes into `groups`). */
  apply: number[];
  /** Per slot: byte offsets of the model's vertex records it writes (from the model start). */
  slots: number[][];
}

function drawGroups(fn: number): number[] | undefined {
  if (fn === 0x490280) return [0];
  if (fn === 0x490230) return [2];
  if (fn === 0x48fca0) return [0, 1, 2, 3];
  return undefined; // none or a skeleton-specific function (e.g. skeleton 0x17), not ported
}

/** Skin pieces of every skeleton (index = skeleton). */
export function readSkins(pe: PeImage, skeletons = 86): SkinPiece[][] {
  const out: SkinPiece[][] = [];
  for (let s = 0; s < skeletons; s++) {
    const pieces: SkinPiece[] = [];
    out.push(pieces);
    const entry = pe.u32(SKIN_TABLE + s * 4);
    if (!entry) continue;
    const count = pe.u32(entry), list = pe.u32(entry + 4);
    if (!count || count > 16 || !list) continue;
    const drawFns = pe.u32(DRAW_TABLE + s * 4);
    for (let k = 0; k < count; k++) {
      const p = pe.u32(list + k * 4);
      if (!p) continue;
      const apply = drawFns ? drawGroups(pe.u32(drawFns + k * 4)) : undefined;
      if (!apply) continue;
      const data = pe.u32(p + 4);
      const slotOff = pe.i32(data + 12), slotSize = pe.i32(data + 16);
      const head = pe.i16(data + 20) * 2, n = pe.i16(data + 22);
      const stride = head + n * 4, slotCount = Math.trunc(slotSize / stride);
      const slots: number[][] = [];
      for (let i = 0; i < slotCount; i++) {
        const offs: number[] = [];
        for (let j = 0; j < n; j++) {
          const v = pe.i32(data + slotOff + i * stride + head + j * 4);
          if (v === -1) break;
          offs.push(v);
        }
        slots.push(offs);
      }
      const groups = [0, 1, 2, 3].map((g) => {
        const at = p + (g < 2 ? 8 + g * 12 : 0x20 + (g - 2) * 12);
        const n = pe.u32(at), ent = pe.u32(at + 4), map = pe.u32(at + 8);
        if (!n || !ent || !map) return undefined;
        const entries = new Float32Array(n * 6);
        for (let i = 0; i < n * 6; i++) entries[i] = pe.f32(ent + i * 4);
        const slotEntry = new Int8Array(slotCount);
        for (let i = 0; i < slotCount; i++) slotEntry[i] = (pe.u8(map + i) << 24) >> 24;
        return { entries, slotEntry };
      });
      const jt = (JOINT_TABLES[s] ?? DEFAULT_JOINTS) + k * 20;
      const joints = [0, 1, 2, 3, 4].map((i) => pe.i32(jt + i * 4)) as SkinPiece['joints'];
      pieces.push({ index: k, model: pe.u32(p), groups, joints, apply, slots });
    }
  }
  return out;
}
