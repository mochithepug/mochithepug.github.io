/**
 * Model files (`pol/*.bin`, after LZ decompression or raw for stage files).
 * Reverse-engineered from the model renderers FUN_004c0780 / FUN_004c0cd0 and tex_register_model
 * (see re/notes/overview.md, "Models").
 *
 * File: table of u32 pairs `(offset, offset)` — one per model — terminated by `(fileSize, 0)`, then
 *       zero padding up to the first model. Offsets are from the start of the file.
 * Model: 0x18-byte header {u32 ?, u32 flags, f32 cx, cy, cz, radius}, then chunks until a word whose
 *        low 31 bits are 0 (the exe compares it as a float against 0.0):
 *   Mesh header (bit 31 set), 0x50 bytes = 20 words:
 *     [0..3] Dreamcast PCW / ISP / TSP / TCW words (→ render states), [4..6] centre, [7] radius,
 *     [8] texture index into the paired tex set (-1 = none), [9] specular exponent (1 << n if n > 0),
 *     [10] ambient scale, [11] alpha, [12..14] RGB, [15] ?, [16..18] specular RGB,
 *     [19] byte size of the primitive chunks that follow.
 *   Primitive chunk: u32 flags, u32 count, then vertices.
 *     flags & 8: triangle list (count = triangles) else strip (count = vertices)
 *     flags & 0x80 clear: set cull mode (flags & 3) and shade mode (flags & 0x40) — else keep previous
 *     flags & 0x20: each vertex is either inline (8 floats; x has bit 0 set) or a reference
 *                   {u32 marker (bit 0 clear), i32 byteOffset from the end of the reference}
 *   Vertex: x y z nx ny nz u v (D3DFVF_XYZ | NORMAL | TEX1).
 */

export interface PolPrim {
  /** Raw flags word. */
  flags: number;
  list: boolean;
  /** Cull mode bits (0..3) in effect for this primitive (carried over when flags & 0x80). */
  cull: number;
  /** Smooth (Gouraud) shading in effect for this primitive. */
  smooth: boolean;
  /** 8 floats per vertex, references resolved. */
  vertices: Float32Array;
}

export interface PolMesh {
  /** Dreamcast parameter words: PCW, ISP/TSP, TSP, TCW. */
  pcw: number;
  isp: number;
  tsp: number;
  tcw: number;
  center: [number, number, number];
  radius: number;
  /** Index into the paired texture set's descriptors, or -1. */
  texture: number;
  specularPower: number;
  ambientScale: number;
  alpha: number;
  color: [number, number, number];
  specular: [number, number, number];
  prims: PolPrim[];
}

export interface PolModel {
  index: number;
  offset: number;
  flags: number;
  center: [number, number, number];
  radius: number;
  meshes: PolMesh[];
}

export class PolError extends Error {}

/** Offsets of the models in a pol file. */
export function polModelOffsets(file: Uint8Array): number[] {
  const v = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const first = v.getUint32(0, true);
  if (!first || first > file.length || first % 8) throw new PolError('not a model table');
  const out: number[] = [];
  for (let i = 0; i < first / 8; i++) {
    const o = v.getUint32(i * 8 + 4, true);
    if (o === 0) break; // (fileSize, 0) terminator
    out.push(o);
  }
  return out;
}

export function parsePolModel(file: Uint8Array, offset: number, index = 0): PolModel {
  const v = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const f32 = (o: number) => v.getFloat32(o, true);
  const u32 = (o: number) => v.getUint32(o, true);
  const need = (o: number, n: number) => {
    if (o < 0 || o + n > file.length) throw new PolError(`model ${index}: read past end at 0x${o.toString(16)}`);
  };
  need(offset, 0x18);
  const model: PolModel = {
    index,
    offset,
    flags: u32(offset + 4),
    center: [f32(offset + 8), f32(offset + 12), f32(offset + 16)],
    radius: f32(offset + 20),
    meshes: [],
  };
  if (model.flags & 0x10) throw new PolError(`model ${index}: flag 0x10 (alternate vertex format) not supported`);

  let p = offset + 0x18;
  let mesh: PolMesh | undefined;
  let meshEnd = 0;
  let cull = 0;
  let smooth = false;
  for (;;) {
    need(p, 4);
    const w = u32(p);
    if ((w & 0x7fffffff) === 0) break;
    if (w & 0x80000000) {
      if (mesh && p !== meshEnd) throw new PolError(`model ${index}: mesh size mismatch at 0x${p.toString(16)}`);
      need(p, 0x50);
      const t = v.getInt32(p + 0x20, true);
      mesh = {
        pcw: w,
        isp: u32(p + 4),
        tsp: u32(p + 8),
        tcw: u32(p + 12),
        center: [f32(p + 16), f32(p + 20), f32(p + 24)],
        radius: f32(p + 28),
        texture: t,
        specularPower: v.getInt32(p + 0x24, true),
        ambientScale: f32(p + 0x28),
        alpha: f32(p + 0x2c),
        color: [f32(p + 0x30), f32(p + 0x34), f32(p + 0x38)],
        specular: [f32(p + 0x40), f32(p + 0x44), f32(p + 0x48)],
        prims: [],
      };
      model.meshes.push(mesh);
      meshEnd = p + 0x50 + v.getInt32(p + 0x4c, true);
      p += 0x50;
      continue;
    }
    if (!mesh) throw new PolError(`model ${index}: primitive before any mesh header`);
    need(p, 8);
    const count = u32(p + 4);
    p += 8;
    if (!(w & 0x80)) {
      cull = w & 3;
      smooth = (w & 0x40) !== 0;
    }
    const list = (w & 8) !== 0;
    const n = list ? count * 3 : count;
    const verts = new Float32Array(n * 8);
    for (let k = 0; k < n; k++) {
      let src = p;
      if (w & 0x20) {
        need(p, 4);
        if ((u32(p) & 1) === 0) {
          need(p, 8);
          src = p + 8 + v.getInt32(p + 4, true);
          p += 8;
        } else p += 32;
      } else p += 32;
      need(src, 32);
      for (let c = 0; c < 8; c++) verts[k * 8 + c] = f32(src + c * 4);
    }
    mesh.prims.push({ flags: w, list, cull, smooth, vertices: verts });
  }
  if (mesh && p !== meshEnd) throw new PolError(`model ${index}: mesh size mismatch at end (0x${p.toString(16)})`);
  return model;
}

export function parsePolFile(file: Uint8Array): PolModel[] {
  return polModelOffsets(file).map((o, i) => parsePolModel(file, o, i));
}
