/**
 * Dreamcast (PowerVR2) texture decoding, as done by Tod_e.exe FUN_004bf400 when it uploads a
 * texture to Direct3D. Texture files hold only pixel data; the descriptors live in the exe
 * (see texsets.ts).
 *
 * Type word: low 3 bits = pixel format, bits 8..15 = layout.
 * The exe maps the pixel format to a D3D surface format (table @0058ff68):
 *   0 ARGB1555 → 5 (ARGB1555), 1 RGB565 → 2 (RGB565), 2 ARGB4444 → 6 (ARGB4444), others → unsupported.
 * For non-palette layouts the 16-bit texels are copied unchanged, so the D3D format equals the
 * source format. 4-bit palette entries are always ARGB1555 and are converted to the D3D format.
 */

export interface TexDesc {
  width: number;
  height: number;
  /** Raw type word: layout (0xff00) | pixel format (0x7). */
  type: number;
  /** Byte offset of the texel data in the (decompressed) texture file. */
  offset: number;
  /** Global texture slot id. */
  id: number;
}

export const Layout = {
  Twiddled: 0x100,
  VQ: 0x300,
  Pal4: 0x500,
  Rect: 0x900,
  RectTwiddled: 0xd00,
} as const;

export const PixelFormat = {
  ARGB1555: 0,
  RGB565: 1,
  ARGB4444: 2,
} as const;

/** D3D surface format the exe creates for a pixel format (table @0058ff68); 8 = unsupported. */
const D3D_FORMAT = [5, 2, 6, 8, 8, 8, 7, 0] as const;
type D3DFmt = 2 | 5 | 6;

export const layoutOf = (type: number) => type & 0xff00;
export const formatOf = (type: number) => type & 7;

export const LAYOUT_NAMES: Record<number, string> = {
  0x100: 'twiddled',
  0x300: 'VQ',
  0x500: '4-bit palette',
  0x900: 'rectangle',
  0xd00: 'rect twiddled',
};
export const FORMAT_NAMES = ['ARGB1555', 'RGB565', 'ARGB4444', 'YUV422', 'bump', 'pal4', 'pal8', '?'];

/** Size in bytes of a texture's data. */
export function texDataSize(d: TexDesc): number {
  switch (layoutOf(d.type)) {
    case Layout.Twiddled:
    case Layout.Rect:
    case Layout.RectTwiddled:
      return d.width * d.height * 2;
    case Layout.VQ:
      return 0x800 + (d.width >> 1) * (d.height >> 1);
    case Layout.Pal4:
      return (d.width * d.height) >> 1;
    default:
      return 0;
  }
}

// Twiddle (Morton) index parts. The exe steps them with `(v + 0x55556) & 0xaaaaa` (x, odd bits)
// and `(v + 0x2aaab) & 0x55555` (y, even bits); depositing the bits directly is equivalent.
function oddBits(n: number) {
  let r = 0;
  for (let b = 0; n >> b; b++) r |= ((n >> b) & 1) << (2 * b + 1);
  return r;
}
function evenBits(n: number) {
  let r = 0;
  for (let b = 0; n >> b; b++) r |= ((n >> b) & 1) << (2 * b);
  return r;
}

/** ARGB1555 palette entry → D3D target format, exactly as the 0x500 path does. */
function convertPaletteEntry(c: number, fmt: D3DFmt): number {
  if (fmt === 2) return (((c & 0xffe0) << 1) | (c & 0x1f)) & 0xffff;
  if (fmt === 6) {
    const a = c & 0x8000 ? 0xf : 0;
    return (a << 12) | (((c >> 11) & 0xf) << 8) | (((c >> 6) & 0xf) << 4) | ((c >> 1) & 0xf);
  }
  return c;
}

export class TextureError extends Error {}

/**
 * Decode one texture to 16-bit texels in the D3D target format (row-major, width × height).
 * @param palette the 16 ARGB1555 entries of the selected bank (only for 4-bit palette textures)
 */
export interface Decoded {
  texels: Uint16Array;
  format: D3DFmt;
  /**
   * True if decoding read beyond this texture's own data. The exe's 4-bit path twiddles tall
   * textures (h > 2w) without splitting them into square blocks, so it reads into whatever follows
   * in the loaded file; we replicate that (bytes past the end of the file read as 0).
   */
  overrun: boolean;
}

export function decodeTexels(d: TexDesc, file: Uint8Array, palette?: ArrayLike<number>): Decoded {
  const { width: w, height: h } = d;
  const fmt = D3D_FORMAT[formatOf(d.type)];
  if (!w || !h || fmt === 8 || fmt === 7 || fmt === 0) throw new TextureError(`unsupported texture type 0x${d.type.toString(16)}`);
  const f = fmt as D3DFmt;
  const end = d.offset + texDataSize(d);
  if (end > file.length) throw new TextureError(`texture data (${d.offset}+${texDataSize(d)}) exceeds file (${file.length})`);
  const src = new DataView(file.buffer, file.byteOffset + d.offset, end - d.offset);
  const u16 = (i: number) => src.getUint16(i * 2, true);
  const out = new Uint16Array(w * h);
  let overrun = false;

  switch (layoutOf(d.type)) {
    case Layout.Twiddled:
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = u16(oddBits(x) + evenBits(y));
      break;

    case Layout.Rect:
      for (let i = 0; i < w * h; i++) out[i] = u16(i);
      break;

    case Layout.RectTwiddled:
      if (w < h) {
        // h / w square blocks of w × w, stacked vertically.
        for (let b = 0; b < Math.trunc(h / w); b++)
          for (let y = 0; y < w; y++)
            for (let x = 0; x < w; x++) out[(b * w + y) * w + x] = u16(b * w * w + oddBits(x) + evenBits(y));
      } else {
        // w / h square blocks of h × h, side by side (a square texture is one block).
        for (let b = 0; b < Math.trunc(w / h); b++)
          for (let y = 0; y < h; y++)
            for (let x = 0; x < h; x++) out[y * w + b * h + x] = u16(b * h * h + oddBits(x) + evenBits(y));
      }
      break;

    case Layout.VQ: {
      // 256-entry codebook of 2×2 blocks (4 texels: TL, BL, TR, BR), then twiddled 8-bit indices.
      const idx = new Uint8Array(file.buffer, file.byteOffset + d.offset + 0x800, (w >> 1) * (h >> 1));
      for (let by = 0; by < (h + 1) >> 1; by++) {
        for (let bx = 0; bx < (w + 1) >> 1; bx++) {
          const c = idx[oddBits(bx) + evenBits(by)]! * 4;
          const x = bx * 2, y = by * 2;
          out[y * w + x] = u16(c);
          out[(y + 1) * w + x] = u16(c + 1);
          out[y * w + x + 1] = u16(c + 2);
          out[(y + 1) * w + x + 1] = u16(c + 3);
        }
      }
      break;
    }

    case Layout.Pal4: {
      if (!palette || palette.length < 16) throw new TextureError('4-bit palette texture needs a 16-entry palette');
      const pal = Array.from({ length: 16 }, (_, i) => convertPaletteEntry(palette[i]!, f));
      const own = texDataSize(d);
      for (let y = 0; y < h; y++) {
        const ey = evenBits(y);
        for (let x = 0; x < w; x++) {
          // Wider than tall: h × h twiddled blocks side by side (the exe's x >= h branch).
          // Taller than wide: plain interleave, as in the exe (see Decoded.overrun).
          const t = x < h ? oddBits(x) : Math.trunc(x / h) * h * h + oddBits(x % h);
          const n = ey + t;
          const byte = n >> 1;
          if (byte >= own) overrun = true;
          const at = d.offset + byte;
          const v = at < file.length ? file[at]! : 0;
          out[y * w + x] = pal[n & 1 ? v >> 4 : v & 0xf]!;
        }
      }
      break;
    }

    default:
      throw new TextureError(`unsupported layout 0x${layoutOf(d.type).toString(16)}`);
  }
  return { texels: out, format: f, overrun };
}

const x5 = (v: number) => (v << 3) | (v >> 2);
const x6 = (v: number) => (v << 2) | (v >> 4);
const x4 = (v: number) => (v << 4) | v;

/** Expand D3D 16-bit texels to RGBA8 (bit replication). */
export function texelsToRgba(texels: Uint16Array, format: D3DFmt): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(texels.length * 4);
  for (let i = 0; i < texels.length; i++) {
    const c = texels[i]!;
    const o = i * 4;
    if (format === 5) {
      out[o] = x5((c >> 10) & 31);
      out[o + 1] = x5((c >> 5) & 31);
      out[o + 2] = x5(c & 31);
      out[o + 3] = c & 0x8000 ? 255 : 0;
    } else if (format === 2) {
      out[o] = x5(c >> 11);
      out[o + 1] = x6((c >> 5) & 63);
      out[o + 2] = x5(c & 31);
      out[o + 3] = 255;
    } else {
      out[o] = x4((c >> 8) & 15);
      out[o + 1] = x4((c >> 4) & 15);
      out[o + 2] = x4(c & 15);
      out[o + 3] = x4(c >> 12);
    }
  }
  return out;
}

export function decodeTexture(d: TexDesc, file: Uint8Array, palette?: ArrayLike<number>): Uint8ClampedArray<ArrayBuffer> {
  const { texels, format } = decodeTexels(d, file, palette);
  return texelsToRgba(texels, format);
}
