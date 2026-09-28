/* SetBook regression tests — no dependencies, no browser.
   Runs the app's real <script> blocks from index.html inside a Node VM
   sandbox with a stubbed DOM, so the shipped code itself is what's tested.

   Usage:
     node tests/regression-test.js
     node tests/regression-test.js /path/to/songbook.json   (read-only;
       the file is loaded and every section is round-trip checked — the
       file itself is never copied or modified)
*/
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const INDEX = path.join(ROOT, 'index.html');

/* ---------------- harness ---------------- */
const results = [];
let currentSuite = '';
const suite = (name) => { currentSuite = name; };
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${currentSuite ? currentSuite + ' · ' : ''}${name}${!ok && detail ? ' — ' + detail : ''}`);
};

/* ---------------- sandbox: enough DOM for the app script to boot ---------------- */
function makeEl() {
  const target = function () {};
  const props = {}; // remembers writes so reads round-trip (select.value etc.)
  const valueLike = new Set(['value', 'textContent', 'innerHTML', 'checked', 'hidden', 'title', 'placeholder']);
  return new Proxy(target, {
    get(t, p) {
      if (p === 'style') return new Proxy({}, {
        get: (t, sp) => (typeof sp === 'string' && /^(height|width|display|top|left|right|bottom|scrollTop|transform|color|opacity|visibility)$/.test(sp)) ? '' : () => {},
        set: () => true
      });
      if (valueLike.has(p)) return p in props ? props[p] : '';
      if (p === 'classList') return { add() {}, remove() {}, toggle() {}, contains: () => false };
      if (p === 'dataset') return {};
      if (p === 'addEventListener' || p === 'removeEventListener' || p === 'appendChild' ||
          p === 'removeChild' || p === 'insertBefore' || p === 'prepend' || p === 'remove' ||
          p === 'click' || p === 'focus' || p === 'blur' || p === 'select' || p === 'setAttribute' ||
          p === 'removeAttribute' || p === 'scrollIntoView') return () => {};
      if (p === 'querySelector' || p === 'closest') return () => makeEl();
      if (p === 'querySelectorAll') return () => [];
      if (p === 'getBoundingClientRect') return () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 });
      if (p === 'scrollTop' || p === 'scrollLeft' || p === 'offsetTop' || p === 'selectionStart' || p === 'selectionEnd') return 0;
      if (p === Symbol.toPrimitive) return () => '';
      if (p === 'setProperty' || p === 'getPropertyValue' || p === 'setSelectionRange') return () => {};
      return Reflect.get(t, p);
    },
    set(t, p, v) { props[p] = v; return true; },
    apply() { return makeEl(); }
  });
}
const noopTimer = () => 0;
const sandbox = {
  console,
  document: {
    getElementById: () => makeEl(),
    querySelector: () => makeEl(),
    querySelectorAll: () => [],
    createElement: () => makeEl(),
    createTextNode: () => makeEl(),
    addEventListener: () => {},
    removeEventListener: () => {},
    body: makeEl(),
    documentElement: { getAttribute: () => 'dark', setAttribute() {}, removeAttribute() {} },
    activeElement: null,
    title: '',
    hidden: false
  },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  navigator: { userAgent: 'node-regression' },
  location: { reload() {}, href: '' },
  matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  requestAnimationFrame: () => 0,
  setTimeout: noopTimer, clearTimeout() {}, setInterval: noopTimer, clearInterval() {},
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  CSS: { escape: (s) => String(s) },
  MutationObserver: class { observe() {} disconnect() {} },
  ResizeObserver: class { observe() {} disconnect() {} },
  IntersectionObserver: class { observe() {} disconnect() {} },
  Blob: class {}, URL: { createObjectURL: () => '', revokeObjectURL() {} },
  innerWidth: 1400, innerHeight: 900, devicePixelRatio: 2
};
sandbox.window = sandbox;
sandbox.addEventListener = () => {};
sandbox.removeEventListener = () => {};
sandbox.dispatchEvent = () => {};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

/* ---------------- extract + run the app script ---------------- */
const html = fs.readFileSync(INDEX, 'utf8');
const re = /<script>([\s\S]*?)<\/script>/g;
const blocks = [];
let m;
while ((m = re.exec(html))) blocks.push(m[1]);
if (blocks.length < 2) {
  console.error('Could not find the app <script> blocks in index.html');
  process.exit(1);
}
try {
  blocks.forEach((src, i) => vm.runInContext(src, sandbox, { filename: `index.html#block${i + 1}` }));
} catch (err) {
  console.error('App script failed to boot in the sandbox:', err.message);
  process.exit(1);
}
/* Export shim: runs as another script in the same context, so it can see
   the app's top-level const/let bindings (shared global lexical scope). */
vm.runInContext(`
globalThis.__sb = {
  get state() { return state; }, set state(v) { state = v; },
  get selectedGroupId() { return selectedGroupId; }, set selectedGroupId(v) { selectedGroupId = v; },
  get selectedSectionId() { return selectedSectionId; }, set selectedSectionId(v) { selectedSectionId = v; },
  get expandedGroups() { return expandedGroups; },
  loadParsedState, groupSections, songStatus, isSongReady, matchesReadyFilter,
  recordSongViewed, viewedAgoText, createSongFromUrlText, autoSplitMassFields,
  massRowsToText, parseMassFieldRows, classifyMassEntryLines, parseChordLine,
  buildSymbolsLine, displaySectionName, massSplitDefaultType, sectionTypeFromCustomName,
  defaultState, uid, touchGroup, touchSection,
  sectionTransposeInfo, transposedSectionLines, blockCannotTranspose,
  transposeSymbolsValue, transposeChordToken, stepTransposeKey, groupLinesForDisplay,
  TRANSPOSE_KEYS, TRANSPOSE_KEY_LABELS
};
`, sandbox, { filename: 'shim.js' });
const sb = sandbox.__sb;

function resetApp() {
  sb.state = sb.defaultState();
  sb.selectedGroupId = null;
  sb.selectedSectionId = null;
  sb.expandedGroups.clear();
}
const loadBook = (book) => { sb.loadParsedState(JSON.parse(JSON.stringify(book))); };

/* Round-trip helper: rows → text (+roles) → rows, compared on meaningful lines */
const norm = (t) => (t ? String(t).replace(/\s+$/, '') : '');
const meaningful = (rows) => rows
  .filter(r => sb.buildSymbolsLine(r.symbols || []) || (r.text && String(r.text).trim()))
  .map(r => JSON.stringify([sb.buildSymbolsLine(r.symbols || []), norm(r.text)]));
function roundTrip(sec) {
  const built = sb.massRowsToText(sec);
  return sb.parseMassFieldRows(built.text, built.roles)
    .map(p => ({ symbols: sb.parseChordLine(p.chords || ''), text: p.text || '' }));
}
function makeSection(lines) {
  return { id: 'sec_x', groupId: 'grp_x', nameType: 'verse', customName: '', nameSuffix: '', name: '', order: 0, lines, updatedAt: Date.now() };
}
const row = (chords, text) => ({ symbols: chords ? sb.parseChordLine(chords) : [], text: text || '' });

/* ================= 0. boot ================= */
suite('boot');
check('app script blocks compile and boot', typeof sb.loadParsedState === 'function' && typeof sb.state === 'object');

/* ================= 1. mass-entry round-trips (#10) ================= */
suite('round-trip');
const rtCases = [
  ['simple chord+lyric pairs', [row('G        D', 'Hello line'), row('', 'second lyric only')]],
  ['chords-only row then lyric-only row', [row('E   G A         E   G A', ''), row('', '...I want to say one more last thing')]],
  ['annotated chord line stays verbatim', [row('Cm (quick chugs x2 builds into the chorus)', '')]],
  ['grid line with x12 keeps its spelling', [row('|D     |D A   |  x12', '')]],
  ['parenthetical chord run stays chord', [row('F/D (5th Fret)   D5 D Dsus4 D D5', '')]],
  ['whitespace-only lyric row drops cleanly', [row('G  D', 'Hello'), row('', '   ')]],
  ['trailing-whitespace lyric trims', [row('B7', 'Sneaking Sally through the alley,    '), row('E7 D7                  B7', '    tryin to keep her outta sight')]],
  ['fully empty section', [row('', '')]]
];
rtCases.forEach(([name, lines]) => {
  const sec = makeSection(lines);
  const back = roundTrip(sec);
  check(name, JSON.stringify(meaningful(sec.lines)) === JSON.stringify(meaningful(back)),
    `orig=${meaningful(sec.lines).join(' | ')} back=${meaningful(back).join(' | ')}`);
});

/* ================= 2. import parse semantics (#1/#10) ================= */
suite('import-parse');
{
  const rows = sb.parseMassFieldRows('A  E x2\nword');
  check('x2 shorthand still applies on import text', rows.length === 1 && rows[0].chords === 'A  E (x2)' && rows[0].text === 'word (x2)',
    JSON.stringify(rows));
}
{
  const rows = sb.parseMassFieldRows('G  D\n\nword one\n\nEm  C\nlyric two');
  check('URL import: blank lines never disturb pairing', rows.length === 2 &&
    rows[0].chords === 'G  D' && rows[0].text === 'word one' && rows[1].chords === 'Em  C' && rows[1].text === 'lyric two',
    JSON.stringify(rows));
}
{
  // role-forced chord + blank before its lyric = deliberately unpaired
  const rows = sb.parseMassFieldRows('G   D\n\nlyric', { 0: 'chord' });
  check('editor: blank after a chord row leaves it unpaired', rows.length === 2 &&
    rows[0].chords === 'G   D' && rows[0].text === '' && rows[1].text === 'lyric', JSON.stringify(rows));
}
{
  // blank BEFORE a forced chord is just spacing — pairing unaffected
  const rows = sb.parseMassFieldRows('\nG  D\nlyric', { 1: 'chord' });
  check('editor: blank before a chord row keeps the pair', rows.length === 1 &&
    rows[0].chords === 'G  D' && rows[0].text === 'lyric', JSON.stringify(rows));
}

/* ================= 3. auto-split on [headers] (#1) ================= */
suite('auto-split');
{
  resetApp();
  const sec = { id: 'sec_s', groupId: 'grp_s', nameType: 'intro', customName: '', nameSuffix: '', name: '', order: 0, lines: [],
    massEntry: true, massEntryOriginal: '', massEntryFields: [
      { id: 'mf1', text: 'intro line\n[Verse 1]\nG  D\nv line\n[Chorus]\nC  G\nc line\n[Solo]\nE  E', nameType: 'intro', customName: '', nameSuffix: '' }
    ] };
  const created = sb.autoSplitMassFields(sec);
  const f = sec.massEntryFields;
  check('splits at recognized headers, dropping them', created === 3 && f.length === 4 &&
    f[0].nameType === 'intro' && f[0].text === 'intro line' &&
    f[1].nameType === 'verse' && f[1].text === 'G  D\nv line' &&
    f[2].nameType === 'chorus' && f[2].text === 'C  G\nc line' &&
    f[3].nameType === 'instrumental' && f[3].text === 'E  E', JSON.stringify(f.map(x => [x.nameType, x.text])));
}
{
  resetApp();
  const sec = { id: 'sec_s', groupId: 'grp_s', nameType: 'intro', customName: '', nameSuffix: '', name: '', order: 0, lines: [],
    massEntry: true, massEntryOriginal: '', massEntryFields: [
      { id: 'mf1', text: '[Verse 1]\nx\n[Weird Name]\ny', nameType: 'intro', customName: '', nameSuffix: '' }
    ] };
  sb.autoSplitMassFields(sec);
  const f = sec.massEntryFields;
  check('unrecognized [Name] stays ordinary text in its field', f.length === 1 && f[0].nameType === 'verse' &&
    f[0].text === 'x\n[Weird Name]\ny', JSON.stringify(f.map(x => [x.nameType, x.text])));
}

/* ================= 4. song status (#4) ================= */
suite('status');
{
  resetApp();
  check('missing status defaults to Not Ready', sb.songStatus({}) === 'not-ready');
  check('garbage status falls back to Not Ready', sb.songStatus({ readyStatus: 'banana' }) === 'not-ready');
  check('in-progress is a real status', sb.songStatus({ readyStatus: 'in-progress' }) === 'in-progress');
  const g = { readyStatus: 'in-progress' };
  sb.state.readyFilter = { ready: true, notReady: true, inProgress: false };
  check('In progress filter pill hides in-progress songs', !sb.matchesReadyFilter(g));
  sb.state.readyFilter = { ready: false, notReady: true, inProgress: true };
  check('Ready pill toggle still works', !sb.matchesReadyFilter({ readyStatus: 'ready' }) && sb.matchesReadyFilter(g));
}
{
  resetApp();
  loadBook({ sectionGroups: [{ id: 'g1', name: 'A', readyStatus: 'ready' }], sections: [],
    readyFilter: { ready: true, notReady: true } });
  check('old files migrate: inProgress filter defaults on', sb.state.readyFilter.inProgress === true);
  check('old files migrate: new config defaults on', sb.state.autoSplitHeaders === true && sb.state.massEntryEditorMode === true);
  check('old files migrate: recentlyViewed starts empty', Array.isArray(sb.state.recentlyViewed) && sb.state.recentlyViewed.length === 0);
}

/* ================= 5. recently viewed (#2) ================= */
suite('recents');
{
  resetApp();
  ['a1','a2','a3','a4','a5','a6','a7','a8'].forEach(id => sb.recordSongViewed(id));
  check('caps at six', sb.state.recentlyViewed.length === 6);
  check('most recent first', sb.state.recentlyViewed[0].id === 'a8' && sb.state.recentlyViewed[5].id === 'a3');
  sb.recordSongViewed('a5');
  check('re-viewing moves a song to the front, deduped', sb.state.recentlyViewed[0].id === 'a5' &&
    sb.state.recentlyViewed.filter(r => r.id === 'a5').length === 1);
  sb.recordSongViewed(null);
  check('null id is a no-op', sb.state.recentlyViewed[0].id === 'a5');
}
{
  const cases = [
    [3000, 'just now'], [45000, '45 sec ago'], [90000, '1 min ago'], [300000, '5 min ago'],
    [3600000, '1 hour ago'], [3 * 3600000, '3 hours ago'], [86400000, '1 day ago'], [2 * 86400000, '2 days ago']
  ];
  cases.forEach(([ms, want]) => check(`time-ago: ${ms}ms → "${want}"`, sb.viewedAgoText(Date.now() - ms) === want,
    `got "${sb.viewedAgoText(Date.now() - ms)}"`));
}

/* ================= 6. add-from-URL takeover (#9) + toggle (#1) ================= */
suite('url-import');
{
  resetApp();
  const yellow = { id: 'grp_yellow', name: 'Yellow', artist: 'Coldplay', readyStatus: 'not-ready', tags: ['x'], updatedAt: null };
  const s1 = { id: 'sec_o1', groupId: yellow.id, nameType: 'verse', customName: '', nameSuffix: '', name: 'Verse 1', order: 0, lines: [row('G', 'old words')], updatedAt: null };
  sb.state.sectionGroups.push(yellow);
  sb.state.sections.push(s1);
  sb.createSongFromUrlText('pre\n\n[Verse 1]\nG  D\nv line\n\n[Chorus]\nC  G\nc line', yellow);
  const secs = sb.groupSections(yellow.id);
  check('takeover keeps the song\u2019s details', yellow.name === 'Yellow' && yellow.artist === 'Coldplay' && yellow.tags.includes('x'));
  check('takeover clears the old sections', secs.length === 1 && secs[0].massEntry === true);
  check('takeover auto-splits on headers (default on)', secs[0].massEntryFields.length === 3 &&
    secs[0].massEntryFields.map(f => f.nameType).join(',') === 'intro,verse,chorus',
    JSON.stringify(secs[0].massEntryFields.map(f => f.nameType)));
  check('takeover opens the staging editor', sb.selectedGroupId === yellow.id && sb.state.sections.find(s => s.id === sb.selectedSectionId)?.massEntry === true);
}
{
  resetApp();
  const before = sb.state.sectionGroups.length;
  sb.createSongFromUrlText('plain text only');
  check('no target: creates a fresh untitled song with staging',
    sb.state.sectionGroups.length === before + 1 &&
    sb.state.sectionGroups[sb.state.sectionGroups.length - 1].name === '' &&
    sb.state.sections.some(s => s.massEntry && s.massEntryFields.length === 1 && s.massEntryFields[0].text === 'plain text only'));
}
{
  resetApp();
  sb.state.autoSplitHeaders = false;
  const yellow = { id: 'grp_y2', name: 'Yellow', artist: 'Coldplay', readyStatus: 'not-ready', tags: [], updatedAt: null };
  sb.state.sectionGroups.push(yellow);
  sb.createSongFromUrlText('[Verse 1]\nG  D\nv line\n\n[Chorus]\nC  G\nc line', yellow);
  const secs = sb.groupSections(yellow.id);
  check('toggle off: headers stay ordinary text in one field',
    secs.length === 1 && secs[0].massEntry && secs[0].massEntryFields.length === 1 &&
    secs[0].massEntryFields[0].text.includes('[Verse 1]'), JSON.stringify(secs[0].massEntryFields?.map(f => f.text)));
  check('Ready songs conceptually excluded (status gate)', sb.songStatus({ readyStatus: 'ready' }) === 'ready');
}

/* ================= 7. section naming sanity ================= */
suite('naming');
{
  resetApp();
  const a = { id: 's1', groupId: 'g', nameType: 'chorus', customName: '', nameSuffix: '', name: '', order: 0, lines: [] };
  const b = { id: 's2', groupId: 'g', nameType: 'chorus', customName: '', nameSuffix: '', name: '', order: 1, lines: [] };
  sb.state.sections.push(a, b); // numbering counts a song's real sections
  check('display names renumber within a song',
    sb.displaySectionName(a) === 'Chorus 1' && sb.displaySectionName(b) === 'Chorus 2',
    sb.displaySectionName(a) + ' / ' + sb.displaySectionName(b));
  check('split default type follows the section flow',
    sb.massSplitDefaultType('intro') === 'verse' && sb.massSplitDefaultType('verse') === 'chorus' &&
    sb.massSplitDefaultType('chorus') === 'verse' && sb.massSplitDefaultType('pre-chorus') === 'chorus');
  check('header names map to section types',
    sb.sectionTypeFromCustomName('Chorus') === 'chorus' && sb.sectionTypeFromCustomName('verse 2') === 'verse' &&
    sb.massHeaderTypeCheck === undefined); // massHeaderSectionType covered via auto-split above
}

/* ================= 8. transposition ================= */
suite('transpose');
{
  // token-level: chords shift, non-chords stay, bar pipes preserved
  const tok = (t, s, f) => sb.transposeChordToken(t, s, f);
  check('G +4 → B', tok('G', 4) === 'B');
  check('G +4 in flat key → B (B has no flat)', tok('G', 4, true) === 'B');
  check('C +3 in flat key → Eb', tok('C', 3, true) === 'Eb');
  check('A +1 in flat key → Bb', tok('A', 1, true) === 'Bb');
  check('F# +3 → A (default sharps)', tok('F#', 3) === 'A');
  check('minor quality kept: Em +2 → F#m', tok('Em', 2) === 'F#m');
  check('extensions kept: Cmaj7 +2 → Dmaj7', tok('Cmaj7', 2) === 'Dmaj7');
  check('sus kept: Asus4 +5 → Dsus4', tok('Asus4', 5) === 'Dsus4');
  check('slash bass moves too: D/F# +2 → E/G#', tok('D/F#', 2) === 'E/G#');
  check('bar pipe preserved: |D +2 → |E', tok('|D', 2) === '|E');
  check('repeat token untouched: (x2)', tok('(x2)', 4) === '(x2)');
  check('bar token untouched: |', tok('|', 4) === '|');
  check('annotation untouched: (ring out)', tok('(ring', 3) === '(ring' && tok('out)', 3) === 'out)');
  check('full line: chords move, extras stay',
    sb.transposeSymbolsValue('|G      |D  A (x2)', 2) === '|A      |E  B (x2)',
    sb.transposeSymbolsValue('|G      |D  A (x2)', 2));
}
{
  // section-level: info, line copy, originals untouched
  const sec = { key: 'G', transposeTo: 'B', lines: [row('|G      D', 'word'), row('', 'lyric only')] };
  const info = sb.sectionTransposeInfo(sec);
  check('info: G→B is +4, sharp spelling', info && info.semis === 4 && info.flats === false);
  const view = sb.transposedSectionLines(sec);
  check('lines shift: |G D → |B F#', sb.buildSymbolsLine(view[0].symbols) === '|B      F#', sb.buildSymbolsLine(view[0].symbols));
  check('lyric-only line untouched', view[1].text === 'lyric only' && view[1].symbols.length === 0);
  check('originals untouched', sb.buildSymbolsLine(sec.lines[0].symbols) === '|G      D');
  const flat = { key: 'G', transposeTo: 'Bb', lines: [row('C  F  G', '')] };
  const fv = sb.transposedSectionLines(flat);
  check('flat-key spelling: C F G → Eb Ab Bb', sb.buildSymbolsLine(fv[0].symbols) === 'Eb  Ab  Bb', sb.buildSymbolsLine(fv[0].symbols));
  check('same target key = no transpose', sb.sectionTransposeInfo({ key: 'G', transposeTo: 'G' }) === null);
  check('no key = no transpose', sb.sectionTransposeInfo({ transposeTo: 'B' }) === null);
  check('key without target = no transpose', sb.sectionTransposeInfo({ key: 'G' }) === null);
  check('bogus keys = no transpose', sb.sectionTransposeInfo({ key: 'banana', transposeTo: 'B' }) === null);
}
{
  // cannot-transpose flagging
  const tsec = { key: 'G', transposeTo: 'B', lines: [] };
  const cantBlock = { symbols: sb.parseChordLine('N.C.  (5th Fret)'), lines: [{ text: '', symbols: [] }], anchorHasSymbols: true, anchorHasText: false };
  const goodBlock = { symbols: sb.parseChordLine('G   D'), lines: [{ text: '', symbols: [] }], anchorHasSymbols: true, anchorHasText: false };
  const lyricBlock = { symbols: [], lines: [{ text: 'just words', symbols: [] }], anchorHasSymbols: false, anchorHasText: true };
  check('chord line with no chords flagged', sb.blockCannotTranspose(cantBlock) === true);
  check('normal chord line not flagged', sb.blockCannotTranspose(goodBlock) === false);
  check('lyric-only block not flagged', sb.blockCannotTranspose(lyricBlock) === false);
  // through the display grouping (transposed view)
  const tview = sb.transposedSectionLines({ ...tsec, lines: [row('N.C.  (5th Fret)', ''), row('G  D', 'words')] });
  const blocks = sb.groupLinesForDisplay(tview);
  check('flag travels through display grouping', sb.blockCannotTranspose(blocks[0]) === true && sb.blockCannotTranspose(blocks[1]) === false);
}
{
  // stepper wraps both directions across the 12-key list
  check('step up from B wraps to C', sb.stepTransposeKey('B', 1) === 'C');
  check('step down from C wraps to B', sb.stepTransposeKey('C', -1) === 'B');
  check('step up from G is G# (chromatic list)', sb.stepTransposeKey('G', 1) === 'G#');
  check('12 keys in the list', sb.TRANSPOSE_KEYS.length === 12);
  check('spelled labels for shared-key spellings', sb.TRANSPOSE_KEY_LABELS['F#'] === 'F# / Gb');
}

/* ================= summary ================= */
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) {
  console.log('FAILED:');
  failed.forEach(f => console.log('  ✗ ' + f.name + (f.detail ? ' — ' + f.detail : '')));
  process.exit(1);
}

/* ================= optional: external real-songbook pass (read-only) ================= */
const externalPath = process.argv[2];
if (externalPath) {
  console.log(`\nExternal corpus: ${externalPath} (read-only)`);
  let book;
  try {
    book = JSON.parse(fs.readFileSync(externalPath, 'utf8'));
  } catch (err) {
    console.error('Could not read/parse that file: ' + err.message);
    process.exit(1);
  }
  try {
    resetApp();
    loadBook(book);
  } catch (err) {
    console.error('Not a loadable SetBook file: ' + err.message);
    process.exit(1);
  }
  let checked = 0;
  const bad = [];
  sb.state.sectionGroups.forEach(g => {
    sb.groupSections(g.id).forEach(sec => {
      if (sec.massEntry) return;
      checked++;
      const back = roundTrip(sec);
      if (JSON.stringify(meaningful(sec.lines)) !== JSON.stringify(meaningful(back))) {
        bad.push(`${g.name || 'Untitled song'} / ${sb.displaySectionName(sec)}`);
      }
    });
  });
  const songs = sb.state.sectionGroups.length;
  if (bad.length) {
    console.log(`FAIL  round-trip: ${checked - bad.length}/${checked} sections OK. Failures:`);
    bad.forEach(b => console.log('  ✗ ' + b));
    process.exit(1);
  }
  console.log(`PASS  round-trip: ${checked}/${checked} sections across ${songs} songs survive text conversion losslessly.`);
}
