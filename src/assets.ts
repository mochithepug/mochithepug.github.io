/** Shared, cached access to decoded game assets (exe tables, pol models, texture sets). */
import {
  classifyBin,
  decodeTexels,
  paletteBankFor,
  parsePolFile,
  PeImage,
  readPalettes,
  readTextureSets,
  texelsToRgba,
  type PolModel,
  type TextureSet,
} from '@ttotd/formats';
import type { GameFS } from './ingest/gamefs';
import type { TextureSource } from './gl/renderer';

export class Assets {
  readonly sets: TextureSet[];
  readonly palettes: Uint16Array[];
  private pol = new Map<string, Promise<PolModel[]>>();
  private tex = new Map<string, Promise<TextureSource | undefined>>();
  private files = new Map<string, Promise<Uint8Array>>();
  readonly fs: GameFS;
  readonly pe: PeImage;

  private constructor(fs: GameFS, pe: PeImage) {
    this.fs = fs;
    this.pe = pe;
    this.sets = readTextureSets(pe);
    this.palettes = readPalettes(pe);
  }

  static async open(fs: GameFS): Promise<Assets> {
    return new Assets(fs, new PeImage(new Uint8Array(await fs.read('Tod_e.exe'))));
  }

  /** Raw bytes of a game file (cached). */
  file(path: string): Promise<Uint8Array> {
    let p = this.files.get(path.toLowerCase());
    if (!p) {
      p = this.fs.read(path).then((b) => new Uint8Array(b));
      this.files.set(path.toLowerCase(), p);
    }
    return p;
  }

  /** Parsed models of `pol/<name>` (empty for save/stub files). */
  models(name: string): Promise<PolModel[]> {
    let p = this.pol.get(name.toLowerCase());
    if (!p) {
      const path = `pol/${name}`;
      p = this.file(path).then((b) => {
        const c = classifyBin(path.toLowerCase(), b);
        return c.kind === 'lz' || c.kind === 'raw' ? parsePolFile(c.data) : [];
      });
      this.pol.set(name.toLowerCase(), p);
    }
    return p;
  }

  /**
   * Lazily decoded textures of `tex/<name>`, or undefined if the set has none.
   * `forModels`: textures used by models take palette bank 0 (see paletteBankFor).
   */
  textures(name: string, forModels = true): Promise<TextureSource | undefined> {
    const key = `${name.toLowerCase()}|${forModels}`;
    let p = this.tex.get(key);
    if (!p) {
      p = this.loadTextures(name, forModels);
      this.tex.set(key, p);
    }
    return p;
  }

  private async loadTextures(name: string, forModels: boolean): Promise<TextureSource | undefined> {
    const set = this.sets.find((s) => s.name.toLowerCase() === name.toLowerCase());
    const path = `tex/${name}`;
    if (!set || !set.textures.length || !this.fs.has(path)) return undefined;
    const { data } = classifyBin(path.toLowerCase(), await this.file(path));
    const decoded = new Map<number, ReturnType<TextureSource['get']>>();
    const { pe, palettes } = this;
    return {
      key: `${set.name}|${forModels}`,
      get(i) {
        if (decoded.has(i)) return decoded.get(i);
        const t = set.textures[i];
        let out: ReturnType<TextureSource['get']>;
        if (t) {
          try {
            const d = decodeTexels(t, data, palettes[paletteBankFor(pe, set, i, forModels)]);
            out = { width: t.width, height: t.height, rgba: texelsToRgba(d.texels, d.format) };
          } catch {
            out = undefined;
          }
        }
        decoded.set(i, out);
        return out;
      },
    };
  }
}
