/**
 * What every ported game object looks like to the game loop. In the exe each object is a block of memory
 * plus a task function called once per frame that updates and draws it; here `update` does the work and
 * `draw` hands back what to render (global model id + world matrix).
 */
import type { CharacterType, Mat4, Motion, ObjectPathSample, SkinPiece, SpawnRecord } from '@ttotd/formats';

/** New position and normal for some vertex records of a skin model (FUN_00490870 / FUN_004908c0). */
export interface VertexPatch {
  /** Byte offsets of the vertex records from the model start. */
  offsets: number[];
  pos: [number, number, number];
  nrm: [number, number, number];
}

export interface DrawItem {
  /** Global model id. */
  model: number;
  world: Mat4;
  /** Skin models: vertices moved this frame. */
  patch?: VertexPatch[];
}

/** Motions by global id: frame counts from the exe table, data once loaded. */
export interface MotionLib {
  /** Length in 60 Hz frames (@00503510). */
  frames(id: number): number;
  /** Motion data for a skeleton with `joints` joints, or undefined while loading / missing. */
  get(id: number, joints: number): Motion | undefined;
}

/** Shared game state the objects read (exe globals). */
export interface World {
  /** Current camera path, global id (DAT_00a11a18); −1 for none. */
  camPath: number;
  /** Camera time (DAT_00a14a30). */
  camTime: number;
  /** Global frame counter (g_rng_counter). */
  frame: number;
  /** Enter pressed this frame (input bits 0x80008). */
  enter: boolean;
  /** DAT_00a14048 bit 0x20: set while the chapter title card is up (written by the title card). */
  titleUp: boolean;
  /** Flag bytes DAT_00a396c0[N] (248 = DAT_00a397b8, title card over). */
  flags: Uint8Array;
  /** Object path by global id at time t (FUN_0040e9a0). */
  path(id: number, t: number): ObjectPathSample | undefined;
  /** Path length by global id (@00598508). */
  pathLength(id: number): number;
  skeletons: CharacterType[];
  /** Skin pieces by skeleton (readSkins). */
  skins: SkinPiece[][];
  motions: MotionLib;
}

export interface GameObject {
  /** One frame of the object's task. */
  update(w: World): void;
  /** What to draw this frame. */
  draw(w: World): DrawItem[];
  /** Set when the task ends (FUN_004bec90). */
  dead?: boolean;
}

/** Builds an object from its spawn record (the exe's task table entry for the record's type). */
export type ObjectFactory = (spawn: SpawnRecord, w: World) => GameObject;
