# SetBook Songbook Conventions

Version: 1.0.1 (2026-10-03)

How an AI agent turns a tab or scraped song text into a SetBook song JSON in
this user's style. These rules were gleaned from the user's `master_songbook.json`
— a private reference file that must never be modified, copied into a public
repo, or used beyond learning these conventions.

## Reference scope

- Only songs with `readyStatus: "ready"` count as ground truth for style.
  Anything marked not-ready (including every agent-produced song) is a draft.
- New songs an agent creates always land as `readyStatus: "not-ready"`,
  `type: "cover"` (unless the user says otherwise), with a genre tag in
  `tags` (e.g. `Jam Band`, `Classic Rock`, `Blues`, `Funk`).

## Song JSON shape

- Top level: `{ sectionGroups: [group], sections: [...] }`.
- Group: `{ id, name, artist, type, readyStatus, tags, updatedAt }`.
- Section: `{ id, groupId, nameType, customName, nameSuffix, name, order, updatedAt, lines }`.
- Row: `{ text, symbols }` where `symbols` is `[{ pos, value }]` — each chord
  symbol stored at its **absolute character offset** within the lyric line.

## Section naming

- `nameType` is one of the picker's types: `intro`, `verse`, `chorus`,
  `pre-chorus`, `bridge`, `instrumental`, `outro`, `continued`, or `custom`.
- The app **derives** display numbering: repeated base names become
  "Verse 1", "Verse 2", "Chorus 1", "Chorus 2" on its own. In the JSON, set
  `name` to the derived form you intend (e.g. `"Verse 1"`) and keep sections
  in performance order via `order` (0-based, dense).
- `continued` is for a section that carries on the previous one: the app
  names it "[previous section name] (Continued)" itself, so leave `name`
  unset for it. Consecutive continued sections number up — "Verse 1
  (Continued)", "Verse 1 (Continued 2)" — following the file's
  auto-numbering setting.
- `customName` is for names the picker can't express: combined sections
  ("Verse/Chorus") or split ones the tab calls out specially. A custom
  "Chorus" still numbers together with picked choruses, so don't hand-number
  it — write `customName: "Chorus"` and let the app number.
- `nameSuffix` is an informational tag appended after the name, e.g.
  `"(guitar solo)"`. Use it for performance notes (solo, jam, optional) —
  never bake those into the name, and never use it for repeat counts (see
  Repeats below).

## Rows: chords and lyrics

- A lyric line with chords above it becomes one row: `text` is the lyric,
  `symbols` holds each chord at its absolute offset (`pos` counts characters
  from the line start, 0-based).
- A **chord-only** passage (intro vamp, solo changes, repeated 12-bar form)
  is a row with `text: ""` and the chords in `symbols`. Don't invent lyric
  text to hold chords.
- When a tab stacks several chords over one word, spread them across the
  word's repeated lyric (or neighboring words) so each symbol renders at a
  distinct offset — never stack two symbols at the same `pos`.
- Validate every offset: `pos` must land inside the lyric line it belongs to.

## Cleanup: what to drop, keep, and normalize

Tabs and scraped pages carry cruft. Drop it:

- Fret-number tab diagrams and other non-chord notation.
- Prose roadmaps with no notated content ("[Intro] x2" as a bare label).
- Songwriter credits, "X" end markers, alternate-capo notes, tuning chatter.
- A tab commenter's alternate chords — prefer the main tab's voicings, and
  **tell the user** what the alternative was rather than silently choosing.

Normalize:

- Enharmonics to the song's key (F# → Gb in an Ab song).
- Typos in lyrics ("shes" → "she's"), curly quotes/punctuation to straight.

Keep verbatim:

- The tab's chord shapes when they matter (e.g. D-shape voicings for capo III).
- Unusual held vocal lines exactly as written ("Evvvvvvvvvvvvvvv").

## Repeats

- A repeated form (e.g. the same 12-bar progression for Solo and Outro) is
  written out per section as chord-only rows.
- The repeat count or instruction — `(x4)`, `(x2, w/ option to extend
  solo)`, `(repeat as needed)` — goes on **its own chord line below the
  final chord line** of the repeated section: a closing row with `text: ""`
  and the annotation stored as `symbols`, e.g.
  `[{ "pos": 0, "value": "(x4)" }]`. Multi-word annotations split into one
  symbol per word at its character offset, exactly as if typed on a chord
  line in the app (`(repeat as needed)` → `(repeat` @0, `as` @8,
  `needed)` @11).
- Never put the count in `nameSuffix`, and don't collapse repeats into a
  bare "x4" label with no chords.

## Judgment calls

When the source is ambiguous, pick the interpretation that preserves the
most playable information, keep the change minimal, and **name the call**
when handing the JSON back (e.g. "kept the main tab's A/D/E over the
commenter's 7ths — say the word to switch"). Never silently rewrite the
user's music.

## Changelog

- 1.0.0 (2026-10-03): initial rules from 41 Ready songs in
  `master_songbook.json` plus five agent-converted examples (Meatstick,
  Hey Jude, Funky Bitch, One Way Out, Closing Time).
- 1.0.1 (2026-10-03): corrected the repeats rule — the `(x#)` count goes on
  its own chord line below the final chord line, not in `nameSuffix`. The
  1.0.0 guidance was wrong: no Ready song uses a suffix for repeat counts.
- 1.0.2 (2026-10-04): new `continued` section type — a section that carries
  on the previous one; the app derives "[previous] (Continued)" naming, so
  converting agents leave `name` unset for it.

## Improving these rules

The user submits more example files (finished song JSONs) to the assistant;
the assistant analyzes them against this doc, proposes additions or
corrections, and publishes a new versioned edition here. Every MCP client
reading this tool gets the improvements automatically. Example files
themselves live in `examples/` next to this doc — they are private working
material and are never pushed to the public repo.
