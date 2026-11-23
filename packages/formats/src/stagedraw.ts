/**
 * What the stage and the sky draw, from Tod_e.exe tables. See re/notes/overview.md "Stage areas & sky".
 *
 *   stage areas  @00597668[stage − 1] → 0x18-byte entries per area: i16 indexes into the model list, −1 ends
 *   model list   @005976a0[stage − 1] → u32 per model: low 16 = global model id, high 16 = flags (2 = light
 *                group 7); 0xffff ends. Drawn by the stage task `FUN_004031b0` for the current area (event op
 *                0x29), each culled by a sphere test, nothing while the title card is up.
 *   sky table    @005b93c0, 16 bytes per row: i16 sky model, i16 second layer (0 = none), f32 height offset,
 *                i32 spin per frame, i32 start angle. Used by the sky task `FUN_0047ede0` (row = event op 0x1b,
 *                mode = op 0x1c: 0 off, 1 on and turning, 2 on and still).
 */
import type { PeImage } from './pe.ts';

const AREA_TABLES = 0x00597668;
const MODEL_LISTS = 0x005976a0;
const SKY_TABLE = 0x005b93c0;

export interface StageAreas {
  /** Per area: the models to draw (global ids), in draw order. */
  areas: { model: number; flags: number }[][];
}

export function readStageAreas(pe: PeImage, stage: number): StageAreas {
  const areaPtr = pe.u32(AREA_TABLES + (stage - 1) * 4), listPtr = pe.u32(MODEL_LISTS + (stage - 1) * 4);
  const list: { model: number; flags: number }[] = [];
  for (let i = 0; i < 256; i++) {
    const v = pe.u32(listPtr + i * 4);
    if ((v & 0xffff) === 0xffff) break;
    list.push({ model: v & 0xffff, flags: v >>> 16 });
  }
  const areas: StageAreas['areas'] = [];
  // Areas run until an entry whose indexes leave the model list (the table is followed by other data).
  for (let a = 0; a < 64; a++) {
    const idx: number[] = [];
    let ok = true;
    for (let k = 0; k < 12; k++) {
      const v = pe.i16(areaPtr + a * 0x18 + k * 2);
      if (v === -1) break;
      if (v < 0 || v >= list.length) ok = false;
      idx.push(v);
    }
    if (!ok) break;
    areas.push(idx.map((i) => list[i]!));
  }
  return { areas };
}

export interface SkyRow {
  model: number;
  layer: number;
  height: number;
  spin: number;
  startAngle: number;
}

export function readSkyTable(pe: PeImage, rows = 12): SkyRow[] {
  return Array.from({ length: rows }, (_, i) => {
    const a = SKY_TABLE + i * 16;
    return { model: pe.i16(a), layer: pe.i16(a + 2), height: pe.f32(a + 4), spin: pe.i32(a + 8), startAngle: pe.i32(a + 12) };
  });
}
