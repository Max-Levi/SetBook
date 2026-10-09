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

/* ---------------------------------------------------------
   Setlists: ordered, labelled song lists ({ id, name, songIds,
   parts: [{ id, label, startIndex }] }). Stored in the save file's
   `setlists` array; legacy `songSubsets` are mirrored for backward
   compatibility with older app versions.
--------------------------------------------------------- */

function normalizeSetlist(raw) {
  const sl = raw && typeof raw === 'object' ? raw : {};
  const out = {
    id: typeof sl.id === 'string' && sl.id ? sl.id : 'subset_' + Math.random().toString(36).slice(2, 9),
    name: typeof sl.name === 'string' ? sl.name : '',
    songIds: Array.isArray(sl.songIds) ? sl.songIds.filter((id) => typeof id === 'string') : [],
    parts: [],
  };
  const seen = new Set();
  (Array.isArray(sl.parts) ? sl.parts : []).forEach((p) => {
    if (!p || typeof p !== 'object') return;
    const start = typeof p.startIndex === 'number' && isFinite(p.startIndex)
      ? Math.max(0, Math.min(out.songIds.length, Math.floor(p.startIndex))) : null;
    const label = typeof p.label === 'string' ? p.label.trim() : '';
    if (start === null || !label || seen.has(start)) return;
    seen.add(start);
    out.parts.push({ id: (typeof p.id === 'string' && p.id) ? p.id : 'part_' + Math.random().toString(36).slice(2, 9), label, startIndex: start });
  });
  out.parts.sort((a, b) => a.startIndex - b.startIndex);
  return out;
}

function mirrorSlToSubsets(data, sl) {
  if (!Array.isArray(data.songSubsets)) data.songSubsets = [];
  let mirror = data.songSubsets.find((s) => s.id === sl.id);
  if (!mirror) { mirror = { id: sl.id, name: sl.name, songIds: [] }; data.songSubsets.push(mirror); }
  mirror.name = sl.name;
  mirror.songIds = sl.songIds.slice();
}

/* List a file's setlists with resolved song titles and part labels. */
export function listSetlists(file) {
  if (!file) throw new Error('A file path is required.');
  const data = loadSongbook(file);
  if (!Array.isArray(data.setlists)) data.setlists = [];
  const groups = new Map(data.sectionGroups.map((g) => [g.id, g]));
  const sectionsByGroup = new Map();
  for (const s of data.sections) sectionsByGroup.set(s.groupId, (sectionsByGroup.get(s.groupId) || 0) + 1);
  return data.setlists.map((sl) => {
    const n = normalizeSetlist(sl);
    const songs = n.songIds.map((id) => {
      const g = groups.get(id);
      if (!g) return { id, title: null, note: 'song not in this file' };
      return { id, title: g.name || 'Untitled song', artist: g.artist || '', sectionCount: sectionsByGroup.get(id) || 0 };
    });
    return { id: n.id, name: n.name, songCount: songs.length, parts: n.parts, songs };
  });
}

/* Create or edit a setlist. Pass id to edit an existing setlist (name,
   songIds order, parts all update); omit id to create one. songIds is the
   performance order. parts items are { label, startIndex } (startIndex =
   index into songIds where the labelled segment begins). */
export function upsertSetlist(file, { id, name = '', songIds = [], parts = [] } = {}) {
  if (!file) throw new Error('A file path is required.');
  const data = loadSongbook(file);
  if (!Array.isArray(data.setlists)) data.setlists = [];
  const groups = new Set(data.sectionGroups.map((g) => g.id));
  const unknown = songIds.filter((sid) => !groups.has(sid));
  if (unknown.length) {
    throw new Error(`Unknown song id(s): ${unknown.join(', ')} — list_songs first, then use song ids from that.`);
  }
  let sl;
  if (id) {
    sl = data.setlists.find((s) => s.id === id);
    if (!sl) throw new Error(`No setlist with id ${id} — call list_setlists first.`);
  }
  const updated = normalizeSetlist({
    id: sl ? sl.id : (id || undefined),
    name: name || (sl ? sl.name : ''),
    songIds,
    parts,
  });
  if (sl) Object.assign(sl, updated); else data.setlists.push(updated);
  mirrorSlToSubsets(data, updated);
  saveSongbook(file, data);
  return { id: updated.id, name: updated.name, songCount: updated.songIds.length, parts: updated.parts, created: !sl };
}

/* Generate a draft setlist from the file's songs: keep/hard selections
   decided by the agent itself, given the available songs with their ready
   status. Convenience: headline readiness + optional keyword filter. */
export function generateSetlist(file, { name = '', filterStatus = '', filterText = '', songIds = [] } = {}) {
  if (!file) throw new Error('A file path is required.');
  const data = loadSongbook(file);
  if (!Array.isArray(data.setlists)) data.setlists = [];
  const groups = new Set(data.sectionGroups.map((g) => g.id));
  const songs = data.sectionGroups.filter((g) => {
    if (filterStatus && (g.readyStatus || 'not-ready') !== filterStatus) return false;
    const hay = `${g.name || ''} ${g.artist || ''}`.toLowerCase();
    if (filterText && !hay.includes(filterText.toLowerCase())) return false;
    return true;
  });
  const chosen = songIds.length
    ? songIds.filter((sid) => groups.has(sid))
    : songs.map((g) => g.id);
  if (!chosen.length) {
    throw new Error('No songs matched — pass explicit songIds, or loosen filterStatus/filterText.');
  }
  const sl = normalizeSetlist({ name: name || 'Generated setlist', songIds: chosen });
  data.setlists.push(sl);
  mirrorSlToSubsets(data, sl);
  saveSongbook(file, data);
  return { id: sl.id, name: sl.name, songCount: sl.songIds.length, songs: sl.songIds };
}

/* Delete a setlist by id (mirrors in songSubsets go too). */
export function deleteSetlist(file, id) {
  if (!file) throw new Error('A file path is required.');
  if (!id) throw new Error('A setlist id is required.');
  const data = loadSongbook(file);
  if (!Array.isArray(data.setlists)) data.setlists = [];
  const before = data.setlists.length;
  data.setlists = data.setlists.filter((s) => s.id !== id);
  if (Array.isArray(data.songSubsets)) data.songSubsets = data.songSubsets.filter((s) => s.id !== id);
  if (data.setlists.length === before) throw new Error(`No setlist with id ${id}.`);
  saveSongbook(file, data);
  return { deleted: id };
}
