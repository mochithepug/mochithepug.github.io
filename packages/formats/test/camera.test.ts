/** Camera paths against the user's install. Skipped unless TTOTD_DIR is set. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CameraFile, cameraFromSample, cameraView, D3D_VIEW_FLIP, lookAngles, readCameraSlots } from '../src/camera.ts';
import { mul } from '../src/d3dmath.ts';
import { PeImage } from '../src/pe.ts';

const dir = process.env.TTOTD_DIR;

describe('lookAngles (FUN_0040bd10)', () => {
  it('yaw/pitch in Sega units from eye − target', () => {
    expect(lookAngles(0, 0, 1)).toEqual([-0, 0]);
    expect(lookAngles(1, 0, 0)).toEqual([-0, 16384]); // atan2(1, 0) = 90° = 0x4000
    const [pitch] = lookAngles(0, 1, 1); // eye above → pitch −45° (−0x2000)
    expect(pitch).toBe(-8192);
  });
});

describe.skipIf(!dir)('camera paths (real data)', () => {
  const pe = () => new PeImage(new Uint8Array(readFileSync(join(dir!, 'Tod_e.exe'))));

  it('every curve of every camera file passes exactly through its keys', () => {
    const p = pe();
    let curves = 0, keys = 0;
    const bad: string[] = [];
    for (const slot of readCameraSlots(p)) {
      const bytes = new Uint8Array(readFileSync(join(dir!, 'cam', slot.file)));
      const cf = new CameraFile(bytes, slot.ids.length);
      const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const data = 4 + slot.ids.length * 4;
      for (let path = 0; path < slot.ids.length; path++) {
        const ph = v.getUint32(path * 4, true);
        // camera paths: eye, target, roll (7 channels); object paths (op_*): position, angles (6)
        for (let c = 0; c < (slot.file.startsWith('op_') ? 6 : 7); c++) {
          const cv = data + v.getInt32(ph + c * 4, true) * 4;
          const cap = v.getUint16(cv, true);
          curves++;
          let prevT = -Infinity;
          for (let k = 0; k < cap; k++) {
            const t = v.getFloat32(cv + 4 + k * 16, true), val = v.getFloat32(cv + 8 + k * 16, true);
            if (!(t > prevT)) break; // padding after the last real key
            prevT = t;
            if (k === 0) continue; // evaluation needs a previous key
            keys++;
            const got = cf.evalCurve(cv, t);
            if (Math.abs(got - val) > 1e-3 * Math.max(1, Math.abs(val))) bad.push(`${slot.file} path ${path} ch ${c} key ${k}: ${got} ≠ ${val}`);
          }
        }
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
    expect(curves).toBeGreaterThan(1000);
    expect(keys).toBeGreaterThan(1000);
  });

  it('Stage 1: 23 paths; the game camera looks at its target (target straight ahead after the z-flip)', () => {
    const p = pe();
    const slot = readCameraSlots(p).find((s) => s.file === 'cp_st1.bin')!;
    expect(slot.ids).toEqual(Array.from({ length: 23 }, (_, k) => 48 + k));
    const cf = new CameraFile(new Uint8Array(readFileSync(join(dir!, 'cam', slot.file))), slot.ids.length);
    for (let path = 0; path < 23; path++) {
      const s = cf.sample(path, 10);
      const view = mul(cameraView(cameraFromSample(s)), D3D_VIEW_FLIP);
      const [x, y, z] = s.target;
      const vx = x * view[0]! + y * view[4]! + z * view[8]! + view[12]!;
      const vy = x * view[1]! + y * view[5]! + z * view[9]! + view[13]!;
      const vz = x * view[2]! + y * view[6]! + z * view[10]! + view[14]!;
      expect(vz, `path ${path}`).toBeGreaterThan(0);
      // int16 angle quantisation leaves the target within ~0.1% of the axis
      expect(Math.hypot(vx, vy) / vz, `path ${path}`).toBeLessThan(0.002);
    }
  });
});
