# SetBook

A single-file HTML songbook app for musicians: organize songs with chords
positioned over lyric lines, and export Performance and Print-Friendly PDFs.

## Use it

Open the hosted app (always the latest version):

**https://max-levi.github.io/SetBook/**

No build step, no server — it's one self-contained HTML file.

## What's here

- `index.html` — the SetBook app.
- `tests/regression-test.js` — dependency-free regression tests that run
  the app's real script in Node (no browser needed):

  ```
  node tests/regression-test.js                                # 45 fixture checks
  node tests/regression-test.js /path/to/songbook.json        # + read-only
                                                               # round-trip pass
                                                               # over any library
  ```

  The optional file argument loads any SetBook JSON (never copied or
  modified) and verifies every section survives the mass-entry editor's
  text conversion losslessly.
- `storage/` — prototype of pluggable storage backends (local file,
  IndexedDB, GitHub, S3, generic REST) behind one adapter interface.
  See `storage/STORAGE_SPIKE_README.md`. `storage/spike-demo.html` is a
  live demo page.

## Updating the hosted app

Replace `index.html` with the newest copy of the app and commit —
GitHub Pages redeploys automatically within a minute or two.
