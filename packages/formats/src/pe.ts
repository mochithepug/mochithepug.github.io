/**
 * Minimal PE reader: map virtual addresses of Tod_e.exe to bytes. The engine reads some tables
 * (file names, subtitles, constants) straight from the user's own exe at runtime.
 */
export interface PeSection {
  name: string;
  va: number;
  vsize: number;
  rawOffset: number;
  rawSize: number;
}

export class PeImage {
  readonly imageBase: number;
  readonly sections: PeSection[] = [];
  readonly bytes: Uint8Array;
  private readonly v: DataView;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (this.v.getUint16(0, true) !== 0x5a4d) throw new Error('not an MZ executable');
    const pe = this.v.getUint32(0x3c, true);
    if (this.v.getUint32(pe, true) !== 0x4550) throw new Error('not a PE executable');
    const nsec = this.v.getUint16(pe + 6, true);
    const optSize = this.v.getUint16(pe + 20, true);
    this.imageBase = this.v.getUint32(pe + 24 + 28, true);
    for (let i = 0; i < nsec; i++) {
      const o = pe + 24 + optSize + i * 40;
      const name = String.fromCharCode(...bytes.subarray(o, o + 8)).replace(/\0+$/, '');
      this.sections.push({
        name,
        vsize: this.v.getUint32(o + 8, true),
        va: this.imageBase + this.v.getUint32(o + 12, true),
        rawSize: this.v.getUint32(o + 16, true),
        rawOffset: this.v.getUint32(o + 20, true),
      });
    }
  }

  /** File offset for a virtual address, or -1 if it is in zero-initialised (.bss) space. */
  offsetOf(va: number): number {
    for (const s of this.sections) {
      if (va >= s.va && va < s.va + Math.max(s.vsize, s.rawSize)) {
        const d = va - s.va;
        return d < s.rawSize ? s.rawOffset + d : -1;
      }
    }
    throw new RangeError(`address 0x${va.toString(16)} is outside the image`);
  }

  u8(va: number) { return this.v.getUint8(this.req(va)); }
  u16(va: number) { return this.v.getUint16(this.req(va), true); }
  i16(va: number) { return this.v.getInt16(this.req(va), true); }
  u32(va: number) { return this.v.getUint32(this.req(va), true); }
  i32(va: number) { return this.v.getInt32(this.req(va), true); }
  f32(va: number) { return this.v.getFloat32(this.req(va), true); }
  cstr(va: number) {
    const o = this.req(va);
    const end = this.bytes.indexOf(0, o);
    return new TextDecoder('latin1').decode(this.bytes.subarray(o, end < 0 ? undefined : end));
  }

  private req(va: number) {
    const o = this.offsetOf(va);
    if (o < 0) throw new RangeError(`address 0x${va.toString(16)} has no file data`);
    return o;
  }
}
