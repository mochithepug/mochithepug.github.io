/**
 * Chapter title card: object type 0x60 (`FUN_00422c00`), spawned at the end of the opening scene.
 * Timing only so far: it sets DAT_00a14048 bit 0x20 (objects such as the opening car hide) for 0xB4 frames,
 * or until Enter once fewer than 0xA0 frames are left; then it clears the bit, sets TITLE_CARD_FLAG and ends. The title itself
 * (sprites 0x210–0x217 for Stage 1, laid out by FUN_004241b0) is not drawn yet.
 */
/** Flag the card sets when it ends (DAT_00a397b8 = DAT_00a396c0[248]); event op 0x45 248 waits for it. */
export const TITLE_CARD_FLAG = 248;

export class TitleCard {
  /** Frames left (obj +0x11c); undefined before the first update. */
  count?: number;
  done = false;

  /** One frame; `enter` = Enter pressed this frame (input bits 0x80008). Returns whether the card is up. */
  update(enter: boolean): boolean {
    if (this.done) return false;
    this.count ??= 0xb4;
    if (this.count < 0xa0 && enter) this.count = 1;
    this.count--;
    if (this.count < 1) this.done = true;
    return !this.done;
  }
}
