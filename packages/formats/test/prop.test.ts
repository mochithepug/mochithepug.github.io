import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readMotionTable } from '../src/character.ts';
import { classifyBin } from '../src/container.ts';
import { PeImage } from '../src/pe.ts';
import { GAME_PROP_MOTIONS, poseProp, propMotionFits, PropMotion, propStride, readPropTypes } from '../src/prop.ts';

describe('prop motion layout', () => {
  it('frame stride is align4(18·(n − 1)), as prop_motion_pos computes (18n − 15) & ~3', () => {
    for (let n = 2; n < 200; n++) expect(propStride(n)).toBe((18 * (n - 1) + 3) & ~3);
  });
});

const dir = process.env.TTOTD_DIR;
describe.skipIf(!dir)('props (real exe + mot/)', () => {
  const pe = new PeImage(new Uint8Array(readFileSync(join(dir!, 'Tod_e.exe'))));
  const types = readPropTypes(pe);
  const motions = readMotionTable(pe);
  const mot = (file: string) => {
    const raw = new Uint8Array(readFileSync(join(dir!, 'mot', file)));
    try {
      return classifyBin(`mot/${file}`, raw).data;
    } catch {
      return raw; // stored raw
    }
  };

  it('reads 30 prop skeletons whose joints fit n − 1', () => {
    expect(types).toHaveLength(30);
    for (const t of types) {
      let maxJoint = 0;
      const walk = (n: (typeof t.roots)[number]) => {
        maxJoint = Math.max(maxJoint, n.joint);
        n.children.forEach(walk);
      };
      t.roots.forEach(walk);
      expect(maxJoint, `type ${t.index}`).toBeLessThanOrEqual(t.n - 1);
      expect([0, 1, 2]).toContain(t.mode);
    }
  });

  it("every motion the game's code pairs with a prop fits the prop layout exactly", () => {
    for (const [type, ids] of Object.entries(GAME_PROP_MOTIONS)) {
      const t = types[Number(type)]!;
      for (const id of ids) {
        const info = motions.find((m) => m.id === id)!;
        expect(existsSync(join(dir!, 'mot', info.file)), info.file).toBe(true);
        expect(propMotionFits(mot(info.file), info, t.n), `type ${type} motion ${id}`).toBe(true);
      }
    }
  });

  it('even frames show stored frames; odd frames are halfway (mode 1)', () => {
    const t = types[12]!; // door_1 debris, mode 1, paired with motion 501
    expect(t.mode).toBe(1);
    const info = motions.find((m) => m.id === 501)!;
    const pm = new PropMotion(mot(info.file), info, t);
    const a = pm.sample(10, 0), b = pm.sample(12, 0), mid = pm.sample(11, 0);
    for (let k = 0; k < 3; k++) expect(mid.pos[k]).toBeCloseTo((a.pos[k]! + b.pos[k]!) / 2, 4);
    expect(poseProp(pm, 0).length).toBeGreaterThan(0);
  });
});
