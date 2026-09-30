#!/usr/bin/env node
/* SetBook MCP server (stdio). Exposes the app's song pipeline to any AI
   agent: scrape a song from a URL, parse text into SetBook sections, and
   add songs to a SetBook save file. Run: node server.mjs */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { scrapeSong, buildSongFromText, addSongToFile, listSongs } from './song-tools.mjs';

const server = new McpServer({ name: 'setbook', version: '1.0.0' });

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

const transport = new StdioServerTransport();
await server.connect(transport);
