/** Word lists, typing letters and the Japanese font against the user's install. Skipped unless TTOTD_DIR is set. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { modelRef } from '../src/character.ts';
import { Font } from '../src/font.ts';
import { PeImage } from '../src/pe.ts';
import { asciiToSjis, charMetrics, codeToSjis, decodeWordList, layoutWordLine, letterModelId, readWordListNames } from '../src/words.ts';

const dir = process.env.TTOTD_DIR;

describe.skipIf(!dir)('words & font (real data)', () => {
  const pe = () => new PeImage(new Uint8Array(readFileSync(join(dir!, 'Tod_e.exe'))));

  it('decodes all 488 word lists (14 061 words); codes are the text in the game charset; every letter has a model', () => {
    const p = pe();
    const names = readWordListNames(p);
    expect(names.length).toBe(488);
    let words = 0;
    const problems: string[] = [];
    for (const n of names) {
      for (const w of decodeWordList(new Uint8Array(readFileSync(join(dir!, 'word', n))))) {
        words++;
        const sj = [...w.codes].map((c) => codeToSjis(p, c));
        const fromText = [...w.text].map((c) => asciiToSjis(p, c.charCodeAt(0)));
        if (sj.join() !== fromText.join()) problems.push(`${n}: ${w.text} codes differ`);
        for (const ch of w.text) {
          if (ch === ' ') {
            // no model: FUN_004b2530 returns early for id 0, a space only advances
            expect(letterModelId(p, 32)).toBe(0);
            continue;
          }
          const ref = modelRef(p, letterModelId(p, ch.charCodeAt(0)));
          if (ref?.file !== 'tod_boxetc.bin') problems.push(`no letter model for ${JSON.stringify(ch)}`);
        }
      }
    }
    expect([...new Set(problems)]).toEqual([]);
    expect(words).toBe(14061);
  });

  it('font.bin has 7 807 glyphs reachable through the exe table', () => {
    const p = pe();
    const font = new Font(p, new Uint8Array(readFileSync(join(dir!, 'word', 'font.bin'))));
    let n = 0;
    for (let c = 0x8140; c <= 0xeaa4; c++) if (font.glyph(c)) n++;
    expect(n).toBe(7807);
    // あ is a real glyph with all three shades used somewhere in the font's hiragana
    expect(font.glyph(0x82a0)!.some((v) => v > 0)).toBe(true);
  });

  it('letter widths match the exe tables (spot checks) and layout keeps hidden letters in place', () => {
    const p = pe();
    const m = (ch: string) => charMetrics(p, asciiToSjis(p, ch.charCodeAt(0))).map((v) => Math.round(v * 100) / 100);
    expect(m('M')).toEqual([0.9, 0]);
    expect(m('i')).toEqual([0.6, 0.2]);
    expect(m('m')).toEqual([0.9, -0.1]);
    expect(m('-')).toEqual([0.9, 0]);
    expect(m(' ')).toEqual([0.4, 0]);
    const all = layoutWordLine(p, 'Ping-pong', 23.75, 320, 240);
    const typed = layoutWordLine(p, 'Ping-pong', 23.75, 320, 240, 8);
    expect(typed.map((l) => l.x)).toEqual(all.map((l) => l.x));
    expect(typed.filter((l) => !l.hidden).map((l) => String.fromCharCode(l.ascii))).toEqual(['g']);
    expect(all.find((l) => l.ascii === 0x67)!.y).toBeLessThan(all[0]!.y); // g drops below the line
  });
});
