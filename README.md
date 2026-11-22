# TTOTD web

A browser reimplementation of *The Typing of the Dead* (English PC v1.0) that runs on **your own copy** of the game:
no game data is included. See [goal.md](goal.md) for the plan, [docs/progress.md](docs/progress.md) for what has been done so far, and
[re/notes/overview.md](re/notes/overview.md) for the reverse-engineering findings.

```sh
npm install
npm run dev          # open the printed URL, then "Open game folder…" → pick the folder with Tod_e.exe
npm test             # unit tests (synthetic data only)
TTOTD_DIR=~/Downloads/TTOTD npm test   # also check your own install
```

Chrome/Edge remember the folder between visits ("Reopen …"); Safari/Firefox ask each time.
