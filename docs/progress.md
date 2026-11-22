# Progress log

What was built in each milestone, how it was verified, and what we learned on the way.
Plan and checklist: [goal.md](../goal.md). Reverse-engineering findings: [re/notes/overview.md](../re/notes/overview.md).

## How to resume

```sh
npm install
npm run dev                                   # http://localhost:5173 → "Open game folder…" → ~/Downloads/TTOTD
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
