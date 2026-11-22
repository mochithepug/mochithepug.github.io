import { describe, expect, it } from 'vitest';
import { decodeTexels, texelsToRgba, type TexDesc } from '../src/pvr.ts';

const file = (vals: number[]) => {
  const b = new Uint8Array(vals.length * 2);
  vals.forEach((v, i) => { b[i * 2] = v & 0xff; b[i * 2 + 1] = v >> 8; });
  return b;
};
const desc = (w: number, h: number, type: number, offset = 0): TexDesc => ({ width: w, height: h, type, offset, id: 0 });

describe('decodeTexels', () => {
  it('twiddled: Dreamcast order goes down the column first (0,0) (0,1) (1,0) (1,1)', () => {
    const { texels } = decodeTexels(desc(2, 2, 0x101), file([10, 11, 12, 13]));
    // row-major output: (0,0)=10 (1,0)=12 / (0,1)=11 (1,1)=13
    expect(Array.from(texels)).toEqual([10, 12, 11, 13]);
  });

  it('twiddled 4×4 recurses on 2×2 quadrants', () => {
    const { texels } = decodeTexels(desc(4, 4, 0x101), file([...Array(16).keys()]));
    expect(Array.from(texels)).toEqual([0, 2, 8, 10, 1, 3, 9, 11, 4, 6, 12, 14, 5, 7, 13, 15]);
  });

  it('rectangle: plain row-major, honours offset', () => {
    const { texels } = decodeTexels(desc(2, 1, 0x901, 2), file([99, 1, 2]));
    expect(Array.from(texels)).toEqual([1, 2]);
  });

  it('rect twiddled: wide textures are square twiddled blocks side by side', () => {
    const { texels } = decodeTexels(desc(4, 2, 0xd01), file([0, 1, 2, 3, 4, 5, 6, 7]));
    expect(Array.from(texels)).toEqual([0, 2, 4, 6, 1, 3, 5, 7]);
  });

  it('rect twiddled: tall textures are blocks stacked vertically', () => {
    const { texels } = decodeTexels(desc(2, 4, 0xd01), file([0, 1, 2, 3, 4, 5, 6, 7]));
    expect(Array.from(texels)).toEqual([0, 2, 1, 3, 4, 6, 5, 7]);
  });

  it('VQ: codebook entries are 2×2 blocks TL, BL, TR, BR; indices are twiddled', () => {
    const book = new Array(1024).fill(0);
    book.splice(0, 4, 1, 2, 3, 4); // entry 0
    book.splice(4, 4, 5, 6, 7, 8); // entry 1
    const f = new Uint8Array(0x800 + 4);
    f.set(file(book));
    f.set([0, 1, 1, 0], 0x800); // twiddled: (0,0)=0 (0,1)=1 (1,0)=1 (1,1)=0
    const { texels } = decodeTexels(desc(4, 4, 0x301), f);
    expect(Array.from(texels)).toEqual([1, 3, 5, 7, 2, 4, 6, 8, 5, 7, 1, 3, 6, 8, 2, 4]);
  });

  it('4-bit palette: nibbles in twiddled order, low nibble first; palette converted to the D3D format', () => {
    const pal = Array.from({ length: 16 }, (_, i) => 0x8000 | i); // ARGB1555 entries
    const { texels, format } = decodeTexels(desc(2, 2, 0x500), Uint8Array.from([0x21, 0x43]), pal);
    expect(format).toBe(5);
    expect(Array.from(texels)).toEqual([0x8001, 0x8003, 0x8002, 0x8004]);
    // ARGB4444 target: A = 0xF if bit 15, RGB = top 4 bits of each 5-bit channel
    const c = decodeTexels(desc(2, 2, 0x502), Uint8Array.from([0x00, 0x00]), [0xfc1f, ...pal.slice(1)]);
    expect(c.texels[0]).toBe(0xff0f);
    // RGB565 target: R and G shifted up one bit, B unchanged
    const r = decodeTexels(desc(2, 2, 0x501), Uint8Array.from([0x00, 0x00]), [0x7fff, ...pal.slice(1)]);
    expect(r.texels[0]).toBe(0xffdf);
  });
});

describe('texelsToRgba', () => {
  it('expands with bit replication', () => {
    expect(Array.from(texelsToRgba(Uint16Array.of(0xffff, 0x7c00), 5))).toEqual([255, 255, 255, 255, 255, 0, 0, 0]);
    expect(Array.from(texelsToRgba(Uint16Array.of(0x07e0), 2))).toEqual([0, 255, 0, 255]);
    expect(Array.from(texelsToRgba(Uint16Array.of(0x8421), 6))).toEqual([68, 34, 17, 136]);
  });
});
