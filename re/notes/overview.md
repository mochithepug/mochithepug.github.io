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

## Words & font (M6)

- **Word lists** `word/Z*.bin` (488, names @004f3bc8): XOR 0x41, then 12-byte records
  `{i32 value, u32 textOffset, u32 codeOffset}` until low 16 bits of value = 0xFFFF (offsets relocated
  by `word_list_relocate`). text = ASCII word; codes = same word in the game's 1-byte charset
  (0–9 → A2–AB, A–Z → AC–C5, a–z → C6–DF, punctuation E3–F8) — verified for all 14 061 words.
  `value` meaning unknown (Z000L040: all 40; Z000L010: 4…19).
- **Typing letters on screen are NOT from font.bin.** Each character is a textured quad model
  (`g_letter_models[ascii]` → `pol/tod_boxetc.bin` #14–#134; space has no model and only advances),
  texture #0 of `tex/tod_boxetc` = 256×256 4-bit atlas, **palette bank 0** (model-path textures — see
  below). Mesh: SRCALPHA/INVSRCALPHA, alpha = texture alpha only, point sampling.
- **Layout** (`word_draw_title` → `word_draw_line` → `word_draw_letter`): x0 = x + (adv(first)/2 −
  width/2)·size·0.75, y −= 0.4·size; per char x −= left·size·0.75, draw quad (x ±0.38·size, height
  1.0·size for word lines), x += adv·size·0.75; g/p/q/y −0.2·size, j −0.1·size. Metrics: Ａ–Ｚ 0.9, most
  lowercase 0.8, i/l 0.6, j 0.65, r 0.7, m/w 0.9; left 0.2 for I/i/j/l, −0.1 for m; space 0.4.
  Colours: word line (1,1,0) yellow, player lines (1,1,1) white; typed characters are skipped but keep
  their space (so the remainder stays right-aligned).
- **Verified against the user's 640×480 boss screenshot**: rendering with the exact letter quads and
  fitting only size/position gives pixel overlap 0.80 (Mercury) and 0.85 (Hydrogen) at the **same size,
  23.75 px**; Dogma's letters match too (its score is lowered by the box border in the crop).
- **font.bin** = Japanese system font (menus, name entry…): 7 807 glyphs, 24×24, 2 bpp, index table
  `g_font_glyph_index[sjis]` (glyph = font + 0x10 + idx·0x20, 160-byte slots). Character textures are
  32×32 ARGB1555 with the glyph at (2,2): shade v → grey `(0x55,0xAA,0xFF)[v−1] & 0x1F` (21,10,31 — the
  middle shade is darker, exe quirk) plus a 1-px black outline (8 neighbours).
- **Palette bank rule (correction to M3)**: textures registered for models (`tex_register_model`) use
  bank 0 — the per-set switch only applies to 2D sets loaded with `load_tex_set`. The M3 viewer had shown
  model sets' 4-bit textures with the 2D rule (e.g. the letter atlas looked hollow); fixed.

## Stage geometry & loading (M7a)

- Loads go through a 64-entry request queue `g_load_queue` (16-byte requests), dispatched by type
  (`g_load_dispatch` @005e98f0). `load_request_model(id)` (type 0/1) loads **one model** by global id with
  a raw read at its offset in the pol file (no decompression) — this is how the sector-aligned **raw stage
  files** are used; `load_request_file(fileIndex)` (type 3) loads a whole LZ pol file + its tex set.
- Stage 1 geometry: `st1_01/03/04/05` and their `b`/`c` parts each cover a different area of one world-space
  scene and meet seamlessly; `st1_02` is small and inside `st1_01`'s area (likely an interior);
  `st1_1`/`st1_1b` are a huge backdrop (sky dome + several concentric rings of city wall — probably
  variants shown one at a time); `etc_1_*` are small local-space objects placed at runtime.
- Open: which pieces / backdrop variants are loaded when (likely driven by the event tables).

## Camera paths & the game camera (M7b)

- `cam/*.bin` (slots: names @004f3abc; per slot path-id list @004ddc44, count @004ddca4): u32 offset per
  path, data area at `4 + count·4`. Path = 7 i32 channel indices (×4 bytes into the data area):
  0–2 eye xyz, 3–5 look-at xyz, 6 roll (int; only if flag @00a110b0).
- Curve: `u16 capacity (power of 2), u16 searchDepth`, keys `{f32 t, value, outTangent, inTangent}`;
  `cam_curve_eval` = padded binary search + cubic Hermite (tangents per time unit). **Verified: every
  curve of all 14 camera files passes exactly through its keys** (test).
- Paths form a **route graph**: each path continues into those starting where it ends; branch points
  (Stage 1: 7, 10, 13; Stage 2: 6, 8, 9, 19, 38) are alternative routes, and paths with no neighbours are
  standalone event shots (Stage 2 has 30). The event script chooses the actual sequence.
- The exe's only COM objects are DirectPlay + DirectPlayLobby (networking) — there is **no video
  playback**; story scenes are real-time (characters + camera shots + voices + subtitles).
- `cp_st1.bin`: 23 paths (ids 48–70), 140–800 time units each. Playback assumes 1 unit = one 60 Hz frame
  (consistent with the frame-based engine; to confirm against a recording). The real order/timing of
  paths is driven by the event script (M9); the viewer plays them in id order.
- Angles (`look_angles`): d = eye − target, yaw = int16(trunc(atan2(dx,dz)·K)), h by quadrant,
  pitch = −int16(trunc(atan2(dy,h)·K)). View (`camera_build_matrices`) = Rz(−roll)·Rx(−pitch)·
  Ry(−yaw)·T(−eye) — this looks along **−z**; the device's fixed **D3D VIEW matrix is diag(1,1,−1)**
  (`device_state_init`), so the full view = game view · z-flip (a reflection, det −1). The game folds
  its view into each object's WORLD matrix.
- Projection (`projection_setup`): T(shake) · perspective(fov 0x1D3B → half-angle trunc(×0.5) ≈ 20.55°,
  i.e. 41.1° vertical, aspect 4/3, near 0.5, far 8000), D3D LH.
- **Correction to M4–M6 viewers:** they used a plain LookAtLH (no z-flip) and a cull mapping that was
  inverted relative to the real pipeline; the two errors cancelled for culling but every viewer showed
  a **mirror image**. Fixed: renderer maps D3DCULL_CCW → GL front = CW (verified with the exact game
  pipeline: correct faces culled), and all viewer cameras use the game's convention (`gameLookAt`).
  A letter "R" model now reads correctly.
- Device defaults (`device_state_init`): ZENABLE, ALPHAREF 1 / GE, COLORVERTEX 0, COLORKEYBLEND 0,
  diffuse/specular/ambient/emissive material source = material, CULL none, Gouraud — relevant for 7c.

## Lighting & fog (M7c)

- Scene inputs (updated each frame by `scene_light_update` @0044fee0): light colour `g_scene_light_colour`,
  intensity `g_scene_light_intensity`, direction from two Sega angles (`g_scene_light_pitch/yaw` →
  `light_dir_from_angles`: (0,0,1)·Rx(pitch)·Ry(yaw), then into camera space = D3D world space, because the
  game folds its camera into WORLD), fog start/end `g_scene_fog_start/end`, fog colour. Set by game and
  event code (not found as direct pointers in the event tables → event commands; M9).
- `light_setup_single`: s = colour × intensity; AMBIENT = trunc(s·255) per channel; light 0 directional,
  diffuse = specular = s × 1.4, light ambient = colour × 0.3; lights 1–15 off.
- Device defaults (`device_state_init`): LIGHTING on, COLORVERTEX 0, material sources = material, local viewer
  (D3D7 default), NORMALIZENORMALS off, SPECULARENABLE on, Gouraud (per-primitive flat via prim flags).
- Fog: LINEAR; **table fog** if the device supports it (caps bit @00849104 & 0x100) else vertex fog;
  FOGSTART/FOGEND = min/max(2·start, 2·end); FOGCOLOR via `fog_set_colour`; per mesh FOGENABLE = !TSP bit 23.
  The 129-entry table `fog_set` also builds is a Dreamcast leftover (PowerVR fog table), not used by D3D.
- Known examples: one mode sets colour (1, 0.2, 0.1) and fog −600..1800; boss scenes aim the light from the
  boss with tint (1, 0.78, 0.57).
- Port: `packages/formats/src/scenelight.ts`; renderer implements the D3D7 lighting equation (ambient =
  Ma·(Ga + La), diffuse = Md·Ld·max(N·L,0), specular with half-vector and local viewer, clamped; normals by
  inverse-transpose without renormalising), flat shading (D3D first vertex), linear W-based table fog.

## Dialogue: voices & subtitles (found while answering a user question)

- `say(dialogueId)` @004239a0: variant by player character (@00a39540: James / Gary / two players) via
  `g_dialogue_variants` → speech record `g_speech` (duration in 60 Hz frames, voice sound id, Japanese
  subtitle image) → plays the voice and starts `subtitle_task`, which shows up to 4 lines from
  `g_speech_lines` → `g_subtitle_lines` (text + "next line when remaining < N").
- Example: dialogue 1 = "We're meeting G over there.", 120 frames, separate James/Gary voices (01_J / 01_GA);
  dialogue 3 = two lines, 420 frames, switching at 130 remaining. Port: `packages/formats/src/dialogue.ts`.
- Open: sound id (e.g. 0x20000182) → WAV file mapping; which dialogue plays when = event script (M9).

## Event scripts (M9)

Port: `packages/formats/src/events.ts`; viewer: Events tab.
- **Loading:** files are raw with DC pointers; `comevtbl` at DC 0x0CEB5800, the stage file at DC 0x0CEB5A00
  (see the file-loading table). `comevtbl` words 0–13 point each mode at the stage table (mode 9 at
  0x0CEB5994 inside comevtbl).
- **Layout:** u32 block pointers (−1-terminated) → block = −1-terminated list: entry 0 = set-up (Stage 1
  block 0 points into comevtbl), entries 1… = scripts run in order. Commands are u32 words: opcode, then
  arguments.
- **Block order:** `g_evt_block_rules` @005e98b8[mode] gives 8-byte rules {kind, a, b, c}: kind 0 → a,
  kind 1 → [a, b, c][choice DAT_00a3b264], kind 2 → this + 1 (Stage 1's last block 14 → 15 = end).
  Stage n uses mode n − 1 (rule counts equal block counts for all six stages).
- **Interpreter:** `evt_run` @0044e8b0 loops `g_evt_ops[op]()` until the yield flag DAT_00a3b860 is set.
  `evt_next_script` (0x4F) moves to the block's next script, or the next block by rule.
- **Command lengths** (bytes, op word included):
  - Most commands are fixed; the table is in events.ts.
  - Lists ending in −1: 0x01–0x0D except 0x0E, 0x0F–0x13, 0x72.
  - 0x60: 5 words, then (count, value) pairs until −1.
  - 0x49–0x4B: words until −2 (one list per player count).
  - 0x30/0x6C/0x6D: 8 + trunc(arg/16)·4 (inline data).
  - 0x20/0x24: by subcommand (5 and 9 → 20; 0–10 → 12; else 8; case 5 falls through into 4 in the
    exe).
  - 0x21/0x23/0x25/0x27: 16. 0x69: 8 if arg ≠ 0, else 12.
  - 0x00/0x2A/0x34/0x3C/0x4C never advance (unused).
  - **Verified:** all 458 scripts of the six stage files decode into whole commands ending on a
    terminator before the next script.
- **Identified commands:**
  - 0x2D `say(dialogue)` (u16 id), 0x2C skippable on/off, 0x41/0x42 wait until segment frame N (0 =
    wait for the timer), 0x4D segment start (resets the timer and RNG), 0x4E halt, 0x4F next script,
    0x71 return, 0x73 branch on game mode (≥ 100 = not equal).
  - 0x09/0x0A/0x72 spawn lists (pointers to records: type, …, position, angles).
  - Positioned spawn record (ops 0x09, 0x03 one-player, 0x07 two-player; handler @0041fe50): +0x00 object
    type (task table @005a741c), +0x04 param → obj +0x34 (| 1), +0x08 f32 xyz → obj +0x40, +0x14 i32 angles
    → obj +0x64, **+0x22 i16 hit points** → obj +0x11c/+0x11e (current/max; health bar = cur/max, dead
    below 1), **+0x24 signed byte skeleton** → obj +0x1f8 (index into `g_chr_skeletons`), +0x25 byte kind
    → obj +0x1310. Stage 1's opening wave: type 0x30 (`FUN_00441d80`), skeleton 7 `znsam2`, 100 HP.
    Type 0x30 replaces +0x1f8 with byte 0 of the data at obj +0x1394 unless it is 9; who sets +0x1394 for
    these objects is still open. Type 0x30's draw (`FUN_00442bc0`) scales ×2 (×1.8 for skeleton 14) only
    when DAT_00a3bac0 & 2.
    Type 0x30 starts motion obj +0x1b8 = 0x3f5 (`zom.bin#13`; 0x457 only when obj +0x1310 is already 4 — not for fresh spawns): frame 0
    puts the feet at y ≈ 0. Model front is local −Z (the unanimated pose has the feet turned to +Z). The
    body keeps the record's yaw; only node 2 (head, `FUN_00442c60`) turns toward the camera eye
    (DAT_00a396a0 ← DAT_00a149e0, +15 y), within ±0x4000 of body yaw − 0x8000, when obj +0x34 & 0x40000
    is clear. Object matrix (`FUN_0044c630`): translate, rotX(+0x64), rotZ(+0x6c), rotY(+0x68).
  - Ops 0x03/0x07 re-dispatch through @0059901c[DAT_00a10c04]; entry 3 = `FUN_00420120` → `FUN_00420050`
    per record, which also sets obj +0x1394 = record + 0x24 and +0x131a = record word 8. Type 0x30 reads
    from it: [0] skeleton (kept if 9), [1] kind → +0x1310, [2] behaviour → +0x1314 (`PTR_FUN_005a215c`).
    Stage 1: behaviour 18 (`FUN_00446700`) for the opening wave; **behaviour 26** (`FUN_00447380`) waits
    record +0x28 frames, then moves along an arc (`FUN_00437460`) to the target at record +0x2c..+0x34
    over +0x38 frames, playing motion 999 (0x3c4 if obj +0x34 & 0x1000000) — the blk4 zombie spawned at
    y 61 over a floor at 35. The blk1 kind-2 zombies (y 11, floor 1.86) also start in the air; kind 2's
    movement is not decoded yet.
  - Placed objects (type 0x41, `FUN_00454d30`): a 0x380-byte sub-object with task `PTR_FUN_005b52d4`
    [kind], placed at the record's pos/angles. Record +0x22 → sub-object +0x11c (the object is removed
    once the scene counter DAT_00a11850 has changed more than that many times, `FUN_00454a20`) and +0x294
    (model id for some kinds). Per-kind setup switch covers kinds 6–0x4d only (byte table @00455b8c,
    jump table @00455ae8, index kind − 6). The allocator `FUN_004beb60` zeroes only the first 0x34 bytes.
    Breakable sub-types @005b5b10 (12 bytes: prop type, prop motion, ?, ?, radius, height; 12 entries)
    feed obj +0x32c/+0x330/+0x124 (set for kind 0x2b from angle z).
    Stage 1 kinds → fixed model ids found in their code: 0 → 0x110d (common #200, round shadow),
    7 → 0x17ea (komono_st1 #8), 9 → 0x1284/0x1285 (kyoukai_garasu #0/#1), 41 → 0x961 (komono_st1 #0),
    44 → 0x10a1 (komono_7 #0) + shadow, 45 → 0x17e9 (komono_st1b #11), 57 → 0xd7f/0xd80 (komono_st1b
    #3/#4). Kind 4 (21 placements, `FUN_004590c0`): breakable — intact draws model +0x294 (unless −1),
    broken plays the prop skeleton (+0x32c type, +0x330 motion); where kind 4 gets those fields is open.
  - **Op 0x0B** (`FUN_00420120`, also entry 3 of @0059901c) spawns every record of its list through
    `spawn_record` @00420050 — same 10-word positioned records; not decoded by the player yet. Stage 1 block 0
    uses it for types 0x26, 0x22, 0x44 ×2, 0x20 ×4; block 1 for 0x33 ×2, 0x24 and some 0x30 zombies.
  - **The opening car** (players driving) = type 0x26 (`FUN_00485140`): record +0x22 (obj +0x11c) picks the
    scene variant 0–7; Stage 1 uses 1 (`FUN_004854b0`). Each frame it places itself on an **object path**
    chosen by the current camera path DAT_00a11a18: 0x30 (48) → path 0x11f, 0x31 → 0x120 (until camera time
    0x15d), 0x32 → 0x121 (+ door angle from it); time = camera time clamped to the path length
    (@00598508[path]). `FUN_0040e9a0(path, t, out[6])` samples 6 channels (x, y, z, rx, ry, rz) via
    `FUN_0040e7c0` from @005f1cd8[path] (channel indices) into the data @005f2afc[@004ddcd4[path]] —
    not the cam/ slot ids, format not decoded yet. Draw (matrix: translate, rotZ, rotY, rotX): body
    0x1603 + 0x1608, figures 0x8c9 and 0x8fd (head bobbing with sin(frame·0x200)), doors 0x1606/0x1607 and
    0x1604/0x1605 (rotY by obj +0x1338), wheels 0x1609 spinning +0x2000 per frame — `char_adv00.bin`
    #49–55 and #0, car_pl #8 (0x8fd = steering wheel: rotX(−0x1c00), rotZ(trunc(sin(frame·0x200)·10240)),
    rotX(0x1c00); 0x8c9 = soft top; dust 0x8ff + frame % 12 at the four wheels, right side mirrored by scale
    (−1, 1, 1)). Object paths are in **cam/op_stN.bin** (cam slots 15–23, same format as the camera files,
    6 channels); Stage 1 paths 0x11f–0x121 = op_st1 local 0–2, lengths @00598508 = 280 / 350 / 150.
    Ported: `packages/engine/src/opencar.ts`. Type 0x33 (`FUN_004216f0` → `FUN_004218f0`) is another car type.
  - **The daemon in the opening** (corrected 2026-11-23 — first noted as "the players") = type 0x22
    (`FUN_004b4330`, op 0x0B): body = skeleton 0x45 (69, char_adv04: the red winged demon, boss1 motions)
    with motion = record +0x26, wings = a sub-object (obj +0x13b4) with skeleton 0x46 (70, 7 joints, bat
    motions), motion 0x10. It speaks the fly-over lines ("I've already taken care of G."). Kind
    (record +0x25) 0 → behaviours @005eb3b4[obj +0x1314]: **0** (`FUN_004b4510`, fly-over): placed at
    (−406, 152.5, 142.4) yaw 0x717f (on a rooftop); camera time 70 → motion 0x448 blend 5 (+voice 0x4317a9); motion end → 0x444 (1092, hard switch; corrected); not drawn while waiting for time 170;
    time 170 → voice 0x4517a9; then follows object path 0x122 at camera time until the title card ends
    (DAT_00a397b8) → behaviour **1** (`FUN_004b4680`): camera path 0x31 → path 0x123 (t 250 → motion 1098
    blend 8; t 280 → motion 1103 blend 3, then 1098 when it ends), 0x32 → path 0x124 (t 180 voice, t 240 →
    motion 1099, then 1098); ends when the camera reaches record+0x24 +6 (path) / +8 (time). Drawn by
    `FUN_004b6d70`: the body's skeleton, then the wings placed by the body's stored node matrix (+0x2c8)
    with angles from it (`FUN_0040c040`), the wings' motion from @0058f970[state +0x1354]. Motion change with blending:
    `FUN_00475900(motion state, id, start, blend)`; hard switch `FUN_00475890`. Not ported yet; not drawn
    while the title card is up.
  - 0x0E set slot xyz (a11880).
  - 0x20–0x27: two families of view/parameter commands with subcommands (camera/light? → 9b).
- **What the script controls (decoded while building the player, `evtplayer.ts`):**
  - **Camera** — 0x30 `camera` (0x6C/0x6D: one-/two-player only) queues a camera command: arg = mode, and
    its high nibble = parameter word count. `cam_queue_run` @0040ca70 copies the parameters to
    0xA14AA4… and runs the mode handler from table @005a2a30; the next command runs in the same frame.
    - Mode 0x40 [start, end, pathId, flags]: play camera path `pathId` (global id; Stage 1 = 48–70 =
      local 0–22). Camera time DAT_00a14a30 = start (−1 = keep) and +1 per frame up to end
      (FUN_0040dc20/0040dcd0); start = end jumps; flags & 2 stores the path to resume after the fight
      (FUN_0040dba0).
    - Mode 0x21 [n]: hand the camera to the fight (gameplay).
    - Modes 0x11 / 0x12 / 0x14 / 0x60: screen effect (FUN_0040e2c0), player state, view player, look-at.
  - **Waits:**
    - 0x41 N: continue once N < camera time.
    - 0x41 0: wait until the shot has < 1 frame left (DAT_00a39468).
    - 0x42 N: wait N frames.
    - 0x40: wait while camera commands are pending (DAT_00a11924).
    - A wait reached mid-frame always yields once first (yield flag DAT_00a3b860 persists across
      frames). 0x4F does not yield.
  - **Light & fog:**
    - 0x20 sets immediately. Subs 0/1 fog start/end (pointer to a float); 2/3/4/5 fog colour (0–255,
      packed into FOGCOLOR by FUN_00451470); 6/7/8/9 light colour (pointers); 10 intensity.
    - 0x23 fades the same values, using {active, current, target, step} records @00a3b3a0 stepped by
      FUN_00450240 (step per frame).
    - 0x18 sets the light direction (pitch, yaw). 0x24/0x27/0x19 do the same for a second set
      @00a14140.
  - **Sound:**
    - 0x38/0x3A play a sound (FUN_00495660); 0x39/0x3B repeat one.
    - 0x50–0x57 are sound/bank commands. 0x5D/0x5F: music/stream.
  - **Screen:** 0x61 screen mode (FUN_004b1510).
- **Stage 1 block 0 as played:**
  - Light fades in; path 48 fly-over (230 frames), skippable from camera time 21.
  - Fade to black (fog closes in, light → 0).
  - Path 49 with "We're meeting G over there." at camera time 6.
  - Lines 2–3 on path 49, then path 50 in three pieces with lines 4–6.
  - First fight (camera mode 0x21 [4]), then block 1.
  - Matches the user's video notes. Title card (≈3 s black card) not yet located: candidates are
    camera mode 0x11 [1] and `screen_mode 0 25`.
- **Stage 1 shape:**
  - Block 0 (opening): skippable scene → `say(1)` "We're meeting G over there." → skippable scene with
    lines 2–5 → line 6.
  - Block 1 has two skippable scenes. Block 14 is the final one (lines 24–40).
  - Branches: block 1 → 10 | 9, block 4 → 6 | 13, block 6 → 11 | 5, block 9 → 2 | 7 | 12 (by choice).

## Props (M7d)

Port: `packages/formats/src/prop.ts`; viewer: Props tab.
- **Skeletons:** `g_prop_skeletons` @004f7f0c (30 types). Root: +6 i16 child count, +8 PropNode*[].
  PropNode: +0 i32 global model id, +4 i16 joint (1-based; < 1 = no transform and not drawn, though its
  children are), +6 i16 child count, +8 PropNode*[]. **No rest offsets**: every joint's position comes
  from the motion, relative to its parent. `g_prop_joint_counts` @004f7f84 holds n (frames hold n − 1
  joints); `g_prop_interp_mode` @004f7fc0.
- **Motion:** u32 stored-frame count, then frames of `(18n − 15) & ~3` = align4(18·(n − 1)) bytes:
  (n − 1) × f32 xyz, then (n − 1) × i16 rx,ry,rz. Same `g_motion_frames` table and `mot/` files as
  characters (mostly `komono*.bin`; some stored raw rather than LZ).
- **Playback** (`prop_skel_draw` @00454680, `prop_joint_transform` @00454290): the object holds {type,
  motion, f, prev} (+0x32C… in game objects); f ≥ F − 1 wraps to 0, f < 0 to F − 2.
  - Mode 0: stored frame f.
  - Modes 1 and 2: even f uses stored frame f/2. Odd f uses halfway between f/2 and f/2 + 1 (or frame 0
    on the last frame when playing forward): position (b − a)·0.5 + a; angles a + trunc(wrap(b − a)/2).
  - Mode 2: when all three angle deltas exceed 0x3000 (and f > 1), the exe blends rotation matrices with
    FUN_00476550 (not ported yet; approximated by a quaternion slerp).
  - Joint matrix: T(pos), then rotZ, rotY, rotX (premultiplying), × parent.
  - Model 0x110B flickers (uniform scale (rand() % 11)·0.01 + 0.27).
  - Game objects advance f by 1 or 2 per tick, depending on the object.
- **Pairings** (`GAME_PROP_MOTIONS`): from object set-up code (literal type/motion stores) and
  {type, motion, …} 12-byte records @005b5b10. A test checks that every pairing fits the layout exactly.
- **Water #28** = 6 one-sided translucent cards (droplet rings, texture mostly transparent, mesh alpha 0.7,
  culled like everything else): invisible from behind. The Props tab shows them with culling off or
  after rotating the view; in the game the owner object presumably faces them towards the camera (M9).
- **Checked visually:** at frame 0 props are intact objects (barrels, gates, window panes, cell grate,
  cabinets, chairs, pots, the full door #15). Glass #8 shatters into shards; door types #12–14 are
  splinter debris.
- **Open:**
  - #16 `garasu` is mode 0 with its only fitting motion (506, 37 stored frames for F = 72): read
    directly, the frames run past the end, so its owner probably steps or limits f differently.
  - #29 (letter boxes + `komono_2`, n = 46): no motion fits.
  - #4, #18, #21, #24: pairing not yet seen in code (the viewer uses the size match).
  - The mode-2 matrix blend is not yet exact.
- **Placement:** prop positions are small and local, so the owning game object places each prop (its
  position, angles and when it starts). Those objects are spawned by the event script → M9.
- **Cars** are not props. `FUN_004218f0` assembles one from parts: the body at the object's position and
  angles, plus wheels at fixed offsets spinning +0x2000 per frame. Models: `car_pl` (0x8C1…, 0x8FC wheel),
  `car_2` (0x1E4F…). A script record (+0x1394) gives a trigger time; at that time the car spawns an
  explosion effect (FUN_00412010, effect 0x44/0x45) and sound, then animates a burning sequence of models
  (0x1D71–0x1D98). Spawning and route come from events → M9.

## Skippable scenes & the "skip" sign (found while answering a user question)

- The sign is not a string: it is **sprite 0x20F** → texture set `scr_common.bin` (set 0x164) texture 23,
  256×32, global texture id 0x752. Sprite tables: `g_sprite_set` @005c1258 (set index per sprite id,
  0xF74 ids) and `g_sprite_tex` @005c5028 (texture id per sprite id); drawn by `sprite_draw` @004940a0
  → FUN_00493cb0 → FUN_004c4e40.
- Drawn by `skip_task` @00423da0 (started by FUN_00423d80) at **x = 384, y = 18** (640×480 screen), depth
  0.99, scale 1; **blinks**: visible while `frame % 60 < 45` (45 on / 15 off); hidden when
  DAT_00a3e760 == 2 (mode not yet identified).
- The event script turns skipping on/off with **event opcode 0x2C** (`evt_op_skippable` @0044f900, one
  u32 argument; script pointer DAT_00a39668). Opcode table `g_evt_ops` @005a2a4c (117 entries).
  On: DAT_00a11a38 = 1. Enter (input bit 8 for P1, 0x80000 for P2, FUN_004840a0) sets DAT_00a10c18; the
  task then sets the skip flags DAT_00a11a14 / DAT_00a1112c (subtitles stop) and calls FUN_00496670.
- **What a skip does** (ported in `evtplayer.ts` `skip()`): `skip_task` sets DAT_00a14a68 (shot end) =
  DAT_00a14a64 (shot time), so the running path shot ends this frame (`FUN_0040dcd0`: done when end ≤ time).
  While DAT_00a11a14 is set: 0x30 camera commands are not queued (`FUN_0044f310`), the waits 0x40
  (`FUN_0044f5a0`), 0x41 (`FUN_0044f5e0`), 0x42 (`FUN_0044f650`) and 0x74 (`FUN_0044fdc0`) pass at once,
  sounds 0x3A/0x3B are not played and 0x2E stops the voice (`FUN_00495660(0x80000002)`), subtitles end
  (`FUN_004238c0`). The script therefore runs to the scene's 0x2C 0, which clears the flag. DAT_00a1112c
  lasts one frame (cleared by `FUN_00423e40`) and tells scene objects to finish (e.g. `FUN_00440990`).
- Cut-scene objects spawned from `comevtbl` records (event op 0x0A): type 0x63 = `skip_task_start` (every
  skippable scene starts with it), type 0x60 = FUN_00422c00 at the scene's end = the **chapter title card** (corrected
  2026-11-23; not "HUD on"): sets DAT_00a14048 |= 0x20 (the opening car and a few other objects hide), shows the
  stage's title sprites (Stage 1: 0x210–0x217, layout FUN_004241b0) for 0xB4 frames — Enter ends it once fewer
  than 0xA0 are left — then clears the bit, sets DAT_00a397b8 = 1 and ends. The script waits for that with
  **op 0x45 248** (`FUN_0044f7f0`: wait until flag byte DAT_00a396c0[N] != 0; 0xa396c0 + 248 = 0xa397b8), so camera
  path 49 starts only after the card. Object task table @00a11180 is filled from
  {type, fn} pairs @005a741c (FUN_0044e730).
- **Letterbox bars** in cut scenes (user: they slide out at a scene's end, not vanish): drawing code still not
  found. Ruled out (2026-11-23): event op 0x2C (`FUN_0044f900` only sets DAT_00a11a38 / DAT_00a1112c / DAT_00a11a14),
  `skip_task`, the subtitle tasks (FUN_004238c0 / 004239a0 / 00423cf0), D3D SetViewport (never called), any
  untextured 2D draw (every 2D quad is a textured sprite: FUN_00493c00 / 00493cb0 → FUN_004c4e40 → FUN_004c0320),
  sprite draws centred at x = 320 or stretched ≥ 8× (only 0xE36, a full-screen dim in FUN_00498fb0). Next
  candidates: sprites with computed y / scale, a 3D model in front of the camera. The PLAY screen slides the
  bars over 20 frames (provisional).
- **Frame clear = black**: the D3DX context (`DAT_008491e0`, ID3DXContext: +0x14 device, +0x44 RestoreSurfaces,
  +0x48 Resize, +0x4c UpdateFrame, +0x54 Clear, +0x58 SetClearColor) gets SetClearColor(FUN_004bdb00(@008491d0 =
  0, 0, 0, 1)) once at start-up (FUN_004bcec0); every frame `FUN_004bf3c0` = BeginScene + Clear(3) (target + Z).
  Never the fog colour — where nothing is drawn (title card, sky off) the screen is black. The Stage tab shows 60 px bars (640×360 picture) while the scene is
  skippable — **height provisional**, to measure from the user's video.
- `evt/*.bin` are **stored raw** (not LZ) and contain Dreamcast RAM pointers (0x0CEBxxxx), so they need
  relocation (M9). Stage 1 has **5 skippable scenes**: 0x2C on/off at offsets 0x24C/0x268, 0x468/0x530,
  0xF18/0x102C, 0x119C/0x1210, 0x64BC/0x6654. Each "on" follows the same command `… 0A 0CEB5854 FFFFFFFF`.

## Reference observations from the original game (user)

- **Stage 1 opening** (from a gameplay video of the original): camera path 0 (aerial fly-over) → **chapter
  title card** → camera path 1. Consistent with the data: path 0 has no geometric continuation (a cut).
- **Chapter title card** = 2D overlay from `tex/scr_chapter_st1` (9 textures, 4-bit palette, 2D-set palette
  rule): clean serif "The First Chapter" / "A Prelude", grainy copies, dripping scrawled versions and
  "序曲"; the game overlays and jitters these layers (doubled, shaky text — `gameplay/cutscene/1/1.png`).
  One set per stage (`scr_chapter_st1`…`st6`). Effect code to be traced in M9b. Stays ≈3 s (user).
- **Path 1** carries the first line, subtitle "We're meeting G over there." — the first subtitle string in
  the exe (@0059b294); voice `sound/voice/st1/01_J.wav` (James) / `01_GA.wav` (Gary), chosen by player
  character (the subtitle table has James/Gary variants too).
- **Cut scene between path 6 and path 7** (user). Path 6 ends exactly where path 7 starts, so the route is
  paused for the scene and resumes in place; Stage 1's standalone shots (paths 16–22) are candidates for
  that scene's camera cuts.
- **Cut scenes show "Press the Enter key to skip"** in the top-right corner (user) — found in the exe, see
  "Skippable scenes" above.

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

## Object motion system (ported 2026-11-23: `packages/engine/src/core/rig.ts`)

Game objects animate through a motion state at obj +0x198 (`FUN_004742a0` set-up, drawn by `FUN_00474ff0` →
`FUN_00475030`). Not the same code as the sequential playback of the Characters tab (`FUN_00472e10`, used via
`FUN_00473380`).
- State: [0] counter (the object adds 1 after drawing), [2] frame, [4] previous stored index, [6] stored index,
  [8] motion id, [10] blend start, byte +0x30 blend length (N + 1), byte +0x37 flags (1 blending, 0x20 half
  frame), +0x60 skeleton, +0x64 flags (1 draw, 2 root motion, 8, 0x10 root y too), +0x68 object rotation order
  (5: Z, Y, X; 1: X, Z, Y), +0x116c size (skeleton 0x1e 0.6, 0x1f 0.7, 0x20–0x38 0.9, else 1), +0x1158 per-node
  draw hook, +0x1160 last root position. Per joint a 0x90 block at +0x78: +0 model, +4 current angles,
  +0x10 from, +0x1c to, +0x28 world matrix.
- Step (`FUN_00475100`): f = counter % (F + 1); odd f (≠ F) shows halfway between stored frames f/2 and f/2 + 1
  (flag 0x20, t = 0.5); even f shows stored frame f/2. While blending (`FUN_00475900(state, id, start, N)`: from =
  current pose, to = target frame; start = counter − 1, length N + 1), t = (counter − start) / (N + 1) until
  counter − start = N + 2, then counter = start frame + 1.
- Root (`FUN_00474880`, `FUN_00474bb0`): position lerps; with root motion the root's x/z travel since the last
  frame (transformed by the object's rotation and size) moves the object (`obj +0x40`), and only root y is drawn.
  Joints (`FUN_00475660`): half frames lerp angles the short way (d = (b − a) & 0xffff; > 32768 → − 65536;
  trunc(d·t + a)); blends use `FUN_00476550`: rotation from→to split into a swing of the Y axis (angle θ
  around (vz, 0, −vx)) and a twist around Y (φ), applied as rotAxis(trunc(θ·t)) then rotY(trunc(φ·t)), turned
  back into angles by `FUN_0040c040`. Hard switch `FUN_00475890`: counter = frame = 0, no blend.
- Spawn lists: op 0x03 runs only with one player, 0x07 only with two (`FUN_0041fdd0` / `FUN_0041fe10`,
  DAT_00a3b844); Stage 1 lists each wave under both.
- Zombie behaviour 18 (`FUN_00446700`): play motion record +0x28 (the opening wave: 1053, 1052, 1064), wait
  until camera time = record +0x2c (469), then behaviour = record +0x27 (1, the attack — not ported).
  Leap (behaviour 26) as noted above; velocity is zeroed on landing (`FUN_0043cf20`). The landing height comes
  from the floor: after drawing, `FUN_00445a40` (via @005a2234) casts down into the stage collision
  (`FUN_00437100` → `FUN_0040fad0`) and puts the zombie on the floor (`FUN_00413410`) — collision is not ported,
  so the jump variant (motion 0x3c4, which drifts during its 26-frame crouch) lands too low for now.

## Chapter title card graphics (ported 2026-11-23: `objects/t60-titlecard.ts`)

- `FUN_00422c00` (type 0x60) draws, every frame of its 0xB4, `FUN_004241b0(190, 80, 400, 350)` for Stage 1
  (sprite ids @005fa5b0… = 0x210–0x217; other stages use other ids/points — `DAT_00a10c08` cases 1–5).
  Animation state @005fa4b0 (`FUN_00424110` resets it): counter @005fa4c0, phase @005fa4cc, scales/alphas.
  Phases: 0 (frames 0–14) two title halves zoom 1.5×→1 with doubled copies 4.5×/6×→1; 1 (15–45) copies grow
  and fade, sprites 7 and 4 fade in; 2 (46–85) flicker through 5/2/6/3/0/1 then fade; 3 (86–115) nothing;
  4 (116–170) 6/3 grow and fade while 7/4 fade in, then squash-and-stretch of 0/1.
- Sprite draw `FUN_004ac0e0(id, x, y, z, sx, sy, alpha)` → `FUN_00493cb0` → `FUN_004c4e40` (queues a quad;
  alpha → colour byte) → corners in `FUN_004c0320`: half-size = texture × scale / 2, corner table @005eb938
  {(1,3),(3,3),(1,1),(3,1)} minus the anchor (flags & 3, flags >> 2 & 3); flags 10 → anchor (2,2) = centred,
  flags 0 → (1,1) = top-left. Sprites 0x210–0x217 → scr_chapter_st1 textures 0–7 (global ids 0x774–0x77b).
- Extra sprite 0x498 (texture 8) when DAT_00a3bb40 high word = 1: not ported.

## Skin pieces (ported 2026-11-23: `formats/src/skin.ts`, `engine/src/core/rig.ts` skinItems)

Found from the user's report that znsam2's belly showed the background (the original: solid skin to the belt).
Characters have extra **skin models** whose vertices follow two joints, filling the joins between rigid parts;
84 pieces on 64 skeletons (znsam2: the belly, model 0x2298 = znsam2 #2; the daemon: its waist; the wings: two).
  zskamere (skeleton 0x17, user report): piece 0 = the belly (0x2378 = zskamere #2) uses draw function 0x490290,
  identical to 0x490280 (FUN_00490240(piece, 1) → group A0) — was skipped as "unknown". Piece 1 is a chain of 8
  models (FUN_004902a0 → FUN_00490410: each segment's vertices from the previous one's) set up only when
  DAT_00a39f80 == 4; not ported. Skeletons 0x1f / 0x46 / 0x4e list no draw function (never drawn).
- `FUN_004742a0` reads @0055ac90[skeleton] → {count, piece*[]}; `FUN_00475030` after the joints loops the pieces:
  `FUN_0048f910` (once) copies the piece and the joint numbers (@0051916c + piece·0x14: A0, A1, B0, B1, reference;
  other tables for skeletons 0x0e, 0x1f/0x46/0x4e, 0x41, 0x4c, 0x53) and relocates the skin data
  (`FUN_00490710`: slots of −1-terminated byte offsets of vertex records in the model); then the skeleton's draw
  function @00519a78: 0x490280 = group A0, 0x490230 = B0, 0x48fca0 = A0 A1 B0 B1 (`FUN_0048fd70` each), then
  `FUN_0048ff30` draws the model at the reference joint (most skeletons: plain draw).
- `FUN_0048fd70`: L = joint · reference⁻¹; for every slot whose byte in the group's list is ≥ 0, entry =
  position + normal (0x18 bytes) → position·L, normal·L written into the model's vertex records
  (`FUN_00490870` / `FUN_004908c0`, x and normal z with bit 0 set). znsam2: 16 slots, 8 follow the torso
  (joint 1), the rest stay as modelled in the waist's space (joint 9).
- Not ported: skeleton 0x17's own functions (0x490290 / 0x490410) and skeleton 0x4c's variant writers.

## Stage areas & sky (ported 2026-11-23: `formats/src/stagedraw.ts`, `engine/src/objects/sky.ts`)

- **Stage scenery** is drawn by the task `FUN_004031b0` (created by `FUN_004033c0`), not "all st files": per stage
  an area table @00597668[stage−1] (0x18-byte entries of i16 indexes, −1 ends) into a model list
  @005976a0[stage−1] (u32: model id | flags << 16; flag 2 = light group 7 via FUN_004c0260). The current area is
  DAT_00a11124, set by **event op 0x29** (`FUN_00403560`; also unloads the old area's models, `FUN_004034d0`);
  **op 0x28** preloads an area (`FUN_004035a0` → `FUN_00403440`). Each model is culled by a sphere test
  (FUN_00410a20). Nothing is drawn while DAT_00a14048 & 0x20 (the title card). Special cases: model 0x18dc
  (areas 2/3 also draw 0x1401, 0x13ff), 0x19cc, 0x1d1a. Stage 1: 13 areas (area 1 = st1_01 + st1_01b …);
  `st1_1.bin` / `st1_1b.bin` are libraries (skies, distant scenery, props) — never in the area lists.
- **Sky**: task `FUN_0047ede0` (created by `FUN_0047efe0`). Row = DAT_00a118d4 (**op 0x1b**), mode = DAT_00a3e764
  (**op 0x1c**: 0 off, 1 on and turning, 2 on and still). Table @005b93c0, 16 bytes: i16 sky model, i16 layer,
  f32 height, i32 spin, i32 start angle. Drawn at the camera eye + height, rotY(angle) (row 5: rotZ(0x8000)
  then rotY(−angle) — upside down), scale 1.2, then the layer at the eye. Stage 1: row 5 for the fly-over (the
  dome lies below the street and shows through the translucent wet-road meshes, e.g. st1_01 mesh 284), off
  before the title card, row 4 afterwards.
- **Wet-street reflections** are geometry: `st1_01b` (area 1's 0x18b2) is a mirrored copy of the street's
  buildings, bridge and lamps below y = 0 (y −147…4), seen through the translucent puddle meshes of st1_01.
  It only shows because translucent meshes of *all* models are deferred until every opaque mesh is drawn
  (`model_draw` pushes the model with priority DAT_0087a66c & 0xf and depth DAT_0087a6b4 = the largest
  view-space z of its translucent meshes' centres; `model_draw_deferred` qsorts by priority, then far to near,
  `FUN_004c12c0`). Drawing opaque + translucent model by model hides the reflection behind the puddles' depth.
  Port: `Renderer.draw({ pass })` + `translucentDepth` in the game screen (priority not ported: all 8 so far). Rows 8/10/11 have their own placement (not ported).
- Ops 0x1d (DAT_00a3b804), 0x1e (DAT_00a3b438), 0x1f (DAT_00a3e7b4) set other display globals (not traced yet).

## Zombie behaviours (type 0x30; behaviour table @005a215c[obj +0x1314], state +0x1316)

- **1 `FUN_00444520` approach**: each frame two crt_rand; motion = set[2 + bit 27 of obj +0x34] (walk / fast
  walk; set = @005a2330[skeleton][kind = obj +0x1310]) blended in over 10 frames from a random frame (FUN_00443860);
  band = `FUN_00445750` (ground distance to the player DAT_00a396a0/a8 against row obj +0x1323 of DAT_00a11880:
  1 ≤ near < 2 ≤ mid < 3 ≤ far < 4; also sets +0x135c from DAT_00a3b7f0..f8). Band 1 → behaviour 2. Else turn
  (`FUN_004372a0`) towards the player + rotY(ftol(player y))·(0, 0, 1.5) at (1 + 1.5·bit27)·416 per frame
  (`FUN_004371d0` short-way step). Bands 2–4 with +0x135c ≤ (char)+0x1321 → behaviour 5; kind 8 → 0x21
  (FUN_00447ff0). Walking itself is the walk motion's root motion.
- **2 `FUN_00444770` stand**: if skeleton ≠ 0, no flag 0x40400 and closer than near − 1 → behaviour 4 (back off).
  Else, when allowed (no flag 0x400, +0x135c > +0x1321, +0x1322 < 3, timer +0x1340 < 1), `FUN_00444e90` asks for
  the player's attack slot (DAT_00a11840[player], one attacker each; obj +0x121 = target player) → behaviour 3
  (kind 4 → 0x34). Otherwise idle set[0] (random start 0–4, voice 0x1917a9) and turn to the player by 0x40
  (`FUN_00437250`). Skeleton 1 / 0x13 / 0x14 first pick a set by which arm parts remain (FUN_00444970).
- **3 `FUN_00444ac0` attack**: attack row from @005a2434 / @005a258c per skeleton & set (random of 10 by
  damage state +0x131c & 7); walks to the attack point (+0x13e8), plays the attack, hits at a frame
  (FUN_00445590), then → 4. **4 `FUN_00444ce0` back off**: set[4] motion, moves to the saved spot +0x13dc for up to
  0xF0 frames / until past near, → 2. Ported 2026-11-23 (one-player rules), details below.
- **Attack details**: `FUN_00444e90` (1P, DAT_00a3b844 = 1): nothing if DAT_00a11a78 (an off-screen attacker
  holds the lock); target = player DAT_00a39540 if its slot DAT_00a11840[p] is 0; `FUN_00437180` (player in the
  fight: DAT_00a39448 = 2 and player state DAT_00a143c2[p·0x104] = 5) else none; `FUN_00436fa0` (on screen: view
  x/z, y/z bounds) — if off screen sets +0x1370 0x20000 and the lock; slot = 1. Released by `FUN_00445620`
  (end of 4; also clears the lock). Attack counts DAT_00a3b7f0/f4/f8 = 2/3/4 (`FUN_00420480`; event "ZXAT2" sets
  them) are only compared with +0x1321 = −1.
  Behaviour 3: state 0 picks row = byte @005a2434[skel][set] + ((rand >> 4) % 10 + (+0x131c & 7)·10)·4; row @005a258c
  [skel][set] + row·16 = {i16 attack, i16 approach, f32 distance, i16 hit frame, i16 damage, u16 arms}. State 1:
  `FUN_00445000` (1P: heading straight at the player, attack point +0x13e8 = player) — farther than distance →
  approach motion (blend 10); else attack motion (blend 5), +0x1370 |= 0x80000, voice (one rand), save the spot
  +0x13dc once (flag 0x40000). State 2: on the hit frame `FUN_00445590` → `FUN_004846d0(player, obj +0x34 &
  0x2000000 ? 0 : 1, damage)` unless all needed arms are lost; motion end → 4. Hooks @005a2240/44 = effects for
  kind 6 only. znsam2 set 0: row 2 = attack 0x42e, approach 0x401, 26, hit frame 55, damage 9 (row 3, one arm
  lost: 0x410, 25, 62, 7). The swing's root motion lunges to ~10 from the camera.
  Behaviour 4: set[4] (znsam2 0x429) from a random frame 0–4; `FUN_00437360` turns towards the saved spot with
  step −0x40 (sign by +0x1370 0x400000) — i.e. keeps its back to it while the motion walks it backwards; ends when
  > 0xF0 frames or farther than near from the attack point (kind 4: 0.7·near), not mid-0x11d.
- Bands: defaults @004dec80 copied at stage start (`FUN_0044eab0`), row 0 = 25 / 38 / 51; event **op 0x0E**
  (`FUN_00420430`) sets a row (Stage 1 does not use it). Set-up `FUN_00441d80`: +0x1310 = record kind, +0x1323 = 2
  for skeleton 0 else 0, +0x1321 = −1, motion 0x3f5 (0x457 for kind 4).
- Player position DAT_00a396a0 ← DAT_00a149e0 = the camera eye (FUN_0040d5b0 samples the camera path, blended
  (1·new + 15·old)/16 only during camera transitions, FUN_0040c4c0).

## Typing: words, word boxes, targeting (M10c research, 2026-11-23)

- **Who gets a box**: `spawn_record` (FUN_00420050) creates a word-box task (`FUN_004b2a30`, 0x2ac bytes,
  box +0x20 = owner) when @005a2848[type] ≠ 0 and the game mode DAT_00a3b858 ∈ {5, 6, 9} (typing modes); owner
  +0x194 = that value | 0x30000000 (word flags). Zombie 0x30 → 1, 0x31 → 4, daemon 0x22 → 0x4000804; 0x20, 0x24,
  0x25, 0x33, 0x41, 0x44 → none. Owner +0x11c = record hp (1 → flags |= 0x14, 2 → |= 0x24: short-word categories).
  Props with words: FUN_00454d30 (@005b5410[kind]). Bosses create their own boxes.
- **Word for a box** (`FUN_004b1ef0` → `FUN_004b1f80`, first frame the box may show): category from
  `FUN_004b2400` (flags 0x10 → 0, 0x20 → 1, 0xc0/0x100 → 5, else the current default DAT_00839cc0); list by
  category (`FUN_004b3f80`, 12-byte records = word-file records): 0 @0058f0e8 (count @0058f928 & 0xff), 1
  PTR @005eaaa0 (count @005eaaa4), 2 the loaded word file (DAT_00846d30, count DAT_00846d2c), 3 @0058f410,
  4 @0058f510, 5 @0058f658. Index = `FUN_004b19f0(lo, n)`: rand % (n − lo) + lo, retried (16×) while in the last
  16 picks (DAT_00839cc4 ring). Accept only if the first character code differs from every other box slot's
  (`FUN_004b23a0`, 14 slots DAT_00839c80, slot = owner +0x3c); up to 16 random tries, then downwards from the end.
  Box +0x50 = word line, +0x9e = record i16, +0x9c = record flags (high half of `value`), +0xa4 = width.
- **Word level** — event **op 0x61 (group, time budget)** → `FUN_004b1510` (also called by bosses / code):
  `FUN_004b16b0(budget, 0)`: p = budget · DAT_005ea9e4 (0.1; modes 0/1: @0058e410[DAT_00a3c1e0] · K, set in
  FUN_004aea10) · (1.2 unless language DAT_005ea730 = 'A'); p ≤ 15 → p + @005ea6c8[rank]; 15 < p ≤ 30 → p +
  @005ea6d8[rank]; above → p · (1 + @005ea688[rank] · k) with k by band (45/65/85/120/150/180/210/240); clamp
  [DAT_00839ca8, 2000]; < 3 → 0; level = min(19, trunc(p)). Level < 0 → category 0, 0 → category 1, > 0 →
  category 2 with `word/` file @005eaaac[group] + level − 1 (`load_word_list`). Budget −2 = random file of the
  group (FUN_004b4080 count). Stage 1 uses op 0x61 `0 25`, `0 50`, `0 100`, `0 150`, `2 −2`; op 0x0F sets the
  attack counts DAT_00a3b7f0.. (Stage 1: `1 2 3`, `2 3 4`, `3 3 4`).
- **Rank** DAT_00a3b856 (`FUN_00437c60`, capped 12 in Stage 1 (DAT_00a10c08 = 0), 14 in Stage 2): starts at
  @004f43cc[difficulty DAT_00a3b99c] (−3, −1, 1, 4, 8) + 4·players (FUN_00409f70; FUN_00451fc0 sets 1), +1 every
  0x708 frames (+2 with ≥ 4 lives), + DAT_00a11d14 (performance), clamped 0–15 (FUN_00451ff0).
- **Box per frame** (`FUN_004b2a30`): follows the owner's view-space anchor +0x10c..+0x114 — stored in the rig
  draw (`FUN_00475420`) at **joint 1** (torso; 9 or 2 in special modes) as view position (+0x100..+0x108 = world)
  — with smoothing (0.? per frame, @004dec48) and depth +0x114 + @004dd6c4; per player: targeting
  (`FUN_004b3080`, input buffer DAT_0087b5e0 + p·0x150, matcher FUN_004b4260) and typing (`FUN_004b31f0` →
  FUN_004b32f0). Queued (DAT_008395c4, max 14) by `FUN_004ae960`; drawn by `FUN_004aec20`: clamps to the screen
  (x within ±@0058e434/430 · z/s, y @0058e42c/@00519138), pushes overlapping boxes apart vertically, then
  `FUN_004b0c90` (normal) / `FUN_004b1100` (flag 0x200) / dimmed (flag 0x100).
- Zombie task also calls `FUN_00436f00(4)`: +0x70 = player view · (+0x100) (used by the on-screen test) and the
  world anchor y += 4. The shadow blob (model 0x110d, `FUN_004379e0`) is drawn after the rig.
- **Box drawing details** (ported 2026-11-23, `engine/src/objects/wordbox.ts`): width +0xa4 = trunc(word width +
  2.3) (FUN_004b1b30). `FUN_004b0c90` (1P, DAT_00839cb4 = 0): word line (FUN_004b0890 line 1, yellow) at
  x + centre·s·0.75, y + 0.13·s; typing line (line 0, white, first +0x99 hidden) at y − 1.3·s; one-letter words
  one line ×1.2 at y − 0.65·s (FUN_004b0980). +0x98 = character count. Frame `FUN_004b01a0`: tod_boxetc #6–#13
  (0x129e/0x1373/0x170c, 0x12a3/0x19d/0x1738, 0x12c5/0x13dd/0x1769), placed by `FUN_004b0490` = translate(p·0.1),
  scale(sx·s·0.1, sy·s·0.1, s·0.1): left = x − (w−2)s/2, rows at y − s, y, y + s (heights 0.25, 1.25, 0.25),
  edges (w−1)/2 − 0.03 wide, centre ((w−0.5)/2 − 0.08w − 0.03)/2 × (1.25/2 + 0.025). Colour on all but the centre
  (FUN_00489140): danger d = clamp((ground dist − 20)·0.025, 0, 1) → d = 0 blink (1, 0/1, 0) every 4 frames, ≤ 0.5
  (1, 2d, 0), else (2(1−d), 1, 0). **The centre model is set black once** (`FUN_004afd90`). Letters
  (`FUN_004b2530`): model @0058efa8[c], translate((x, y + drop, z)·0.1), scale (s, h·s, s)·0.1, colour (1,1,0)
  word / (1,1,1) typing; drop −0.2·s for g/p/q/y, −0.1·s for j. Before drawing: `FUN_004afd50` (z > −10 → moved to
  z = −10 with x, y scaled), `FUN_004affd0` (size × ((−32 − z)/32 + 1) beyond 32, × (1 − (z + 28)/28) nearer than
  28; x within ±(270 − 8·w·s)·|z|/s_proj unless w > 25; y within ±150·|z|/s_proj). Boxes are **lit**: white light
  (FUN_004c2b30) along rotY(0x2000)·rotX(0x2000)·(0,0,1) in view space (FUN_0046d780 → FUN_004c2b70). Drawing at
  one tenth of the view-space anchor keeps the screen position and puts the box in front of the scene.
  DAT_00a11a10 = 240 / tan(fov/2) (FUN_00488260). Specular assumed off (the original's word line is yellow).
