/**
 * The players' car in the Stage 1 opening: object type 0x26 (`FUN_00485140`), scene variant 1
 * (`FUN_004854b0`), spawned by event op 0x0B. Ported from Tod_e.exe; see re/notes/overview.md.
 *
 * Each frame it places itself on an object path (`cam/op_st1.bin`) chosen by the current camera path,
 * at the camera time, then draws its parts with the matrix stack. It is not drawn once the gameplay
 * HUD is on (DAT_00a14048 & 0x20).
 */
import {
  identity,
  rotateXLocal,
  rotateYLocal,
  rotateZLocal,
  scaleLocal,
  translateLocal,
  type Mat4,
  type ObjectPathSample,
} from '@ttotd/formats';
import type { DrawItem, GameObject, World } from '../core/object.ts';

type CarInputs = Pick<World, 'camPath' | 'camTime' | 'path' | 'pathLength'> & {
  /** DAT_00a3b840 == 2: the right door opens as well (meaning of the flag not traced yet). */
  bothDoors?: boolean;
};

const RAD = (2 * Math.PI) / 65536;
/** f32 from its bit pattern, as the exe passes constants to the matrix ops. */
const F = (bits: number) => new Float32Array(new Uint32Array([bits]).buffer)[0]!;

export class OpeningCar implements GameObject {
  pos: [number, number, number];
  /** Sega angles x, y, z (obj +0x64, +0x68, +0x6c). */
  angles: [number, number, number];
  /** Wheels turning and dust shown (obj +0x1324). */
  moving = false;
  /** Wheel angle (obj +0x1334). */
  wheel = 0;
  /** Door angle (obj +0x1338). */
  door = 0;
  /** Right door follows (obj +0x1328). */
  bothDoors = false;

  constructor(spawn: { pos?: [number, number, number]; angles?: [number, number, number] }) {
    this.pos = [...(spawn.pos ?? [0, 0, 0])];
    this.angles = [...(spawn.angles ?? [0, 0, 0])];
  }

  private place(s: ObjectPathSample | undefined) {
    if (!s) return;
    this.pos = [...s.pos];
    this.angles = [...s.angles];
  }

  /** One frame of FUN_004854b0's update part. */
  update(w: CarInputs) {
    const { camPath, camTime } = w;
    if (camPath === 0x30 || (camPath === 0x31 && camTime <= 0x15d)) {
      const id = camPath === 0x30 ? 0x11f : 0x120;
      this.moving = true;
      this.place(w.path(id, Math.min(w.pathLength(id), camTime)));
    } else if (camPath === 0x31) {
      this.moving = false;
    } else if (camPath === 0x32) {
      this.place(w.path(0x120, 350));
      this.moving = false;
      const t = camTime < 0 || camTime > 0x31 ? 150 : camTime + 100;
      const d = w.path(0x121, t);
      if (d) this.door = d.angles[1] - 0x4000;
      if (w.bothDoors) this.bothDoors = true;
    }
    if (this.moving) this.wheel += 0x2000;
  }

  /** FUN_004854b0's draw part: hidden while the title card is up; `frame` = g_rng_counter. */
  draw(w: Pick<World, 'frame' | 'titleUp'>): DrawItem[] {
    if (w.titleUp) return [];
    const frame = w.frame;
    const out: DrawItem[] = [];
    const add = (model: number, world: Mat4) => out.push({ model, world });
    let base = translateLocal(identity(), ...this.pos);
    base = rotateZLocal(base, this.angles[2]);
    base = rotateYLocal(base, this.angles[1]);
    base = rotateXLocal(base, this.angles[0]);
    add(0x1603, base);
    add(0x1608, base);

    let m = translateLocal(base, F(0xc0959db2), 0, F(0x3e74bc6a));
    m = translateLocal(m, 0, 9, 6);
    add(0x8c9, rotateXLocal(m, 0xd000));

    m = translateLocal(base, 0, F(0x412bd2f2), F(0x41366f00));
    m = rotateXLocal(m, -0x1c00);
    m = rotateZLocal(m, Math.trunc(Math.sin(((frame << 9) | 0) * RAD) * 10240));
    add(0x8fd, rotateXLocal(m, 0x1c00));

    m = rotateYLocal(translateLocal(base, F(0xc1211f8a), F(0x40c5ac71), F(0x40db35a8)), this.door);
    add(0x1606, m);
    add(0x1607, m);
    m = translateLocal(base, F(0x41213b64), F(0x40c6c083), F(0x40da9100));
    if (this.bothDoors) m = rotateYLocal(m, -this.door);
    add(0x1604, m);
    add(0x1605, m);

    add(0x1609, rotateXLocal(translateLocal(base, 0, F(0x4076617c), F(0x4181ca8c)), this.wheel));
    add(0x160a, rotateXLocal(translateLocal(base, 0, F(0x4076617c), F(0xc14ac56d)), this.wheel));

    if (this.moving) {
      const dust = (frame % 12) + 0x8ff;
      for (const z of [F(0x417fd2f2), F(0xc14e9c78)]) {
        add(dust, translateLocal(base, F(0xc11a147b), 0, z));
        add(dust, scaleLocal(translateLocal(base, F(0x411a147b), 0, z), -1, 1, 1));
      }
    }
    return out;
  }
}

/** Global model ids the opening car can draw (to preload). */
export const OPENING_CAR_MODELS = [
  0x1603, 0x1604, 0x1605, 0x1606, 0x1607, 0x1608, 0x1609, 0x160a, 0x8c9, 0x8fd,
  ...Array.from({ length: 12 }, (_, k) => 0x8ff + k),
];
