import { describe, expect, it } from 'vitest';
import { parseWav, WavError } from '../src/wav.ts';

/** Builds a synthetic WAV (no game data in tests). */
function makeWav(opts: { channels: number; rate: number; frames: number; loop?: [number, number] }): ArrayBuffer {
  const blockAlign = opts.channels * 2;
  const dataLen = opts.frames * blockAlign;
  const smplLen = opts.loop ? 36 + 24 : 0;
  const total = 12 + 8 + 16 + 8 + dataLen + (opts.loop ? 8 + smplLen : 0);
  const v = new DataView(new ArrayBuffer(total));
  const w4 = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w4(0, 'RIFF'); v.setUint32(4, total - 8, true); w4(8, 'WAVE');
  w4(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, opts.channels, true);
  v.setUint32(24, opts.rate, true); v.setUint32(28, opts.rate * blockAlign, true);
  v.setUint16(32, blockAlign, true); v.setUint16(34, 16, true);
  w4(36, 'data'); v.setUint32(40, dataLen, true);
  if (opts.loop) {
    const s = 44 + dataLen;
    w4(s, 'smpl'); v.setUint32(s + 4, smplLen, true);
    v.setUint32(s + 8 + 28, 1, true);
    v.setUint32(s + 8 + 36 + 8, opts.loop[0], true);
    v.setUint32(s + 8 + 36 + 12, opts.loop[1], true);
  }
  return v.buffer;
}

describe('parseWav', () => {
  it('reads PCM format and duration', () => {
    const info = parseWav(makeWav({ channels: 2, rate: 22050, frames: 22050 }));
    expect(info).toMatchObject({ formatTag: 1, channels: 2, sampleRate: 22050, bitsPerSample: 16, frames: 22050 });
    expect(info.durationSec).toBe(1);
    expect(info.dataOffset).toBe(44);
    expect(info.loops).toEqual([]);
  });

  it('reads smpl loop points', () => {
    const info = parseWav(makeWav({ channels: 1, rate: 11025, frames: 100, loop: [10, 90] }));
    expect(info.loops).toEqual([{ start: 10, end: 90 }]);
    expect(info.chunks).toEqual(['fmt ', 'data', 'smpl']);
  });

  it('rejects non-WAV data', () => {
    expect(() => parseWav(new ArrayBuffer(64))).toThrow(WavError);
  });
});
