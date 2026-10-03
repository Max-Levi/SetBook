/* Tests for the SetBook MCP package. Run: npm test
   1. Parity: the checked-in core matches a fresh extraction from index.html,
      so the app and the MCP server can never silently drift apart.
   2. Pipeline: scrape/normalize/deglue/classify/parse behave like the app.
   3. File round-trip: add_song_to_file writes a song the app can read. */
import './shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeScrapedText,
  deglueChordLyricLines,
  classifyMassEntryLines,
  parseMassFieldRows,
  parseChordLine,
  extractTextFromHtml,
  autoSplitMassFields,
  uid,
} from './core/setbook-core.mjs';
import { buildSongFromText, addSongToFile, listSongs } from './song-tools.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const APP_HTML = process.env.SETBOOK_APP_HTML || join(here, '..', 'index.html');

test('core parity: checked-in core matches a fresh extraction', () => {
  const fresh = execFileSync('node', [join(here, 'build-core.mjs'), APP_HTML, '--stdout'], { encoding: 'utf8' });
  const checkedIn = readFileSync(join(here, 'core', 'setbook-core.mjs'), 'utf8');
  assert.equal(fresh, checkedIn, 'core is stale — run node build-core.mjs and commit the result');
});

test('deglue splits chords glued to lyrics', () => {
  const out = deglueChordLyricLines("GSlowin'\nthrough the mindG");
  assert.match(out, /^G\nSlowin'/m);
  assert.match(out, /mind\nG$/m);
});

test('normalize collapses whitespace and deglues', () => {
  const out = normalizeScrapedText('  GSlowin\'  \r\n\r\n\r\nthrough it all  ');
  assert.ok(!out.includes('\r'), 'no carriage returns');
  assert.ok(!/\n{3,}/.test(out), 'no triple blank lines');
  assert.match(out, /G\nSlowin'/);
});

test('extractTextFromHtml strips tags and scripts without executing them', () => {
  const html = '<html><head><script>window.pwned = true</script></head>' +
    '<body><nav>menu</nav><h1>Title</h1><p>G&nbsp;&nbsp;Slowin\'</p><br><div>verse line</div></body></html>';
  const out = extractTextFromHtml(html);
  assert.ok(!out.includes('menu'), 'nav removed: ' + JSON.stringify(out));
  assert.ok(!out.includes('pwned'), 'script text removed');
  assert.match(out, /Title/);
  assert.match(out, /verse line/);
  assert.equal(globalThis.pwned, undefined, 'script did not execute');
});

test('classifyMassEntryLines is content-aware, not just positional', () => {
  const types = classifyMassEntryLines('G C\nSlowin\' words here\nAm\nmore lyric words').map((c) => c.type);
  assert.deepEqual(types, ['chord', 'lyric', 'chord', 'lyric']);
});

test('parseMassFieldRows pairs chord lines with the lyric line under them', () => {
  const rows = parseMassFieldRows('G C\nSlowin\' along\nAm');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].chords, 'G C');
  assert.equal(rows[0].text, "Slowin' along");
  assert.equal(rows[1].chords, 'Am');
  assert.equal(rows[1].text, '');
});

test('parseChordLine positions symbols by character offset', () => {
  assert.deepEqual(parseChordLine('G   C'), [{ pos: 0, value: 'G' }, { pos: 4, value: 'C' }]);
});

test('autoSplitMassFields splits on [Section] headers', () => {
  const sec = {
    massEntryFields: [{ id: uid('mf'), text: 'G\nintro line\n[Verse]\nC\nverse line', nameType: 'intro', customName: '', nameSuffix: '' }],
  };
  autoSplitMassFields(sec);
  assert.equal(sec.massEntryFields.length, 2);
  assert.equal(sec.massEntryFields[0].nameType, 'intro');
  assert.equal(sec.massEntryFields[1].nameType, 'verse');
  assert.ok(!sec.massEntryFields[1].text.includes('[Verse]'), 'header line consumed');
});

test('buildSongFromText produces app-shaped sections', () => {
  const { group, sections } = buildSongFromText({
    title: 'Test Song', artist: 'Tester', text: '[Verse]\nG C\nSlowin\' along\n[Chorus]\nAm\nsing it loud',
  });
  assert.ok(group.id.startsWith('grp_'));
  assert.equal(group.name, 'Test Song');
  assert.equal(group.readyStatus, 'not-ready');
  assert.equal(sections.length, 2);
  assert.equal(sections[0].nameType, 'verse');
  assert.equal(sections[1].nameType, 'chorus');
  assert.equal(sections[0].order, 0);
  const row = sections[0].lines[0];
  assert.equal(row.text, "Slowin' along");
  assert.deepEqual(row.symbols, [{ pos: 0, value: 'G' }, { pos: 2, value: 'C' }]);
  assert.ok(sections.every((s) => s.groupId === group.id));
});

test('add_song_to_file + list_songs round-trip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'setbook-mcp-'));
  try {
    const file = join(dir, 'songs.json');
    const res = addSongToFile(file, { title: 'Round Trip', text: 'G\nla la la' });
    assert.ok(res.songId.startsWith('grp_'));
    assert.equal(res.sectionCount, 1);
    const songs = listSongs(file);
    assert.equal(songs.length, 1);
    assert.equal(songs[0].name, 'Round Trip');
    assert.equal(songs[0].sectionCount, 1);
    // Second song appends without clobbering the first.
    addSongToFile(file, { title: 'Second', text: 'Am\nmmm' });
    assert.equal(listSongs(file).length, 2);
    // The file is shaped like an app save: the app's own loader keys exist.
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    assert.ok(Array.isArray(raw.sectionGroups) && Array.isArray(raw.sections));
    assert.equal(raw.sections.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('add_song_to_file rejects text with no sections', () => {
  const dir = mkdtempSync(join(tmpdir(), 'setbook-mcp-'));
  try {
    assert.throws(() => addSongToFile(join(dir, 'x.json'), { title: 'Empty', text: '   \n  ' }), /no sections/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('conventions doc is present, versioned, and covers the key rules', () => {
  const doc = readFileSync(join(here, 'conventions', 'CONVENTIONS.md'), 'utf8');
  assert.match(doc, /^Version: \d+\.\d+\.\d+/m, 'versioned');
  assert.ok(doc.includes('readyStatus'), 'reference scope rule present');
  assert.ok(doc.includes('nameSuffix'), 'suffix rule present');
  assert.ok(doc.includes('absolute character offset'), 'chord offset rule present');
  assert.ok(doc.includes('never be modified'), 'master file treated as read-only reference');
});

test('server exposes get_songbook_conventions', () => {
  const src = readFileSync(join(here, 'server.mjs'), 'utf8');
  assert.ok(src.includes("'get_songbook_conventions'"), 'tool registered');
  assert.ok(src.includes('CONVENTIONS.md'), 'tool reads the conventions doc');
});
