/**
 * Decompressor for `pol/*.bin` and `tex/*.bin`.
 * Port of Tod_e.exe FUN_0044fe20 (see re/notes/overview.md).
 *
 * File layout: u32 LE uncompressed size, followed by the compressed stream.
 *
 * Stream: flag bits are read LSB-first from a byte refilled every 8 bits; data bytes are
 * interleaved with the flag bytes in stream order.
 *   1          → literal: copy 1 byte
 *   0 1 + u16  → long match: w = u16 LE; w == 0 ends the stream.
 *                distance = 0x2000 - (w >> 3)  (1..8192)
 *                length   = (w & 7) ? (w & 7) + 2 : next byte + 1
 *   0 0 b1 b0 + u8 → short match: length = (b1 << 1 | b0) + 2, distance = 0x100 - u8 (1..256)
 * Matches copy byte-by-byte, so they may overlap the bytes being written.
 */

export class LzError extends Error {}

export interface LzResult {
  data: Uint8Array;
  /** Bytes of the compressed stream consumed, including the end marker. */
  consumed: number;
}

export function lzDecompress(src: Uint8Array, outSize: number): LzResult {
  const out = new Uint8Array(outSize);
  let s = 0; // read position in src
  let d = 0; // write position in out
  let bits = 0;
  let left = 0; // bits remaining in `bits`

  const byte = () => {
    if (s >= src.length) throw new LzError(`input overrun at ${s}`);
    return src[s++]!;
  };
  const bit = () => {
    if (left === 0) {
      bits = byte();
      left = 8;
    }
    const b = bits & 1;
    bits >>= 1;
    left--;
    return b;
  };

  for (;;) {
    if (bit()) {
      if (d >= outSize) throw new LzError(`output overrun at ${d}`);
      out[d++] = byte();
      continue;
    }
    let dist: number;
    let len: number;
    if (bit()) {
      const w = byte() | (byte() << 8);
      if (w === 0) break;
      dist = 0x2000 - (w >> 3);
      len = w & 7 ? (w & 7) + 2 : byte() + 1;
    } else {
      len = ((bit() << 1) | bit()) + 2;
      dist = 0x100 - byte();
    }
    if (dist > d) throw new LzError(`match distance ${dist} before start of output at ${d}`);
    if (d + len > outSize) throw new LzError(`output overrun at ${d} (+${len})`);
    for (let i = 0; i < len; i++, d++) out[d] = out[d - dist]!;
  }

  if (d !== outSize) throw new LzError(`decompressed ${d} bytes, header says ${outSize}`);
  return { data: out, consumed: s };
}

/** Unpack a whole `pol/` or `tex/` file (u32 size header + stream). */
export function unpackFile(file: Uint8Array): LzResult {
  if (file.length < 4) throw new LzError('file too small');
  const size = file[0]! | (file[1]! << 8) | (file[2]! << 16) | (file[3]! << 24);
  if (size < 0) throw new LzError(`implausible size ${size >>> 0}`);
  const r = lzDecompress(file.subarray(4), size);
  return { data: r.data, consumed: r.consumed + 4 };
}
