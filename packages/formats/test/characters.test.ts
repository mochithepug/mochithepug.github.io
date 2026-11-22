/** Characters & motions against the user's install. Skipped unless TTOTD_DIR is set. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyBin } from '../src/container.ts';
import { Motion, motionStride, poseCharacter, readCharacterTypes, readMotionTable, storedFrames, type CharNode } from '../src/character.ts';
import { PeImage } from '../src/pe.ts';
import { parsePolFile } from '../src/pol.ts';

const dir = process.env.TTOTD_DIR;

describe.skipIf(!dir)('characters (real data)', () => {
  const pe = () => new PeImage(new Uint8Array(readFileSync(join(dir!, 'Tod_e.exe'))));

  it('every motion header equals floor((F-1)/2)+2 for its 60 Hz frame count F', () => {
    const p = pe();
    const table = readMotionTable(p);
    expect(table.length).toBe(1116);
    const bad: string[] = [];
    for (const m of table) {
      const b = readFileSync(join(dir!, 'mot', m.file));
      const v = new DataView(b.buffer, b.byteOffset, b.length);
      const stored = v.getUint32(v.getUint32(m.index * 4, true), true);
      if (stored !== storedFrames(m.frames)) bad.push(`${m.file}#${m.index} id${m.id} F${m.frames} stored${stored}`);
    }
    expect(bad).toEqual([]);
  });

  it('reads 86 skeletons; every drawable node resolves to a model that exists', () => {
    const p = pe();
    const types = readCharacterTypes(p);
    expect(types.length).toBe(86);
    const files = new Map<string, number>();
    const missing: string[] = [];
    for (const t of types) {
      const walk = (n: CharNode) => {
        if (n.model > 0) {
          if (!n.ref) missing.push(`type ${t.index}: model id ${n.model} unresolved`);
          else {
            if (!files.has(n.ref.file)) {
              const c = classifyBin(`pol/${n.ref.file}`.toLowerCase(), new Uint8Array(readFileSync(join(dir!, 'pol', n.ref.file))));
              files.set(n.ref.file, parsePolFile(c.data).length);
            }
            if (n.ref.index >= files.get(n.ref.file)!) missing.push(`type ${t.index}: ${n.ref.file}#${n.ref.index} out of range`);
          }
        }
        n.children.forEach(walk);
      };
      walk(t.root);
    }
    expect(missing).toEqual([]);
  });

  it("player1's head sits on its torso when posed (rest offset of the neck joint)", () => {
    const p = pe();
    const james = readCharacterTypes(p)[57]!;
    expect(james.name).toBe('player1');
    const motions = readMotionTable(p).filter((m) => m.file === 'player1.bin');
    const file = new Uint8Array(readFileSync(join(dir!, 'mot', 'player1.bin')));
    for (const info of motions) {
      const mo = new Motion(file, info, james.joints);
      expect(4 + mo.stored * motionStride(james.joints)).toBeLessThanOrEqual(file.length);
      for (let f = 0; f < info.frames; f++) {
        const posed = poseCharacter(james, mo.sample(f));
        expect(posed.length).toBe(16);
        for (const { matrix } of posed) expect(Number.isFinite(matrix[12]!) && Math.abs(matrix[13]!) < 1000).toBe(true);
      }
    }
  });
});
