/**
 * How a `pol/` or `tex/` file is stored. Evidence (see re/notes/overview.md):
 * - `lz`: loaded via FUN_00487fd0 / FUN_00494160 → FUN_0044fe20; decompresses exactly.
 * - `raw`: stage data, sizes are multiples of the 2048-byte disc sector; loader not yet located.
 * - `save`: 2816-byte save files disguised as data (table @005ea000, FUN_004af060/FUN_004af0e0).
 * - `bmp`: Windows bitmaps (`scr_etc00x`).
 * - `stub`: empty / tiny placeholder files.
 */
import { LzError, unpackFile } from './lz.ts';

export type StorageKind = 'lz' | 'raw' | 'save' | 'bmp' | 'stub';

export const SAVE_FILES = ['pol/tv2.bin', 'pol/komono_0.bin', 'tex/scr_tod_itm_itamidome2.bin', 'pol/bg_adv19.bin'];
const SECTOR = 2048;

export interface Classified {
  kind: StorageKind;
  /** Decompressed payload for `lz`, otherwise the file itself. */
  data: Uint8Array;
}

/** @param key normalised path, e.g. `pol/st1_01.bin` */
export function classifyBin(key: string, file: Uint8Array): Classified {
  if (SAVE_FILES.includes(key)) return { kind: 'save', data: file };
  if (file.length < 32) return { kind: 'stub', data: file };
  if (file[0] === 0x42 && file[1] === 0x4d) return { kind: 'bmp', data: file };
  try {
    const r = unpackFile(file);
    if (r.consumed === file.length) return { kind: 'lz', data: r.data };
  } catch (e) {
    if (!(e instanceof LzError)) throw e;
  }
  if (file.length % SECTOR === 0) return { kind: 'raw', data: file };
  throw new Error(`${key}: unrecognised storage (${file.length} bytes)`);
}
