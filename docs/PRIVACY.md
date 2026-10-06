# SetBook privacy

Plain words, current reality. If SetBook ever adds accounts, cloud sync,
advertising, or subscriptions, **this document is rewritten first** — before
the feature ships, not after.

## The short version

SetBook is a static web app. There are no accounts, no server-side storage,
no analytics, no telemetry, no ads, and no tracking cookies. Your songs are
in files you own.

## Where your data lives

- **Your songbook file** — on your disk, in a folder you chose, saved with
  your browser's File System Access API (or downloaded).
- **Your browser** — crash-recovery snapshots, the linked-file handle, theme
  and layout preferences, and one anonymous random device id live in
  IndexedDB / localStorage on your device. Clearing site data wipes all of it.
- **Your Google Drive** — only if *you* connect one. SetBook asks for the
  per-file `drive.file` scope (it can only see files it created or that you
  explicitly picked — never the rest of your Drive), and access tokens live
  in memory only, never written to disk.

## Network requests the app makes

- **Google Fonts** — Work Sans and JetBrains Mono typefaces.
- **cdnjs** — the jsPDF and PDF.js libraries (pinned, integrity-checked).
- **Add song from URL** — your browser fetches exactly the page you asked
  for, directly; it never passes through a SetBook server (there isn't one).
- **Google Drive API** — only while a Drive connection you set up is active.

## What we never see

Your songs. They never leave your device (or your own Drive) on their way to
anyone. There is no SetBook server to see them.

## The anonymous device id

SetBook generates a random id (`dev_…`) stored only in your browser. It is
not tied to any identity, account, or contact info, and it is not transmitted
anywhere today. Its purpose is continuity: if accounts ever arrive, linking
this id is how your existing local work carries over instead of starting
from zero.

## Questions

The bug-report address in Help → Report a bug… (nozomu1000@gmail.com) works
for privacy questions too.

*Last updated 2026-10-05.*
