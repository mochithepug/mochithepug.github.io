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
