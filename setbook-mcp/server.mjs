#!/usr/bin/env node
/* SetBook MCP server (stdio). Exposes the app's song pipeline to any AI
   agent: scrape a song from a URL, parse text into SetBook sections, and
   add songs to a SetBook save file. Run: node server.mjs */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrapeSong, buildSongFromText, addSongToFile, listSongs, listSetlists, upsertSetlist, generateSetlist, deleteSetlist } from './song-tools.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const CONVENTIONS_PATH = join(here, 'conventions', 'CONVENTIONS.md');

const server = new McpServer({ name: 'setbook', version: '1.1.0' });

server.tool(
  'get_songbook_conventions',
  'Read the user\'s versioned songbook conventions BEFORE converting song text or tabs into SetBook JSON: section naming and numbering, nameSuffix usage, chord-only rows, chord symbol offsets, tab cleanup rules, and judgment-call norms. Gleaned from the user\'s Ready songs; the user improves them over time by submitting more example files, so read this fresh for each conversion job.',
  {},
  async () => {
    try {
      const text = readFileSync(CONVENTIONS_PATH, 'utf8');
      return { content: [{ type: 'text', text }] };
    } catch (e) {
      return { content: [{ type: 'text', text: 'Error: conventions file not available: ' + e.message }], isError: true };
    }
  }
);

server.tool(
  'scrape_song',
  'Fetch a URL and extract song text the way SetBook\'s Add-song-from-URL does (http(s) only; HTML stripped to text; chord/lyric deglue applied). Returns the normalized text lines.',
  { url: z.string().describe('The page URL to scrape a song from.') },
  async ({ url }) => {
    try {
      const text = await scrapeSong(url);
      return { content: [{ type: 'text', text }] };
    } catch (e) {
      return { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true };
    }
  }
);

server.tool(
  'parse_song_text',
  'Turn raw or scraped song text into a SetBook song ({ group, sections }) using the app\'s exact pipeline: [Section]-header auto-split, chord/lyric classification, chord symbols positioned over lyrics. Returns JSON ready to append to a SetBook save file.',
  {
    text: z.string().describe('The song text (chord lines over lyric lines, [Section] headers optional).'),
    title: z.string().optional().describe('Song title.'),
    artist: z.string().optional().describe('Artist name.'),
  },
  async ({ text, title = '', artist = '' }) => {
    try {
      const song = buildSongFromText({ title, artist, text });
      return { content: [{ type: 'text', text: JSON.stringify(song, null, 2) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true };
    }
  }
);

server.tool(
  'add_song_to_file',
  'Parse song text and append the resulting song to a SetBook save file (JSON), creating the file when it does not exist yet. The song lands as Not Ready, like a manual URL import.',
  {
    file: z.string().describe('Path to the SetBook save file (.json).'),
    title: z.string().describe('Song title.'),
    artist: z.string().optional().describe('Artist name.'),
    text: z.string().describe('The song text to parse and add.'),
  },
  async ({ file, title, artist = '', text }) => {
    try {
      const res = addSongToFile(file, { title, artist, text });
      return {
        content: [{
          type: 'text',
          text: `Added "${res.title || 'Untitled song'}" (${res.sectionCount} sections) to ${res.file} — song id ${res.songId}.`,
        }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true };
    }
  }
);

server.tool(
  'list_songs',
  'List the songs in a SetBook save file: id, title, artist, ready status, section count.',
  { file: z.string().describe('Path to the SetBook save file (.json).') },
  async ({ file }) => {
    try {
      const songs = listSongs(file);
      return { content: [{ type: 'text', text: JSON.stringify(songs, null, 2) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true };
    }
  }
);

server.tool(
  'list_setlists',
  "List the setlists (ordered, labelled gig song lists) in a SetBook save file: id, name, set-label parts, and resolved song titles in performance order.",
  { file: z.string().describe('Path to the SetBook save file (.json).') },
  async ({ file }) => {
    try {
      const setlists = listSetlists(file);
      return { content: [{ type: 'text', text: JSON.stringify(setlists, null, 2) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true };
    }
  }
);

server.tool(
  'edit_setlist',
  "Create or edit a setlist in a SetBook save file. Pass an existing setlist id (from list_setlists) to edit it, or omit id to create one. songIds must be valid song ids from this file; parts are { label, startIndex } set labels (e.g. {\"label\":\"Set 1\",\"startIndex\":0}).",
  {
    file: z.string().describe('Path to the SetBook save file (.json).'),
    id: z.string().optional().describe('Setlist id to edit; omit to create a new one.'),
    name: z.string().optional().describe('Setlist name (e.g. "Friday at the Roseland").'),
    songIds: z.array(z.string()).describe('Song ids in performance order — the exact order the app and its PDF export use.'),
    parts: z.array(z.object({ label: z.string(), startIndex: z.number().int().min(0) })).optional().describe('Set labels: each marks where a labelled segment begins in songIds.'),
  },
  async ({ file, id, name = '', songIds, parts = [] }) => {
    try {
      const res = upsertSetlist(file, { id, name, songIds, parts });
      return { content: [{ type: 'text', text: (res.created ? 'Created' : 'Updated') + ' setlist "' + res.name + '" (' + res.songCount + ' songs, ' + res.parts.length + ' set label(s)) — id ' + res.id }] };
    } catch (e) {
      return { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true };
    }
  }
);

server.tool(
  'generate_setlist',
  "Generate a new setlist in a SetBook save file from the available songs: all songs matching an optional readiness filter and optional title/artist text filter, in file order — or an explicit songIds order. Returns the created setlist; use edit_setlist to refine order and labels.",
  {
    file: z.string().describe('Path to the SetBook save file (.json).'),
    name: z.string().optional().describe('New setlist name.'),
    filterStatus: z.enum(['', 'ready', 'in-progress', 'not-ready']).optional().describe('Only include songs with this ready status (omit for all).'),
    filterText: z.string().optional().describe('Only include songs whose title/artist contains this text (case-insensitive).'),
    songIds: z.array(z.string()).optional().describe('Explicit ordered song ids; when given, filters are ignored.'),
  },
  async ({ file, name = '', filterStatus = '', filterText = '', songIds = [] }) => {
    try {
      const res = generateSetlist(file, { name, filterStatus, filterText, songIds });
      return { content: [{ type: 'text', text: 'Created setlist "' + res.name + '" with ' + res.songCount + ' songs — id ' + res.id + '. Use edit_setlist to reorder, label sets, or rename.' }] };
    } catch (e) {
      return { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true };
    }
  }
);

server.tool(
  'delete_setlist',
  'Delete a setlist (and its legacy subset mirror) from a SetBook save file by id.',
  {
    file: z.string().describe('Path to the SetBook save file (.json).'),
    id: z.string().describe('The setlist id to delete.'),
  },
  async ({ file, id }) => {
    try {
      const res = deleteSetlist(file, id);
      return { content: [{ type: 'text', text: 'Deleted setlist ' + res.deleted }] };
    } catch (e) {
      return { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
