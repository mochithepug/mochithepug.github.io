/**
 * Minimal RIFF/WAVE header parser.
 *
 * All 1314 WAVs in the PC release are uncompressed 16-bit PCM (11025–44100 Hz, mono/stereo),
 * so the browser can decode them directly. This parser exists to surface format details and,
 * later, loop points (`smpl` chunk) which `decodeAudioData` ignores.
 */

export interface WavLoop {
  /** Loop start, in sample frames. */
  start: number;
  /** Loop end (inclusive), in sample frames. */
  end: number;
}

export interface WavInfo {
  formatTag: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  blockAlign: number;
  /** Byte offset of the PCM data within the file. */
  dataOffset: number;
  dataLength: number;
  frames: number;
  durationSec: number;
  loops: WavLoop[];
  chunks: string[];
}

export class WavError extends Error {}

const fourcc = (v: DataView, o: number) =>
  String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));

export function parseWav(buf: ArrayBuffer): WavInfo {
  const v = new DataView(buf);
  if (buf.byteLength < 12 || fourcc(v, 0) !== 'RIFF' || fourcc(v, 8) !== 'WAVE') {
    throw new WavError('not a RIFF/WAVE file');
  }

  let fmt: Pick<WavInfo, 'formatTag' | 'channels' | 'sampleRate' | 'bitsPerSample' | 'blockAlign'> | undefined;
  let dataOffset = -1;
  let dataLength = 0;
  const loops: WavLoop[] = [];
  const chunks: string[] = [];

  let o = 12;
  while (o + 8 <= buf.byteLength) {
    const id = fourcc(v, o);
    const size = v.getUint32(o + 4, true);
    const body = o + 8;
    chunks.push(id);
    if (id === 'fmt ') {
      if (size < 16) throw new WavError('fmt chunk too small');
      fmt = {
        formatTag: v.getUint16(body, true),
        channels: v.getUint16(body + 2, true),
        sampleRate: v.getUint32(body + 4, true),
        blockAlign: v.getUint16(body + 12, true),
        bitsPerSample: v.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      dataOffset = body;
      // Some writers put a bogus size on the last chunk; clamp to the file.
      dataLength = Math.min(size, buf.byteLength - body);
    } else if (id === 'smpl' && size >= 36) {
      const n = v.getUint32(body + 28, true);
      for (let i = 0; i < n && body + 36 + i * 24 + 24 <= buf.byteLength; i++) {
        const l = body + 36 + i * 24;
        loops.push({ start: v.getUint32(l + 8, true), end: v.getUint32(l + 12, true) });
      }
    }
    o = body + size + (size & 1); // chunks are word-aligned
  }

  if (!fmt) throw new WavError('missing fmt chunk');
  if (dataOffset < 0) throw new WavError('missing data chunk');
  const frames = fmt.blockAlign ? Math.floor(dataLength / fmt.blockAlign) : 0;
  return {
    ...fmt,
    dataOffset,
    dataLength,
    frames,
    durationSec: fmt.sampleRate ? frames / fmt.sampleRate : 0,
    loops,
    chunks,
  };
}
