# Goal: The Typing of the Dead — browser reimplementation

Reimplement **The Typing of the Dead (English PC v1.0, `Tod_e.exe`)** to run natively in the
browser, behaving **exactly** like the original (same logic, timing, scoring, visuals, audio),
not a "similar experience".

## Ground rules

- **Bring-your-own-data.** The engine contains no game assets. The player selects their own
  install folder in the browser at runtime; files are parsed client-side and cached locally
  (OPFS/IndexedDB). Extracted models/textures/audio/word lists/levels are never committed or shipped.
- **Exactness comes from the original code.** Game logic is ported from the decompiled
  `Tod_e.exe`, not reinvented from observation.
- **Small, verifiable milestones.** Each milestone ends with something the user can open/run
  and check by themselves before moving on.
- Claude drives the reverse engineering and keeps notes in `re/`.

## Inputs

- Original game: `~/Downloads/TTOTD` (563 MB)
  - `Tod_e.exe` (2 MB, x86, DirectX 7 / D3DX era, no symbols) — all game logic
  - `pol/` 358 models · `tex/` 553 textures — both appear compressed (u32 size header + LZ-like stream)
  - `mot/` 49 animations · `cam/` 23 camera paths · `coli/` 9 collision · `evt/` 13 event tables
  - `word/` 489 word lists + `font.bin`
  - `sound/` 1314 WAV (PCM 16-bit, 22050 Hz — directly playable)
  - `myth.acm`, `mythxpak.exe` — unknown codec / packer, to investigate
- Notable: `evt/*.bin` contain absolute pointers like `0x0CEB5A0C` (Dreamcast/NAOMI RAM range)
  → raw memory dumps that need pointer rebasing on load. The PC game is a port of the console code
  (House of the Dead 2 engine).
- Reference project for *method* (not formats — it's HOTD1/Model 2, different engine):
  [The House of the Dead: ReWrithe](https://github.com/TawhidI-602/The-House-of-the-Dead-ReWrithe)

## Tech decisions

- **Renderer: raw WebGL2** with a thin *D3D7-shaped* layer (render states, blend modes, fog,
  pre-lit vertex colours, draw order) so decompiled draw code ports nearly 1:1.
  Three.js may be used for throwaway dev viewers only.
- **Language: TypeScript.** Vite for the web app; file decoders are pure TS, also runnable in Node
  for CLI dumping and tests.
- **Reverse engineering: Ghidra** (headless + scripts), notes and a symbol map kept in `re/`.
- **Audio:** Web Audio. **Input:** keyboard events mapped to original DirectInput semantics.
- **Display:** 640×480 4:3 internal resolution, scaled.
- **Timing:** fixed simulation tick matching the original (expected 60 Hz — to confirm in RE),
  decoupled from display refresh.

## Architecture (layers)

```
L0  RE + tooling      Ghidra project, symbol map, notes, CLI dumpers
L1  Formats           decompressor · tex · pol · mot · cam · coli · evt · word/font · wav
L2  Game runtime      main loop · task/actor system · event interpreter · camera rails ·
                      enemy AI · typing engine · scoring/grades · bosses · modes
                      (arcade / original / tutorial / drill / boss) · menus · attract
L3  Platform (web)    WebGL2 D3D7-style renderer · Web Audio · keyboard · folder ingest +
                      cache · saves/settings · scaling
L4  Verification      exact RNG port · deterministic input replay · golden-data tests
```

Planned repo layout:

```
packages/formats   pure decoders + unit tests
packages/engine    game runtime (ported logic)
packages/web       browser app, renderer, audio, input, ingest
tools/             Node CLIs (dump/convert/inspect)
re/                Ghidra scripts, notes, symbol map (no game data)
```

## Milestones

What each finished milestone delivered, how it was verified and what we learned: [docs/progress.md](docs/progress.md).

Each milestone: **deliverable → how you verify**.

- [x] **M0 — Skeleton + asset ingest.** Vite/TS project, folder picker loads `TTOTD`, lists files
  by category, plays any WAV.
  → Open the page, pick the folder, click a sound and hear it.
- [x] **M1 — Exe recon.** Ghidra import of `Tod_e.exe`; locate file loaders (via path strings),
  the decompressor, main loop, and frame timing. Write `re/notes/overview.md`.
  → Read the notes; key functions named with addresses.
- [x] **M2 — Decompressor.** TS port of the original decompression; CLI decompresses every
  `pol/` and `tex/` file.
  → CLI report: every file accounted for; every LZ file decompresses to its declared size.
- [x] **M3 — Texture viewer.** Decode pixel formats (16-bit / possible twiddled/VQ), browse all
  textures in the browser.
  → Textures look correct (zombies, stage walls, UI).
- [x] **M4 — Static model viewer.** Decode `pol/` meshes, render textured in WebGL2 with orbit camera.
  → Recognisable characters and stage pieces.
- [x] **M5 — Hierarchy + animation.** Node hierarchy and `mot/` playback.
  → Zombies walk/attack in the viewer.
- [x] **M6 — Font + word lists.** Decode `font.bin` and `word/` lists; browsable word list viewer
  rendered with the original font.
  → Words and font match what you see in-game.
- [x] **M7 — Stage fly-through.** Stage geometry + `cam/` rail playback for Stage 1, with the game's exact
  lighting (D3D7 per-vertex lighting + the game's light/ambient values) and fog.
  Sub-steps: 7a geometry ✅ · 7b camera paths ✅ · 7c lighting & fog ✅ · 7d moving objects ✅ — the 30
  animated prop types (boxes/`komono`, doors, glass, bridges, water…) decoded with their animations and
  a Props tab to watch each one; cars (`car_*`, plain models moved by code) traced.
  → Camera path matches the Stage 1 route; each prop animates like the original.
- [ ] **M9 — Event tables** (done before M8, agreed 2026-11-23: fights and the enemies that carry the words
  are started by the event script). Decode `evt/` (pointer rebasing) + Stage 1 event timeline viewer.
  9a ✅ decoder, Events tab, script player (camera, subtitles, skip sign, letterbox, light & fog).
  9b: title card, spawn records (type, position, word box), props and cars placed and triggered.
  → Spawns/events line up with Stage 1; props and cars appear and move in the Stage view during playback.
- [ ] **M8 — Typing core.** Typing range: words appear, input matching, mistakes, scoring —
  ported from the exe, on top of the real spawns from M9 (enemies with their word boxes in the fights).
  → Typing feel and score values match the original.
- [ ] **M9b — Stage 1 story scenes.** Play Stage 1's scripted scenes as the game does: characters with
  their motions, camera cuts (standalone camera paths), voices and subtitles in sync, driven by the event
  tables. (No video files exist — all scenes are real-time.)
  → Compare scenes with the real game (recording/screenshots): same shots, timing, lines.
  Reference so far: Stage 1 opens path 0 → chapter title card (`scr_chapter_st1` layers) → path 1
  (`gameplay/cutscene/1/1.png`), title ≈3 s; path 1 subtitle "We're meeting G over there." (voice 01_J /
  01_GA); a cut scene between path 6 and path 7 (route resumes in place); cut scenes show the blinking "Press the Enter key to skip" sign top right (sprite 0x20F at (384,18); scenes marked by event opcode 0x2C, 5 in Stage 1).
- [ ] **M10 — Stage 1 playable** (game screen, ▶ PLAY; agreed 2026-11-23: port the game logic step by step,
  each step playable from the PLAY button). Event interpreter, Stage 1 enemies, damage, life, items,
  SE/voice/BGM.
  10a ✅ game screen: PLAY → Stage 1 from block 0 at a fixed 60 Hz (camera, subtitles, light & fog, skip
  sign, letterbox), Enter skips a scene as the exe does, Esc quits; fights held 3 s.
  10b: enemies in the fights — type 0x30/0x31 objects with their skeletons, start motion and behaviours
  (walk, leap down), placed from the spawn records. Part 1 ✅ character rig (object motion system), daemon
  (type 0x22), zombie type 0x30 behaviours 18 and 26; next: other behaviours/types, stage collision.
  10c: word boxes and typing (M8 core) — words from the word lists, input matching, kill on completion.
  10d: enemy attacks, damage and life; game over.
  10e: placed objects — breakables (kind 4), props and cars; items.
  10f: sounds — voices with the subtitles, SE, BGM; title card.
  → Play Stage 1 start to end.
- [ ] **M11 — Stage 1 boss.**
- [ ] **M12 — Stages 2–6 + bosses** (one milestone per stage).
- [ ] **M13 — Front end.** Title, attract mode, menus, game over, ranking, ending.
- [ ] **M14 — Other modes.** Original mode, tutorial (lesson), drills, boss mode.
- [ ] **M15 — Verification + polish.** RNG-exact replays, timing audit, settings, saves.

## Open items

- Original can't run on the Mac — reference comes from the user playing on Windows
  (screenshots/video on request) and from the decompiled code itself.
- What `myth.acm` / `mythxpak.exe` are used for.
- ~~Confirm simulation tick rate and RNG algorithm~~ → fixed 60 Hz, MSVC `rand()` (re/notes/overview.md).
- Locate the loader for raw (sector-aligned) stage `pol/`/`tex/` files.
- Look for existing format research on House of the Dead 2 (PC/Dreamcast) to speed up L1.
