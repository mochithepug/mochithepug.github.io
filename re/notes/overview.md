# Tod_e.exe — reconnaissance (M1)

Target: English PC v1.0, `Tod_e.exe` 2,048,000 bytes, SHA-256 `15a333df…3fbdf`.
Names below are ours (applied from `re/symbols.tsv`); addresses are virtual addresses in the exe.

## Binary

- 32-bit x86 PE, MSVC C++ (RTTI present), image base `0x00400000`.
- Sections: `.text` 0x401000–0x4dcfff (880 KB code), `.rdata`, `.data` 0x594000–0xa40fff (4.9 MB, mostly
  zero-initialised static buffers: the console code's fixed memory map lives here), `.rsrc`.
- Ghidra: 2331 functions, all decompile.
- APIs: DirectDraw 7 + D3DX/Direct3D 7 (fixed-function), DirectInput, DirectSound, GDI (fonts/BMP),
  IMM32, INI settings (`GetPrivateProfile*`).
- It is a straight port of the Dreamcast/NAOMI code (House of the Dead 2 engine): file names, sector-sized
  data files and console RAM pointers inside data files.

## Main loop & timing — **fixed 60 Hz**

- `win_main_loop` @004bdf40: `PeekMessage` pump; when idle runs a frame and calls `frame_pace`.
- `frame_pace` @004bd790: QueryPerformanceCounter-based wait until `g_frame_ms` = **16.6667 ms** has
  elapsed. If behind, skips up to `g_max_frameskip` = **4** frames. Every 333 ms it compares the frame
  count against 20 and nudges a ±0.2 ms tolerance (clamped ±10 ms).
- Game logic counts in frames (e.g. timers of `0x168` = 360 = 6 s). → The web port runs logic at a fixed
  60 Hz tick, decoupled from display refresh.

## Random numbers

- Standard MSVC CRT `rand()` @004c62cc: `s = s * 0x343FD + 0x269EC3; return (s >> 16) & 0x7FFF`
  (112 call sites). `srand` @004c62bf.
- `seed_rng` @00484b60: `srand(FUN_0047ed90() ? 0 : g_rng_counter)`. A fixed seed of 0 in some mode
  (likely attract/demo playback) makes it deterministic. `g_rng_counter` @00a11a48 is reset/incremented
  elsewhere — to trace.

## File loading

All paths are relative to the install folder, built with `wsprintfA` from per-folder formats
(`pol\%s`, `tex\%s`, `evt\%s`, `coli\%s`, `word\%s`) and name tables in `.rdata`.

| Data | Loader | Notes |
|---|---|---|
| `pol/` `tex/` (characters, common) | `load_common_pol_tex` @00487fd0, `load_tex_set` @00494160 | u32 size + LZ stream → `lz_decompress` |
| `evt/*.bin` | `load_comevtbl` @0047d620, `load_stage_evtbl` @0047d700 | Raw. Then `evt_rebase_pointers`: every u32 with `(v & 0xFFF80000) == 0x0CE80000` gets `+= 0xF3B30C00`, i.e. the 512 KB console window `0x0CE80000–0x0CEFFFFF` ↔ PC `0x009B0C00–0x00A30BFF` (inside `.data`). `comevtbl` loads at PC 0x009E6400; the current stage/mode table at 0x009E6600 (pointer @005b8ae8). Verified: every `comevtbl` pointer targets itself or exactly 0x009E6600; 93–100 % of each other table's pointers target itself or `comevtbl` (the rest point elsewhere in the window — to trace). |
| `coli/*.bin` | `load_coli` @0047d7b0 | Raw, into `DAT_009e6400 + 0x6000 (+0x600 if index ≠ 0)` — element size of that expression unverified; as bytes it would overlap large stage tables, so to re-check |
| `word/Z*.bin` | `load_word_list` @004b4100 | Raw, **XOR 0x41** on every byte, max 0xD000 bytes |
| `word/font.bin` | `load_font` @004539d0 | Raw, 0x138000-byte buffer |
| save data | `save_read` @004af060 / `save_write` @004af0e0 | One 0x2C00 block @00a3bb60 stored as 4 × 0xB00 *inside* `pol/bg_adv19.bin`, `tex/scr_tod_itm_itamidome2.bin`, `pol/komono_0.bin`, `pol/tv2.bin` (looks encrypted/scrambled). After writing, each file gets the timestamps of `pol/zstin.bin` so it looks untouched. |
| BGM | `sound_stream_thread` @004bc070 | DirectSound streaming from WAV |

### LZ format (`lz_decompress` @0044fe20)

Flag bits LSB-first from a byte refilled every 8 bits, payload bytes interleaved in stream order:

- `1` → literal byte
- `0 1` + u16 `w` → `w == 0`: end of stream; else distance `0x2000 - (w >> 3)` (1..8192),
  length `(w & 7) + 2`, or if `w & 7 == 0` length `next byte + 1`
- `0 0 b1 b0` + u8 → distance `0x100 - u8` (1..256), length `(b1 << 1 | b0) + 2`

Port: `packages/formats/src/lz.ts`. Verified on every LZ file: exact declared size, zero trailing bytes.

### Storage census (`tools/unpack.ts`)

| | lz | raw (sector-aligned) | save | bmp | stub |
|---|---|---|---|---|---|
| pol (358) | 257 | 98 | 3 | – | – |
| tex (553) | 438 | 87 | 1 | 3 | 24 |

`raw` = stage geometry/textures (`st1_01`, `etc_1`, …), sizes are multiples of the 2048-byte disc sector.
Their loader is not yet found — no direct callers to the generic reader; likely via a pointer table or
inlined. `stub` = empty/4-byte placeholders. `bmp` = `scr_etc000-002` (512×512 8-bit).

## Input

- `dinput_init` @004b81e0 (DirectInputCreateEx), `keyboard_map` @004b8050 maps key state through
  `MapVirtualKeyEx` + the active keyboard layout; shift/ctrl/alt bits mirrored into several key-state
  globals. Key-name tables in `.rdata` @0058d268 / @0058d284.

## Text

- All English subtitles/dialogue are plain strings in `.rdata` (@0059b294 onwards).

## Textures (M3)

- Texture files hold **only texel data**. Per-set descriptors are in the exe: names `g_tex_set_names`
  @004f3160, descriptor pointers @0058c0e0, counts @0058c974 (index 0 unused; 548 sets, 11 913
  textures). Descriptor (16 bytes): `i16 w, i16 h, u32 type, u32 offset, u32 id`. The offset is into the
  decompressed file (`lz`) or the file itself (`raw` stage sets use the same descriptors).
  Verified: every texture fits its file, no overlaps, descriptors cover a median 100 % of each file.
- Formats are Dreamcast PVR, decoded at upload by `tex_upload` @004bf400. `type & 7` = pixel format
  (0 ARGB1555, 1 RGB565, 2 ARGB4444), `type & 0xff00` = layout: `0x100` twiddled, `0x300` VQ
  (256-entry 2×2 codebook, 0x800 bytes, then twiddled indices; texel order TL, BL, TR, BR), `0x500`
  4-bit palette (twiddled), `0x900` linear, `0xD00` rectangular twiddled (square blocks side by side,
  or stacked when taller). No mipmaps are used. Twiddle = Morton order, x in odd bits, y in even bits.
- 16-bit texels are uploaded unchanged (D3D formats ARGB1555/RGB565/ARGB4444). 4-bit palette
  entries are ARGB1555 and converted per target format (565: `(c & 0xffe0) << 1 | c & 0x1f`;
  4444: A = bit15 ? 0xF : 0, RGB = top 4 bits of each channel).
- Palettes: 59 banks × 16 colours, records @005b9a80, uploaded once at start-up by `palette_upload`.
  Bank for texture *i* of set *s* = `tex_palette_bank(s, i) + 1` (default bank 0 if > 0x3f; sets loaded
  through `tex_register_model`, i.e. common.bin, use bank 0). `tex_palette_bank` is a jump-table
  switch: the port reads the byte/jump tables from the exe and implements its 29 handlers.
- **Quirk:** for 4-bit textures taller than 2× their width, the exe keeps interleaving instead of using
  square blocks and reads past the texture's data (252 textures, almost all `scr_jimaku*` — Japanese
  subtitle images, probably unused in the English version). The port replicates it.
- **Orientation:** all textures are stored bottom-up (signs, doors and UI text read upside down in
  memory order). The exe uploads row 0 first, so the game's UVs count from the bottom. The renderer
  must upload rows unchanged and use the original UVs; the viewer flips for display only.

Port: `packages/formats/src/pvr.ts`, `texsets.ts`; checks in `test/pvr.test.ts`, `test/textures.test.ts`
(all 11 913 textures decode).

## Models (M4)

- `pol` file: table of `(offset, offset)` u32 pairs (one per model), terminated by `(fileSize, 0)`,
  zero padding up to the first model. Raw stage files use the same format uncompressed.
  355 files, 10 022 models, 44 817 meshes, 2 080 932 vertices — all parse.
- Model: 0x18-byte header `{u32 ?, u32 flags, f32 centre xyz, f32 radius}`, then chunks until a word
  whose low 31 bits are 0 (`model_draw` compares it as a float with 0.0). Flags seen: 1, 3, 5, 7.
  Flag 0x10 would select a 14-float vertex format; unused.
- Mesh header (bit 31 set), 20 words: `[0..3]` PVR PCW/ISP/TSP/TCW · `[4..7]` bounding sphere (used
  for culling via ComputeSphereVisibility) · `[8]` texture index into the **same-named tex set's**
  descriptor list (-1 = none; `tex_register_model` patches it to `id | 0x40000000` in memory, and
  `model_draw` indexes the slot table with it ×4, which wraps back to `id`) · `[9]` specular exponent n
  (power `1 << n`) · `[10]` ambient scale · `[11]` alpha · `[12..14]` RGB · `[16..18]` specular RGB ·
  `[19]` byte size of the primitive chunks that follow (verified exact for every mesh).
- Primitive chunk: `u32 flags, u32 count`, vertices `x y z nx ny nz u v` (FVF 0x112).
  `flags & 8` list (count = triangles) else strip · `flags & 0x80` clear → set cull (`& 3` via
  `g_cull_table`: 0,1 none, 2 CCW, 3 CW) and shade mode (`& 0x40` Gouraud) · `flags & 0x20` → each
  vertex is inline (x has bit 0 set) or a reference `{marker, i32 byte offset from the end of the ref}`.
  With MIRROR addressing and a device-caps bit clear, the reference path folds UVs into [-1, 1]
  in software (`u' = ±1 − frac(u)`); assumed inactive on modern hardware — open question.
- Render state (`apply_pvr_state`): ISP 31-29 → ZFUNC (inverted, DC depth is 1/w), ISP 26 → no Z write,
  TSP 31-29/28-26 → SRC/DESTBLEND, TSP 23 → fog off, TSP 20-19 → alpha test (and opaque vs translucent
  pass), TSP 18/16 & 17/15 → ADDRESSU/V (flip → mirror, clamp → clamp), TSP 14-13 → point/linear,
  TSP 7-6 → alpha op (mode 1 SELECTARG1, else MODULATE); colour op always MODULATE.
  Global: ALPHAREF 1, ALPHAFUNC GREATEREQUAL, SPECULARENABLE, DITHERENABLE.
- Drawing: opaque meshes (`(TSP & 0x180000) == 0x80000`) are drawn immediately with blending off;
  others are deferred to `model_draw_deferred` (blending on). `model_draw_fade` (object flag
  0x20000000) multiplies alpha by the object's fade value and forces SRCALPHA/INVSRCALPHA.
- Texture orientation: with texel rows uploaded unchanged and the original UVs, everything renders
  upright (checked on Stage 1 buildings, a player face) — confirms the bottom-up storage finding.
- Character files hold body parts in local coordinates (assembled by the skeleton in M5); stage files
  are already in world space.

Port: `packages/formats/src/pol.ts`, `renderstate.ts`; WebGL2 renderer `packages/web/src/gl/`.

## Function discovery (M5)

Ghidra's auto-analysis covered only 56 % of `.text`: much of the game is reached only through
function-pointer tables (task/state callbacks). `re/scripts/FindFunctions.java` creates functions at
(1) data words pointing into uncovered code and (2) 16-byte-aligned starts after NOP/INT3/RET padding,
then re-analysis: **920 functions recovered, coverage 92 %** (3 261 functions decompiled).

## Characters & motions (M5)

- Global model ids: `g_model_file[id]` → pol file index → `g_pol_names[file]`; the model's index in
  the file is the position of `id` in `g_pol_id_lists[file]`. The texture set has the same index (hence
  "same name"). In the pol table, entry `(start|noTexFlag, modelOffset)`; a model's block runs to the next
  entry's start (the `(fileSize, 0)` terminator closes the last one).
- **86 character skeletons** `g_chr_skeletons` (joint counts `g_chr_joint_counts`, nearly all 16):
  node `{i32 model id, f32 rest offset xyz, ?, i16 joint, i16 nChildren, node*[]}`. Root (joint 0)
  has no model. Standard humanoid: j1 chest → j2 head, j3–5 / j6–8 arms; j9 hips → j10–12 / j13–15 legs.
  Every drawable node resolves to an existing model (test). Characters include players (57 = player1 /
  James), zombies `zn*`/`zs*`, townspeople `hito_*`, animals, all bosses.
- **Motions**: `mot/*.bin` starts with u32 offsets (one per listed motion id, `g_mot_id_lists[slot]`;
  order not necessarily sorted). Motion = u32 stored frame count + frames of `align4(12 + 6n)`:
  f32 root xyz, then i16 rx, ry, rz per joint (joint 0 = root). Stored count = `floor((F−1)/2) + 2`
  where F = 60 Hz frame count `g_motion_frames[id]` — verified for all 1 116 motions; blocks padded to 8.
- **Playback** (60 Hz frame f): root position = stored[f/2], halfway to stored[f/2+1] on odd f; root
  rotation = stored[f/2]; joint rotation = stored[f/2] on f = 0 or odd, and on even f the integer
  halfway point (shortest way round) from the angle shown at f−1 — i.e. joints lag positions by half a
  frame. Matrix order: root `Rx·Ry·Rz·T(rootPos)·object`; joint `Rx·Ry·Rz·T(restOffset)·parent`
  (Sega angle units, 65536 = 360°; rotations are D3DX-style).
- Which motions a character uses is chosen by game code (AI/scripts); the viewer offers every motion
  whose block size matches the joint count. Mismatched pairings can leave gaps (e.g. zsass with zom.bin);
  the right pairing (zsass with assb.bin) is seamless.
- **Prop skeletons** (30 types `g_prop_skeletons`: doors, glass, bridge, water…) use a different motion
  layout (per-joint positions + angles, `(18n − 15) & ~3` per frame) and interpolation modes 0/1/2 —
  needed for the stage scenery in M7.
- Matrix stack: `mtx_push/pop/translate/rotx/roty/rotz/identity` (@004c2100…), each premultiplying.

## How these claims are checked

`packages/formats/test/notes.test.ts` re-checks the notes against the user's own install
(`TTOTD_DIR=~/Downloads/TTOTD npm test`): exe constants and code bytes, path/save tables, word XOR,
size limits, evt pointer targets. LZ claims are covered by `real-data.test.ts`.

## Open questions

- Loader for `raw` stage pol/tex (sector streaming).
- What enables the fixed RNG seed (`FUN_0047ed90`) and where `g_rng_counter` advances.
- `myth.acm` / `mythxpak.exe` (installer unpacker; `myth.acm` not referenced by name in the exe).
- Settings INI name/keys (`read_ini` @004be890).
- Software UV mirror fold in `model_draw` — which device-caps bit (`DAT_00849128 & 2`) enables it.
- Lighting: `light_setup_single` @004c2bb0 sets D3DRS_AMBIENT (0x8B) from three floats and one
  D3DLIGHT7 @0087a6d0 (direction/colours from globals @0087a740.., scaled by constants @004f100c,
  @004dd4a8), enables light 0, disables 1–15. `light_setup_multi` @004c3490 (object flag 0x4000000)
  sets ambient from @0087ade0 and up to 16 D3DLIGHT7s from @0087a760 (stride 0x68), enabled per
  flag @0087ae6c. Open: who writes these values (per stage / event) — trace in M7. Fog render
  states (FOGCOLOR 0x22, FOGSTART/END 0x24/0x25) are set around @004c4xxx — also M7.
