# Stage 1 — what is not ported yet (audit 2026-11-24)

How this list was made: every script of all 15 blocks of `evt/st1evtbl.bin`, every spawn record they create
(civilian attackers included) and every civilian script reachable from the civilians in it, compared with what the
port's code handles (`evtplayer.ts` op cases, `registry.ts` types, zombie behaviour dispatch, civilian `exec`
cases, segment-flag checks). Re-run: `TTOTD_DIR=<game folder> npx tsx tools/audit-stage1.ts`.

Block route (block rules): 0 → 1 → 9 (woman saved) or 10 (woman died); 10 → 3; 9 → 2 / 7 / 12; 2 → 3 → 4;
4 → 6 or 13; 6 → 11 or 5; 7 → 8 → 4; 5, 11 → 14 (boss).

Status: **G** = changes gameplay (a scene plays wrongly or cannot finish), **P** = presentation only
(sound, effects, display), **?** = not identified yet.

## 1. Objects that need typing (have a word box)

| Item | Where | Status | Notes |
|---|---|---|---|
| Zombie behaviour 33 — thrower (`FUN_00448310`) + thrown items (task `FUN_00449d20`, own word box) | blocks 3, 4, 8 | G | zombie stands still; items never thrown |
| Zombie behaviours 37 → 38 (`FUN_0044aaf0`, `FUN_0044af70`) | block 6 (civilian attacker) | G | civilian scene in block 6 |
| ~~Zombie behaviour 39 (`FUN_0044b280`)~~ | blocks 6, 9 | done 2026-11-24 | hidden until the civilian's op 0x1A releases it |
| ~~Zombie behaviour 0x2D (`FUN_0044bf80`)~~ | after 34 / 35 | done 2026-11-24 | short pause after the victim dies, then the next behaviour |
| Type 0x11 — frog (`FUN_004279f0`), single-letter words | block 3 (×3) | G | not spawned |
| Type 0x31 — enemy, hp 100, word flags 4 | block 4 (×2) | G ? | not identified |
| Type 0x22 kind 1 — the boss (daemon) | block 14 | G | only kind 0 (opening fly-by) is ported |

## 2. Event script commands (only logged by our player)

| Op | Uses (blocks) | Status | What it is (if known) |
|---|---|---|---|
| 0x0F attack_counts | 7 (0,1,2,4,10) | G | how many zombies may attack (DAT_00a3b7f0..); we allow one at a time |
| 0x0D spawn variant | 1 (block 1) | ? | spawns a type 0x25 object (scenery) |
| 0x10 | 15 (1,2,3,4,6,8,9,14) | ? | pointer to a run-time address |
| 0x1A | 14 | ? | pointer to a small parameter block (1.0, 152.0, 0x26 …) |
| 0x14, 0x15 | 1 each (block 0) | ? | |
| 0x19, 0x24, 0x27 | 4 / 3 / 3 (1, 14) | P | second light set (@00a14140) |
| 0x1D, 0x1E, 0x1F | 6 / 5 / 22 | P ? | display globals (DAT_00a3b804, a3b438, a3e7b4) |
| 0x28 stage_area_load | 10 | P | area preload (we load everything up front — harmless) |
| 0x2B, 0x2F, 0x32 | 1 each (block 14) | ? | boss block |
| 0x2E stop_voice_if_skipping | 4 | P | voices not ported |
| 0x38 / 0x3A / 0x39 sound | 22 / 2 / 1 | P | sound not ported (0x38/0x3A have a case but only log) |
| 0x3D, 0x3E, 0x3F | 9 / 2 / 2 | ? | |
| ~~0x46~~ | 8 | done | wait until ≤ N civilians in play (DAT_00a3e7a8) and the fight camera is done |
| 0x48 | 23 | ? | |
| 0x50–0x59 | ~250 | P | sound bank / sound commands |
| 0x5D, 0x5F | 1 each | P | music / stream |
| 0x60 | 1 (block 4) | ? | `1800 90 2 10` + list |
| 0x62, 0x63 | 1 each (block 4) | ? | |
| 0x66 | 11 (1,4,6,8) | ? | |
| 0x68 | 2 (3,4) | ? | |
| 0x45 wait_flag 3 | block 14 | G | nothing ported sets flag 3 (boss) |

## 3. Camera

| Item | Where | Status |
|---|---|---|
| Mode 0x60 — camera list / look-at (`FUN_0040df90`, `FUN_0040e4a0`) | blocks 1, 3, 11 | G ? — shots use the plain path instead |
| Modes 0x10, 0x11, 0x12, 0x14 (screen effect, player state, view) | block 0 | P ? |
| Mode 0x15 | block 3 | ? |
| Exact aim point on a body (object +0x100) | all fights | P — hips + 4 used |
| Eye glide during a fight (DAT_00a39473) | when set | P |

## 4. Civilians

Script commands used in Stage 1 but not ported:

| Op | Uses | What it does |
|---|---|---|
| 0x03 | 5 | motion blend length for the next motion start |
| 0x10 | 1 | calls an exe function (a special behaviour) |
| 0x14, 0x15 | 1 each | `FUN_004821c0` / `FUN_00482250` — not identified |
| 0x16 | 1 | fade a value (+0x128) over N frames |
| 0x17, 0x2A | 3 / 1 | set a byte (+0x80 / +0x81) — not identified |
| 0x18 | 1 | jump to a point |
| ~~0x1A~~ | 6 | done: releases hidden attackers (behaviour, count); 0x31 = remove them |
| 0x1B | 7 | global DAT_00a3e7b4 (display/sound state?) |
| 0x21, 0x22 | 10 / 5 | voice clip sequences (sound) |
| 0x25 | 5 | a timed value (+0xa4 / +0xa8) |
| 0x2B | 1 | drill-mode only |

Segment flags used but not handled:

| Bit | Uses | What it does |
|---|---|---|
| 0x100000, 0x200000, 0x8000, 0x20000 | 40 / 12 / 4 / 3 | motion start (`FUN_00481970`): root motion on/off, root reset, blend from the segment, alignment turns |
| ~~0x80000~~ | 13 | done: civilian count −1 (also condition 8, event op 0x46) |
| 0x2000000 | 5 | off-screen exit |
| 0x800000, 0x1000000 | 1 / 7 | not read by the civilian code — meaning unknown |

Also not ported: rescue reward (+400, rescue count), −100 when a civilian dies, the player hitting a civilian
(flag 8 → `FUN_004848a0`), the green blood pool.

## 5. Zombies (behaviours that are ported)

- Per-motion flags (0x1ca / 0x1ce / 0x1d2 / 0xb4 …) and the corpse twitch (`FUN_00443e50`).
- Hit flinches of other skeletons, lost arms / part models, blood.
- Spawn flag 0x20000 (thrower / item holder, used in `FUN_00443950`) is not handled.

## 6. Other object types (no word box — scenery / effects)

0x12 (block 6), 0x20 (×5), 0x24 (×3), 0x25 (×6), 0x28 (×4), 0x29 (×2), 0x33 (×10, a car type), 0x40 (×4),
**0x41 placed props (×52, drawn in the stage viewer, not in PLAY)**, 0x44 (×10), 0x52 (×4, library), 0x61
(block 14), 0x63 (×5 — the skip itself works through event op 0x2C).

## 7. Game systems

| Item | Status |
|---|---|
| Game over / continue at 0 lives | G |
| Score (kills, −100 per hit, rescue +400) and the results screen | P (G for ranking) |
| Health display (HUD), hit flash | P — debug line only |
| Sound effects, music, voices | P |
| Blood, gore, impact effects beyond the letter sparks | P |
| Two players | not planned for now |
| Starting rank from the save's clear count | P (fresh-save value used) |
