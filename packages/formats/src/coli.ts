/**
 * Stage collision meshes (`coli/`, re/notes/overview.md "Floors and collision").
 *
 * `load_coli(0)` and `load_coli(stage + 1)` read two files into the Dreamcast-address buffer: index 0 at DC 0x0CECD800,
 * the others at DC 0x0CECF000 (PC = DC − 0x0C4CF400). Event op 0x10 lists DC pointers into them, each a mesh:
 *   i32 group count; per group: i32 face count, f32 max x y z, f32 min x y z, then faces of 18 words:
 *   plane a b c d, projection axis (i32 0: y–z, 1: x–z, 2: x–y), four corners x y z, material (i32, 0 = none).
 * `FUN_004c3620` tests a segment against one mesh: groups whose box overlaps the segment's; faces the segment crosses
 * from the back (plane ≤ 0) to the front (> 0); the crossing point inside the quad (edge cross products in the
 * projection plane, signed by the plane's matching component); the hit nearest the segment's end wins.
 */
import type { PeImage } from './pe.ts';

type Vec3 = [number, number, number];

/** `load_coli`'s file names (@004f3ba4): 0 coli0.bin (always), stage + 1 the stage's (Stage 1: coli1.bin). */
export function coliFileName(pe: PeImage, index: number): string {
  const p = pe.u32(0x004f3ba4 + index * 4);
  let s = '';
  for (let k = 0; k < 32; k++) {
    const c = pe.u8(p + k);
    if (!c) break;
    s += String.fromCharCode(c);
  }
  return s;
}

export interface CollisionFace {
  plane: [number, number, number, number];
  axis: number;
  quad: [Vec3, Vec3, Vec3, Vec3];
  material: number;
}

export interface CollisionGroup {
  max: Vec3;
  min: Vec3;
  faces: CollisionFace[];
}

export type CollisionMesh = CollisionGroup[];

/** Where `load_coli` puts index 0 and the stage's file, as Dreamcast addresses. */
export const COLI_COMMON_BASE = 0x0cecd800;
export const COLI_STAGE_BASE = 0x0cecf000;

export interface CollisionHit {
  point: Vec3;
  material: number;
  /** Squared distance from the segment's end. */
  dist2: number;
}

export class CollisionFiles {
  private readonly files: { base: number; data: DataView }[] = [];
  private readonly meshes = new Map<number, CollisionMesh | null>();

  /** `common` = coli0.bin, `stage` = the stage's coli file (Stage 1: coli1.bin). */
  constructor(common?: Uint8Array, stage?: Uint8Array) {
    if (stage) this.files.push({ base: COLI_STAGE_BASE, data: new DataView(stage.buffer, stage.byteOffset, stage.byteLength) });
    if (common) this.files.push({ base: COLI_COMMON_BASE, data: new DataView(common.buffer, common.byteOffset, common.byteLength) });
  }

  /** The mesh a DC pointer (event op 0x10) refers to. */
  mesh(ptr: number): CollisionMesh | undefined {
    if (this.meshes.has(ptr)) return this.meshes.get(ptr) ?? undefined;
    let mesh: CollisionMesh | null = null;
    for (const f of this.files) {
      const o = (ptr >>> 0) - f.base;
      if (o < 0 || o + 4 > f.data.byteLength) continue;
      mesh = readMesh(f.data, o);
      break;
    }
    this.meshes.set(ptr, mesh);
    return mesh ?? undefined;
  }
}

function readMesh(v: DataView, o: number): CollisionMesh | null {
  const i32 = (p: number) => v.getInt32(p, true), f = (p: number) => v.getFloat32(p, true);
  const groups = i32(o);
  if (groups < 0 || groups > 4096) return null;
  const out: CollisionMesh = [];
  let p = o + 4;
  for (let g = 0; g < groups; g++) {
    if (p + 28 > v.byteLength) return null;
    const n = i32(p);
    const group: CollisionGroup = { max: [f(p + 4), f(p + 8), f(p + 12)], min: [f(p + 16), f(p + 20), f(p + 24)], faces: [] };
    p += 28;
    for (let k = 0; k < n; k++, p += 72) {
      if (p + 72 > v.byteLength) return null;
      const c = (i: number): Vec3 => [f(p + 20 + i * 12), f(p + 24 + i * 12), f(p + 28 + i * 12)];
      group.faces.push({ plane: [f(p), f(p + 4), f(p + 8), f(p + 12)], axis: i32(p + 16), quad: [c(0), c(1), c(2), c(3)], material: i32(p + 68) });
    }
    out.push(group);
  }
  return out;
}

const f32 = Math.fround;

/** FUN_004c3620 for one mesh; `best` (the nearest so far) is kept or replaced. */
export function segmentHit(mesh: CollisionMesh, a: Vec3, b: Vec3, best?: CollisionHit): CollisionHit | undefined {
  const lo: Vec3 = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])];
  const hi: Vec3 = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])];
  for (const g of mesh) {
    if (lo[0] > g.max[0] || lo[1] > g.max[1] || lo[2] > g.max[2] || g.min[0] > hi[0] || g.min[1] > hi[1] || g.min[2] > hi[2]) continue;
    for (const face of g.faces) {
      const [pa, pb, pc, pd] = face.plane;
      const da = f32(pc * a[2] + pb * a[1] + pa * a[0] + pd);
      if (da > 0) continue; // only from the back (the two-sided flag DAT_00a3f33c is not set here)
      const db = f32(pc * b[2] + pb * b[1] + pa * b[0] + pd);
      if (!(db > 0)) continue;
      const wa = -da, k = 1 / (db + wa);
      const hx = f32((wa * b[0] + db * a[0]) * k), hy = f32((wa * b[1] + db * a[1]) * k), hz = f32((wa * b[2] + db * a[2]) * k);
      if (!inside(face, hx, hy, hz)) continue;
      const dist2 = (b[2] - hz) ** 2 + (b[1] - hy) ** 2 + (b[0] - hx) ** 2;
      if (!best || best.material === 0 || dist2 < best.dist2) best = { point: [hx, hy, hz], material: face.material, dist2 };
    }
  }
  return best;
}

/**
 * The quad's inside test in its projection plane (FUN_004c3620's three cases): for every edge i → i+1,
 *   axis 0 (y–z): ((z1 − z0)(y0 − hy) − (z0 − hz)(y1 − y0)) · a ≥ 0
 *   axis 1 (x–z): ((x1 − x0)(z0 − hz) − (z1 − z0)(x0 − hx)) · b ≥ 0
 *   axis 2 (x–y): ((y1 − y0)(x0 − hx) − (x1 − x0)(y0 − hy)) · c ≥ 0
 * any other axis value: inside.
 */
function inside(face: CollisionFace, hx: number, hy: number, hz: number): boolean {
  const q = face.quad, [pa, pb, pc] = face.plane;
  for (let i = 0; i < 4; i++) {
    const [x0, y0, z0] = q[i]!, [x1, y1, z1] = q[(i + 1) % 4]!;
    let e: number;
    if (face.axis === 0) e = ((z1 - z0) * (y0 - hy) - (z0 - hz) * (y1 - y0)) * pa;
    else if (face.axis === 1) e = ((x1 - x0) * (z0 - hz) - (z1 - z0) * (x0 - hx)) * pb;
    else if (face.axis === 2) e = ((y1 - y0) * (x0 - hx) - (x1 - x0) * (y0 - hy)) * pc;
    else return true;
    if (e < 0) return false;
  }
  return true;
}
