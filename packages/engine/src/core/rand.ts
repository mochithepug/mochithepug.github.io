/**
 * The game's random numbers: MSVC `rand()` (crt_rand), seed × 214013 + 2531011, bits 16–30. The exe's seed at
 * the moment a stage starts is not modelled, so sequences differ from the original; what matters is that each
 * behaviour draws the same number of values in the same order as the exe.
 */
export class CrtRand {
  private seed: number;
  constructor(seed = 1) {
    this.seed = seed >>> 0;
  }
  next(): number {
    this.seed = (Math.imul(this.seed, 214013) + 2531011) >>> 0;
    return (this.seed >>> 16) & 0x7fff;
  }
}
