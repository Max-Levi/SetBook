# SetBook

A single-file HTML songbook app for musicians: organize songs with chords
positioned over lyric lines, and export Performance and Print-Friendly PDFs.

## Use it

Open the hosted app (always the latest version):

**https://\<your-github-username\>.github.io/SetBook/**

No build step, no server — it's one self-contained HTML file.

## What's here

- `index.html` — the SetBook app.
- `storage/` — prototype of pluggable storage backends (local file,
  IndexedDB, GitHub, S3, generic REST) behind one adapter interface.
  See `storage/STORAGE_SPIKE_README.md`. `storage/spike-demo.html` is a
  live demo page.

## Updating the hosted app

Replace `index.html` with the newest copy of the app and commit —
GitHub Pages redeploys automatically within a minute or two.
