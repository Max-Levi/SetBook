# setbook-mcp

An MCP (Model Context Protocol) server that gives any AI agent SetBook's song
pipeline: scrape a song from a URL, parse text into SetBook sections, and add
songs to a SetBook save file.

## Setup

Requires Node 18+.

```sh
cd setbook-mcp
npm install
```

No build step is needed for normal use — `core/setbook-core.mjs` is checked in.

### Use with an MCP client

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "setbook": {
      "command": "node",
      "args": ["/path/to/SetBook/setbook-mcp/server.mjs"]
    }
  }
}
```

Any stdio-based MCP client works the same way: run `node server.mjs` and speak
JSON-RPC over stdio.

## Tools

- `scrape_song(url)` — Fetch a URL and extract song text exactly like SetBook's
  Add-song-from-URL: http(s) only, HTML stripped to text (scripts never run),
  chord/lyric deglue applied. Returns the normalized text.
- `parse_song_text(text, title?, artist?)` — Turn raw or scraped text into a
  SetBook song (`{ group, sections }`) using the app's exact pipeline:
  `[Section]`-header auto-split, content-aware chord/lyric classification, and
  chord symbols positioned over lyrics by character offset. Returns JSON ready
  to append to a SetBook save file's `sectionGroups` / `sections` arrays.
- `add_song_to_file(file, title, artist?, text)` — Parse text and append the
  song to a SetBook save file (`.json`), creating the file when it doesn't
  exist. The song lands as Not Ready, like a manual URL import.
- `list_songs(file)` — List a save file's songs: id, title, artist, ready
  status, section count.

## Keeping the server in sync with the app

The parsing core is **not** a copy — it is extracted from the app. The pure
functions (URL fetch, HTML text extraction, normalization, chord/lyric deglue,
mass-entry classification, chord positioning) live in the app's `index.html`,
wrapped in `/*__SETBOOK_MCP_CORE_BEGIN__*/` / `/*__SETBOOK_MCP_CORE_END__*/`
markers. `build-core.mjs` extracts those regions verbatim into
`core/setbook-core.mjs`; `index.html` is the source of truth.

Whenever the app changes in a way that touches the marked regions:

```sh
cd setbook-mcp
node build-core.mjs   # or: npm run build-core
npm test              # parity test fails if the core went stale
```

and commit the regenerated `core/setbook-core.mjs` alongside the app change.
The parity test (`core parity: checked-in core matches a fresh extraction`)
fails loudly if someone edits the app without rebuilding, so a stale core can
never ship silently. The MCP server and the app then parse identically, always.

`song-tools.mjs` (the song-building and file helpers) and `server.mjs` (the
MCP wiring) are hand-written; they only call the extracted core, so they need
no regeneration — update them only when the tool surface itself changes.
