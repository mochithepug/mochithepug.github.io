import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readDialogue } from '../src/dialogue.ts';
import { PeImage } from '../src/pe.ts';

const dir = process.env.TTOTD_DIR;
describe.skipIf(!dir)('dialogue table (real exe)', () => {
  it("dialogue 1 is Stage 1's first line, per player character", () => {
    const pe = new PeImage(new Uint8Array(readFileSync(join(dir!, 'Tod_e.exe'))));
    const james = readDialogue(pe, 1, 0)!, gary = readDialogue(pe, 1, 1)!;
    expect(james.lines.map((l) => l.text)).toEqual(["We're meeting G over there."]);
    expect(james.durationFrames).toBe(120);
    expect(james.voiceSound).not.toBe(gary.voiceSound); // separate James / Gary recordings
    const d3 = readDialogue(pe, 3, 0)!;
    expect(d3.lines).toEqual([
      { text: "I've already taken care of G.", nextBelow: 130 },
      { text: 'This is only the beginning.', nextBelow: 0 },
    ]);
    expect(readDialogue(pe, 6, 0)).toBeUndefined(); // "Let's go Gary!" exists only for two players
    expect(readDialogue(pe, 6, 2)!.lines[0]!.text).toBe("Let's go Gary!");
  });
});
