/**
 * The sky: a task created at stage start (`FUN_0047efe0` → `FUN_0047ede0`), not spawned by a record.
 * Each frame, if the mode (event op 0x1c) is not 0: centred on the camera eye (+ the row's height), turned
 * about Y by an angle that grows by the row's spin (not in mode 2) — row 5 is also turned upside down and
 * spins the other way — scaled ×1.2, draw the row's sky model; then its second layer at the eye, unturned.
 * Rows 8, 10 and 11 (later stages) have their own placement (FUN_0047f140 / FUN_0047f020): not ported.
 */
import { identity, rotateYLocal, rotateZLocal, scaleLocal, translateLocal, type SkyRow } from '@ttotd/formats';
import type { DrawItem } from '../core/object.ts';

const SCALE = Math.fround(1.2);

export class Sky {
  private readonly rows: SkyRow[];
  /** Angle (task +0x48) and the row it belongs to (DAT_00818d80). */
  private angle = 0;
  private last = 0;
  private items: DrawItem[] = [];

  constructor(rows: SkyRow[]) {
    this.rows = rows;
  }

  /** One frame of FUN_0047ede0. */
  update(row: number, mode: number, eye: readonly [number, number, number]) {
    this.items = [];
    const r = this.rows[row];
    if (!r) return;
    if (row !== this.last) this.angle = r.startAngle;
    this.last = row;
    if (mode === 0 || row === 8 || row === 10 || row === 11) return;
    const base = translateLocal(identity(), eye[0], r.height + eye[1], eye[2]);
    if (mode !== 2) this.angle += r.spin;
    let m = row === 5 ? rotateYLocal(rotateZLocal(base, 0x8000), -this.angle) : rotateYLocal(base, this.angle);
    m = scaleLocal(m, SCALE, SCALE, SCALE);
    this.items.push({ model: r.model, world: m });
    if (r.layer) this.items.push({ model: r.layer, world: base });
  }

  draw(): DrawItem[] {
    return this.items;
  }
}
