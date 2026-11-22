/**
 * Animated props (doors, glass, boxes, bridges, water…): skeletons in the exe, motions in `mot/`.
 * See re/notes/overview.md "Props (M7d)".
 *
 * Exe tables:
 *   g_prop_skeletons   @004f7f0c  PropRoot*[30]   root: +6 i16 child count, +8 PropNode*[]
 *   g_prop_joint_counts@004f7f84  i16[30]  n (motion frames hold n − 1 joints)
 *   g_prop_interp_mode @004f7fc0  u8[30]   0 = one stored frame per tick, 1 = half rate, 2 = half rate
 *                                           with a matrix blend for big turns
 *   PropNode: +0 i32 global model id, +4 i16 joint (1-based; < 1 = no transform, not drawn),
 *             +6 i16 child count, +8 PropNode*[]
 * Motion (`prop_motion_pos` @00454900 / `prop_motion_rot` @00454930): u32 stored-frame count, then frames
 *   of S = (18n − 15) & ~3 = align4(18·(n − 1)) bytes: (n − 1) × f32 x,y,z, then (n − 1) × i16 rx,ry,rz.
 *   There are no rest offsets: every joint's position comes from the motion (relative to its parent).
 * Playback (`prop_skel_draw` @00454680, `prop_joint_transform` @00454290), object = {type, motion, f, prev}:
 *   f ≥ F − 1 → 0; f < 0 → F − 2 (F = g_motion_frames[motion], 60 Hz frames).
 *   mode 0: stored frame f.
 *   mode 1/2, f even: stored frame f/2.
 *   mode 1/2, f odd: a = f/2, b = a + 1 (or 0 when f = F − 1 and f > prev); position = (b − a)·0.5 + a;
 *     angles = a + trunc(wrap(b − a) / 2) (wrap to −0x7FFF..0x8000).
 *     mode 2 and f > 1 and all three |b − a| > 0x3000 (unwrapped): the exe blends the two rotation
 *     matrices instead (FUN_00476550) — approximated here by a quaternion slerp (open item).
 * Joint matrix: T(pos)·then rotZ, rotY, rotX — each premultiplying (the exe's matrix stack), × parent.
 * Model 0x110B flickers: uniform scale (rand() % 11)·0.01 + 0.27 each frame.
 */
import { identity, rotateXLocal, rotateYLocal, rotateZLocal, translateLocal, scaling, mul, type Mat4 } from './d3dmath.ts';
import type { PeImage } from './pe.ts';
import { modelRef, type ModelRef, type MotionInfo } from './character.ts';

const PROP_SKELETONS = 0x004f7f0c;
const PROP_JOINTS = 0x004f7f84;
const PROP_MODE = 0x004f7fc0;
export const PROP_TYPES = 30;
/** Model id drawn with a random flicker scale. */
export const FLICKER_MODEL = 0x110b;

export interface PropNode {
  model: number;
  ref?: ModelRef;
  /** 1-based joint index into the motion; < 1 = not transformed or drawn (children still are). */
  joint: number;
  children: PropNode[];
}

export interface PropType {
  index: number;
  /** n from the exe; motion frames hold n − 1 joints. */
  n: number;
  mode: number;
  roots: PropNode[];
  /** pol files used by the nodes (first one names the prop). */
  files: string[];
  name: string;
}

export function readPropTypes(pe: PeImage): PropType[] {
  const out: PropType[] = [];
  for (let t = 0; t < PROP_TYPES; t++) {
    const files = new Set<string>();
    const walk = (p: number, depth: number): PropNode => {
      if (depth > 64) throw new Error('prop skeleton too deep');
      const model = pe.i32(p);
      const ref = modelRef(pe, model);
      if (ref) files.add(ref.file);
      const kids = pe.i16(p + 6);
      return {
        model,
        ref,
        joint: pe.i16(p + 4),
        children: Array.from({ length: kids }, (_, k) => walk(pe.u32(p + 8 + k * 4), depth + 1)),
      };
    };
    const root = pe.u32(PROP_SKELETONS + t * 4);
    const roots = Array.from({ length: pe.i16(root + 6) }, (_, k) => walk(pe.u32(root + 8 + k * 4), 0));
    const f = [...files];
    out.push({
      index: t,
      n: pe.i16(PROP_JOINTS + t * 2),
      mode: pe.u8(PROP_MODE + t),
      roots,
      files: f,
      name: f[0]?.replace(/\.bin$/i, '') ?? `prop ${t}`,
    });
  }
  return out;
}

/**
 * Motion ids the game pairs with each prop type, collected from the object set-up code
 * (FUN_00456xxx–0045bxxx, FUN_0045cxxx: literal `type`/`motion` stores into object +0x32C/+0x330) and the
 * {i16 type, i16 motion, …} 12-byte records @005b5b10. Types not listed were not found yet; the viewer
 * falls back to motions whose size fits.
 */
export const GAME_PROP_MOTIONS: Readonly<Record<number, readonly number[]>> = {
  0: [512], 1: [511], 2: [510], 3: [510], 5: [514], 6: [512], 7: [508], 8: [503], 9: [504], 10: [496],
  11: [509], 12: [501], 13: [494], 14: [495], 15: [497], 17: [505], 19: [507], 20: [515], 22: [507],
  23: [514], 25: [511], 26: [508], 27: [508], 28: [493],
};

export const propStride = (n: number) => (n * 18 - 15) & ~3;

function motionBlock(file: Uint8Array, info: MotionInfo): { off: number; end: number } | undefined {
  const v = new DataView(file.buffer, file.byteOffset, file.byteLength);
  if (file.length < 8) return undefined;
  const first = v.getUint32(0, true);
  const offsets: number[] = [];
  for (let k = 0; k * 4 < first && k * 4 < file.length; k++) offsets.push(v.getUint32(k * 4, true));
  const off = offsets[info.index];
  if (off === undefined || off + 4 > file.length) return undefined;
  const end = [...offsets, file.length].filter((o) => o > off).reduce((a, b) => Math.min(a, b), file.length);
  return { off, end };
}

/** Does this motion's block have exactly the size of a prop motion with this n? */
export function propMotionFits(file: Uint8Array, info: MotionInfo, n: number): boolean {
  const b = motionBlock(file, info);
  if (!b) return false;
  const stored = new DataView(file.buffer, file.byteOffset, file.byteLength).getUint32(b.off, true);
  const size = 4 + stored * propStride(n);
  return size === b.end - b.off || ((size + 7) & ~7) === b.end - b.off;
}

export interface PropJointSample {
  pos: [number, number, number];
  rot: [number, number, number];
  /** Set when the exe would blend matrices (mode 2 big turn): the rotation to use instead of rot. */
  blend?: Mat4;
}

const wrap = (d: number) => {
  d &= 0xffff;
  return d > 0x8000 ? d - 0x10000 : d;
};

export class PropMotion {
  readonly info: MotionInfo;
  readonly type: PropType;
  readonly stored: number;
  private readonly v: DataView;
  private readonly base: number;

  constructor(file: Uint8Array, info: MotionInfo, type: PropType) {
    this.info = info;
    this.type = type;
    this.v = new DataView(file.buffer, file.byteOffset, file.byteLength);
    const b = motionBlock(file, info);
    if (!b) throw new Error(`motion ${info.id}: no block`);
    this.base = b.off;
    this.stored = this.v.getUint32(b.off, true);
  }

  /** Playable 60 Hz frames: f runs 0 … F − 2 before wrapping (prop_skel_draw). */
  get frames(): number {
    return Math.max(1, this.info.frames - 1);
  }

  /** Stored frames the exe reads exist? (mode 0 reads frame f directly.) */
  get readsPastEnd(): boolean {
    const need = this.type.mode === 0 ? this.info.frames - 2 : Math.floor((this.info.frames - 2) / 2) + 1;
    return need >= this.stored;
  }

  private posAt(i: number, j: number): [number, number, number] {
    const o = this.base + 4 + Math.min(i, this.stored - 1) * propStride(this.type.n) + j * 12;
    return [this.v.getFloat32(o, true), this.v.getFloat32(o + 4, true), this.v.getFloat32(o + 8, true)];
  }
  private rotAt(i: number, j: number): [number, number, number] {
    const n = this.type.n;
    const o = this.base + 4 + Math.min(i, this.stored - 1) * propStride(n) + (n - 1) * 12 + j * 6;
    return [this.v.getInt16(o, true), this.v.getInt16(o + 2, true), this.v.getInt16(o + 4, true)];
  }

  /** Normalise f as prop_skel_draw does. */
  wrapFrame(f: number): number {
    const F = this.info.frames;
    if (f >= F - 1) f = 0;
    if (f < 0) f = F - 2;
    return f;
  }

  /** Joint `j` (0-based) at 60 Hz frame f, previous frame `prev` (direction of play). */
  sample(f: number, j: number, prev = f - 1): PropJointSample {
    const mode = this.type.mode;
    if (mode === 0) return { pos: this.posAt(f, j), rot: this.rotAt(f, j) };
    const a = Math.trunc(f / 2);
    if ((f & 1) === 0) return { pos: this.posAt(a, j), rot: this.rotAt(a, j) };
    const F = this.info.frames;
    const b = f === F - 1 && f - prev > 0 ? 0 : a + 1;
    const pa = this.posAt(a, j), pb = this.posAt(b, j);
    const pos = [0, 1, 2].map((k) => Math.fround(Math.fround((pb[k]! - pa[k]!) * 0.5) + pa[k]!)) as [number, number, number];
    const ra = this.rotAt(a, j), rb = this.rotAt(b, j);
    if (mode === 2 && f > 1 && [0, 1, 2].every((k) => Math.abs(rb[k]! - ra[k]!) > 0x3000)) {
      return { pos, rot: ra, blend: slerpRotations(rotationMatrix(ra), rotationMatrix(rb), 0.5) };
    }
    const rot = [0, 1, 2].map((k) => Math.trunc(wrap(rb[k]! - ra[k]!) / 2) + ra[k]!) as [number, number, number];
    return { pos, rot };
  }
}

/** rotZ, rotY, rotX premultiplied onto identity — the rotation part of a joint. */
function rotationMatrix(r: [number, number, number]): Mat4 {
  return rotateXLocal(rotateYLocal(rotateZLocal(identity(), r[2]), r[1]), r[0]);
}

function toQuat(m: Mat4): [number, number, number, number] {
  // row-major D3D matrix (row vectors); rotation part m[r*4+c]
  const m00 = m[0]!, m01 = m[1]!, m02 = m[2]!, m10 = m[4]!, m11 = m[5]!, m12 = m[6]!, m20 = m[8]!, m21 = m[9]!, m22 = m[10]!;
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    return [(m12 - m21) / s, (m20 - m02) / s, (m01 - m10) / s, s / 4];
  }
  if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return [s / 4, (m01 + m10) / s, (m20 + m02) / s, (m12 - m21) / s];
  }
  if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m20 - m02) / s];
  }
  const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return [(m20 + m02) / s, (m12 + m21) / s, s / 4, (m01 - m10) / s];
}

function fromQuat([x, y, z, w]: number[]): Mat4 {
  return new Float32Array([
    1 - 2 * (y! * y! + z! * z!), 2 * (x! * y! + z! * w!), 2 * (x! * z! - y! * w!), 0,
    2 * (x! * y! - z! * w!), 1 - 2 * (x! * x! + z! * z!), 2 * (y! * z! + x! * w!), 0,
    2 * (x! * z! + y! * w!), 2 * (y! * z! - x! * w!), 1 - 2 * (x! * x! + y! * y!), 0,
    0, 0, 0, 1,
  ]);
}

function slerpRotations(a: Mat4, b: Mat4, t: number): Mat4 {
  const qa = toQuat(a);
  let qb = toQuat(b);
  let dot = qa.reduce((s, v, k) => s + v * qb[k]!, 0);
  if (dot < 0) {
    qb = qb.map((v) => -v) as typeof qb;
    dot = -dot;
  }
  let wa = 1 - t, wb = t;
  if (dot < 0.9995) {
    const th = Math.acos(dot), s = Math.sin(th);
    wa = Math.sin((1 - t) * th) / s;
    wb = Math.sin(t * th) / s;
  }
  const q = qa.map((v, k) => v * wa + qb[k]! * wb);
  const len = Math.hypot(...q);
  return fromQuat(q.map((v) => v / len));
}

export interface PosedPropNode {
  node: PropNode;
  matrix: Mat4;
}

/**
 * World matrices of every drawn node at frame f (already wrapped), with the prop object at `world`.
 * `rand` supplies rand() for the flicker model (defaults to Math.random-based).
 */
export function poseProp(
  motion: PropMotion,
  f: number,
  world: Mat4 = identity(),
  prev = f - 1,
  rand: () => number = () => Math.floor(Math.random() * 0x8000),
): PosedPropNode[] {
  const out: PosedPropNode[] = [];
  const walk = (n: PropNode, parent: Mat4) => {
    let m = parent;
    if (n.joint >= 1) {
      const s = motion.sample(f, n.joint - 1, prev);
      m = translateLocal(m, s.pos[0], s.pos[1], s.pos[2]);
      if (s.blend) m = mul(s.blend, m);
      else m = rotateXLocal(rotateYLocal(rotateZLocal(m, s.rot[2]), s.rot[1]), s.rot[0]);
      let draw = m;
      if (n.model === FLICKER_MODEL) {
        const k = Math.fround((rand() % 11) * Math.fround(0.01) + Math.fround(0.27));
        draw = mul(scaling(k, k, k), m);
        m = draw;
      }
      out.push({ node: n, matrix: draw });
    }
    n.children.forEach((c) => walk(c, m));
  };
  motion.type.roots.forEach((r) => walk(r, world));
  return out;
}
