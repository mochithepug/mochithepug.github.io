import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { identity, rotateXLocal, rotateYLocal } from '../src/d3dmath.ts';
import { PeImage } from '../src/pe.ts';
import { angleDirection, d3dLighting, DEFAULT_SCENE_LIGHT, lightingConstants } from '../src/scenelight.ts';

describe('scene lighting', () => {
  it('direction from (pitch, yaw) equals FUN_0046d780: identity → rotY(yaw) → rotX(pitch), then (0,0,1)·M', () => {
    for (const [p, y] of [[0, 0], [4096, 0], [-8000, 12000], [16384, -30000], [1234, 5678]] as const) {
      let m = identity();
      m = rotateYLocal(m, y);
      m = rotateXLocal(m, p);
      const viaStack = [m[8]!, m[9]!, m[10]!]; // (0,0,1)·M = row 2
      const d = angleDirection(p, y);
      for (let k = 0; k < 3; k++) expect(d[k]).toBeCloseTo(viaStack[k]!, 5);
    }
  });

  it('light_setup_single: ambient = colour·intensity·255 (truncated), light = ×1.4, light ambient = colour × 0.3', () => {
    const L = d3dLighting({ ...DEFAULT_SCENE_LIGHT, color: [1, 0.2, 0.1], intensity: 0.5 });
    expect(L.ambient.map((v) => Math.round(v * 255))).toEqual([127, 25, 12]);
    expect(L.lightDiffuse[0]).toBeCloseTo(0.7, 6);
    expect(L.lightAmbient[1]).toBeCloseTo(0.06, 6);
  });

  it('fog: device start/end are twice the game values, ordered', () => {
    const L = d3dLighting({ ...DEFAULT_SCENE_LIGHT, fogStart: -600, fogEnd: 1800 });
    expect([L.fogStart, L.fogEnd]).toEqual([-1200, 3600]);
    const R = d3dLighting({ ...DEFAULT_SCENE_LIGHT, fogStart: 500, fogEnd: 100 });
    expect([R.fogStart, R.fogEnd]).toEqual([200, 1000]);
  });
});

const dir = process.env.TTOTD_DIR;
describe.skipIf(!dir)('scene lighting constants (real exe)', () => {
  it('match the exe', () => {
    const c = lightingConstants(new PeImage(new Uint8Array(readFileSync(join(dir!, 'Tod_e.exe')))));
    expect(c.diffuseScale).toBeCloseTo(1.4, 6);
    expect(c.ambientScale).toBeCloseTo(0.3, 6);
    expect(c.ambientTo255).toBe(255);
  });
});
