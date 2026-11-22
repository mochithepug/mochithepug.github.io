/**
 * word/font.bin — the Shift-JIS bitmap font (7 807 glyphs, 24×24, 2 bits per pixel), and the
 * 32×32 ARGB1555 character textures the game builds from it (Tod_e.exe FUN_00453ab0/FUN_00453c90).
 *
 *   glyph(sjis) = font + 0x10 + table[sjis] × 0x20, table = u16 @00597bb8 indexed by the SJIS code
 *                 (valid 0x8140..0xEAA4, 0 = no glyph). Glyph = 24 rows × 6 bytes, 4 px per byte,
 *                 most significant pair first; value 0 = empty, 1..3 = shade.
 *   Texture: glyph drawn at (2, 2) in a zeroed 32×32 buffer. A shaded pixel becomes opaque grey with
 *   each channel = (0x55, 0xAA, 0xFF)[v−1] & 0x1F (so 21, 10, 31 of 31 — the middle shade is darker,
 *   exactly as the exe computes it); its 8 neighbours get the alpha bit (a black 1-px outline).
 */
import type { PeImage } from './pe.ts';

const GLYPH_TABLE = 0x00597bb8;
const OUTLINE_DX = [-1, 0, 1, -1, 1, -1, 0, 1]; // @004f4414
const OUTLINE_DY = [-1, -1, -1, 0, 0, 1, 1, 1]; // @004f441c
const SHADE = [0, 0x55, 0xaa, 0xff];

export class Font {
  private readonly pe: PeImage;
  private readonly data: Uint8Array;

  constructor(pe: PeImage, fontBin: Uint8Array) {
    this.pe = pe;
    this.data = fontBin;
  }

  /** Glyph shade values (0..3), 24×24 row-major, or undefined if the code has no glyph. */
  glyph(sjis: number): Uint8Array | undefined {
    if (sjis < 0x8140 || sjis > 0xeaa4) return undefined;
    const idx = this.pe.u16(GLYPH_TABLE + sjis * 2);
    if (!idx) return undefined;
    const base = idx * 0x20 + 0x10;
    if (base + 144 > this.data.length) return undefined;
    const out = new Uint8Array(24 * 24);
    for (let r = 0; r < 24; r++)
      for (let c = 0; c < 6; c++) {
        let b = this.data[base + r * 6 + c]!;
        for (let k = 0; k < 4; k++, b = (b << 2) & 0xff) out[r * 24 + c * 4 + k] = b >> 6;
      }
    return out;
  }

  /** The 32×32 ARGB1555 character texture the exe builds for `sjis` (row 0 = top). */
  texture(sjis: number): Uint16Array | undefined {
    const g = this.glyph(sjis);
    if (!g) return undefined;
    const buf = new Uint16Array(32 * 32);
    for (let r = 0; r < 24; r++)
      for (let x = 0; x < 24; x++) {
        const v = g[r * 24 + x]!;
        if (!v) continue;
        const u = SHADE[v]!, t = u & 0x1f;
        const px = 2 + x, py = 2 + r;
        buf[py * 32 + px] = (((((u | 0xffe0) << 5) | t) << 5) | t) & 0xffff;
        for (let n = 0; n < 8; n++) {
          const i = (py + OUTLINE_DY[n]!) * 32 + px + OUTLINE_DX[n]!;
          buf[i] = buf[i]! | 0x8000;
        }
      }
    return buf;
  }
}
