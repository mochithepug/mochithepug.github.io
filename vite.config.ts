import { createReadStream, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { Plugin } from 'vite';
import { defineConfig } from 'vite';

/**
 * Dev-only convenience: when TTOTD_DIR is set, `npm run dev` serves that folder (the user's own
 * install) at /__ttotd/ so the page can load it without the folder picker (open with ?dev).
 * Only active in the dev server on localhost; never part of a build.
 */
function devGameData(): Plugin {
  const root = process.env.TTOTD_DIR && resolve(process.env.TTOTD_DIR);
  return {
    name: 'ttotd-dev-game-data',
    apply: 'serve',
    configureServer(server) {
      if (!root) return;
      server.middlewares.use('/__ttotd/', (req, res) => {
        const url = decodeURIComponent((req.url ?? '/').split('?')[0]!);
        if (url === '/list') {
          const files: { path: string; size: number }[] = [];
          const walk = (d: string) => {
            for (const n of readdirSync(d)) {
              if (n === '.DS_Store') continue;
              const p = join(d, n);
              const s = statSync(p);
              if (s.isDirectory()) walk(p);
              else files.push({ path: relative(root, p).split(sep).join('/'), size: s.size });
            }
          };
          walk(root);
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(files));
          return;
        }
        const p = resolve(root, '.' + url);
        if (!p.startsWith(root + sep) || !statSync(p, { throwIfNoEntry: false })?.isFile()) {
          res.statusCode = 404;
          res.end();
          return;
        }
        createReadStream(p).pipe(res);
      });
    },
  };
}

export default defineConfig({ plugins: [devGameData()], server: { host: 'localhost' } });
