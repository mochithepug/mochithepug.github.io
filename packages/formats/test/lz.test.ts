import { describe, expect, it } from 'vitest';
import { lzDecompress, LzError, unpackFile } from '../src/lz.ts';

/** Tiny encoder for tests: emits flag bits and payload bytes in the decoder's stream order. */
class Writer {
  bytes: number[] = [];
  private flagPos = -1;
  private nbits = 8;
  bit(b: number) {
    if (this.nbits === 8) {
      this.flagPos = this.bytes.push(0) - 1;
      this.nbits = 0;
    }
    this.bytes[this.flagPos]! |= b << this.nbits++;
  }
  literal(v: number) { this.bit(1); this.bytes.push(v); }
  short(dist: number, len: number) {
    this.bit(0); this.bit(0); this.bit((len - 2) >> 1); this.bit((len - 2) & 1);
    this.bytes.push(0x100 - dist);
  }
  long(dist: number, len: number) {
    this.bit(0); this.bit(1);
    const lo = len >= 3 && len <= 9 ? len - 2 : 0;
    const w = ((0x2000 - dist) << 3) | lo;
    this.bytes.push(w & 0xff, w >> 8);
    if (!lo) this.bytes.push(len - 1);
  }
  end() { this.bit(0); this.bit(1); this.bytes.push(0, 0); return Uint8Array.from(this.bytes); }
}

describe('lzDecompress', () => {
  it('decodes literals', () => {
    const w = new Writer();
    [1, 2, 3].forEach((b) => w.literal(b));
    expect(Array.from(lzDecompress(w.end(), 3).data)).toEqual([1, 2, 3]);
  });

  it('decodes short, long and extended-length matches, including overlapping copies', () => {
    const w = new Writer();
    w.literal(0xaa); w.literal(0xbb);
    w.short(2, 4);      // abab
    w.long(1, 9);       // 9 × last byte (overlapping run)
    w.long(6, 20);      // extended length form
    const data = lzDecompress(w.end(), 2 + 4 + 9 + 20).data;
    const exp = [0xaa, 0xbb, 0xaa, 0xbb, 0xaa, 0xbb, ...Array(9).fill(0xbb)];
    for (let i = 0; i < 20; i++) exp.push(exp[exp.length - 6]);
    expect(Array.from(data)).toEqual(exp);
  });

  it('reports consumed bytes and handles flag bytes spanning many tokens', () => {
    const w = new Writer();
    for (let i = 0; i < 100; i++) w.literal(i);
    const s = w.end();
    const r = lzDecompress(s, 100);
    expect(r.consumed).toBe(s.length);
    expect(r.data[99]).toBe(99);
  });

  it('unpackFile reads the size header', () => {
    const w = new Writer();
    w.literal(7);
    const body = w.end();
    expect(Array.from(unpackFile(Uint8Array.from([1, 0, 0, 0, ...body])).data)).toEqual([7]);
  });

  it('rejects size mismatch and bad distances', () => {
    const w = new Writer(); w.literal(1);
    expect(() => lzDecompress(w.end(), 2)).toThrow(LzError);
    const b = new Writer(); b.literal(1); b.short(5, 2);
    expect(() => lzDecompress(b.end(), 3)).toThrow(/before start/);
  });
});
