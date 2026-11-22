import { describe, expect, it } from 'vitest';
import { parsePolFile, PolError } from '../src/pol.ts';
import { meshState, Blend, Cmp, Address } from '../src/renderstate.ts';

/** Builds a tiny pol file: 1 model, 1 mesh, a strip of 3 inline vertices and a list using a reference. */
function build(): Uint8Array {
  const w: number[] = [];
  const f = (x: number) => new Uint32Array(new Float32Array([x]).buffer)[0]!;
  const vert = (x: number) => [f(x) | 1, f(0), f(0), 0, 0, 0, 0, 0]; // x LSB set = inline
  // table: (0x10,0x10), (size,0)
  w.push(0x10, 0x10, 0, 0);
  // model header
  w.push(0, 1, f(0), f(0), f(0), f(1));
  const meshAt = w.length;
  w.push(0x80000000 | 0xac, 0xc0000000, 0x00080000, 0, f(0), f(0), f(0), f(1), 3, 0, f(1), f(1), f(1), f(0.5), f(0.25), 0, 0, 0, 0, 0);
  const primStart = w.length;
  w.push(0x72, 3, ...vert(1), ...vert(2), ...vert(3)); // strip, refs allowed, all inline
  const firstVert = primStart + 2;
  w.push(0x2a, 1); // list of 1 triangle with refs, state from flags (cull 2, no smooth)
  w.push(...vert(4));
  // reference back to the first vertex of the strip: offset from the end of this 8-byte ref
  const refAt = w.length;
  w.push(0, (firstVert - (refAt + 2)) * 4);
  w.push(...vert(5));
  w[meshAt + 19] = (w.length - primStart) * 4;
  w.push(0); // end of model
  const out = new Uint8Array(new Uint32Array(w).buffer);
  new DataView(out.buffer).setUint32(8, out.length, true);
  return out;
}

describe('parsePolFile', () => {
  it('parses meshes, strips, lists and resolves references', () => {
    const [m] = parsePolFile(build());
    expect(m!.meshes.length).toBe(1);
    const mesh = m!.meshes[0]!;
    expect(mesh.texture).toBe(3);
    expect(mesh.color).toEqual([1, 0.5, 0.25]);
    const [strip, list] = mesh.prims;
    expect(strip!.list).toBe(false);
    expect(strip!.vertices.length).toBe(3 * 8);
    expect(list!.list).toBe(true);
    expect(list!.cull).toBe(2);
    const xs = [0, 8, 16].map((i) => Math.round(list!.vertices[i]!));
    expect(xs).toEqual([4, 1, 5]); // middle vertex came from the reference
  });

  it('rejects a mesh whose size field does not match its primitives', () => {
    const b = build();
    const v = new DataView(b.buffer);
    v.setInt32(0x28 + 0x4c, v.getInt32(0x28 + 0x4c, true) + 4, true);
    expect(() => parsePolFile(b)).toThrow(PolError);
  });
});

describe('meshState', () => {
  it('maps Dreamcast ISP/TSP bits to D3D render state like FUN_004bfff0', () => {
    // ISP depth mode 6 (DC greater-or-equal on 1/w) → D3D LESS; TSP src 4/dst 5 = alpha blend
    const s = meshState({ isp: 6 << 29, tsp: (4 << 29) | (5 << 26) | 0x100000 | (1 << 17) | (1 << 16) | 0x2000 });
    expect(s.zFunc).toBe(Cmp.LESS);
    expect(s.zWrite).toBe(true);
    expect([s.srcBlend, s.destBlend]).toEqual([Blend.SRCALPHA, Blend.INVSRCALPHA]);
    expect(s.opaque).toBe(false);
    expect(s.alphaTest).toBe(true);
    expect(s.addressV).toBe(Address.MIRROR); // flip V (bit 17)
    expect(s.addressU).toBe(Address.CLAMP); // clamp U (bit 16)
    expect(s.linear).toBe(true);
    const o = meshState({ isp: 1 << 26, tsp: 0x80000 });
    expect(o.opaque).toBe(true);
    expect(o.alphaTest).toBe(false);
    expect(o.zWrite).toBe(false);
  });
});
