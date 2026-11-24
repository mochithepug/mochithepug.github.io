/**
 * What every ported game object looks like to the game loop. In the exe each object is a block of memory
 * plus a task function called once per frame that updates and draws it; here `update` does the work and
 * `draw` hands back what to render (global model id + world matrix).
 */
import type { AimEntry } from './fightcam.ts';
import type { PlayerStatus } from './player.ts';
import type { WordDeck } from './words.ts';
import type { PeImage, AttackTable, CharacterType, Mat4, Motion, ObjectPathSample, SkinPiece, SpawnRecord } from '@ttotd/formats';

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
  /** Material colour for every mesh (FUN_00489140). */
  color?: [number, number, number];
  /** 2D-like overlay (word boxes): drawn after the scene. */
  overlay?: boolean;
}

/** Motions by global id: frame counts from the exe table, data once loaded. */
/** A zombie in the queue: its distance key and where its places go (+0x1321 all, +0x1322 not backing off). */
export interface QueueEntry {
  key: number;
  backingOff: boolean;
  setPlaces(all: number, ready: number): void;
}

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
  /** The player's position (DAT_00a396a0 ← DAT_00a149e0): the game camera's eye. */
  eye: [number, number, number];
  /** Approach bands (DAT_00a11880): per row near / mid / far distance from the player. */
  bands: number[][];
  /** Motion set of a skeleton's kind (@005a2330): [0] idle, [2] walk, [3] fast walk, [4] back off. */
  motionSet(skeleton: number, kind: number): number[] | undefined;
  /** crt_rand. */
  rand(): number;
  /** Attack table of a skeleton's set (@005a2434 / @005a258c). */
  attackTable(skeleton: number, set: number): AttackTable | undefined;
  /** Attack slot per player (DAT_00a11840): 1 while an enemy is attacking that player — one attacker each. */
  attackSlots: number[];
  /** FUN_004846d0: an attack reaches player `player` (hit = 1, or 0 when the attacker is flagged 0x2000000). */
  hitPlayer(player: number, hit: number, damage: number): void;
  /** Game camera view (the exe's view space: z negative ahead), world → view. */
  view: Mat4;
  /** Projection scale DAT_00a11a10 = 240 / tan(fov / 2). */
  projScale: number;
  /** Camera mode DAT_00a39448 = 2: a fight. */
  inFight: boolean;
  /** Word state (DAT_00839cc0 …). */
  words?: WordDeck;
  /** Frame a word was last picked (DAT_00839d24). */
  wordPickedFrame: number;
  /** Key typed this frame by player 1 (DAT_00818015, upper-cased as the English matcher does), if any. */
  key?: string;
  /** Each player's target: the owner id (+0x3c) of the word being typed, −1 none (DAT_0083911c). */
  targets: number[];
  /** Player camera yaw (DAT_00a149f0), Sega units. */
  camYaw: number;
  /** Live enemies (DAT_00a39546): +1 at set-up, −1 when the death motion ends. */
  enemies: number;
  /** Enemies not yet dying (DAT_00a3ba4a): +1 at set-up, −1 when the death starts (FUN_00445660). */
  attackers: number;
  /** Enemies that registered this frame (FUN_004205d0 → the table DAT_00a147e0): those without flag 0x10000. */
  active: number;
  /** This frame's registrations with their aim points (FUN_004205d0, for the fight camera — core/fightcam.ts). */
  aims?: AimEntry[];
  /** DAT_005ea728: frames before any zombie may start an attack (core/player.ts restartAttackTimer). */
  attackTimer?: number;
  /** Zombies allowed per distance band (event op 0x0F, DAT_00a3b7f0..). */
  attackCounts?: number[];
  /** This frame's zombie queue (FUN_00420720): ranked nearest first at the start of the next frame (FUN_004207c0). */
  queue?: QueueEntry[];
  /** Civilians still in play (DAT_00a3e7a8): +1 at set-up, −1 once at a 0x80000 segment or when removed. */
  civilians?: number;
  /** Player states (lives, grace — core/player.ts); index = player. */
  players?: PlayerStatus[];
  /** A civilian's line (op 0x1D → FUN_004239a0): the owner shows the dialogue. */
  say?(id: number): void;
  /** A civilian's route choice (op 0x19 → DAT_00a3b264): which block follows a branching one. */
  route?(n: number): void;
  /** The exe, for objects that read their scripts from it (civilians). */
  pe?: PeImage;
  /** spawn_record for objects that create others (a civilian's attackers): created, listed, given a word box. */
  spawn?(rec: SpawnRecord, parent?: GameObject): GameObject | undefined;
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
