# SetBook

A single-file HTML songbook app for musicians: organize songs with chords
positioned over lyric lines, and export Performance and Print-Friendly PDFs.

## Use it

Open the hosted app (always the latest version):

**https://max-levi.github.io/SetBook/**

No build step, no server — it's one self-contained HTML file.

## What's here

- `index.html` — the SetBook app.
- `docs/MAINTAINER.md` — technical reference for anyone maintaining or
  extending the app (architecture, data model, dependencies, MCP server,
  security, QA). The in-app Help is written for musicians; this file is
  for maintainers.
- `storage/` — prototype of pluggable storage backends (local file,
  IndexedDB, GitHub, S3, generic REST) behind one adapter interface.
  See `storage/STORAGE_SPIKE_README.md`. `storage/spike-demo.html` is a
  live demo page. The app embeds this file verbatim (between
  `__SETBOOK_STORAGE__` markers in `index.html`) and routes the linked-file
  and Drive save/load paths through adapters on the same contract —
  sync with `node tools/embed-storage.js` after editing it.
- `docs/` — the maintainer reference (`MAINTAINER.md`) and the privacy
  policy (`PRIVACY.md`).

## Updating the hosted app

Replace `index.html` with the newest copy of the app and commit —
GitHub Pages redeploys automatically within a minute or two. Keep
`docs/MAINTAINER.md` in sync with any app change (the deploy script
pushes both).
