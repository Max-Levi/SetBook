# SetBook — Maintainer Guide

This file is the technical reference for anyone who maintains or extends
SetBook — human or AI. The in-app Help modal is written for musicians; it
deliberately contains none of this. When you change the app, update the
relevant section here **and** the in-app Help (see "Documentation
discipline" below).

## 1. What this is

SetBook is a **single-file HTML application**: all markup, CSS, and
JavaScript live in `index.html`. There is no build step and no backend.

Repo layout:

- `index.html` — the app. This is the source of truth.
- `docs/MAINTAINER.md` — this file.
- `README.md` — public pointer to the hosted app.
- `LICENSE`

The hosted app is served from this repo via GitHub Pages. The deploy
script (`setbook_deploy.py` in the maintainer's tooling) pushes
`index.html` (plus this doc and the README) through the GitHub Contents
API; the deployed bytes get a `noindex,nofollow` meta tag injected so the
site stays unlisted. Before pushing, a freshness gate compares the working
`index.html` against the latest commit on the branch and the live site:
if the branch moved after the working file was last touched, the deploy
is refused rather than clobbering newer work (`--force` bypasses it only
for an intentional revert; `--check` runs the gate without pushing).
GitHub Pages can take ~45s–2min to serve new bytes —
re-fetch with a cache-buster before diagnosing a stale deploy.

## 2. Architecture

- All application state is held in a single in-memory `state` object.
  Rendering is performed by a set of render functions
  (`renderSidebar`, `renderMain`, `renderPreview`) that rebuild their
  panes from that state.
- PDF generation is handled by the jsPDF library with a custom embedded
  monospace typeface (IBM Plex Mono, regular and bold), fetched once per
  session from a CDN and cached in memory, with graceful fallback if the
  fetch fails.
- Appearance is controlled by a `data-theme` attribute on the `<html>`
  element. The default theme is dark; a light theme follows the device's
  system preference. The choice can be overridden in File →
  Configuration…, and is persisted on the device.
- Layout consists of a resizable song-library sidebar alongside the main
  editor column, and adapts responsively down to phone widths.

## 3. Data model

All persistent data is a JSON serialization of the `state` object:

- `schemaVersion` — the saved-data shape version (`SETBOOK_SCHEMA_VERSION`;
  currently 1). Files without the field are legacy (pre-versioning) and load
  as version 1; files with a NEWER version still load (unknown fields are
  ignored here and preserved on the next save), so a bump never locks anyone
  out of their own songs. Per-version migrations live in `loadParsedState()`.
- `sectionGroups[]` — songs. Fields: `id`, `name` (title), `artist`,
  `videoUrl` (album-version link, optional), `videoUrlLive`
  (live-performance link, optional), `type` (`"cover"` | `"original"`,
  defaults to `"cover"`), `readyStatus` (`"ready"` | `"in-progress"` |
  `"not-ready"`, defaults to `"not-ready"`; files from before In Progress
  existed only hold the two old values and keep working), `tags` (array
  of custom tag strings, defaults to `[]`), `updatedAt` (ms-epoch
  timestamp of the song's last edit; `null` on files saved before stamps
  existed, shown as "unknown" in comparisons).
- `sections[]` — song sections. Fields: `id`, `groupId` (owning song),
  `nameType` (one of `"intro"`, `"verse"`, `"chorus"`, `"pre-chorus"`,
  `"bridge"`, `"instrumental"`, `"outro"`, or `"custom"`), `customName`
  (free text, used when `nameType` is `"custom"`), `nameSuffix`
  (optional informational tag appended after the number, e.g.
  `"(guitar solo)"`), `order` (position within the song), `lines[]`,
  `updatedAt` (ms-epoch timestamp of the section's last edit; `null` on
  older files, shown as "unknown"), and `name` — the derived display
  name, stamped at save time so the raw JSON stays readable and older
  SetBook versions still show a sensible title. The visible name is
  computed by `displaySectionName()`: sections sharing a base name within
  a song are numbered (`"Chorus"` alone, but `"Chorus 1"` / `"Chorus 2"`
  when there are two); custom names take part in the counting too, and a
  user-typed trailing number on a custom name (e.g. `"Solo 2"`) is ignored
  for grouping so numbering is never doubled. The **Auto-number sections**
  master switch (File → Configuration…) turns all automatic numbering
  off — every section then shows its plain base name; it is stored per
  file as `autoNumberSections` and defaults to on, and while it is off
  the singles switch is disabled. The **Number single sections** setting
  also numbers sections that appear only once (`"Chorus 1"` instead of
  `"Chorus"`); it is stored per file as `numberSingleSections` and
  defaults to off. Files saved before the name picker existed only have
  `name`; on load the whole old title becomes a custom name, with a
  trailing parenthetical aside moved into `nameSuffix` — then any custom
  name matching a section-type name, optionally with a trailing number
  (e.g. `"Verse 1"`), is converted to that picked type and the number is
  discarded.
- Line — `{ text, symbols[] }`. `text` is the lyric line; `symbols` is an
  array of `{ pos, value }` placing each chord symbol at an absolute
  character offset within the row, so chords stay aligned over the
  correct lyric characters in the preview and in PDF output.
- A section may be a mass-entry staging section (from Add song from URL)
  instead of a real section: it carries `massEntry: true`,
  `massEntryOriginal` (the exact scraped text, used by Reset), and
  `massEntryFields` — a list of `{ id, text, nameType, customName,
  nameSuffix }` fields, one per future section, each with its own
  section-naming row carried through to the created sections. The preview
  and the Create-sections parse share one line classifier
  (`classifyMassEntryLines()`), so the preview can never disagree with the
  parse. These fields exist only while the staging section is open;
  submitting the mass entry deletes the section and replaces it with
  normal sections.
- `songSubsets[]` — named song selections, `{ id, name, songIds[] }`,
  used to scope which songs are included in a PDF export.
- UI preferences persisted in the file: `projectName`, `songSort { field,
  dir }`, `sidebarWidth`, `songTypeFilter`, `readyFilter`,
  `autoNumberSections`, `numberSingleSections`, `focusedGroupId`,
  `lastFolderName`.
- `recentlyViewed[]` — the last six opened songs (`{ id, at }`, most
  recent first), powering Songs → Recently viewed songs….
- `recentlyDeleted[]` — the last five deleted songs as full snapshots
  (`{ group, sections, index, at }`, most recent first), powering
  Songs → Recently deleted songs….
- `tombstones[]` — bounded (50) deletion markers `{ id, deletedAt }` for
  deleted songs, saved with the file. Sync groundwork: a future multi-device
  merge uses them to keep a song deleted on one device from being
  resurrected by an older copy on another. Rules: song ids are never
  reused, so a live song with a tombstoned id means the delete was undone —
  `pruneTombstonesForLiveSongs()` drops those (and `loadParsedState`
  validates/caps/prunes on every load); undo and Recently-deleted restore
  drop the tombstone via `dropSongTombstone()`. Deletions on devices that
  never re-sync eventually fall out of the 50-cap — an accepted bound, not
  a correctness risk for the merge below.
- `mergeSongbooksForSync(mine, theirs)` — pure two-way, whole-song merge
  for a future sync backend: newer `updatedAt` wins wholesale (song AND its
  sections — never interleave two versions of one song); a one-sided song
  survives unless the other side carries a tombstone with
  `deletedAt >= song.updatedAt` (edit-after-delete wins); tombstones union
  newest-per-id, pruned of survivors. Returns
  `{ sectionGroups, sections, tombstones }`; callers own file-level fields
  and the live state. Not yet called from UI code — it is the contract a
  sync adapter will consume (see §13). Restoring re-inserts the song at its
  original position with all its sections; the undo-restore path drops
  the entry so a song restored via Undo can't be restored twice. Named
  deleted songs also count as "real work" for the crash-recovery offer
  (`recoveryHasContent`), so wiping the songbook still triggers "Pick up
  where you left off?".

## 4. Code organization and invariants

- All persistence serialization goes through `serializeState()` — the one
  seam that stamps `schemaVersion` on a shallow copy (live state is never
  mutated by a save). Never call `JSON.stringify(state)` directly in a save
  path: the linked-file save, `driveFileBody()`, the Save-as/backup
  download, and the filtered export all route through the seam.
- All book **writes and loads against the active link** go through the
  adapter facade: `storage/storage-adapters.js` is embedded verbatim in the
  app between `__SETBOOK_STORAGE__` markers (byte-parity asserted by the
  regression suite; sync with `node tools/embed-storage.js` after editing
  the canonical file), and the app adds two adapters on the same contract —
  `LinkedFileBookAdapter` (FS-handle file) and `DriveBookAdapter` (Drive
  file, conflict semantics identical to the original `driveSaveLibrary`).
  `activeBookAdapter()` is the single dispatch point (Drive wins while a
  Drive link exists, file handle otherwise, then the `SetBookCloudBookAdapter`
  prototype once `SETBOOK_CLOUD.enabled` is true and it is configured,
  null unlinked). Save/open code asks the facade instead of branching on
  `fileHandle`/`driveLink`; a future backend implements the same six
  methods and registers here. The
  spike's adapters are still exercised via `globalThis.SetBookStorage`;
  user gesture flows (open/save pickers, Drive connection) stay outside
  the adapter contract on purpose.
- All display-affecting transforms (lyric-continuation grouping,
  comment-line stripping, repeat markers) are centralized in
  `groupLinesForDisplay` and its helpers so the preview and both PDF
  pipelines share one code path. Editor source data is never mutated by
  display logic.
- Section display names are derived in exactly one place —
  `displaySectionName()`, with `sectionBaseName()` and
  `migrateSectionName()` beside it. Never read `sec.name` for display;
  `sec.name` is only stamped at save time by
  `stampSectionDisplayNames()` for JSON readability and backwards
  compatibility.
- Sidebar focus state lives in `state.focusedGroupId` (`null` = off).
  Enter and exit focus only through `setSongFocus()` so search-clearing,
  persistence, and re-rendering stay together; `renderSidebar()` reads the
  flag to hide the toolbar, other songs, and the "+ New song" button.
- The snapshot diff engine (`diffStates`) matches songs by id with a
  title+artist fallback, sections by id with a display-name fallback
  within each song, and compares rows as multisets of serialized lines —
  so it reports honest "+N / −N rows" without pretending to track
  individual edits. Section renames are detected by comparing the
  (`nameType`, `customName`, `nameSuffix`) triple rather than the display
  name, so auto-numbering shifts ("Chorus" → "Chorus 1") don't read as
  renames; `songIsEmpty()` keeps contentless placeholder songs out of the
  diff. It is a pure function of two states; the Snapshots modal and the
  open-file conflict modal are the callers. `renderDiffInto()` accepts
  `{ showTimes: true }` to append each song's and section's last-modified
  time on both sides (the later highlighted), used by the conflict modal;
  the Snapshots Compare view renders without it and is unchanged.
- URL import (Add song from URL) is the app's only fetch-from-URL
  feature, and its security model is: fetch gates the scheme on the
  resolved URL (only `http:`/`https:`) so smuggled schemes can't pass;
  HTML extraction runs through `DOMParser`, which never executes
  scripts; and scraped text is only ever assigned to input value
  properties or plain strings — never `innerHTML`. The
  `setbook-url-import` event hook normalizes its text through the same
  path before creating the staging section, and its takeover choice only
  re-targets which existing song is cleared — it never widens what the
  hook can touch.
- `generatePerformancePdf()` accepts an optional fifth argument
  `onlySectionId` for the per-section Section Preview. That parameter is
  deliberately **not** part of the MCP-extracted core (see below).
- Never call `renderSidebar()` on a text field's `input` event: it tears
  down and rebuilds the whole song list per keystroke, which reads as
  scroll/paint jank in a long library. The section-name fields follow
  this split — the type picker and custom-name field still re-render
  (typing a custom name can renumber siblings, since `sectionBaseName()`
  feeds the numbering key), but `renderSidebar()` there preserves and
  restores `#sidebarList.scrollTop`; the suffix field skips the sidebar
  entirely and patches the one `.section-row .name` label, because
  `nameSuffix` is only ever appended to the derived name and cannot
  renumber, re-sort, or re-filter anything.

## 5. Design system

- UI icons are hand-drawn inline SVGs (`<svg class="svg-icon"
  viewBox="0 0 512 512">`) embedded directly in the markup — there is no
  icon font or icon CDN. To add an icon, inline a new SVG with the
  `svg-icon` class; it sizes to 1em and inherits `currentColor`. **Do not
  reintroduce an external icon library.**
- Design tokens are disciplined: gold (`--gold`) is reserved for the
  brand mark, chord symbols, active states, and focus — never for general
  labels, tags, or status text. Radii follow a three-step scale: 6px
  controls, 10px surfaces, 999px pills. Only two typefaces load — Work
  Sans for UI, JetBrains Mono for chords and code. Pressable controls
  translate 1px on press (`:active`), and every focusable element shows a
  gold `:focus-visible` ring. In light mode the dimmed gold
  (`--gold-dim` #7a5f16) is the darkest that still keeps the brand look
  while holding ≈4.9:1 contrast against the paper background for preview
  chord symbols. The empty preview state shows a hand-drawn open-book
  illustration, not blank paper.

## 6. Third-party dependencies and offline support

- The jsPDF library lazy-loads from the cdnjs CDN on first PDF export
  (`ensurePdfLib()` injects the script tag) with a pinned Subresource
  Integrity hash (`integrity` + `crossorigin="anonymous"`), verified
  against the CDN's published value for the pinned version — a tampered
  or substituted file is rejected by the browser instead of executing. If
  jsPDF is ever upgraded, regenerate the hash from the new file (e.g.
  `openssl dgst -sha512 -binary`, base64-encoded) and update the
  constant in `ensurePdfLib()`, the `PRECACHE_URLS` entry in `sw.js`, and
  the security test, which asserts the exact hash.
- The PDF.js page renderer (`ensurePdfJs()`, cdnjs
  pdf.js/3.11.174/pdf.min.js + pdf.worker.min.js) follows the same
  pattern — pinned SRI hashes, same places to update on upgrade. The
  worker bundle is preloaded so pdf.js runs it on the main thread (its
  "fake worker"); with `window.pdfjsWorker` already present,
  `getDocument()` performs no extra fetch. If either file can't load, the
  preview falls back to the plain iframe viewer.
- Offline support is a service worker (`sw.js`) plus
  `manifest.webmanifest` and placeholder icons. The worker is
  network-first for the app shell (a Pages deploy must never be pinned
  stale) and cache-first for immutable CDN assets (jsPDF, fonts);
  Drive/auth traffic is bypassed so tokens never transit the cache. Bump
  `CACHE_VERSION` in `sw.js` whenever the pre-cached asset list changes.
  Registration is guarded to https/localhost and never blocks the app —
  including the Node test sandbox, which provides no service worker.
- A `Content-Security-Policy` meta pins every origin the page may touch:
  `script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://accounts.google.com https://apis.google.com`
  (the whole app is inline script, so 'unsafe-inline' is unavoidable without
  a build step — it is also what keeps the scraper extension's MAIN-world
  injections working; the two Google origins load the Drive auth SDK
  (`/gsi/client`) and Picker SDK (`js/api.js`) on demand), `style-src`
  inline + fonts.googleapis.com, `font-src` fonts.gstatic.com,
  `connect-src https:` (URL import + Drive REST + OAuth tokens),
  `img-src 'self' data: blob:`, `frame-src blob:` (PDF preview iframe)
  plus `https://docs.google.com` (the Picker's iframe) and
  `https://accounts.google.com` (Google auth's hidden frames),
  `worker-src 'self' blob:` (sw.js registration + pdf.js worker),
  `object-src 'none'`, `base-uri 'none'`. Adding an
  external origin means updating the CSP meta, the pinned SRI, `sw.js`, and
  the security test together — one change, four places. **Known failure
  mode (2026-10-07):** the first CSP rollout omitted the two Google
  origins, which silently severed every Drive path — boot re-link,
  Connect, and the Picker — because `loadScriptOnce` rejected on the
  blocked script; any new SDK origin must be load-tested by actually
  invoking the feature that fetches it, not just by a clean page load.

## 7. Google Drive cloud save

Drive autosave uses Google's Picker flow with the per-file `drive.file`
scope (non-sensitive: no OAuth app verification or security assessment).
The credentials are bring-your-own constants
(`DRIVE_CLIENT_ID`/`DRIVE_API_KEY`) at the top of the script — the app
ships with them empty and hides the Drive menu items until they are
filled; tokens are memory-only and the persisted link (file/folder ids)
lives in the same IndexedDB store as local file handles. Drive v3 has no
conditional writes: conflict detection compares `modifiedTime` before
each write — a documented check-then-write race. The same staleness rule
guards the crash-recovery offer: "Pick up where you left off?" is
suppressed (at boot and at restore-click time) when the snapshotted file
is newer on disk — or on Drive, via `isDriveFileNewerThanSnapshot()`,
which compares the Drive file's `modifiedTime` against the snapshot (an
external import or another device moving the Drive copy on must not be
overwritten by a stale browser restore). Unreachable Drive resolves to
"can't tell" and keeps the old behavior.

The file Picker itself is factored as `drivePickJsonFile(title)`, shared
by File → Open from Google Drive… (`drivePickAndOpen`) and the Import
songs modal's "Choose from Drive…" button (`drivePickCopySource`). The
import path downloads the picked file and loads it as the copy source
only — it never opens or links it, so the open file stays the import
target and autosave is untouched. Every imported song is marked
In Progress on the way in (regardless of the status the source file
claimed), so freshly pulled-in songs are easy to find and review via
the status filter.

## 8. MCP server

`setbook-mcp/` (in the maintainer's tooling checkout, alongside this
repo) is a stdio MCP server exposing the song pipeline to AI agents:
`scrape_song`, `parse_song_text`, `add_song_to_file`, `list_songs`. Its
parsing core (`core/setbook-core.mjs`) is not a copy: `build-core.mjs`
extracts it verbatim from the `__SETBOOK_MCP_CORE_BEGIN__` /
`__SETBOOK_MCP_CORE_END__` marker comments in `index.html`, so
`index.html` is the source of truth. Keep those regions
environment-agnostic (no app state; `DOMParser`/`fetch` only) and rebuild
the core (`node build-core.mjs`) whenever they change — the package's
parity test fails if the checked-in core goes stale.

## 9. Documentation discipline

- The in-app Help modal is written for musicians: clear, concise,
  task-oriented, no implementation detail. Keep it that way.
- This file is the maintainer reference. When you add, change, or remove
  a feature: update this file **and** the in-app Help, and refresh the
  Help's "Last updated" date. No separate approval is needed for doc
  updates — they ship with the change.
- The Help modal's content sections carry ids of the form `help-*`
  (e.g. `help-extension`, which the URL-import dialog scrolls to). Keep
  those ids stable.

## 10. Mobile is a standing requirement

Mobile UX is a requirement on every change, not a separate pass: any UI
addition or alteration must also be adapted and verified at phone width
(≤760px). New header controls need ≥44px touch targets; new modals must
pick up the compact mobile styling (94vw sheet, tightened type, enlarged
action buttons); drawer interactions must hand the full screen to the
editor (close the drawer when a section, search result, or "+ Add
section" is chosen, keep it open while naming a new song). Verify with
the mobile Playwright suite plus a 390px visual pass.

## 11. Security audit checklist

Run this audit on every change; fix what you find, test, and deploy:

- CDN dependencies without pinned SRI (jsPDF, PDF.js main + worker,
  Google Fonts).
- CSP meta missing an origin a change newly fetches script, style, font, or
  connect access for (see §6) — and check the browser console for CSP
  violation reports after any dependency change.
- `innerHTML` / DOM sinks fed by untrusted data (imported files, scraped
  pages) — scraped text must only ever reach input values or plain
  strings.
- `eval` / `new Function`.
- Overly broad extension permissions (the scraper extension asks for the
  minimum: `activeTab`, `scripting`, host access to the SetBook site and
  `file://` pages only).
- Insecure link handling.

## 12. QA regression checklist

Run this pass after any code change — especially refactors — before
calling the work done. It is written so a human or an automated browser
script can repeat it. (The maintainer's Playwright suites under
`setbook-qa/` automate the browser pass; the suite names and check
counts are listed in part C.)

**A. Static checks** (fast, no browser needed):

- Extract the inline `<script>` blocks and run node --check on them —
  JavaScript syntax must pass.
- Verify balanced div / section / ul / button tags.
- After a refactor, grep for dangling references to removed identifiers
  and confirm every modal open/close button has exactly one listener
  path.

**B. Browser regression pass** (serve the file over local HTTP, e.g.
`python3 -m http.server` in the file's folder, then open it in a real
browser with the console visible):

- Load: no console errors; the welcome modal appears; the jsPDF library
  loads from CDN.
- Welcome modal: dismisses cleanly via its start button.
- Create content: add a song (title + artist), set its section type via
  the picker, add rows, type chords and lyrics. The live preview must
  reflect every edit.
- Focus mode: click the ◎ button on a song header and confirm the
  search box, sort/filter controls, "+ New song", and other songs are
  hidden while the focused song's sections stay listed and selectable,
  and confirm the editor opens the focused song's top section (not
  whatever section was open in the previous song); click "← All songs"
  and confirm everything returns; reload and confirm the focus choice is
  restored.
- Section naming: pick each section type and confirm the sidebar,
  preview, and a generated PDF show the derived name; add a second Chorus
  and confirm both become "Chorus 1" / "Chorus 2", then delete one and
  confirm the other reverts to "Chorus"; set a Custom name and a label
  like (guitar solo); toggle Number single sections in File →
  Configuration… and confirm a lone Chorus becomes "Chorus 1" (and that a
  legacy custom "Verse 1" does not become "Verse 1 1"); toggle Auto-number
  sections off and confirm all numbering disappears and the singles
  checkbox disables, then toggle it back on; open a legacy JSON whose
  sections only have name and confirm type-like titles (e.g. Verse 1,
  Bridge (quiet)) become picked types while other titles (including
  trailing parentheticals) survive as Custom names.
- Row actions: copy appends a duplicate with the same chords and lyrics
  at the bottom of the section; move up/down reorders; dragging the
  line-number gutter reorders live and dropping commits the new order
  (Escape cancels, a press without moving does nothing); Clear chords
  clears only chords; Clear lyrics clears only lyrics; delete removes the
  row. Each destructive row action offers Undo via toast, the File menu,
  or Ctrl/Cmd+Z. No console errors.
- Section split and reorder (mass editor): in a song with three sections,
  put a blank line in the middle section's field and press its Split chip —
  the new section must appear directly below the split one (both in the
  editor and in the sidebar), carrying the lower text, with the head
  keeping the upper text; the song's other sections must not move. The
  ↑ ↓ buttons in each section header move that section one slot within
  the song (up disabled on the first section, down disabled on the last);
  they are hidden while focusing a single section. No console errors.
- Line classifier chips: with a song open, the per-line "as chords" /
  "as lyrics" chips are hidden until the section field is hovered or
  focused (tap into the field on touch); a line with a manual override
  always shows its "auto" chip, and clicking it reverts to automatic.
- Editor hint: the "One field per section" coaching line at the top of
  the editor disappears as soon as the song has any content (and stays
  hidden on re-render).
- Section focus button: the ◎ button in a section header shows a gold
  active state while its section is the focused one.
- Song details page: the ⓘ icon on a song card opens a dedicated details
  page (title, artists, tags, type, ready status, both video links fully
  visible with a Watch button); editing there syncs the sidebar card;
  "← Back to chart" returns to the previously open section; navigating to
  a section, focusing, or deleting the song closes the page. No console
  errors.
- Sidebar scroll timing: `scrollSelectedSongHeadIntoView()` measures after
  a double rAF (not setTimeout 0) so auto-growing name fields have settled;
  otherwise the scroll can land short when cards grow post-measure.
- "(Continued)" section type: inherits the previous section's name
  ("Verse 1 (Continued)"); consecutive continued sections number up
  ("Verse 1 (Continued 2)") following the auto-numbering setting; also
  available in the mass-entry field picker and via a `[(Continued)]`
  header line. No console errors.
- Transpose key pickers: 17 keys — every entry pairs its relative minor
  (C / Am); the five black keys have separate flat and sharp entries
  (Ab / Fm vs G# / Fm). The picked spelling decides sharp-vs-flat chord
  spellings. No console errors.
- Caret column-keep: ↑ ↓ in a section edit field hold the cursor's column,
  padding the target line with spaces when shorter (undoable); modified
  keys and first/last lines keep native behavior. No console errors.
- Transposed chord spacing: `transposedSectionLines()` keeps every chord
  after the first at least one space clear of its predecessor, so tight
  originals and chords that grow in transposition never jam together in
  the preview or PDF. Stored data untouched. PDF key-note uses ASCII
  "->" (a raw → renders as "!'" with the embedded mono font).
- Disconnected cloud badge: with Drive not connected, the header badge
  reads "Cloud save disabled" in neutral gray (not red); the green
  "Drive" badge is unchanged while connected.
- Welcome modal: "Open existing file…" is the single gold primary;
  "Start new file" and "Keep it in Google Drive…" are secondary.
- Header status: with no file open and an empty songbook, only "No file
  open" shows — the save dot/text are hidden; adding content without a
  file link still shows the "not linked to a file yet" prompt.
- Recently deleted songs: delete a song (confirm the ✕ popover) and
  confirm Songs → Recently deleted songs… lists it with a time-ago
  label; Restore puts it back with all its sections at its original
  position and opens it; deleting six songs keeps only the last five;
  reloading the file keeps the list (it is saved with the file); using
  Undo on the delete toast removes the entry from the list.
- PDF modal: the song checklist lists the song; Select all checks
  everything, Select none clears, Ready only selects just Ready songs
  (mark one song Ready first to verify). Generate a Performance PDF in
  light mode and in dark mode, and a Print-Friendly PDF — each must
  complete and produce a download with no errors.
- Per-song PDF preview: click the PDF icon on a song header (also present
  in focus mode) — the modal opens with the song's name, the Performance
  PDF renders as a left-to-right page strip, and the Download button
  appears. Turn pages with the ‹ › buttons and the arrow keys; switch to
  Print Friendly PDF (vertical scrolling) and to dark mode; each change
  re-renders without errors.
- Section Preview: each section editor field has a folded Section
  Preview accordion beneath it — unfolding it renders the Performance PDF
  page for just that section (light mode, iPad landscape) on a canvas;
  typing while it is open refreshes the canvas after a short delay rather
  than on every keystroke; renaming, re-typing, transposing, or
  chord/lyric-swapping the section updates it; closing the accordion
  cancels any in-flight render.
- Modals: Help, share/device-transfer help, copy-songs, Configuration,
  and the PDF dialog each open from their buttons and close via their
  close buttons, via clicking the overlay background, and via Escape
  (focus returns to the opener).
- Report a bug: Help → Report a bug… builds a mailto: to
  nozomu1000@gmail.com with subject "SetBook bug report" and the
  Steps-taken / Expected-outcome / Actual-outcome template body; clicking
  it must not navigate the app away or raise console errors (covered by
  bug-report-test.js).
- Configuration: open File → Configuration…; switch Appearance to Light
  and confirm the theme applies, then reload and confirm the choice
  persists; set Watch video links to Same tab and confirm the Watch
  button's tooltip changes, then set it back to New tab.
- Sidebar: search filters the song list; the Sort & Filter toggle
  collapses and expands the sort/filter controls and its summary line
  reflects the active filters; Expand/Collapse all sit outside the panel
  and highlight gold to show the expansion state (Collapse all also
  closes all open Details panels); the Clear all button appears beside
  the toggle whenever anything narrows the list — panel open or closed —
  and resets search plus every filter at once, while each dropdown's ✕
  clears just that dropdown; title and artist sorting reorder correctly;
  Cover/Original, Ready/In progress/Not ready, tag, and artist filters
  apply. Hiding the open song with a filter closes the editor to the
  empty starting view, and restoring the filter leaves the empty view
  (nothing auto-reopens).
- Save: Save as produces a file download with no errors.
- Snapshots & diff: open File → Snapshots… and confirm a snapshot exists
  for the last file load; take a manual snapshot, edit a song (add a row,
  rename, toggle Ready), then Compare the earlier snapshot against
  Current and confirm the diff lists the changes; restore the earlier
  snapshot (confirm the popover) and confirm the edits are gone while a
  "Before restoring…" snapshot was kept; use "Compare with a file…" on
  another JSON and confirm added/removed songs appear.
- Narrow layout (mobile UX): at phone width (≤760px) the sidebar is a
  drawer opened by the 44px hamburger button and closes when a section,
  search result, or "+ Add section" is chosen (it stays open while naming
  a new song); header icon buttons and modal action buttons meet the 44px
  touch target; the welcome and PDF modals use the compact mobile styling
  with no horizontal overflow; row icon buttons collapse into a ⋯ menu
  with labeled actions; the PDF dialog keeps Generate visible in a sticky
  footer; the hint row wraps instead of colliding with the Clear pills;
  the preview paper scrolls horizontally instead of clipping; no console
  errors.

**C. Record the result.** Note what was checked, the date, and any
failures or limitations (e.g. a CDN dependency being unreachable in the
test environment). Automated Playwright scripts covering the browser pass
live in the maintainer's `setbook-qa/` workspace: `regression-test.js`
(57 checks), `section-names-test.js` (32), `ux-top5-test.js` (28),
`row-drag-test.js` (24), `polish4-test.js` (27),
`mobile-drawer-test.js` (14), `snapshot-test.js` (33),
`pdf-toc-links-test.js` (10), `tag-filter-test.js` (18),
`export-filtered-test.js` (12), `song-details-test.js` (33),
`pdf-redownload-test.js` (11), `recovery-relink-test.js` (13),
`filter-panel-test.js` (68), `pull-refresh-test.js` (14),
`welcome-compact-test.js` (13), `section-numbering-test.js` (18),
`section-continued-test.js` (10), `transpose-keys-test.js` (20),
`transpose-spacing-test.js` (13), `caret-column-test.js` (16),
`recovery-stale-test.js` (11), `recovery-drive-stale-test.js` (9), `recovery-open-conflict-test.js` (38),
`save-age-test.js` (15), `security-test.js` (24), `video-links-test.js`
(25), `url-import-test.js` (124), `setbook-ext-test.js` (38),
`section-autoconvert-test.js` (33), `auto-period-test.js` (12),
`picker-filter-test.js` (9), `import-feedback-test.js` (8),
`pdf-preview-test.js` (32), `section-pdf-preview-test.js` (19),
`deleted-songs-test.js` (22), `suffix-scroll-test.js` (17) — 34 suites, 870 checks in total. A refactor that changes no user-visible
behavior does not require a documentation update beyond this file's own
revision note.

## 13. Phase-0 groundwork for a future service

Inert scaffolding for the day SetBook grows accounts/sync, ads, or a
subscription. None of it changes behavior today; all of it is tested in the
regression suite and documented so the future change is a plug-in, not a
rewrite.

- **Serialization seam** — `serializeState()` (§4) is the single path every
  save takes; a future sync backend reads/writes the same bytes users' files
  already use.
- **Anonymous device persona** — `getDevicePersonaId()` returns a stable
  random `dev_…` id from localStorage (null when storage is unavailable). It
  identifies nothing personal and is not transmitted. When accounts arrive,
  sign-up links this persona's local data (recovery snapshots, linked-file
  history) to the account so existing users keep their work. Privacy note:
  docs/PRIVACY.md discloses it.
- **Ad-slot contract** — `AD_CONFIG` (disabled) + `mountAdSlot(name)`. Ads
  must never mount inside the editor, sidebar, or preview DOM; the SDK (if
  there ever is one) must be lazy-loaded behind user consent, exactly like
  `ensurePdfLib()`, so the core file stays ad-free and CSP changes stay
  localized. While `AD_CONFIG.enabled` is false the mount returns null and
  renders nothing.
- **Adapter quota seam** — `storage/storage-adapters.js` adapters implement
  `quota() -> null | {used, limit, unit}` (see the storage spike README).
  A future first-party backend reports the signed-in plan there; the app
  never hardcodes storage limits.
- **Privacy policy** — docs/PRIVACY.md states today's reality (no accounts,
  no analytics, no ads). It must be rewritten BEFORE any account/ad/
  subscription feature ships.
- **Deletion tombstones + two-way merge** — `state.tombstones` (§3) and
  `mergeSongbooksForSync()` give sync a way to represent deletions and
  resolve whole-song conflicts without a server format change: the merged
  result is an ordinary songbook file.
- **SetBook Cloud prototype (disabled)** — `SETBOOK_CLOUD = { enabled: false }`
  and `SetBookCloudBookAdapter` implement the sync adapter the tombstone
  groundwork was waiting for: same six-method contract, `https://`-only
  endpoint, rev = ETag with `If-Match`/`If-None-Match` conditional writes,
  and — when the server copy moved since our rev — a
  `mergeSongbooksForSync()` over both sides whose survivor set is written
  back (returning `merged: true` so a caller knows to reload, like the
  Drive conflict modal). While the flag is false the adapter is
  unreachable from the dispatch and nothing fetches; no server exists yet.
  Flipping the flag is the rollout gate — before that, wire the reload
  path and a real endpoint, and re-run the §11 security audit (the
  endpoint is user-configurable, so treat it as untrusted input).

---

*Maintainer guide extracted from the in-app documentation on 2026-10-01.
Revised 2026-10-05: schemaVersion + serializeState seam, CSP meta, Phase-0
groundwork (§13), adapter quota seam. Revised 2026-10-06: storage-adapters
embedded verbatim; LinkedFileBookAdapter/DriveBookAdapter +
activeBookAdapter() facade as the single write/load path; deletion
tombstones + mergeSongbooksForSync() sync groundwork; SetBook Cloud sync
adapter prototype (disabled) + §11 security audit re-run. Revised
2026-10-07: CSP fix — add the Drive auth/Picker script origins and the
Picker/auth frame origins that the first CSP rollout blocked, which had
broken every Google Drive path (boot re-link, Connect, Picker). Keep it
current: it is the reference any tool or human uses to maintain and
extend this app.*
