/**
 * Spawn record type → ported object (the exe's task table @005a741c). Types not listed are not ported yet
 * and are skipped by the game loop.
 */
import type { SpawnRecord } from '@ttotd/formats';
import type { GameObject, World } from './core/object.ts';
import { Civilian } from './objects/t10-civilian.ts';
import { Daemon } from './objects/t22-daemon.ts';
import { OpeningCar } from './objects/t26-opencar.ts';
import { Zombie } from './objects/t30-zombie.ts';
import { TitleCard } from './objects/t60-titlecard.ts';

export function createObject(rec: SpawnRecord, w: World, parent?: GameObject): GameObject | undefined {
  switch (rec.type) {
    case 0x10:
      return rec.pos && w.skeletons[(rec.tail?.[0] ?? -1) << 24 >> 24] ? new Civilian(rec, w) : undefined;
    case 0x22:
      return rec.kind === 0 ? new Daemon(rec, w) : undefined;
    case 0x26:
      return rec.hp === 1 ? new OpeningCar(rec) : undefined;
    case 0x30:
      return rec.pos && w.skeletons[(rec.tail?.[0] ?? -1) << 24 >> 24] ? new Zombie(rec, w, parent) : undefined;
    case 0x60:
      return new TitleCard();
  }
  return undefined;
}
