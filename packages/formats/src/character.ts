/**
 * Characters: skeletons (in the exe), motions (`mot/*.bin`), posing — as Tod_e.exe does it.
 * See re/notes/overview.md "Characters & motions (M5)".
 *
 * Exe tables:
 *   character skeleton roots  @00503170  CharNode*[type]   (86 types)
 *   joint count n             @00503464  i16[type]
 *   CharNode: +0 i32 global model id, +4 f32 x,y,z rest offset, +0x10 ?, +0x14 i16 joint,
 *             +0x16 i16 child count, +0x18 CharNode*[]
 *   global model id → pol file index  @0050e198 u16[id];  file names @004f2bd0 char*[file];
 *     model index in file = position of id in the file's id list @0050d4b8 i16*[file] (count @0050dd4c)
 *   motion files: names @004f39f4 char*[slot], motion-id lists @00505a10 i16*[slot], counts @00505ad8
 *     (the k-th u32 at the start of the file is the offset of the k-th listed motion)
 *   frame count F (60 Hz frames) @00503510 i16[motionId]
 * Motion: u32 stored frame count (= floor((F-1)/2) + 2), then frames of align4(12 + 6n) bytes:
 *   f32 x, y, z root position, then i16 rx, ry, rz per joint (joint 0 = root).
 * Playback at 60 Hz frame f (FUN_00472e10 root, FUN_00472b90 joints):
 *   root position: f even → frame[f/2]; f odd → halfway between frame[f/2] and frame[f/2 + 1]
 *   root rotation: frame[f/2]
 *   joint rotation: f == 0 or odd → frame[f/2]; even → halfway (shortest way round) from the angle
 *                   shown at f−1 (= frame[f/2 − 1]) to frame[f/2], integer-halved as the exe does.
 * Pose: root M = Rx·Ry·Rz · T(rootPos) · object; joint M = Rx·Ry·Rz · T(restOffset) · M(parent)
 * (each "local" op premultiplies, exactly like the exe's matrix stack).
 */
import { identity, rotateXLocal, rotateYLocal, rotateZLocal, translateLocal, type Mat4 } from './d3dmath.ts';
import type { PeImage } from './pe.ts';

const CHAR_ROOTS = 0x00503170;
const CHAR_JOINTS = 0x00503464;
const CHAR_TYPES = 86;
const MODEL_FILE = 0x0050e198;
const POL_NAMES = 0x004f2bd0;
const POL_ID_LISTS = 0x0050d4b8;
const POL_ID_COUNTS = 0x0050dd4c;
const MOT_NAMES = 0x004f39f4;
const MOT_ID_LISTS = 0x00505a10;
const MOT_ID_COUNTS = 0x00505ad8;
const MOT_FRAMES = 0x00503510;

export interface ModelRef {
  /** pol file name, e.g. `player1.bin` (its texture set has the same name). */
  file: string;
  /** Model index inside that file. */
  index: number;
}

export interface CharNode {
  model: number;
  ref?: ModelRef;
  offset: [number, number, number];
  joint: number;
  children: CharNode[];
}

export interface CharacterType {
  index: number;
  joints: number;
  root: CharNode;
  /** Name for display: the pol file of the first drawable node. */
  name: string;
}

export function modelRef(pe: PeImage, id: number): ModelRef | undefined {
  if (id <= 0) return undefined;
  try {
    const fi = pe.u16(MODEL_FILE + id * 2);
    const file = pe.cstr(pe.u32(POL_NAMES + fi * 4));
    const list = pe.u32(POL_ID_LISTS + fi * 4);
    const count = pe.u16(POL_ID_COUNTS + fi * 2);
    for (let k = 0; k < count; k++) if (pe.i16(list + k * 2) === id) return { file, index: k };
  } catch {
    /* id outside the tables */
  }
  return undefined;
}

export function readCharacterTypes(pe: PeImage): CharacterType[] {
  const types: CharacterType[] = [];
  for (let t = 0; t < CHAR_TYPES; t++) {
    const walk = (p: number, depth: number): CharNode => {
      if (depth > 64) throw new Error('skeleton too deep');
      const model = pe.i32(p);
      const kids = pe.i16(p + 0x16);
      return {
        model,
        ref: modelRef(pe, model),
        offset: [pe.f32(p + 4), pe.f32(p + 8), pe.f32(p + 12)],
        joint: pe.i16(p + 0x14),
        children: Array.from({ length: kids }, (_, k) => walk(pe.u32(p + 0x18 + k * 4), depth + 1)),
      };
    };
    const root = walk(pe.u32(CHAR_ROOTS + t * 4), 0);
    let name = '';
    const find = (n: CharNode) => {
      if (!name && n.ref) name = n.ref.file.replace(/\.bin$/i, '');
      n.children.forEach(find);
    };
    find(root);
    types.push({ index: t, joints: pe.i16(CHAR_JOINTS + t * 2), root, name: name || `type ${t}` });
  }
  return types;
}

export interface MotionInfo {
  id: number;
  /** mot file name, e.g. `player1.bin`. */
  file: string;
  /** Index in the file's offset table. */
  index: number;
  /** Frames at 60 Hz. */
  frames: number;
}

export function readMotionTable(pe: PeImage): MotionInfo[] {
  const out: MotionInfo[] = [];
  for (let s = 0; s < 64; s++) {
    let file: string;
    try {
      file = pe.cstr(pe.u32(MOT_NAMES + s * 4));
    } catch {
      continue;
    }
    if (!/\.bin$/i.test(file) || file.startsWith('cp_')) continue;
    const list = pe.u32(MOT_ID_LISTS + s * 4);
    const count = pe.u16(MOT_ID_COUNTS + s * 2);
    for (let k = 0; k < count; k++) {
      const id = pe.i16(list + k * 2);
      out.push({ id, file, index: k, frames: pe.i16(MOT_FRAMES + id * 2) });
    }
  }
  return out;
}

export const motionStride = (joints: number) => (12 + 6 * joints + 3) & ~3;
export const storedFrames = (frames: number) => Math.floor((frames - 1) / 2) + 2;

/**
 * Does motion `info` in this mot file have exactly `joints` joints? Its block (up to the next offset
 * in the file, padded to 8 bytes) must equal 4 + stored × align4(12 + 6·joints).
 */
export function motionFits(file: Uint8Array, info: MotionInfo, joints: number): boolean {
  const v = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const first = v.getUint32(0, true);
  const offsets: number[] = [];
  for (let k = 0; k * 4 < first; k++) offsets.push(v.getUint32(k * 4, true));
  const off = offsets[info.index];
  if (off === undefined || off + 4 > file.length) return false;
  const end = [...offsets, file.length].filter((o) => o > off).reduce((a, b) => Math.min(a, b), file.length);
  const size = 4 + v.getUint32(off, true) * motionStride(joints);
  return size === end - off || ((size + 7) & ~7) === end - off;
}

export class Motion {
  readonly info: MotionInfo;
  readonly joints: number;
  readonly stored: number;
  private readonly v: DataView;
  private readonly base: number;

  constructor(file: Uint8Array, info: MotionInfo, joints: number) {
    this.info = info;
    this.joints = joints;
    this.v = new DataView(file.buffer, file.byteOffset, file.byteLength);
    this.base = this.v.getUint32(info.index * 4, true);
    this.stored = this.v.getUint32(this.base, true);
    const need = this.base + 4 + this.stored * motionStride(joints);
    if (need > file.length) throw new Error(`motion ${info.id}: ${this.stored} frames × ${joints} joints exceed file`);
  }

  private frame(i: number) {
    return this.base + 4 + Math.min(i, this.stored - 1) * motionStride(this.joints);
  }
  /** Root position of stored frame i (clamped to the last stored frame). */
  framePos(i: number): [number, number, number] {
    return this.pos(i);
  }
  /** Angles of joint j in stored frame i. */
  frameRot(i: number, j: number): [number, number, number] {
    return this.rot(i, j);
  }
  private pos(i: number): [number, number, number] {
    const o = this.frame(i);
    return [this.v.getFloat32(o, true), this.v.getFloat32(o + 4, true), this.v.getFloat32(o + 8, true)];
  }
  private rot(i: number, j: number): [number, number, number] {
    const o = this.frame(i) + 12 + j * 6;
    return [this.v.getInt16(o, true), this.v.getInt16(o + 2, true), this.v.getInt16(o + 4, true)];
  }

  /** Root position and per-joint angles shown at 60 Hz frame f (sequential playback). */
  sample(f: number): { pos: [number, number, number]; rot: Int32Array } {
    const i = f >> 1;
    let pos = this.pos(i);
    if (f & 1) {
      const b = this.pos(i + 1);
      pos = [0, 1, 2].map((k) => Math.fround(Math.fround((b[k]! - pos[k]!) * 0.5) + pos[k]!)) as [number, number, number];
    }
    const rot = new Int32Array(this.joints * 3);
    for (let j = 0; j < this.joints; j++) {
      const cur = this.rot(i, j);
      if (j === 0 || f === 0 || f & 1) {
        rot.set(cur, j * 3);
        continue;
      }
      const prev = this.rot(i - 1, j);
      for (let a = 0; a < 3; a++) {
        let d = (cur[a]! - prev[a]!) & 0xffff;
        if (d > 0x8000) d -= 0x10000;
        rot[j * 3 + a] = Math.trunc(d / 2) + prev[a]!;
      }
    }
    return { pos, rot };
  }
}

export interface PosedNode {
  node: CharNode;
  matrix: Mat4;
}

/** World matrices of every node for a sample, with the object at `world`. */
export function poseCharacter(type: CharacterType, s: { pos: number[]; rot: Int32Array }, world: Mat4 = identity()): PosedNode[] {
  const out: PosedNode[] = [];
  const rotate = (m: Mat4, j: number) => {
    // exe order: rotZ, then rotY, then rotX — each premultiplying
    m = rotateZLocal(m, s.rot[j * 3 + 2] ?? 0);
    m = rotateYLocal(m, s.rot[j * 3 + 1] ?? 0);
    return rotateXLocal(m, s.rot[j * 3] ?? 0);
  };
  const root = rotate(translateLocal(world, s.pos[0]!, s.pos[1]!, s.pos[2]!), 0);
  out.push({ node: type.root, matrix: root });
  const walk = (n: CharNode, parent: Mat4) => {
    const m = rotate(translateLocal(parent, n.offset[0], n.offset[1], n.offset[2]), n.joint);
    out.push({ node: n, matrix: m });
    n.children.forEach((c) => walk(c, m));
  };
  type.root.children.forEach((c) => walk(c, root));
  return out;
}
