/**
 * Spoken lines: voice + subtitles, as Tod_e.exe plays them (`say` FUN_004239a0, subtitle task FUN_004238c0).
 *
 *   dialogue id → 3 variants (A = playing James, B = Gary, C = two players) @0059ac58: i16 speech id
 *   speech record @00599338 (16 bytes): i16 subtitle image (Japanese mode), i16 duration (60 Hz frames),
 *     …, u32 voice sound id @+12 (played via FUN_00495660; 0 = none)
 *   subtitle lines: @005a0fd0 i16[speech·4 + k] → line record @0059b210 (64 bytes):
 *     u32 ?, char text[] @+4, i16 @+0x3E = advance to the next line when the remaining frames drop below it
 * Which dialogue plays when is decided by the event script (M9).
 */
import type { PeImage } from './pe.ts';

export interface SubtitleLine {
  text: string;
  /** Show the next line once the remaining frames fall below this (0 = last line). */
  nextBelow: number;
}

export interface Speech {
  id: number;
  durationFrames: number;
  voiceSound: number;
  subtitleImage: number;
  lines: SubtitleLine[];
}

export const DIALOGUE_VARIANTS = ['James', 'Gary', 'Two players'] as const;

export function readSpeech(pe: PeImage, id: number): Speech {
  const rec = 0x00599338 + id * 16;
  const lines: SubtitleLine[] = [];
  for (let k = 0; k < 4; k++) {
    const idx = pe.i16(0x005a0fd0 + (id * 4 + k) * 2);
    if (k > 0 && idx <= 0) break;
    const text = pe.cstr(0x0059b214 + idx * 0x40);
    if (text) lines.push({ text, nextBelow: pe.i16(0x0059b24e + idx * 0x40) });
  }
  return { id, durationFrames: pe.i16(rec + 2), voiceSound: pe.u32(rec + 12), subtitleImage: pe.i16(rec), lines };
}

/** The speech for a dialogue id and player variant (0 James, 1 Gary, 2 two players), or undefined. */
export function readDialogue(pe: PeImage, dialogueId: number, variant: number): Speech | undefined {
  const sid = pe.i16(0x0059ac58 + (dialogueId * 3 + variant) * 2);
  return sid ? readSpeech(pe, sid) : undefined;
}
