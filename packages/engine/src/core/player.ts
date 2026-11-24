/**
 * Player state for damage and the word rank (re/notes/overview.md "Lives and rank").
 *
 * Lives are DAT_00a143c6 + p·0x208, set at the start from the options' life setting (@004f2ba0[DAT_00a3c1e1]:
 * 1 2 3 4 5, default setting 2 → 3 lives). An attack that reaches a player (`FUN_004846d0`, from the zombie's hit
 * FUN_00445590) is ignored during that player's grace time (DAT_00a3b7c8[p]); otherwise: one life less, the rank
 * pending change DAT_00a11d14 −= 2, score −100 (FUN_00484b00 — score not ported), grace 0x5A frames; outside a
 * fight a player keeps at least one life. Every frame (`FUN_00451f20`): the rank update (WordDeck.tick,
 * FUN_00451ff0), then the grace timers count down.
 * Not ported: game over / continue at 0 lives, the hit screen effect (DAT_00a14430), the hit statistics, the
 * extra conditions (FUN_00484850 in mode 6, DAT_00a3b858 = 5, the no-damage flag DAT_00a3c22d).
 */
import type { PeImage } from '@ttotd/formats';
import type { World } from './object.ts';

export interface PlayerStatus {
  /** DAT_00a143c6 + p·0x208. */
  lives: number;
  /** DAT_00a3b7c8[p]: frames left in which hits are ignored. */
  grace: number;
  /** Hits taken (for tests and the debug line). */
  hits: number;
}

/** Starting lives (@004f2ba0[life setting]; the default setting is 2). */
export function startLives(pe?: PeImage, setting = 2): number {
  return pe ? (pe.u16(0x004f2ba0 + setting * 2) << 16) >> 16 : 3;
}

/**
 * The attack timer DAT_005ea728 (FUN_004b1410): while it is above 0 no zombie may start an attack (FUN_00444e90 →
 * FUN_004b14c0). Restarted (case 2) to @005ea674[life/word setting 2][rank] frames — 390 390 360 330 300 270 …
 * 150 for ranks 0–15 — when a word box gets its word (FUN_004b1ef0), when a word is completed (FUN_004b32f0) and
 * when a hit counts (FUN_004846d0); counted down 1 a frame (case 1, from the main update FUN_00472030).
 */
export function restartAttackTimer(w: World) {
  const pe = w.pe;
  const rank = w.words?.effectiveRank ?? 0;
  w.attackTimer = pe ? pe.i32(pe.u32(0x005ea674 + 2 * 4) + rank * 4) : 390;
}

/** FUN_004846d0: an attack reaches player `p`. Returns whether it counted. */
export function hurtPlayer(w: World, p: number): boolean {
  const s = w.players?.[p];
  if (!s || s.grace > 0) return false;
  s.lives--;
  s.hits++;
  w.words?.adjustRank(-2);
  s.grace = 0x5a;
  restartAttackTimer(w);
  if (!w.inFight && s.lives < 1) s.lives = 1;
  return true;
}

/** FUN_00451f20, once a frame: the rank update (+2 every 0x708 frames instead of +1 with ≥ 4 lives), grace timers. */
export function tickPlayers(w: World) {
  w.words?.tick(w.players?.[0]?.lives ?? 0);
  w.attackTimer = Math.max(0, (w.attackTimer ?? 0) - 1); // FUN_004b1410(1)
  for (const s of w.players ?? []) s.grace = Math.max(0, s.grace - 1);
}
