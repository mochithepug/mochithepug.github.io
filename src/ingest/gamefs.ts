/**
 * GameFS: read-only, case-insensitive view of the user's own game folder.
 *
 * Bring-your-own-data: nothing is uploaded or bundled; files are read on demand from the
 * folder the user picked. Paths are normalised to lowercase with forward slashes, relative
 * to the game root (the folder containing Tod_e.exe), because the original Windows game
 * opens files case-insensitively.
 */

export interface GameFile {
  /** Normalised key, e.g. `sound/bgm/adv_ar.wav`. */
  key: string;
  /** Path with original casing, e.g. `sound/bgm/ADV_AR.wav`. */
  path: string;
  size: number;
}

export interface GameFS {
  /** Display name of the picked folder. */
  readonly name: string;
  readonly files: readonly GameFile[];
  has(path: string): boolean;
  read(path: string): Promise<ArrayBuffer>;
}

export const normPath = (p: string) => p.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();

class BaseFS implements GameFS {
  readonly files: GameFile[];
  readonly name: string;
  private readonly byKey = new Map<string, () => Promise<File>>();

  constructor(name: string, entries: { path: string; size: number; open: () => Promise<File> }[]) {
    this.name = name;
    this.files = entries
      .map((e) => ({ key: normPath(e.path), path: e.path, size: e.size }))
      .sort((a, b) => a.key.localeCompare(b.key));
    for (const e of entries) this.byKey.set(normPath(e.path), e.open);
  }

  has(path: string) {
    return this.byKey.has(normPath(path));
  }

  async read(path: string): Promise<ArrayBuffer> {
    const open = this.byKey.get(normPath(path));
    if (!open) throw new Error(`file not found in game folder: ${path}`);
    return (await open()).arrayBuffer();
  }
}

const IGNORED = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);
const ignored = (name: string) => IGNORED.has(name.toLowerCase()) || name.startsWith('._');

/** From a File System Access API directory handle (Chromium). */
export async function fsFromDirectoryHandle(root: FileSystemDirectoryHandle): Promise<GameFS> {
  const entries: { path: string; size: number; open: () => Promise<File> }[] = [];
  async function walk(dir: FileSystemDirectoryHandle, prefix: string): Promise<void> {
    const subdirs: Promise<void>[] = [];
    const files: Promise<void>[] = [];
    for await (const h of dir.values()) {
      if (ignored(h.name)) continue;
      const path = prefix + h.name;
      if (h.kind === 'directory') {
        subdirs.push(walk(h as FileSystemDirectoryHandle, path + '/'));
      } else {
        const fh = h as FileSystemFileHandle;
        files.push(fh.getFile().then((f) => void entries.push({ path, size: f.size, open: () => fh.getFile() })));
      }
    }
    await Promise.all([...files, ...subdirs]);
  }
  await walk(root, '');
  return new BaseFS(root.name, entries);
}

/** From an `<input type=file webkitdirectory>` selection (all browsers). */
export function fsFromFileList(list: FileList): GameFS {
  const all = Array.from(list);
  // webkitRelativePath is "<picked folder>/<sub path>"; strip the picked folder name.
  const rootName = all[0]?.webkitRelativePath.split('/')[0] ?? 'folder';
  const entries = all
    .filter((f) => !ignored(f.name))
    .map((f) => ({
      path: f.webkitRelativePath.split('/').slice(1).join('/'),
      size: f.size,
      open: async () => f,
    }));
  return new BaseFS(rootName, entries);
}

/** Dev-only: the game folder served by the Vite dev server when TTOTD_DIR is set (see vite.config.ts). */
export async function fsFromDevServer(): Promise<GameFS | undefined> {
  const r = await fetch('/__ttotd/list').catch(() => undefined);
  if (!r?.ok || !(r.headers.get('content-type') ?? '').includes('json')) return undefined;
  const list = (await r.json()) as { path: string; size: number }[];
  return new BaseFS('TTOTD (dev server)', list.map((f) => ({
    path: f.path,
    size: f.size,
    open: async () => new File([await (await fetch('/__ttotd/' + f.path.split('/').map(encodeURIComponent).join('/'))).blob()], f.path),
  })));
}

// ---------------------------------------------------------------------------
// Remember the picked folder between visits (Chromium only; handles are structured-cloneable).

interface PermissionedHandle extends FileSystemDirectoryHandle {
  queryPermission?(d: { mode: 'read' }): Promise<PermissionState>;
  requestPermission?(d: { mode: 'read' }): Promise<PermissionState>;
}

declare global {
  interface Window {
    showDirectoryPicker?: (opts?: { id?: string; mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
  }
}

export const canPickDirectory = () => typeof window.showDirectoryPicker === 'function';

export async function pickDirectory(): Promise<FileSystemDirectoryHandle> {
  return window.showDirectoryPicker!({ id: 'ttotd-game', mode: 'read' });
}

function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('ttotd', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('handles');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const req = fn(open.result.transaction('handles', mode).objectStore('handles'));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    };
  });
}

export const saveHandle = (h: FileSystemDirectoryHandle) => idb('readwrite', (s) => s.put(h, 'gameDir'));
export const loadHandle = () =>
  idb<FileSystemDirectoryHandle | undefined>('readonly', (s) => s.get('gameDir')).catch(() => undefined);

/** Current permission without prompting (Chrome may keep it across visits: "Allow on every visit"). */
export async function hasReadPermission(h: FileSystemDirectoryHandle): Promise<boolean> {
  return (await (h as PermissionedHandle).queryPermission?.({ mode: 'read' })) === 'granted';
}

/**
 * Must be called synchronously from a click handler: Chrome only shows the permission prompt
 * while the click's user activation is still fresh, so nothing may be awaited before it.
 * (requestPermission returns 'granted' straight away if permission is already held.)
 */
export function requestReadPermission(h: FileSystemDirectoryHandle): Promise<PermissionState> {
  const ph = h as PermissionedHandle;
  return ph.requestPermission ? ph.requestPermission({ mode: 'read' }) : Promise.resolve('granted');
}
