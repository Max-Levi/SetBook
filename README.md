# SetBook

A single-file HTML songbook app for musicians: organize songs with chords
positioned over lyric lines, and export Performance and Print-Friendly PDFs.

## Use it

Open the hosted app (always the latest version):

**https://max-levi.github.io/SetBook/**

No build step, no server — it's one self-contained HTML file.

## What's here

- `index.html` — the SetBook app.
- `sw.js` — the offline service worker (PWA). Network-first for the app
  shell, cache-first for the CDN assets (jsPDF, fonts). Bump `CACHE_VERSION`
  when the pre-cached asset list changes.
- `manifest.webmanifest`, `icons/` — PWA manifest and icons (placeholders;
  regenerate with `node tools/make-icons.js`).
- `tests/regression-test.js` — dependency-free regression tests that run
  the app's real script in Node (no browser needed):

  ```
  node tests/regression-test.js                                # fixture checks
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

## Google Drive cloud save (setup)

The Drive autosave is wired but disabled until credentials exist (the File
menu hides the Drive items when they're empty). One-time setup:

1. Create a Google Cloud project; enable the **Drive API** and the
   **Google Picker API**.
2. Create an **API key** and an **OAuth 2.0 Web client ID**. Add the
   hosting origin (e.g. `https://max-levi.github.io`) and
   `http://localhost` to the client's authorized JavaScript origins.
3. Fill `DRIVE_CLIENT_ID` and `DRIVE_API_KEY` at the top of the script in
   `index.html`.

Users sign in through Google's own picker; SetBook uses the per-file
`drive.file` scope (non-sensitive — no OAuth verification process), sees
only the file it creates in the folder the user picked, and keeps access
tokens in memory only.

## Updating the hosted app

Replace `index.html` with the newest copy of the app and commit —
GitHub Pages redeploys automatically within a minute or two.
