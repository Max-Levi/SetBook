/* Song-building and SetBook-file tools. The parsing pipeline mirrors the
   app exactly: createSongFromUrlText() (staging field + auto-split) and the
   mass-entry "Create sections" submit (parseMassFieldRows + parseChordLine).
   Section/group object shapes match what the app writes to its save file. */
import './shim.mjs';
import {
  uid,
  sectionBaseName,
  fetchUrlText,
  normalizeScrapedText,
  autoSplitMassFields,
  parseMassFieldRows,
  parseChordLine,
} from './core/setbook-core.mjs';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const rtrim = (s) => (s || '').replace(/[ \t ]+$/, '');

/* Fetch a URL and return the app's normalized song text (same pipeline as
   the app's Add-song-from-URL: http(s) only, HTML stripped to text). */
export async function scrapeSong(url) {
  return fetchUrlText(url);
}

/* Legacy display-name for the save file's `name` field: the section's base
   name plus its suffix. (The app recomputes numbered display names itself.) */
function legacySectionName(sec) {
  const base = sectionBaseName(sec) || 'Untitled section';
  const suffix = (sec.nameSuffix || '').trim();
  return suffix ? base + ' ' + suffix : base;
}

/* Raw or scraped text -> { group, sections }, ready to append to a SetBook
   save file's sectionGroups / sections arrays. */
export function buildSongFromText({ title = '', artist = '', text = '' } = {}) {
  const group = {
    id: uid('grp'),
    name: title || '',
    artist: artist || '',
    videoUrl: '',
    videoUrlLive: '',
    type: 'cover',
    readyStatus: 'not-ready',
    tags: [],
    updatedAt: Date.now(),
  };
  // Staging field, exactly like the app's URL import: one Intro field, then
  // [Section]-header auto-split (the app default).
  const staging = {
    id: uid('sec'),
    groupId: group.id,
    massEntryFields: [
      { id: uid('mf'), text: normalizeScrapedText(text), nameType: 'intro', customName: '', nameSuffix: '' },
    ],
  };
  autoSplitMassFields(staging);
  const sections = [];
  for (const f of staging.massEntryFields) {
    const rows = parseMassFieldRows(f.text || '')
      .map((p) => ({
        text: rtrim(p.text),
        symbols: parseChordLine(rtrim(p.chords)),
      }))
      .filter((r) => r.text.trim() !== '' || r.symbols.length > 0);
    if (!rows.length) continue; // skip fields left completely empty
    const sec = {
      id: uid('sec'),
      groupId: group.id,
      nameType: f.nameType || 'intro',
      customName: f.customName || '',
      nameSuffix: f.nameSuffix || '',
      name: '',
      order: sections.length,
      lines: rows,
      updatedAt: Date.now(),
    };
    sec.name = legacySectionName(sec);
    sections.push(sec);
  }
  return { group, sections };
}

/* ---- SetBook save-file helpers ---- */

function loadSongbook(file) {
  let data;
  if (!existsSync(file)) {
    data = { sectionGroups: [], sections: [] };
  } else {
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      throw new Error(`Couldn't parse ${file} as JSON: ${e.message}`);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error(`${file} doesn't look like a SetBook save (expected a JSON object).`);
    }
  }
  if (!Array.isArray(data.sectionGroups)) data.sectionGroups = [];
  if (!Array.isArray(data.sections)) data.sections = [];
  return data;
}

function saveSongbook(file, data) {
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

/* Scrape-free variant: add an already-built song to a SetBook save file,
   creating the file when it doesn't exist yet. */
export function addSongToFile(file, { title = '', artist = '', text = '' } = {}) {
  if (!file) throw new Error('A file path is required.');
  const { group, sections } = buildSongFromText({ title, artist, text });
  if (!sections.length) throw new Error('Nothing to add — the text produced no sections.');
  const data = loadSongbook(file);
  data.sectionGroups.push(group);
  data.sections.push(...sections);
  saveSongbook(file, data);
  return { songId: group.id, title: group.name, sectionCount: sections.length, file };
}

export function listSongs(file) {
  if (!file) throw new Error('A file path is required.');
  const data = loadSongbook(file);
  const counts = new Map();
  for (const s of data.sections) counts.set(s.groupId, (counts.get(s.groupId) || 0) + 1);
  return data.sectionGroups.map((g) => ({
    id: g.id,
    name: g.name || 'Untitled song',
    artist: g.artist || '',
    readyStatus: g.readyStatus || 'not-ready',
    sectionCount: counts.get(g.id) || 0,
  }));
}
