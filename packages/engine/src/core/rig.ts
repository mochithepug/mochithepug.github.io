/**
 * Character rig: a skeleton playing motions the way game objects do it in Tod_e.exe (the object motion
 * state at obj +0x198). See re/notes/overview.md "Object motion system".
 *
 *   setup        FUN_004742a0 / FUN_004744f0   pose = frame 0 of the start motion; size by skeleton
 *   play         FUN_00475890                  hard switch to a motion from frame 0
 *   blendTo      FUN_00475900 / FUN_00475950   switch with a blend of N frames from the current pose
 *   step         FUN_00475100                  frame = counter % (F + 1); odd frames halfway between two
 *                                              stored frames; blends run (counter − start) / (N + 1)
 *   pose         FUN_00474880 / FUN_00474bb0   root: object translate·rotate·scale, root motion (x/z of the
 *                                              root moves the object), then the root's own angles
 *                FUN_00475420 / FUN_00475660   joints: translate(rest offset), angles; blends use
 *                                              blendAngles (FUN_00476550), half frames lerpAngle
 *   skins        FUN_00475030 → FUN_0048fd70   skin pieces after the joints: each group's vertices moved
 *                / FUN_0048ff30               by joint · reference⁻¹, model drawn at the reference joint
 * The object advances `counter` itself after posing, as each task function does (`*piVar1 += 1`).
 */
import {
  identity,
  invert,
  mul,
  rotateXLocal,
  rotateYLocal,
  rotateZLocal,
  scaleLocal,
  transformPoint,
  translateLocal,
  type CharacterType,
  type CharNode,
  type Mat4,
  type Motion,
  type SkinPiece,
  transformDir,
} from '@ttotd/formats';
import { blendAngles, lerpAngle } from './angles.ts';
import type { DrawItem, MotionLib, VertexPatch } from './object.ts';

const BLEND = 1;
const HALF = 0x20;

type Vec3 = [number, number, number];

const bits = new Float32Array(1), word = new Uint32Array(bits.buffer);
/** The exe ORs 1 into a float's bit pattern when it writes a skin vertex. */
function setBit0(v: number): number {
  bits[0] = v;
  word[0]! |= 1;
  return bits[0]!;
}

/** Size factor by skeleton (FUN_004742a0 → +0x116c). */
function skeletonScale(skel: number): number {
  if (skel === 0x1e) return Math.fround(0.6);
  if (skel === 0x1f) return Math.fround(0.7);
  if (skel >= 0x20 && skel <= 0x38) return Math.fround(0.9);
  return 1;
}

export interface Placement {
  /** Object position (obj +0x40); root motion moves it. */
  pos: Vec3;
  /** Object Sega angles x, y, z (obj +0x64, +0x68, +0x6c). */
  angles: Vec3;
}

export interface PosedJoint {
  node: CharNode;
  matrix: Mat4;
}

export class CharacterRig {
  readonly type: CharacterType;
  readonly skel: number;
  readonly lib: MotionLib;
  /** Motion state (obj +0x198 …). */
  counter = 0; // [0]
  frame = 0; // [2]
  prevIndex = 0; // [4]
  index = 0; // [6]
  motion: number; // [8]
  blendStart = 0; // [10]
  blendLen = 0; // byte +0x30 (blend + 1)
  flags = 0; // byte +0x37
  /** Frame ≥ F (+0x5d) / ≥ F − 1 (+0x5e) after the last step. */
  ended = false;
  nearEnd = false;
  /** Root motion on (+0x64 & 2): the root's x/z movement moves the object. */
  rootMotion = true;
  /** Order of the object rotation (+0x68): 5 = rotZ, rotY, rotX; 1 = rotX, rotZ, rotY. */
  order = 5;
  readonly scale: number;
  private rootCur: Vec3 = [0, 0, 0];
  private rootA: Vec3 = [0, 0, 0];
  private rootB: Vec3 = [0, 0, 0];
  private lastRoot: Vec3 = [0, 0, 0];
  readonly cur: Int32Array;
  private readonly A: Int32Array;
  private readonly B: Int32Array;
  private ready = false;
  /** Last pose, by joint. */
  joints: PosedJoint[] = [];
  /** Per-joint model override (node block +0, e.g. the daemon's mouth). */
  readonly modelOverride = new Map<number, number>();

  /** Skin pieces of this skeleton (@0055ac90). */
  readonly skins: SkinPiece[];

  constructor(type: CharacterType, skel: number, motion: number, lib: MotionLib, skins: SkinPiece[] = []) {
    this.skins = skins;
    this.type = type;
    this.skel = skel;
    this.motion = motion;
    this.lib = lib;
    this.scale = skeletonScale(skel);
    this.cur = new Int32Array(type.joints * 3);
    this.A = new Int32Array(type.joints * 3);
    this.B = new Int32Array(type.joints * 3);
  }

  private data(id = this.motion): Motion | undefined {
    return this.lib.get(id, this.type.joints);
  }
  private F(id = this.motion) {
    return this.lib.frames(id);
  }

  /** Copy stored frame i of motion `id` into root/joint slots. */
  private load(id: number, i: number, root: Vec3, ang: Int32Array): boolean {
    const m = this.data(id);
    if (!m) return false;
    const p = m.framePos(i);
    root[0] = p[0]; root[1] = p[1]; root[2] = p[2];
    for (let j = 0; j < this.type.joints; j++) ang.set(m.frameRot(i, j), j * 3);
    return true;
  }

  /** FUN_004744f0: the pose of frame 0 of the start motion. Retried until the motion is loaded. */
  private setup(): boolean {
    if (this.ready) return true;
    if (!this.load(this.motion, 0, this.rootCur, this.cur)) return false;
    this.lastRoot = [...this.rootCur];
    this.ready = true;
    return true;
  }

  /** FUN_00475890: switch to `id` from frame 0, no blend. */
  play(id: number) {
    this.motion = id;
    this.counter = this.prevIndex = this.index = this.frame = 0;
    this.flags = 0;
    if (this.rootMotion) {
      const m = this.data(id);
      if (m) this.lastRoot = [...m.framePos(0)];
    }
  }

  /** FUN_00475900: switch to `id` at `start`, blending from the current pose over `blend` (+1) frames. */
  blendTo(id: number, start: number, blend: number) {
    this.frame = start;
    this.index = Math.trunc(start / 2);
    this.blendStart = this.counter - 1;
    this.motion = id;
    this.blendLen = blend + 1;
    this.flags = (this.flags & ~HALF) | BLEND;
    // FUN_00475950: from = the current pose; to = the target frame
    if (start & 1 && start === this.F(id)) this.index++;
    this.rootA = [...this.rootCur];
    this.A.set(this.cur);
    if (!(start & 1) || start === this.F(id)) {
      this.load(id, this.index, this.rootB, this.B);
    } else {
      // odd start mid-motion (FUN_00475e80): halfway between stored frames (approximation)
      const r1: Vec3 = [0, 0, 0], a1 = new Int32Array(this.cur.length);
      if (this.load(id, this.index, this.rootB, this.B) && this.load(id, this.index + 1, r1, a1)) {
        for (let k = 0; k < 3; k++) this.rootB[k] = Math.fround((r1[k]! - this.rootB[k]!) * 0.5 + this.rootB[k]!);
        for (let k = 0; k < a1.length; k++) this.B[k] = lerpAngle(this.B[k]!, a1[k]!, 0.5);
      }
    }
  }

  /** FUN_00475100: work out what this frame shows. */
  private step() {
    this.ended = this.nearEnd = false;
    if (this.flags & BLEND) {
      const d = this.counter - this.blendStart, L = this.blendLen + 1;
      if (d <= L && d >= 0) {
        if (d === L) {
          this.counter = this.frame + 1;
          this.flags &= ~BLEND;
        }
      } else this.flags &= ~BLEND;
    }
    const F = this.F();
    if (!(this.flags & BLEND)) {
      const f = this.counter % (F + 1);
      this.frame = f;
      this.index = Math.trunc(f / 2);
      let half = false;
      if (f & 1) {
        if (f !== F) {
          let i0 = this.index, i1 = this.index + 1;
          if (i0 < 0) i0 = Math.trunc(F / 2);
          if (Math.trunc(F / 2) < i1) i1 = 0;
          this.load(this.motion, i0, this.rootA, this.A);
          this.load(this.motion, i1, this.rootB, this.B);
          this.flags |= HALF;
          this.blendStart = this.counter - 1;
          this.blendLen = 2;
          half = true;
        } else this.index++;
      }
      if (!half) {
        this.flags &= ~HALF;
        this.load(this.motion, this.index, this.rootCur, this.cur);
      }
    }
    if (F <= this.frame) this.ended = true;
    if (F - 1 <= this.frame) this.nearEnd = true;
  }

  /** Blend fraction (FUN_00474b30). */
  private t() {
    return Math.fround((this.counter - this.blendStart) / this.blendLen);
  }

  private jointAngles(j: number, t: number): [number, number, number] {
    const k = j * 3;
    if (!(this.flags & (BLEND | HALF))) return [this.cur[k]!, this.cur[k + 1]!, this.cur[k + 2]!];
    const a = [this.A[k]!, this.A[k + 1]!, this.A[k + 2]!], b = [this.B[k]!, this.B[k + 1]!, this.B[k + 2]!];
    if (!(this.flags & BLEND)) return [lerpAngle(a[0]!, b[0]!, t), lerpAngle(a[1]!, b[1]!, t), lerpAngle(a[2]!, b[2]!, t)];
    return blendAngles(a, b, t);
  }

  /** The root joint's world position after `pose` (the hips). */
  rootPosition(): [number, number, number] {
    const m = this.joints[0]?.matrix;
    if (!m) return [0, 0, 0];
    const p = transformPoint(m, [0, 0, 0]);
    return [p[0], p[1], p[2]];
  }

  /** One frame: step the motion, apply root motion to `obj`, pose every joint. Call before `counter++`. */
  pose(obj: Placement): PosedJoint[] {
    if (!this.setup()) return this.joints;
    this.step();
    const t = this.t();
    // FUN_00474880: root position and angles
    let root: Vec3;
    if (!(this.flags & (BLEND | HALF))) {
      root = [...this.rootCur];
    } else {
      root = [0, 1, 2].map((k) => Math.fround((this.rootB[k]! - this.rootA[k]!) * t + this.rootA[k]!)) as Vec3;
    }
    const rootAng = this.jointAngles(0, t);
    this.rootCur = root;
    this.cur.set(rootAng, 0);
    // FUN_00474bb0: root motion (the root's x/z travel moves the object)
    const F = this.F();
    if (Math.trunc(F / 4) < Math.abs(this.prevIndex - this.index)) {
      for (let k = 0; k < 3; k++) this.lastRoot[k] = Math.fround((root[k]! - this.lastRoot[k]!) / F + root[k]!);
    }
    if (this.flags & BLEND && !(this.flags & HALF)) this.lastRoot = [...root];
    const objRot = (m: Mat4) => {
      const [ax, ay, az] = obj.angles;
      if (this.order === 1) return rotateYLocal(rotateZLocal(rotateXLocal(m, ax), az), ay);
      return rotateXLocal(rotateYLocal(rotateZLocal(m, az), ay), ax);
    };
    if (this.rootMotion) {
      let m = translateLocal(identity(), ...obj.pos);
      m = scaleLocal(objRot(m), this.scale, this.scale, this.scale);
      const p = transformPoint(m, [root[0] - this.lastRoot[0], root[1] - this.lastRoot[1], root[2] - this.lastRoot[2]]);
      obj.pos[0] = p[0];
      obj.pos[2] = p[2];
      this.lastRoot = [...root];
    }
    this.prevIndex = this.index;
    let base = translateLocal(identity(), ...obj.pos);
    base = scaleLocal(objRot(base), this.scale, this.scale, this.scale);
    base = this.rootMotion ? translateLocal(base, 0, root[1], 0) : translateLocal(base, ...root);
    const rootM = rotateXLocal(rotateYLocal(rotateZLocal(base, rootAng[2]), rootAng[1]), rootAng[0]);
    // FUN_00475420 / FUN_00475660: the joints
    const out: PosedJoint[] = [{ node: this.type.root, matrix: rootM }];
    const walk = (n: CharNode, parent: Mat4) => {
      const ang = this.jointAngles(n.joint, t);
      this.cur.set(ang, n.joint * 3);
      let m = translateLocal(parent, n.offset[0], n.offset[1], n.offset[2]);
      m = rotateXLocal(rotateYLocal(rotateZLocal(m, ang[2]), ang[1]), ang[0]);
      out[n.joint] = { node: n, matrix: m };
      n.children.forEach((c) => walk(c, m));
    };
    this.type.root.children.forEach((c) => walk(c, rootM));
    this.joints = out;
    return out;
  }

  /** Nodes in joint order (root, then depth first — as `pose` lists them), for use before the first pose. */
  private nodeOrder?: CharNode[];

  /** Model of a joint's node, with any override (also before the first pose). */
  model(j: number): number {
    const o = this.modelOverride.get(j);
    if (o !== undefined) return o;
    if (this.joints[j]) return this.joints[j]!.node.model;
    if (!this.nodeOrder) {
      const out: CharNode[] = [this.type.root];
      const walk = (n: CharNode) => {
        out.push(n);
        n.children.forEach(walk);
      };
      this.type.root.children.forEach(walk);
      this.nodeOrder = out;
    }
    return this.nodeOrder[j]?.model ?? 0;
  }

  /** Default per-node draw (FUN_00474fb0): each non-root node's model at its matrix, then the skins. */
  draw(): DrawItem[] {
    const out: DrawItem[] = [];
    for (let j = 1; j < this.joints.length; j++) {
      const p = this.joints[j];
      const model = this.model(j);
      if (p && model > 0) out.push({ model, world: p.matrix });
    }
    out.push(...this.skinItems());
    return out;
  }

  /** Skin pieces drawn after the joints (see skinItems). */
  skinItems(): DrawItem[] {
    return skinItems(this.skins, (j) => this.joints[j]?.matrix);
  }
}

/**
 * Skin pieces (FUN_0048fd70 then FUN_0048ff30): for each applied group, L = joint · reference⁻¹; each slot
 * bound to an entry gets position·L and normal·L (x / normal z with bit 0 set, as the exe writes them);
 * the model is drawn at the reference joint.
 */
export function skinItems(skins: SkinPiece[], joint: (j: number) => Mat4 | undefined): DrawItem[] {
  const out: DrawItem[] = [];
  for (const piece of skins) {
    const ref = joint(piece.joints[4]);
    if (!ref) continue;
    const inv = invert(ref);
    const patch: VertexPatch[] = [];
    for (const g of piece.apply) {
      const group = piece.groups[g], J = joint(piece.joints[g]!);
      if (!group || !J) continue;
      const L = mul(J, inv);
      group.slotEntry.forEach((e, i) => {
        if (e < 0) return;
        const at = e * 6, v = group.entries;
        const pos = transformPoint(L, [v[at]!, v[at + 1]!, v[at + 2]!]);
        const nrm = transformDir(L, [v[at + 3]!, v[at + 4]!, v[at + 5]!]);
        pos[0] = setBit0(pos[0]);
        nrm[2] = setBit0(nrm[2]);
        patch.push({ offsets: piece.slots[i] ?? [], pos, nrm });
      });
    }
    out.push({ model: piece.model, world: ref, patch });
  }
  return out;
}
