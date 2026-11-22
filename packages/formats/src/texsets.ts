/**
 * Texture sets, read from the user's Tod_e.exe (the files themselves hold only texel data).
 *
 *   names       @004f3160  char*[set]          file name under tex\ (index 0 unused)
 *   descriptors @0058c0e0  TexDesc*[set]       16-byte entries: i16 w, i16 h, u32 type, u32 offset, u32 id
 *   counts      @0058c974  i16[set]
 *   palettes    @005b9a80  12-byte records {i16 ?, i16 n=16, u32 ptr, i32 count}, uploaded in order
 *                          into palette RAM banks 0..N-1 by FUN_004bfe40.
 * Palette bank for set s, texture i (load_tex_set → FUN_004bfce0): b = paletteBank(s, i) + 1;
 * if b > 0x3f the default bank 0 is used. Sets loaded through FUN_004bfb10 (common.bin) use bank 0.
 */
import { PeImage } from './pe.ts';
import type { TexDesc } from './pvr.ts';

const NAMES = 0x004f3160;
const DESCS = 0x0058c0e0;
const COUNTS = 0x0058c974;
const PALETTES = 0x005b9a80;

export interface TextureSet {
  index: number;
  /** File name under tex/, e.g. `common.bin`. */
  name: string;
  textures: TexDesc[];
}

export function readTextureSets(pe: PeImage): TextureSet[] {
  const sets: TextureSet[] = [];
  for (let i = 1; ; i++) {
    let name: string;
    try {
      name = pe.cstr(pe.u32(NAMES + i * 4));
    } catch {
      break;
    }
    if (!name.toLowerCase().endsWith('.bin')) break;
    const ptr = pe.u32(DESCS + i * 4);
    const n = pe.i16(COUNTS + i * 2);
    const textures: TexDesc[] = [];
    for (let k = 0; ptr && k < n; k++) {
      const a = ptr + k * 16;
      textures.push({ width: pe.i16(a), height: pe.i16(a + 2), type: pe.u32(a + 4), offset: pe.u32(a + 8), id: pe.u32(a + 12) });
    }
    sets.push({ index: i, name, textures });
  }
  return sets;
}

/** The palette banks as uploaded at start-up: each 16 ARGB1555 entries. */
export function readPalettes(pe: PeImage): Uint16Array[] {
  const banks: Uint16Array[] = [];
  for (let a = PALETTES; ; a += 12) {
    if (pe.i16(a + 2) !== 0x10 || pe.i32(a + 8) < 1) break;
    const p = pe.u32(a + 4);
    banks.push(Uint16Array.from({ length: 16 }, (_, k) => pe.u16(p + k * 2)));
  }
  return banks;
}

// FUN_00493740: switch (set) through a byte index table @493984 (set - 0x164, 0..0xbe) and a
// jump table @493910. Handlers are keyed by their code address; byte tables are read from the exe.
const SWITCH_BASE = 0x164;
const SWITCH_MAX = 0xbe;
const IDX_TABLE = 0x00493984;
const JUMP_TABLE = 0x00493910;

type Handler = (pe: PeImage, i: number) => number;
const tbl = (addr: number): Handler => (pe, i) => pe.u8(addr + i);
const HANDLERS: Record<number, Handler> = {
  0x493763: () => 0x01,
  0x493769: () => 0x21,
  0x49376f: tbl(0x5c1214),
  0x49377c: () => 0x0a,
  0x493782: () => 0x0b,
  0x493788: (_, i) => (i > 0x6d ? 0x0d : 0x2b),
  0x49379c: (_, i) => (i === 0x11 ? 0x10 : 0),
  0x4937ad: tbl(0x5c11fc),
  0x4937ba: (_, i) => (i === 0x17 ? 0x10 : 0),
  0x4937cb: (_, i) => (i > 0x0d ? 0 : 0x13),
  0x4937dc: (_, i) => (i > 6 ? 0 : 0x10),
  0x4937ed: (_, i) => (i === 3 || i === 5 || i === 6 ? 0x12 : 0),
  0x49380a: tbl(0x5c11f4),
  0x493817: (_, i) => (i === 1 ? 0x31 : i >= 0x2c && i <= 0x38 ? 0x32 : i >= 3 && i <= 0x0f ? 0x33 : 0),
  0x49384e: () => 0x14,
  0x493854: () => 0x1b,
  0x49385a: tbl(0x5c1198),
  0x493867: () => 0x1a,
  0x49386d: (_, i) => (i < 0 ? 0x2d : i < 0x4b ? 0x1c : i < 0x96 ? 0x1d : i < 0xe1 ? 0x1e : i < 0x12c ? 0x1f : 0x20),
  0x4938c7: () => 0x2d,
  0x4938cd: (_, i) => (i >= 0x2b && i <= 0x38 ? 0x2f : 0),
  0x4938e1: () => 0x30,
  0x4938e7: () => 0x34,
  0x4938ed: () => 0x35,
  0x4938f3: () => 0x36,
  0x4938f9: () => 0x37,
  0x4938ff: () => 0x38,
  0x493905: () => 0x39,
  0x49390b: () => 0,
};

/** Port of FUN_00493740(set, textureIndex). */
export function paletteBankFn(pe: PeImage, set: number, i: number): number {
  const k = set - SWITCH_BASE;
  if (k < 0 || k > SWITCH_MAX) return 0;
  const target = pe.u32(JUMP_TABLE + pe.u8(IDX_TABLE + k) * 4);
  const h = HANDLERS[target];
  if (!h) throw new Error(`palette switch: unknown handler 0x${target.toString(16)}`);
  return h(pe, i);
}

/** Palette RAM bank used for texture i of a set loaded with load_tex_set. */
export function paletteBankFor(pe: PeImage, set: TextureSet, i: number): number {
  if (set.name.toLowerCase() === 'common.bin') return 0;
  const b = paletteBankFn(pe, set.index, i) + 1;
  return b > 0x3f || b < 0 ? 0 : b;
}
