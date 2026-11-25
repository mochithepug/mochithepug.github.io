import type { GameFile, GameFS } from './gamefs';

/**
 * What a complete English PC v1.0 install looks like. Only counts, sizes and a hash —
 * metadata used to tell the player whether their copy is the one this engine targets.
 */
export const EXE_NAME = 'tod_e.exe';
export const EXE_SIZE = 2_048_000;
export const EXE_SHA256 = '15a333dfbe0d7baf94d08d2219e466ec006dd05e1f0c469d2452caee9fb3fbdf';

export interface Category {
  id: string;
  label: string;
  prefix: string;
  expected: number;
  kind: 'bin' | 'wav' | 'other';
}

export const CATEGORIES: Category[] = [
  { id: 'pol', label: 'Models', prefix: 'pol/', expected: 358, kind: 'bin' },
  { id: 'tex', label: 'Textures', prefix: 'tex/', expected: 553, kind: 'bin' },
  { id: 'mot', label: 'Motions', prefix: 'mot/', expected: 49, kind: 'bin' },
  { id: 'cam', label: 'Camera paths', prefix: 'cam/', expected: 23, kind: 'bin' },
  { id: 'coli', label: 'Collision', prefix: 'coli/', expected: 9, kind: 'bin' },
  { id: 'evt', label: 'Event tables', prefix: 'evt/', expected: 13, kind: 'bin' },
  { id: 'word', label: 'Word lists + font', prefix: 'word/', expected: 489, kind: 'bin' },
  { id: 'bgm', label: 'Music', prefix: 'sound/bgm/', expected: 38, kind: 'wav' },
  { id: 'voice', label: 'Voices', prefix: 'sound/voice/', expected: 831, kind: 'wav' },
  { id: 'se', label: 'Sound effects', prefix: 'sound/se/', expected: 445, kind: 'wav' },
];

export const OTHER: Category = { id: 'other', label: 'Other files', prefix: '', expected: 0, kind: 'other' };

export type Status = 'ok' | 'warn' | 'error';

export interface CategoryReport {
  category: Category;
  files: GameFile[];
  bytes: number;
  status: Status;
  note: string;
}

export interface Report {
  exe: { status: Status; note: string };
  categories: CategoryReport[];
  other: CategoryReport;
}

const isJunk = (f: GameFile) => f.key.endsWith('mscache.sys');

export function categorise(fs: GameFS): { categories: CategoryReport[]; other: CategoryReport } {
  const buckets = new Map<Category, GameFile[]>([...CATEGORIES, OTHER].map((c) => [c, []]));
  for (const f of fs.files) {
    const c = CATEGORIES.find((c) => f.key.startsWith(c.prefix) && !isJunk(f)) ?? OTHER;
    buckets.get(c)!.push(f);
  }
  const report = (c: Category): CategoryReport => {
    const files = buckets.get(c)!;
    const bytes = files.reduce((n, f) => n + f.size, 0);
    if (c === OTHER) return { category: c, files, bytes, status: 'ok', note: '' };
    const n = files.length;
    const status: Status = n === 0 ? 'error' : n === c.expected ? 'ok' : 'warn';
    const note =
      n === 0 ? `missing: no files in ${c.prefix}` : n === c.expected ? '' : `expected ${c.expected} files, found ${n}`;
    return { category: c, files, bytes, status, note };
  };
  return { categories: CATEGORIES.map(report), other: report(OTHER) };
}

export async function checkExe(fs: GameFS): Promise<{ status: Status; note: string }> {
  if (!fs.has(EXE_NAME)) {
    return {
      status: 'error',
      note: 'Tod_e.exe not found at the top of this folder. Pick the folder that contains Tod_e.exe.',
    };
  }
  const buf = await fs.read(EXE_NAME);
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buf)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  if (hash === EXE_SHA256) return { status: 'ok', note: 'English PC v1.0 (known good)' };
  return {
    status: 'warn',
    note: `Tod_e.exe differs from the known English v1.0 (size ${buf.byteLength}, sha256 ${hash.slice(0, 12)}…). Patched or another release?`,
  };
}

export async function buildReport(fs: GameFS): Promise<Report> {
  return { exe: await checkExe(fs), ...categorise(fs) };
}
