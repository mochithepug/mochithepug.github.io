import { parseWav, type WavInfo } from '@ttotd/formats';

/** Simple one-at-a-time WAV preview player (dev tool, not the game's sound system). */
export class Previewer {
  private ctx?: AudioContext;
  private current?: AudioBufferSourceNode;
  onEnded?: () => void;

  async play(buf: ArrayBuffer, loop = false): Promise<WavInfo> {
    const info = parseWav(buf); // validate + report format before handing to the browser
    this.ctx ??= new AudioContext();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    const audio = await this.ctx.decodeAudioData(buf.slice(0)); // decodeAudioData detaches its input
    this.stop();
    const src = this.ctx.createBufferSource();
    src.buffer = audio;
    const l = info.loops[0];
    if (loop && l) {
      src.loop = true;
      src.loopStart = l.start / info.sampleRate;
      src.loopEnd = (l.end + 1) / info.sampleRate;
    }
    src.connect(this.ctx.destination);
    src.onended = () => {
      if (this.current === src) {
        this.current = undefined;
        this.onEnded?.();
      }
    };
    src.start();
    this.current = src;
    return info;
  }

  stop() {
    const s = this.current;
    this.current = undefined;
    s?.stop();
  }
}
