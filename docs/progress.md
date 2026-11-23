# Progress log

What was built in each milestone, how it was verified, and what we learned on the way.
Plan and checklist: [goal.md](../goal.md). Reverse-engineering findings: [re/notes/overview.md](../re/notes/overview.md).

## How to resume

```sh
npm install
npm run dev                                   # http://localhost:5173 → "Open game folder…" → ~/Downloads/TTOTD
TTOTD_DIR=~/Downloads/TTOTD npm run dev       # dev only: http://localhost:5173/?dev loads the folder without the picker
TTOTD_DIR=~/Downloads/TTOTD npm test          # unit tests + checks against your own install
npm run typecheck
node --experimental-strip-types tools/unpack.ts ~/Downloads/TTOTD [--out dumps]   # classify/unpack pol+tex
```

Reverse engineering (Ghidra 12.2 via `brew install ghidra`): see [re/README.md](../re/README.md).
`re/scripts/headless.sh` forces Ghidra's own JDK 25 because `jenv` (JENV_FORCEJAVAHOME) otherwise
forces Java 11 onto every Java process.

Not in git (gitignored, regenerable): `re/ghidra-project/`, `re/out/` (decompiled exe), `dumps/`
(unpacked game files), `node_modules/`. No game data is ever committed.

## Project layout

| Path | What |
|---|---|
| `packages/formats/src` | Pure decoders, runnable in browser and Node: `wav.ts`, `lz.ts`, `container.ts`, `pe.ts`, `pvr.ts`, `texsets.ts` |
| `packages/formats/test` | Unit tests (synthetic data) + real-data tests (skipped unless `TTOTD_DIR` is set) |
| `packages/web` | Browser app: folder ingest, Files tab, Textures tab |
| `tools/` | Node CLIs (`unpack.ts`) |
| `re/` | Notes, symbol map, Ghidra scripts (`ExportAll.java`, `ApplySymbols.java`), `peek.py` |

Conventions: TypeScript with `erasableSyntaxOnly` (no enums / parameter properties) so every file runs
directly under `node --experimental-strip-types`; imports use `.ts` extensions.

---

## M0 — Skeleton + asset ingest ✅ (2026-11-22)

**Delivered:** npm workspace (Vite 8, TypeScript 7, Vitest 5); page with folder picker, install check
(exe SHA-256 + expected file counts per folder), file browser with WAV playback and hex peek.

**Files:** `packages/web/src/ingest/gamefs.ts` (case-insensitive read-only view of the picked folder),
`ingest/inventory.ts` (expected counts, exe hash `15a333df…3fbdf`), `audio.ts`, `main.ts`;
`packages/formats/src/wav.ts`.

**Verified:** all 1314 WAVs are 16-bit PCM (test); install check passes on the real copy (test);
user confirmed picker, report, playback in Chrome.

**Issues fixed:**
- Root `npm run dev -- --port …` passed the port as Vite's root → scripts now call `vite packages/web` directly.
- "Reopen folder" did nothing after reload: Chrome only shows the permission prompt while the click is
  fresh, and the handler awaited `queryPermission` first. Now `requestPermission` is called immediately
  in the click; auto-reopens when permission is already held; errors are shown. User confirmed.

## M1 — Exe reconnaissance ✅ (2026-11-22)

**Delivered:** Ghidra project + export (2331 functions, all decompiled), `re/notes/overview.md`,
`re/symbols.tsv`, `re/scripts/*`.

**Key findings:** fixed 60 Hz (16.667 ms, ≤ 4 frame skip); MSVC `rand()`; per-folder loaders; evt pointer
rebasing (`0x0CE8xxxx + 0xF3B30C00`); word lists XOR 0x41; save data hidden in 4 data files with
timestamps copied from `pol/zstin.bin`; the PC build is a port of the Dreamcast/NAOMI code.

**Verified:** every checkable claim is a test in `packages/formats/test/notes.test.ts` (exe constants and
code bytes, path and save tables, word XOR, size limits, evt pointer targets). The evt check first failed
for `comevtbl` — investigation showed its pointers target itself or exactly the stage-table base
0x009E6600, which strengthened the finding; notes corrected. User confirmed the Windows install is the
same file set as `~/Downloads/TTOTD`.

**Still open:** loader for raw stage pol/tex; what enables the fixed RNG seed; `myth.acm`; collision load
address (marked unverified); settings INI.

## M2 — Decompressor ✅ (2026-11-22)

**Delivered:** `packages/formats/src/lz.ts` (port of `lz_decompress` @0044fe20), `container.ts`
(storage classification), `tools/unpack.ts`.

**Verified:** all 695 LZ files decompress to exactly their declared size with zero trailing bytes;
all 911 pol/tex files classified: pol 257 lz / 98 raw / 3 save; tex 438 lz / 87 raw / 1 save / 3 bmp /
24 stub. First run "failed" 216 files → they were raw sector-aligned stage files, save files, BMPs and
empty stubs, not decompressor bugs.

## M3 — Texture viewer ✅ (2026-11-22)

**Delivered:** `packages/formats/src/pvr.ts` (PVR decoding as `tex_upload` @004bf400 does it),
`texsets.ts` (texture-set descriptors and palettes read from the exe, palette-bank jump-table port),
`pe.ts` additions; Textures tab in the web app (set list with filter, ↑/↓ navigation, zoom,
transparency, upright toggle).

**Verified:** 548 sets / 11 913 textures, all decode (test); unit tests for twiddle, rect-twiddle, VQ,
4-bit palette and colour expansion; visual check of `common`, `scr_common`, `st1_01`, `scr_jimaku`
contact sheets; user confirmed textures look good.

**Findings:**
- Texture files contain only texel data; descriptors and the 59 palettes are in the exe.
- Layouts used: twiddled, VQ, 4-bit palette, linear, rectangular twiddled; no mipmaps.
- The palette-bank switch was partly garbled by the decompiler (case 0x1FD); ported from the
  disassembly instead, and driven by the exe's own jump table.
- Quirk: tall 4-bit textures (h > 2w) are read past their data by the exe — 252 textures, nearly all
  `scr_jimaku*` (Japanese subtitle images). Replicated and flagged ⚠ in the viewer.
- All textures are stored bottom-up; the game's UVs count from the bottom. The renderer must upload
  rows unchanged and use the original UVs; the viewer flips for display only.

**Issue fixed:** Node's type stripping rejected `const enum` and constructor parameter properties →
removed and `erasableSyntaxOnly` turned on.

## M4 — Static model viewer ✅ (2026-11-22)

**Delivered:** `packages/formats/src/pol.ts` (model table + model/mesh/primitive parser with reference
resolution), `renderstate.ts` (PVR words → D3D render state, tables from the exe);
`packages/web/src/gl/mat.ts` (D3D-style matrices), `gl/renderer.ts` (WebGL2 emulation of the D3D7
fixed-function setup: modulate, alpha test, blend factors, depth funcs, culling, wrap/mirror/clamp,
opaque-then-translucent passes); Models tab (file list, model list, orbit camera, texture-set picker,
all-models / lighting / culling toggles). Dev-only data endpoint in `packages/web/vite.config.ts`.

**Verified:** all 355 model files / 10 022 models parse with every mesh's size field matching exactly
(test); texture indices of all 43 563 textured meshes fall inside their same-named set; render-state
tables match the exe (test); unit tests for the parser and state mapping; headless-Chrome screenshots
of Stage 1 (`st1_01`, upright tower, arched windows, solid walls), a zombie (`zsass`) and James's head
(`player1` #1) look correct. User confirmed the viewer renders models well.

**Findings:** see re/notes/overview.md "Models". Notably: the texture index is local to the same-named
tex set; 23 pol files have empty tex sets and borrow another set (viewer guesses by name prefix).

**Q&A worth keeping:** heads "missing" in the all-models view are expected — every part is stored
around its own joint, so without the skeleton the head sits inside the torso (player1 head y −0.79..1.65,
torso y 0..5.03). Culling = skip triangles seen from their back side (decided per triangle per frame by
on-screen winding); a street seen from below disappears because only its top was modelled.

**Known limits (by design, later milestones):** lighting is an approximation (exact lights/fog later);
character parts are unassembled until the skeleton (M5); flat shading drawn smooth.

## M5 — Skeletons & animation ✅ (2026-11-22)

**Delivered:** `re/scripts/FindFunctions.java` + `DecompileAt.java`; `packages/formats/src/character.ts`
(86 character skeletons from the exe, global model-id → file/model lookup, motion table, `Motion`
sampling with the exe's half-frame rules, `poseCharacter`), `d3dmath.ts` (moved from web + the exe's
matrix-stack ops); web: shared `assets.ts` cache, `gl/orbit.ts`, **Characters** tab (character list,
motions that fit its joint count, play/pause, frame slider, speed, step with ←/→, in-place toggle).

**Verified:** all 1 116 motion headers equal `floor((F−1)/2)+2` (test); every drawable node of all 86
skeletons resolves to an existing model (test); every frame of James's 14 motions poses with finite
matrices (test); rotation/translate ops checked line-by-line against the decompiled exe; screenshots:
James (front/back, keyboard, backpack), zombie `zsass` with `assb.bin` (twin blades, seamless).
User confirmed the characters look good.

**Q&A worth keeping:** the box on James's back is identified as a Dreamcast from the game's own
textures (player1 tex #33 round disc lid, #38 four controller ports); the yellow cylinder beside it
(#28–30) looks like a battery. Lesson: keep "the data shows" separate from "I recognise".

**Findings:** function coverage fix (56 % → 92 %); motion/skeleton formats; prop skeletons are separate
(M7). See re/notes/overview.md "Characters & motions".

**Known limits:** the viewer can't know which motions belong to which character (game logic decides);
wrong pairings may show gaps. Head/face variants and motion cross-fades not applied yet.

## M6 — Font & word lists ✅ (2026-11-22)

**Delivered:** `packages/formats/src/words.ts` (word-list decoder, charset ↔ SJIS, exe letter metrics,
letter model lookup, exact `layoutWordLine`), `font.ts` (font.bin glyphs + the exe's character
textures), `d3dmath.orthoOffCenterLH`; renderer colour override; palette-bank rule fix
(`paletteBankFor(..., loadedForModels)`); **Words** tab (488 lists, search across all words, preview with
the game's letter models: yellow word line, white player line with a "typed" slider, size; Japanese font
browser). `gameplay/` (user's reference screenshots) added to .gitignore.

**Verified:** 488 lists / 14 061 words decode; every word's codes equal its text in the game charset;
every character has a letter model (space excepted, by design); font has 7 807 reachable glyphs; width
tables spot-checked (tests). Pixel comparison with the user's 640×480 boss screenshot: IoU 0.80 / 0.85 at
one consistent size (23.75 px). Words tab renders "Ping-pong" (8 typed) and "Sweet pea" (7 typed) like
the user's screenshots. User confirmed all four checks (word previews, other lists, Japanese font, letter atlas).

**Findings:** on-screen letters are textured quad models, not font.bin; font.bin is the Japanese system
font; palette bank 0 for model textures (M3 correction). User keyboard: US.

**Known limits:** box frame is a placeholder; line spacing (34 px) is measured, not yet from code — both
come with the typing milestone (M8).

## M7 — Stage 1 fly-through ✅

### 7a — Stage geometry ✅ (2026-11-22)
**Delivered:** renderer batches each mesh's primitives per cull mode into one triangle list (same strip
winding; render identical to within scattered single pixels); `gl/fly.ts` free-fly camera; **Stage** tab
(stage selector, per-file checkboxes + select-all toggle, `?off=` URL option).
**Findings:** load request queue (`load_request_model` raw per-model reads for stage files vs
`load_request_file` LZ whole files); Stage 1 = 11 world-space files meeting seamlessly + backdrop
(`st1_1/1b`, several concentric wall rings — likely variants chosen at runtime).
**Verified:** screenshots of the assembled town; user checked the Stage tab and the select-all toggle.

### 7b — Camera path ✅ (2026-11-22)
**Delivered:** `packages/formats/src/camera.ts` (camera slots, `CameraFile` with the exe's curve
evaluator, `lookAngles`, `cameraView`, `cameraProjection`, `D3D_VIEW_FLIP`, `gameLookAt`); Stage tab
**camera: game path** mode (path list, play/pause, time slider, speed, chain to next path, 4:3 letterbox,
exact game projection).
**Verified:** every camera curve passes through its keys; for all 23 Stage 1 paths the target is dead
ahead after the z-flip (tests); screenshots of path 0 (aerial start) and path 2 (street level).
**Findings / fixes:** fixed z-flip view matrix; corrected cull mapping and un-mirrored all viewers
(M4–M6 views were mirror images); control directions adjusted to the un-mirrored view.
**Route structure:** paths form a graph — `pathContinuations` links each path to those starting where it
ends. Stage 1: branches at 7, 10, 13; Stage 2: 66 paths, branches at 6, 8, 9, 19, 38 and 30 standalone
event shots. Playback "follow route" continues along continuity (first option at a branch) and stops at
the end of a run; the real sequence comes from the event script (M9). User: camera looks good.
**Assumption to confirm:** 1 path time unit = 1/60 s.

### 7c — Lighting & fog (2026-11-22) ✅ verified by user 2026-11-23
**Delivered:** `scenelight.ts` (scene inputs → D3D7 state exactly as `light_setup_single` / `fog_set`);
renderer: D3D7 fixed-function lighting equation, flat shading with D3D's first vertex, linear table fog;
Stage tab "Scene light & fog" panel (game inputs, exe reset values); viewers light from the camera using the
same formula.
**Verified:** constants match the exe; light direction equals the exe's matrix-stack sequence; fog range
doubling/ordering (tests). Screenshot of path 2 with the game's lighting.
**Open:** each scene's actual light/fog values are set by event commands → M9 (the panel lets you explore
until then).

### 7d — Moving objects (2026-11-23) ✅ verified by user 2026-11-23
**Delivered:** `prop.ts` (30 prop skeletons, prop motion layout, playback modes 0/1/2 as
`prop_joint_transform`, the game's type→motion pairings); Props tab (list of props, fitting motions with
★ game pairing, 60 Hz playback, frame slider).
**Verified:** a test checks that every game pairing fits the decoded layout exactly; frame-0 contact sheet of
all 30 props shows intact objects (barrels, gates, panes, chairs, pots, door); glass and door debris
animate apart.
**Traced:** cars are code-built (body + spinning wheels) and event-driven, so placing them is M9.
**Open:** mode-2 big-turn matrix blend (approximated); #16 frame range; #29 has no motion; four
pairings not yet seen in code. Props and cars appear in the Stage view with M9 (their owners place them).

## M9 — Event scripts (in progress)

### 9a — Decode the event script (2026-11-23) ✅ verified by user 2026-11-23
**Delivered:** `events.ts` (block table, scripts, command lengths for all 117 opcodes, the exe's next-block
rules); Events tab (stage select, blocks with their next-block rule, every script's commands with names
and notes: dialogue text, skippable scenes, waits in seconds, mode branches).
**Verified:** all 458 scripts in the six stage files decode cleanly (tests); stage n ↔ rule table n − 1
(block counts match); Stage 1: five skippable scenes, the first spoken line after the opening scene is
dialogue 1, as in the user's video notes.
**Next (9b):** name the remaining commands (camera path changes, title card, light/fog, spawns, sounds).

### 9a+ — Event script player (2026-11-23) ✅ verified by user 2026-11-23
**Delivered:** `evtplayer.ts` (runs a block frame by frame as the exe: camera queue and camera time, the
three wait kinds with the exe's yield rule, say(), skippable, light & fog set/fade/direction, block order);
Stage tab camera mode **event script**: camera follows the script's paths, subtitles, blinking skip sign
(scr_common texture 23 at (384, 18)), the script's light & fog, and a live log of every triggered action.
**Verified:** test — block 0 plays path 48 → path 49 (line 1 at camera time 6) → lines 2–3 → path 50 ×3 with
lines 4–6 → first fight; matches the user's video notes. Screenshots of the fly-over (skip sign), line 1 and
line 2.
**Not yet:** title card; fights (held for a chosen time); characters, enemies and props in scenes; sounds;
camera modes 0x10/0x11/0x12/0x14/0x60 details.
**Follow-ups (user):** skip sign blinks and shows only in cut scenes; cut-scene letterbox bars (60 px,
provisional); block dropdown follows playback; `[hidden]` always hides (toolbars' display rules overrode it).

### 9b — Spawn records as markers (2026-11-23) ✅ committed ecff3b0
**Delivered:** spawn records for ops 0x09 / 0x03 (one player) / 0x07 (two players) / 0x0A; record +0x22 =
hit points (characters) and +0x24 = skeleton index (both traced in the exe); markers + labels
(`t30 znsam2 hp100`) in the Stage view's event playback.
**Tried and reverted (user):** drawing the characters at their spawn points — without the game logic they
float (some spawn in mid-air and leap down: behaviour 26) or face the wrong way (the unanimated pose), so
markers only until the logic is ported. Findings (start motion 0x3f5, facing, behaviours, placed-object
kinds) are in re/notes/overview.md.

## M10 — Stage 1 playable (in progress)

### 10a — Game screen (2026-11-23)
**Delivered:** ▶ PLAY button (header, once the game folder is open) → full-window game screen
(`packages/web/src/game.ts`): Stage 1 from block 0 at a fixed 60 Hz, 640×480 picture scaled to the window,
event-script camera, subtitles, light & fog, blinking skip sign, letterbox; **Enter skips a scene** as the exe
does (`EventPlayer.skip()`); Esc quits back to the tools. Fights are held 3 s ("Fight — not ported yet").
`?dev&play=game` starts it directly.
**Verified:** test — Enter during the opening fly-over reaches the scene's end within 2 frames, no subtitle;
headless Chrome screenshots: fly-over with the skip sign, Enter → next scene ("We're meeting G over there."),
Esc → back to the tools.
**Next:** 10b enemies in the fights.

### 10a+ — The opening car (2026-11-23) ✅ verified by user 2026-11-23
**Delivered:** event op 0x0B decoded as a spawn (it creates the car, the players, more zombies); object
paths (`cam/op_stN.bin`, same format as camera paths, 6 channels) with `CameraFile.objectSample` and the
exe's path lengths; new **`packages/engine`** (ported game logic) with the players' car (type 0x26, variant 1:
follows object paths 0x11f/0x120 by the camera path, parks and opens its doors on path 50, wheels, steering
wheel, dust) and the chapter title card's timing (type 0x60 — corrected: it is the title card, not "HUD on");
the PLAY screen draws the car (models by global id).
**Verified:** tests — every object-path curve passes through its keys; the car drives on paths 48–49, hides
for the title card's 0xB4 frames, parks at (−64, 0, 137.5) with the door open on path 50; headless screenshots
of path 49 (car driving away from the camera) and path 50 (parked, left door open).
**Not yet:** the daemon on the rooftop and flying over the car (type 0x22, traced — see notes; first
misnamed "James and Gary"); title card graphics.
**Fix (user: the car only appeared near the end of path 1):** the script holds path 49 with event op 0x45 248
(`FUN_0044f7f0`: wait until flag byte DAT_00a396c0[N] is set); 248 = DAT_00a397b8, which the title card sets
when it ends. The player now implements 0x45 and the title card sets the flag (game screen and Stage view), so
the scene fades to black for the 3 s card and path 49 starts afterwards with the car beside the camera
(test + screenshots).

### 10b (part 1) — Character rig, the daemon, the first zombies (2026-11-23) ✅ verified by user 2026-11-23
**Delivered:** `packages/engine` reorganised (core/, objects/tNN-*.ts, registry.ts); the **character rig** = the
exe's object motion system (motion state, half frames, blended switches with the swing/twist rotation blend,
root motion, per-node draw); the **daemon** (type 0x22: rooftop, motion cues, wings on the body's joint 1,
talking mouth, eyes, flies off, removed at path 50 time 400); the **zombie** type 0x30 with behaviours 18 (wait
with an idle motion) and 26 (leap down); spawn records carry their parameter bytes (`tail`); the PLAY screen runs
every ported object from the registry and loads models and motions on demand; one-/two-player spawn lists fixed.
**Verified:** tests (scene runner on real data) — the daemon's timeline (rooftop, 0x448, 1092, path 49 with
1103, 1099, gone), the first wave = three znsam2 with motions 1052/1053/1064, feet on the ground; the blend
starts at A and ends at B; screenshots: daemon on the rooftop, landing on the car ("What!?"), at the fence
("You're next."), on the church roof; the first fight with its three zombies.
**Open:** zombie behaviour 1 (attack) and others; head turning to the player; the jump leap lands too low until
stage collision is ported; voices.

### 10f (title card part) — Chapter title graphics (2026-11-23) ✅ verified by user 2026-11-23 (title card and bellies)
**Delivered:** the title card's animation (`FUN_004241b0`) ported into `TitleCard.layers`; the PLAY screen draws
the layers (scr_chapter_st1 textures, centred sprites) on a 2D overlay. **Verified:** screenshots during the
card ("The First Chapter" / "A Prelude", zoom and drip phases). **Fixed (user: zombie belly see-through):** characters' **skin pieces** were not drawn — ported (exe tables
@0055ac90 / @0051916c / @00519a78, vertices moved by joint · reference⁻¹ each frame) in PLAY and the Characters
tab; tests: znsam2's belly piece, all 2 238 slot offsets land on model vertices; screenshots: bellies closed.

### 10f (sky part) — Sky and stage areas (2026-11-23) ✅ verified by user 2026-11-23
**Delivered (user: skydome missing):** the stage is drawn by area from the exe's tables (event op 0x29) instead of
drawing every st file — st1_1/st1_1b are libraries whose fogged sky variants had covered the sky; the sky task
(ops 0x1b/0x1c) draws the dome and cloud layer around the camera, turning, upside down for the fly-over;
nothing is drawn behind the title card. Debug `?dev&play=game&at=N` freezes PLAY at frame N for exact screenshots.
**Verified:** tests (13 areas, area 1 = st1_01 + st1_01b, sky rows 4/5, the player's area/sky after block 0);
screenshots: dusk sky over the first fight; the fly-over's wet road reflecting the upside-down sky (ray-cast
confirmed the patch is st1_01's translucent mesh 284, not a hole).
**Follow-up (user: street reflection differs from the original):** the game screen now draws like the exe —
every opaque mesh first, then all translucent meshes, models sorted far to near. The mirrored street (st1_01b)
now shows through the puddles: upside-down bridge, railing and lamp, as in the user's screenshot (frame 40).
**Follow-up (user: title card background not black; letterbox should slide out):** the frame is cleared to
black like the exe (found the D3DX clear colour, set once to 0,0,0) instead of the fog colour — the title card is
now on black; the letterbox bars slide out (and in) over 20 frames — provisional, the exe's bar code is still not
found (searched paths listed in the notes). Screenshots: frames 225 (bars in), 240 (sliding out), 330 (title card).

### 10b (part 2) — Zombies walk up to the player (2026-11-23) ✅ verified by user 2026-11-23
**Delivered:** zombie behaviour 1 (walk towards the player — the camera eye — turning at the exe's rate, using
the skeleton's walk motion from the exe's motion sets; stops at the near band, 25) and behaviour 2 (idle motion,
keeps facing the player); approach bands (exe defaults + event op 0x0E), the game's rand (MSVC LCG). PLAY holds a
fight for 10 s (was 3) so the approach can be seen.
**Verified:** tests — turning steps the short way; the first wave walks with 0x437 and ends in behaviour 2 at
24–27 from the player, facing them; real-time screenshots: walking towards the camera, then standing close.
**Not yet:** the attack (3), backing off (4), damage, sounds; `at=N` can show characters missing (motions that
load after the freeze are never posed).
**Fix (user: zskamere missing its belly in the Characters tab):** its belly piece's draw function (0x490290) is
a second copy of the standard one and was skipped; now recognised (test: skeleton 0x17 → model 0x2378, group A0).

### 10b (part 3) — Zombies attack (2026-11-23) ✅ verified by user 2026-11-23
**Delivered:** zombie behaviours 3 (attack: pick a row from the exe's attack tables, walk in, swing, hit on the
row's frame) and 4 (back off, give the attack slot back); behaviour 2 now asks for the player's attack slot —
one attacker at a time, so the first wave takes turns. A hit calls `World.hitPlayer(player, hit, damage)` (no
effect yet: damage is 10d).
**Verified:** test — never more than one attacker; all three swing (0x42e); every hit = player 0, 9 damage;
real-time screenshots: a zombie lunging at the camera, backing off, the next one coming in.
**Not yet:** off-screen attacker lock, lost arms, cool-down, two-player rules, sounds, damage.

### 10c (part 1) — Word boxes (2026-11-23) ✅ verified by user 2026-11-23
**Delivered:** enemies with word flags (zombies) get a word box, as `spawn_record` does: the word comes from the
exe's word state — event op 0x61 (group, time budget) → word level by rank (FUN_004b16b0) → the built-in
two-letter list (category 1) or a `word/Z000Lnnn.bin` file; random picks avoiding the last 16 and any first letter
already on screen. The box follows the zombie's torso (joint 1) with the exe's smoothing, stays on screen, and is
drawn from the game's own models (tod_boxetc frame pieces, letter models): black box, danger-coloured frame, the
word in yellow and the line to type in white; shown only during fights. Rank starts at 1, +1 every 30 s.
**Verified:** tests — category 1 = 41 words incl. Me / U2 (the user's library screenshot), word levels for Stage 1
budgets, word flags per type, the first wave's three boxes (different first letters, 13 items each); real-time
screenshots of the first fight (boxes follow the zombies; a lunging zombie's box is clamped to the screen).
**Not yet:** typing (targeting, letters, shooting), red target brackets, fight end; rank changes from play;
category 0's special picks; the frame colour saturates to yellow when lit (open: same in the original?).
**Stand-in (user request): when a fight's hold runs out, its zombies end as if shot** (`GameObject.fightOver`,
`EventPlayer.fightsOver`): no leftover zombies — fixes the stray word boxes and the library fight's attack order
(a leftover first-wave zombie held the attack slot). Removed again once typing ends fights (10c step 3).
Verified: test (after fight 1: no zombies, slot free, no boxes); screenshot of the library fight: two boxes only,
the jeans zombie in front as in the user's original screenshot.

### 10c (part 2) — Typing kills zombies (2026-11-23) ✅ verified by user 2026-11-23
**Delivered:** typing in PLAY: the first key picks the box whose word starts with it (spinning red brackets) and
types its first letter; letters vanish from the white line as they are typed (case-insensitive; a space can be
skipped by typing the next character); each letter hits a body part with the impact effect; the last letter kills —
the zombie plays a death motion chosen by direction, its attack slot and word slot are freed, it sinks for 2 s
and is removed; the live-enemy count (DAT_00a39546) drops when the death motion ends.
**Verified:** test — typing the first wave: target + first letter on one key, all three die with death motions
0x412–0x419, enemies 3 → 0, no boxes or zombies left; PLAY screenshots: brackets on "D2" with "2" left, the three
falling, then gone.
**Not yet:** the fight ending on zero enemies (still the 10 s hold — step 3), player 2, misses' effects, hit
flinches and part loss, blood, score, voices; the impact effect's part radius (taken as 0) and size flag (×0.3
assumed).
**Fix (user: Esc should cancel the current word, not quit):** the exe maps Esc to key ')' which drops the target
— ported: Esc with a target cancels it (the word starts again, another zombie can be picked); Esc with nothing to
cancel still leaves PLAY. Test: cancel resets the word and the next key picks another box.

### 10c (part 3) — Fights end when their enemies are dead (2026-11-23) ✅ verified by user 2026-11-23
**Delivered:** the 10 s hold is gone from PLAY: a fight lasts until its enemies are dead, by the exe's rule
(FUN_0040cda0: no enemy left that is not dying and none registered this frame — the last first-wave zombie keeps
the fight going until its body has sunk). Then the camera returns to the script's path. The stand-in that removed
leftover zombies is removed. Viewers without gameplay (Stage view) still hold fights for a few seconds.
**Verified:** tests — no hold ends a fight (20 s without typing), typing the first wave ends it right after the last
body is gone, counts back to 0; a typing bot through blocks 0–2; PLAY: type the first wave → the street empties and
the camera moves on to the library fight.
**Notes:** fights whose enemies are not ported yet (types 0x20, 0x31, 0x44, …) end at once; op 0x43 (wait for at
most N enemies) not ported; the player cannot be hurt yet (10d).

### 10c (part 4) — The script's fight flow (2026-11-23) ✅ verified by user 2026-11-23
**Delivered (user: third wave showed 3 boxes for 1 zombie; after the first kill it stopped):** the event player now
runs fights like the exe: a fight holds the camera queue; event op 0x44/0x43 wait until the enemies are dead and the
fight camera is done; op 0x31 ends the fight; op 0x33 releases the queue; fights 6 and 7 move the camera along the
stored path (camera time advances), fight 4 holds it. Zombie behaviours 13 (lie hidden without a word box until a
camera time, get up) and 15 (walk a set distance). Result: the third wave shows one zombie; after it dies the camera
moves on and the two others get up and come at you, as in the original.
**Verified:** tests — the third-wave sequence (spawn after the first fight, no boxes while lying, rise at camera
times 265 / 304 during moving fight 6, the stage moves on); a typing bot through blocks 0–2; PLAY with an in-page
bot: one zombie + one box, then the two risen zombies with their boxes, then path 53.
**Not yet:** the fight camera turning towards the enemies, the camera's return blend, mode 0x60 camera lists.
