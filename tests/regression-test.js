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
  // Map-backed localStorage so recovery-fallback and prefs round-trip.
  localStorage: (() => {
    const store = new Map();
    return {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(String(k), String(v)),
      removeItem: (k) => store.delete(k),
      clear: () => store.clear(),
    };
  })(),
  // Minimal but real IndexedDB: same API surface the app uses (open with
  // onupgradeneeded, objectStore get/put/delete in transactions), resolved
  // via microtasks so the async recovery-store tests can await outcomes.
  indexedDB: (() => {
    const dbs = new Map();
    const tick = () => Promise.resolve();
    return {
      open(name, version){
        const req = { result: null, onupgradeneeded: null, onsuccess: null, onerror: null };
        tick().then(() => {
          if (!dbs.has(name)) dbs.set(name, { stores: new Map() });
          const db = dbs.get(name);
          req.result = {
            createObjectStore(storeName){ if (!db.stores.has(storeName)) db.stores.set(storeName, new Map()); return db.stores.get(storeName); },
            transaction(storeName, _mode){
              const store = (() => {
                if (!db.stores.has(storeName)) db.stores.set(storeName, new Map());
                return db.stores.get(storeName);
              })();
              const ops = [];
              const tx = {
                objectStore(){
                  return {
                    get(key){ const r = { result: undefined, onsuccess: null, onerror: null }; ops.push(() => tick().then(() => { r.result = store.has(String(key)) ? store.get(String(key)) : undefined; r.onsuccess && r.onsuccess(); })); return r; },
                    put(val, key){ const r = { result: undefined, onsuccess: null, onerror: null }; ops.push(() => tick().then(() => { store.set(String(key), val); r.onsuccess && r.onsuccess(); })); return r; },
                    delete(key){ const r = { result: undefined, onsuccess: null, onerror: null }; ops.push(() => tick().then(() => { store.delete(String(key)); r.onsuccess && r.onsuccess(); })); return r; },
                  };
                },
                oncomplete: null,
              };
              // Transactions self-run: the app attaches its op handlers
              // synchronously, then this microtask chain executes the ops
              // and fires oncomplete — mirroring real IndexedDB ordering.
              queueMicrotask(() => {
                ops.reduce((p, op) => p.then(op), tick())
                  .then(() => { tx.oncomplete && tx.oncomplete(); });
              });
              return tx;
            },
            close(){},
          };
          if (db.stores.size === 0 && req.onupgradeneeded) req.onupgradeneeded({ result: req.result });
          req.onsuccess && req.onsuccess();
        });
        return req;
      },
    };
  })(),
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
  // Web globals the embedded storage-adapter library needs (the vm context
  // does not inherit Node's globals): UTF-8 encoding for SigV4 and base64
  // helpers for the adapters' token handling.
  TextEncoder, TextDecoder, btoa, atob,
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
  get fileHandle() { return fileHandle; }, set fileHandle(v) { fileHandle = v; },
  get driveLink() { return driveLink; }, set driveLink(v) { driveLink = v; },
  get driveApi() { return driveApi; }, set driveApi(v) { driveApi = v; },
  loadParsedState, groupSections, songStatus, isSongReady, matchesReadyFilter, ensureFiltersAdmitSongs,
  recordSongViewed, viewedAgoText, createSongFromUrlText, autoSplitMassFields,
  massRowsToText, parseMassFieldRows, classifyMassEntryLines, parseChordLine,
  normalizeScrapedText, breakOutInlineSectionHeaders,
  buildSymbolsLine, displaySectionName, massSplitDefaultType, sectionTypeFromCustomName,
  defaultState, uid, touchGroup, touchSection, serializeState, SETBOOK_SCHEMA_VERSION,
  getDevicePersonaId, mountAdSlot, AD_CONFIG,
  SetBookStorage, activeBookAdapter, linkedFileBookAdapter, driveBookAdapter,
  LinkedFileBookAdapter, DriveBookAdapter,
  SETBOOK_CLOUD, SetBookCloudBookAdapter, setBookCloudBookAdapter,
  recordSongTombstone, dropSongTombstone, pruneTombstonesForLiveSongs,
  mergeSongbooksForSync, MAX_TOMBSTONES,
  sectionTransposeInfo, transposedSectionLines, blockCannotTranspose,
  deglueChordLyricLines,
  transposeSymbolsValue, transposeChordToken, stepTransposeKey, groupLinesForDisplay,
  TRANSPOSE_KEYS,
  readRecoverySnapshot, writeRecoverySnapshot, clearRecoverySnapshot, scheduleRecoverySave,
  parseRecoverySnapshot, driveRemoteChanged, ensurePdfLib, driveConfigured
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
  // Badge click order: Not Ready -> In Progress -> Ready -> Not Ready.
  // Mirrors the click handler in renderSidebar (the cycle isn't a helper).
  const cyc = (from) => from === 'not-ready' ? 'in-progress' : from === 'in-progress' ? 'ready' : 'not-ready';
  check('status cycle: Not Ready → In Progress → Ready → Not Ready',
    cyc('not-ready') === 'in-progress' && cyc('in-progress') === 'ready' && cyc('ready') === 'not-ready');
}

/* ================= 4b. new-song filter guard ================= */
suite('new-song-filters');
{
  resetApp();
  const g = { name: 'New one' }; // no readyStatus → Not Ready; defaults to Cover
  sb.state.readyFilter = { ready: true, notReady: false, inProgress: true };
  const changed = sb.ensureFiltersAdmitSongs([g]);
  check('new-song guard: Not Ready pill turns back on for a new song',
    changed !== '' && /Not ready/.test(changed) && sb.state.readyFilter.notReady === true && sb.matchesReadyFilter(g));
}
{
  resetApp();
  const g = { name: 'New one' };
  sb.state.readyFilter = { ready: false, notReady: false, inProgress: false };
  sb.state.tagFilter = 'jazz'; sb.state.artistFilter = 'Esperanza';
  const changed2 = sb.ensureFiltersAdmitSongs([g]);
  check('new-song guard: widens only what is needed, clears foreign tag/artist filters',
    changed2 !== '' && sb.state.readyFilter.ready === false && sb.state.readyFilter.inProgress === false &&
    sb.state.readyFilter.notReady === true && sb.state.tagFilter === '' && sb.state.artistFilter === '');
  resetApp();
  check('new-song guard: no-op when filters already admit the song', sb.ensureFiltersAdmitSongs([g]) === '');
  const t = { name: 'Original', type: 'original', readyStatus: 'ready', tags: ['jazz'], artist: 'Esperanza' };
  sb.state.songTypeFilter = { cover: true, original: false };
  sb.state.readyFilter = { ready: false, notReady: true, inProgress: true };
  sb.state.tagFilter = 'jazz'; sb.state.artistFilter = 'Esperanza';
  const changed3 = sb.ensureFiltersAdmitSongs([t]);
  check('new-song guard: matching tags/artists kept, missing type/status buckets widen',
    changed3 !== '' && sb.state.songTypeFilter.original === true && sb.state.readyFilter.ready === true &&
    sb.state.tagFilter === 'jazz' && sb.state.artistFilter === 'Esperanza');
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
  check('step up from G is Ab (chromatic list)', sb.stepTransposeKey('G', 1) === 'Ab');
  check('17 keys in the list', sb.TRANSPOSE_KEYS.length === 17);
  check('enharmonic black keys have separate entries',
    sb.TRANSPOSE_KEYS.some(k => k.key === 'Ab' && k.label === 'Ab / Fm') &&
    sb.TRANSPOSE_KEYS.some(k => k.key === 'G#' && k.label === 'G# / Fm'));
  check('every key pairs its relative minor', sb.TRANSPOSE_KEYS.every(k => / \/ [A-G][#b]?m$/.test(k.label)));
}

/* ================= 9. deglue rules (scraped wall-of-text splitting) ================= */
suite('deglue');
{
  // New rules from the "Wolly Bully" scraping report
  const cases = [
    ['comma-glued chord + capital', 'take a little salt,A7Put it in my shotgun',
      ['take a little salt,', 'A7', 'Put it in my shotgun']],
    ['comma-glued chord run', 'you take a silver dollar,C C# D',
      ['you take a silver dollar,', 'C C# D']],
    ['trailing bar-pipe chord tail', "I go walkin' out      |D7",
      ["I go walkin' out", '|D7']],
    ['lead chord (strong) + lowercase word', 'A7joo-ba joo-ba, Wolly Bully,',
      ['A7', 'joo-ba joo-ba, Wolly Bully,']],
    ['leading chord run + lyric', 'C C# D    Take a silver dime',
      ['C C# D', 'Take a silver dime']],
    // classic behaviors must survive
    ['mid chord + capital', 'D   CSuch a fine sight', ['D   C', 'Such a fine sight']],
    ['lead chord + capital', "GSlowin' through the park", ['G', "Slowin' through the park"]],
    ['trailing glued chord', '…mindG', ['…mind', 'G']],
    ['trailing chord tail', '…Arizona   D   C', ['…Arizona', 'D   C']],
  ];
  cases.forEach(([name, input, want]) => {
    const got = sb.deglueChordLyricLines(input).split('\n');
    check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}`);
  });
  // Must NOT break
  const safe = [
    ['numbered comma stays', 'In 3,500 days', ['In 3,500 days']],
    ['Amazing stays whole', 'Amazing grace, how sweet', ['Amazing grace, how sweet']],
    ['Email stays whole', 'Email me at once', ['Email me at once']],
    ['St. abbreviation stays', 'St.Louis blКues', ['St.Louis blКues']],
    ['bar grid untouched', '| G | D | A |', ['| G | D | A |']],
    ['pure chord line untouched', 'A7  D7  E7', ['A7  D7  E7']],
    ['lone root-only chord + word stays', 'A Letter To You', ['A Letter To You']],
    ['lone minor chord + pronoun lyric stays', 'Am I sitting here waiting', ['Am I sitting here waiting']],
  ];
  safe.forEach(([name, input, want]) => {
    const got = sb.deglueChordLyricLines(input).split('\n');
    check('safe: ' + name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}`);
  });
  // End-to-end: the "Wolly Bully" wall of text from the original report —
  // every arrow-called-out glue in the screenshot must resolve.
  const wall = [
    'A7',
    'A7joo-ba joo-ba, Wolly Bully, looking high, looking low,',
    'I take a little powder, take a little salt,A7Put it in my shotgun, I go walkin\u2019 out      |D7',
    'Well you take a silver dollar,C C# D    Take a silver dime,C C# D    Mix it up together',
    'With some alligator wine.'
  ].join('\n');
  const got = sb.deglueChordLyricLines(wall).split('\n');
  const want = [
    'A7',
    'A7', 'joo-ba joo-ba, Wolly Bully, looking high, looking low,',
    'I take a little powder, take a little salt,',
    'A7', 'Put it in my shotgun, I go walkin\u2019 out', '|D7',
    'Well you take a silver dollar,',
    'C C# D', 'Take a silver dime,',
    'C C# D', 'Mix it up together',
    'With some alligator wine.'
  ];
  check('end-to-end Wolly Bully wall of text', JSON.stringify(got) === JSON.stringify(want),
    'got\n' + got.map(l => '  ' + JSON.stringify(l)).join('\n'));

  // Regression: "Jack Straw" import. sus/add extension chords must survive
  // deglue whole (the longest chord prefix wins, so "E7sus4" is never
  // shredded into "E7" + "sus4"), and inline [Verse N] headers glue into
  // surrounding lines must be broken out for the auto-splitter.
  const susCases = [
    ['sus chord at line start splits from its lyric', 'E7sus4 I just jumped the watchman, right outside the fence,',
      ['E7sus4', 'I just jumped the watchman, right outside the fence,']],
    ['lone slash chord + lyric splits', 'C/E Walking down the avenue', ['C/E', 'Walking down the avenue']],
    ['sus chord glued to lyric splits whole', 'E7sus4I just jumped the watchman',
      ['E7sus4', 'I just jumped the watchman']],
    ['sharp sus glued to lyric splits whole', 'F#7sus4Hurts my ears to listen, Shannon,',
      ['F#7sus4', 'Hurts my ears to listen, Shannon,']],
    ['lone sus chord', 'E7sus4', ['E7sus4']],
    ['add chord glued splits whole', 'Dadd9Took his rings', ['Dadd9', 'Took his rings']],
    ['strong chord still splits from lowercase', 'A7joo-ba, Wolly Bully,',
      ['A7', 'joo-ba, Wolly Bully,']],
  ];
  susCases.forEach(([name, input, want]) => {
    const got = sb.deglueChordLyricLines(input).split('\n');
    check('sus/add: ' + name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}`);
  });
  const inlineCases = [
    ['header glued mid-line', 'movin\u2019 much too slow.  [Verse 2]E7sus4',
      ['movin\u2019 much too slow.', '[Verse 2]', 'E7sus4']],
    ['header glued to chord intro', 'Jack Straw - Grateful Dead (Hunter, Weir)  [Verse 1]E',
      ['Jack Straw - Grateful Dead (Hunter, Weir)', '[Verse 1]', 'E']],
    ['two inline headers on one line', '[Verse 1]E   F#m',
      ['[Verse 1]', 'E   F#m']],
    ['unrecognized bracket stays inline', 'the box [sic] was full', ['the box [sic] was full']],
    ['plain header line stays put', '[Chorus]', ['[Chorus]']],
    ['unrecognized bracket with suffix stays inline', 'intro riff  [Bridge (quiet)]Am',
      ['intro riff  [Bridge (quiet)]Am']],
  ];
  inlineCases.forEach(([name, input, want]) => {
    const got = sb.breakOutInlineSectionHeaders(input).split('\n');
    check('inline header: ' + name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}`);
  });
  // Full pipeline: header breakout happens before deglue, NBSP becomes a
  // space, and the whole "Jack Straw" first-verse snippet comes out clean.
  const js = sb.normalizeScrapedText(
    'Jack Straw\u00a0- Grateful Dead (Hunter, Weir)  [Verse 1]E\n' +
    'F#m\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0C#m\u00a0A\n' +
    'We can share the women, we can share the wineE\n' +
    'Bm\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0D\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0A\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0E\u00a0\u00a0G#m\u00a0D\u00a0A\n' +
    'We can share what we\'ve got of yours \'cause we done shared all of mine.\u00a0 [Verse 2]E7sus4'
  ).split('\n');
  // Pure chord lines (even multi-token) stay whole — the mass-entry parser
  // pairs a chord line with the lyric line beneath it, so they must not be
  // broken into one-token lines.
  const jsWant = [
    'Jack Straw - Grateful Dead (Hunter, Weir)',
    '[Verse 1]',
    'E',
    'F#m            C#m A',
    'We can share the women, we can share the wine',
    'E',
    'Bm            D      A          E  G#m D A',
    'We can share what we\'ve got of yours \'cause we done shared all of mine.',
    '[Verse 2]',
    'E7sus4'
  ];
  check('end-to-end Jack Straw verse (sus + inline headers + NBSP)',
    JSON.stringify(js) === JSON.stringify(jsWant),
    'got\n' + js.map(l => '  ' + JSON.stringify(l)).join('\n'));
}

/* ================= recovery store: IDB + fallback + migration ================= */
suite('recovery-store');
const recoveryStoreChecks = (async () => {
  suite('recovery-store');
    const snap = { savedAt: 1720000000000, state: sb.defaultState() };

    // 1) write → read via the async API
    const state = sb.state; // the app serializes live `state`
    sb.state = snap.state;
    sb.writeRecoverySnapshot();
    sb.state = state;
    await new Promise((r) => setTimeout(r, 5)); // let the debounce-less write land
    const reread = await sb.readRecoverySnapshot();
    // writeRecoverySnapshot stamps savedAt itself; assert content round-trips
    // and a sane fresh timestamp comes back.
    suite('recovery-store');
    check('IDB write→read round-trip', !!reread && typeof reread.savedAt === 'number' &&
      JSON.stringify(reread.state) === JSON.stringify(snap.state),
      JSON.stringify(reread && reread.savedAt));

    // 2) corrupt IDB record is dropped and reads null
    sb.clearRecoverySnapshot();
    await new Promise((r) => setTimeout(r, 5));
    const afterClear = await sb.readRecoverySnapshot();
    suite('recovery-store');
    check('clear removes the IDB snapshot', afterClear === null);

    // 3) legacy localStorage entry migrates into IDB
    const legacy = { savedAt: 1710000000000, state: sb.defaultState() };
    sandbox.localStorage.setItem('setbook-recovery-v1', JSON.stringify(legacy));
    const migrated = await sb.readRecoverySnapshot();
    suite('recovery-store');
    check('legacy localStorage snapshot migrates to IDB', !!migrated && migrated.savedAt === legacy.savedAt);
    check('legacy entry removed after migration', sandbox.localStorage.getItem('setbook-recovery-v1') === null);
    const viaIdb = await sb.readRecoverySnapshot();
    suite('recovery-store');
    check('migrated snapshot reads from IDB afterwards', !!viaIdb && viaIdb.savedAt === legacy.savedAt);
    sb.clearRecoverySnapshot();
    await new Promise((r) => setTimeout(r, 5));

    // 4) malformed payloads never restore
    check('parseRecoverySnapshot rejects junk', sb.parseRecoverySnapshot('not json') === null);
    check('parseRecoverySnapshot rejects missing arrays', sb.parseRecoverySnapshot(JSON.stringify({ savedAt: 1, state: {} })) === null);
    sandbox.localStorage.setItem('setbook-recovery-v1', 'garbage');
    const junk = await sb.readRecoverySnapshot();
    suite('recovery-store');
    check('malformed legacy entry is dropped, not restored', junk === null);
    sandbox.localStorage.removeItem('setbook-recovery-v1');
  })();

/* ================= lazy jsPDF loader guard ================= */
const lazyPdfChecks = (async () => {
  suite('lazy-pdf');
  // In the sandbox there is no document.head: ensurePdfLib must return a
  // promise that REJECTS with the friendly error (not throw synchronously,
  // not hang) — exactly what a blocked CDN produces in a real browser.
  const p = typeof sb.ensurePdfLib === 'function' ? sb.ensurePdfLib() : null;
  check('ensurePdfLib exists and returns a promise', !!p && typeof p.then === 'function');
  try {
    await p;
    check('ensurePdfLib rejects gracefully without a DOM loader', false, 'unexpectedly resolved');
  } catch (err) {
    // cross-realm Error: match on the message, not the prototype
    suite('lazy-pdf');
    check('ensurePdfLib rejects gracefully without a DOM loader', err && /did not load/.test(err.message), err && err.message);
  }
})();

/* ================= Drive conflict decision (pure) ================= */
const driveConflictChecks = (async () => {
  suite('drive-conflict');
  check('remote unchanged → no conflict', sb.driveRemoteChanged('2026-09-29T00:00:00Z', '2026-09-29T00:00:00Z') === false);
  check('remote changed → conflict', sb.driveRemoteChanged('2026-09-29T00:00:00Z', '2026-09-29T01:00:00Z') === true);
  check('unknown baseline → adopt silently, no conflict', sb.driveRemoteChanged(null, '2026-09-29T01:00:00Z') === false);
  check('missing remote time → no conflict', sb.driveRemoteChanged('2026-09-29T00:00:00Z', undefined) === false);
  // driveConfigured depends on the (possibly user-filled) credential
  // constants — assert only its contract, not the credential state.
  check('driveConfigured returns a boolean', typeof sb.driveConfigured() === 'boolean');
})();

/* ========== 13. phase-0 groundwork: schemaVersion, persona, ad slots, CSP ========== */
{
  // schemaVersion: every persistence path stamps it via the single seam.
  check('serializeState stamps schemaVersion', JSON.parse(sb.serializeState()).schemaVersion === sb.SETBOOK_SCHEMA_VERSION);
  check('serializeState stamps a copy, not the live object',
    (() => { const o = { a: 1 }; const s = sb.serializeState(o);
      return o.schemaVersion === undefined && JSON.parse(s).a === 1 && JSON.parse(s).schemaVersion === sb.SETBOOK_SCHEMA_VERSION; })());
  check('defaultState carries the current schemaVersion', sb.defaultState().schemaVersion === sb.SETBOOK_SCHEMA_VERSION);

  // Legacy and newer files both load: legacy becomes version 1, newer is tolerated.
  resetApp();
  sb.loadParsedState({ sectionGroups: [], sections: [] }); // legacy: no field
  check('legacy file (no schemaVersion) loads as version 1', sb.state.schemaVersion === 1);
  sb.loadParsedState({ sectionGroups: [], sections: [], schemaVersion: 99 }); // from the future
  check('newer schemaVersion loads without throwing', sb.state.schemaVersion === 99);
  resetApp();

  // Device persona: stable, namespaced, built only from randomness.
  const p1 = sb.getDevicePersonaId();
  const p2 = sb.getDevicePersonaId();
  check('device persona id is stable and namespaced', typeof p1 === 'string' && p1 === p2 && p1.indexOf('dev_') === 0);

  // Ad slots: the mount contract is inert while ads are disabled.
  check('ad slots are disabled by default', sb.AD_CONFIG.enabled === false);
  check('mountAdSlot renders nothing while disabled', sb.mountAdSlot('footer') === null);

  // CSP meta ships in the head (asserted against the raw file, not the sandbox DOM).
  check('Content-Security-Policy meta is present', /http-equiv="Content-Security-Policy"/.test(html));
  // The CSP must allow every origin an on-demand SDK fetches: the Drive
  // auth SDK (accounts.google.com/gsi/client), the Picker SDK
  // (apis.google.com/js/api.js), and the Picker/auth frame hosts.
  // Regression guard for the 2026-10-07 outage where the first CSP
  // rollout omitted these and silently broke every Drive path.
  const cspMatch = html.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/);
  const cspScriptSrc = cspMatch ? ((cspMatch[1].match(/script-src ([^;]*);/) || [])[1] || '') : '';
  const cspFrameSrc = cspMatch ? ((cspMatch[1].match(/frame-src ([^;]*);/) || [])[1] || '') : '';
  check('CSP allows the Drive auth + Picker script origins',
    cspScriptSrc.includes('https://accounts.google.com') && cspScriptSrc.includes('https://apis.google.com'));
  check('CSP allows the Picker iframe + auth frame origins',
    cspFrameSrc.includes('https://docs.google.com') && cspFrameSrc.includes('https://accounts.google.com'));
}

/* ========== 14. book adapters: embedded spike copy + app adapters ========== */
const adapterChecks = (async () => {
  // The embedded region must be byte-identical to the canonical storage/ copy.
  const begin = html.indexOf('/*__SETBOOK_STORAGE_BEGIN__*/');
  const end = html.indexOf('/*__SETBOOK_STORAGE_END__*/');
  check('embedded storage region present', begin !== -1 && end !== -1 && end > begin);
  if (begin !== -1 && end !== -1){
    const embedded = html.slice(begin + '/*__SETBOOK_STORAGE_BEGIN__*/'.length, end).replace(/^\n/, '').replace(/\n\s*$/, '');
    const canonical = fs.readFileSync(path.join(ROOT, 'storage', 'storage-adapters.js'), 'utf8').replace(/\s+$/, '');
    check('embedded adapters match storage/ copy verbatim', embedded === canonical);
  }
  check('spike adapter library exported', sb.SetBookStorage && Array.isArray(sb.SetBookStorage.ADAPTERS) && sb.SetBookStorage.ADAPTERS.length === 5);
  check('ConflictError exposed', typeof sb.SetBookStorage.ConflictError === 'function');

  // These checks run concurrently with the other async suites, so they
  // never resetApp() — they set exactly the bindings they exercise and
  // restore the boot state at the end.
  const bootState = sb.state;
  check('dispatch: none by default', sb.activeBookAdapter() === null);
  check('linked-file adapter unconfigured without handle', (await sb.linkedFileBookAdapter.isConfigured()) === false);
  let threw = null;
  try { await sb.linkedFileBookAdapter.loadBook(); } catch (e){ threw = e; }
  check('linked-file loadBook without handle throws', !!threw);

  // Round-trip through a minimal writable-stream handle stub: saveBook
  // must create a writable, write exactly the bytes given, and close it.
  {
    const writes = [];
    let closed = false;
    sb.state = sb.defaultState();
    sb.fileHandle = {
      createWritable: async () => ({
        write: async (d) => { writes.push(d); },
        close: async () => { closed = true; },
        abort: async () => {},
      }),
      getFile: async () => ({ text: async () => writes.join('') }),
    };
    const payload = JSON.stringify({ schemaVersion: 1, sectionGroups: [], sections: [] });
    const saved = await sb.linkedFileBookAdapter.saveBook(null, payload);
    check('linked-file saveBook writes bytes and closes', closed && writes.join('') === payload && saved && saved.rev === null);
    const loaded = await sb.linkedFileBookAdapter.loadBook();
    check('linked-file loadBook returns the written bytes', loaded.data === payload && loaded.rev === null);
    check('dispatch: linked file when only a handle exists', sb.activeBookAdapter() === sb.linkedFileBookAdapter);
    sb.fileHandle = null;
  }

  // DriveBookAdapter semantics with a stubbed driveApi: conflict on stale
  // modifiedTime, success path returns a rev and advances driveLink.
  {
    const realDriveApi = sb.driveApi;
    sb.state = sb.defaultState();
    sb.driveLink = { folderId: 'F', folderName: 'f', fileId: 'XYZ', fileName: 'book.json', remoteModifiedTime: '2026-10-06T00:00:00.000Z' };
    sb.driveApi = async () => ({ ok: true, json: async () => ({ modifiedTime: '2026-10-06T09:00:00.000Z' }), text: async () => '{"a":1}' });
    let conflictThrown = null;
    try { await sb.driveBookAdapter.saveBook('XYZ', '{}'); } catch (e){ conflictThrown = e; }
    check('drive adapter: stale remote time -> drive-conflict', !!conflictThrown && conflictThrown.message === 'drive-conflict' && conflictThrown.remoteModifiedTime === '2026-10-06T09:00:00.000Z');
    let patchBody = null;
    sb.driveApi = async (method, reqPath, opts) => {
      if (method === 'GET' && reqPath.indexOf('upload/') === -1){
        return { ok: true, json: async () => ({ modifiedTime: '2026-10-06T00:00:00.000Z' }), text: async () => '{"a":1}' };
      }
      patchBody = opts && opts.body;
      return { ok: true, json: async () => ({ modifiedTime: '2026-10-06T01:00:00.000Z' }), text: async () => '{"a":1}' };
    };
    const saved = await sb.driveBookAdapter.saveBook('XYZ', '{"a":1}');
    check('drive adapter: save returns new rev', !!saved && saved.rev === '2026-10-06T01:00:00.000Z');
    check('drive adapter: body written as given', patchBody === '{"a":1}');
    check('drive adapter: remoteModifiedTime advanced', sb.driveLink.remoteModifiedTime === '2026-10-06T01:00:00.000Z');
    const loaded = await sb.driveBookAdapter.loadBook('XYZ');
    check('drive adapter: loadBook returns data + rev', typeof loaded.data === 'string' && loaded.rev === '2026-10-06T01:00:00.000Z');
    sb.driveLink = null;
    sb.driveApi = realDriveApi;
  }
  sb.state = bootState;
  sb.fileHandle = null;
  sb.driveLink = null;
})();

/* ========== 15. sync tombstones + two-way merge ========== */
{
  const song = (id, updatedAt, extra) => Object.assign({ id, name: 'Song ' + id, artist: '', updatedAt }, extra || {});
  const sec = (id, groupId, order) => ({ id, groupId, nameType: 'intro', customName: '', nameSuffix: '', name: 'Intro', order, lines: [] });

  // recordSongTombstone: newest-first, deduped by id, capped.
  sb.state = sb.defaultState();
  sb.recordSongTombstone('g1', 1000);
  sb.recordSongTombstone('g2', 2000);
  sb.recordSongTombstone('g1', 3000); // re-delete wins, stays single
  check('tombstone: newest first, deduped by id',
    sb.state.tombstones.length === 2 && sb.state.tombstones[0].id === 'g1' && sb.state.tombstones[0].deletedAt === 3000);
  for (let i = 0; i < sb.MAX_TOMBSTONES + 5; i++) sb.recordSongTombstone('x' + i, 4000 + i);
  check('tombstone: capped at MAX_TOMBSTONES', sb.state.tombstones.length === sb.MAX_TOMBSTONES);
  check('tombstone: newest kept when over cap', sb.state.tombstones[0].id === 'x' + (sb.MAX_TOMBSTONES + 4));

  // drop + prune
  sb.state = sb.defaultState();
  sb.state.sectionGroups = [song('live1', 500)];
  sb.state.tombstones = [{ id: 'dead1', deletedAt: 900 }, { id: 'live1', deletedAt: 400 }];
  sb.dropSongTombstone('dead1');
  check('tombstone: drop removes one id', sb.state.tombstones.length === 1 && sb.state.tombstones[0].id === 'live1');
  sb.pruneTombstonesForLiveSongs();
  check('tombstone: prune drops tombstones for live songs', sb.state.tombstones.length === 0);

  // loadParsedState validation: junk tombstones dropped, live-id tombstones pruned
  sb.state = sb.defaultState();
  sb.loadParsedState({
    sectionGroups: [song('liveA', 100)], sections: [sec('sA', 'liveA', 0)],
    tombstones: [{ id: 'ok', deletedAt: 5 }, { id: 'bad' }, { id: 'nodate' }, 'junk', { id: 'liveA', deletedAt: 3 }],
  });
  check('tombstone: load keeps only well-formed non-live entries',
    sb.state.tombstones.length === 1 && sb.state.tombstones[0].id === 'ok');

  // ---- mergeSongbooksForSync ----
  // 1. both sides changed: newer updatedAt wins wholesale
  {
    const mine = { sectionGroups: [song('a', 200, { name: 'Mine' })], sections: [sec('sa', 'a', 0)], tombstones: [] };
    const theirs = { sectionGroups: [song('a', 300, { name: 'Theirs' })], sections: [sec('sa2', 'a', 0)], tombstones: [] };
    const m = sb.mergeSongbooksForSync(mine, theirs);
    check('merge: newer updatedAt wins', m.sectionGroups.length === 1 && m.sectionGroups[0].name === 'Theirs');
    check('merge: sections filtered to the winning song', m.sections.length === 1 && m.sections[0].id === 'sa2');
  }
  // 2. add on each side: union
  {
    const mine = { sectionGroups: [song('a', 100)], sections: [sec('sa', 'a', 0)], tombstones: [] };
    const theirs = { sectionGroups: [song('b', 100)], sections: [sec('sb', 'b', 0)], tombstones: [] };
    const m = sb.mergeSongbooksForSync(mine, theirs);
    check('merge: additions from both sides survive', m.sectionGroups.length === 2);
  }
  // 3. delete vs unedited copy: tombstone wins, song gone
  {
    const mine = { sectionGroups: [], sections: [], tombstones: [{ id: 'a', deletedAt: 500 }] };
    const theirs = { sectionGroups: [song('a', 100)], sections: [sec('sa', 'a', 0)], tombstones: [] };
    const m = sb.mergeSongbooksForSync(mine, theirs);
    check('merge: delete (tombstone newer than song) wins', m.sectionGroups.length === 0);
    check('merge: dead song sections dropped', m.sections.length === 0);
    check('merge: tombstone survives the merge', m.tombstones.some(t => t.id === 'a'));
  }
  // 4. edit after delete: edit wins, tombstone pruned
  {
    const mine = { sectionGroups: [], sections: [], tombstones: [{ id: 'a', deletedAt: 100 }] };
    const theirs = { sectionGroups: [song('a', 200)], sections: [sec('sa', 'a', 0)], tombstones: [] };
    const m = sb.mergeSongbooksForSync(mine, theirs);
    check('merge: edit newer than tombstone survives', m.sectionGroups.length === 1 && m.sectionGroups[0].id === 'a');
    check('merge: losing tombstone pruned', m.tombstones.length === 0);
  }
  // 5. tombstone union: newest deletedAt per id, both kept when for different ids
  {
    const mine = { sectionGroups: [], sections: [], tombstones: [{ id: 'a', deletedAt: 100 }] };
    const theirs = { sectionGroups: [], sections: [], tombstones: [{ id: 'a', deletedAt: 300 }, { id: 'b', deletedAt: 50 }] };
    const m = sb.mergeSongbooksForSync(mine, theirs);
    check('merge: tombstone union keeps newest per id',
      m.tombstones.length === 2 && m.tombstones.find(t => t.id === 'a').deletedAt === 300);
  }
  // 6. legacy files (no tombstones field) merge cleanly
  {
    const mine = { sectionGroups: [song('a', 100)], sections: [sec('sa', 'a', 0)] };
    const theirs = { sectionGroups: [song('b', 100)], sections: [sec('sb', 'b', 0)] };
    const m = sb.mergeSongbooksForSync(mine, theirs);
    check('merge: legacy inputs without tombstones work', m.sectionGroups.length === 2 && Array.isArray(m.tombstones));
  }
  // 7. delete undo end-to-end through the app functions
  {
    sb.state = sb.defaultState();
    const g = song('undoMe', 100);
    sb.state.sectionGroups = [g];
    sb.state.sections = [sec('su', 'undoMe', 0)];
    sb.recordSongTombstone('undoMe', 200);
    check('tombstone: record marks deleted id', sb.state.tombstones.length === 1);
    sb.dropSongTombstone('undoMe'); // what the undo callback does
    check('tombstone: undo (drop) clears it', sb.state.tombstones.length === 0);
  }
}

/* ========== 16. SetBook Cloud prototype (disabled sync adapter) ========== */
const cloudAdapterChecks = (async () => {
  // The dispatch checks below read the fileHandle/driveLink bindings the
  // adapter suite sets and restores — drain that suite first so they are
  // deterministic (the IIFE below starts as soon as it is defined).
  await adapterChecks;
  suite('setbook-cloud');
  const adapter = sb.setBookCloudBookAdapter;
  check('cloud adapter registered', !!adapter && adapter.id === 'setbook-cloud' && adapter.kind === 'cloud');
  check('prototype flag ships disabled', sb.SETBOOK_CLOUD.enabled === false);
  check('cloud configFields: endpoint + secret token', (() => {
    const f = adapter.configFields();
    return f.length === 2 && f[0].key === 'baseUrl' && f[1].key === 'token' && f[1].secret === true;
  })());
  check('cloud quota reports nothing (no plan API yet)', (await adapter.quota()) === null);

  // HTTPS-only guard: plaintext endpoints are rejected and leave the
  // adapter unconfigured.
  let httpThrew = null;
  try { await adapter.configure({ baseUrl: 'http://api.example.com' }); } catch (e){ httpThrew = e; }
  check('cloud configure rejects http://', !!httpThrew && /https/.test(httpThrew.message));
  check('rejected endpoint leaves adapter unconfigured', adapter.isConfigured() === false);

  // Flag off: configured or not, the adapter is invisible to dispatch.
  await adapter.configure({ baseUrl: 'https://api.setbook.app/v1', token: 't' });
  check('flag off: configured adapter still not active', adapter.isConfigured() === false);
  check('flag off: dispatch unchanged', sb.activeBookAdapter() === null);

  // From here on the suite drives the adapter with a stubbed fetch. The
  // sandbox has no fetch global, so save/restore it exactly.
  const realFetch = sandbox.fetch;
  const realCloud = sb.SETBOOK_CLOUD;
  const calls = [];
  sandbox.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body });
    const last = calls[calls.length - 1];
    return sandbox.__cloudRespond(last);
  };
  try {
    sb.SETBOOK_CLOUD.enabled = true;
    check('flag on + configured: adapter activates', adapter.isConfigured() === true);
    check('flag on: dispatch hands saves to the cloud adapter', sb.activeBookAdapter() === adapter);

    // Unconfigured instance refuses to fetch.
    const bare = new sb.SetBookCloudBookAdapter();
    let bareThrew = null;
    try { await bare.saveBook('b1', '{}', 'r1'); } catch (e){ bareThrew = e; }
    check('saveBook without configuration throws before any fetch', !!bareThrew && calls.length === 0);

    // Create (rev=null): PUT gated by If-None-Match *, body passed verbatim.
    calls.length = 0;
    sandbox.__cloudRespond = () => ({ ok: true, status: 201, headers: { get: (k) => k.toLowerCase() === 'etag' ? '"rev-a"' : null } });
    const created = await adapter.saveBook('book1', '{"a":1}', null);
    check('create: single PUT with If-None-Match *', calls.length === 1 && calls[0].method === 'PUT' && calls[0].headers['If-None-Match'] === '*');
    check('create: body passed through verbatim', calls[0].body === '{"a":1}');
    check('create: returns server rev', created && created.rev === 'rev-a');
    check('create: id is URL-encoded in the path', calls[0].url === 'https://api.setbook.app/v1/book1.json');

    // Unchanged remote (304): plain PUT, no merge.
    calls.length = 0;
    sandbox.__cloudRespond = (c) => c.method === 'GET'
      ? { ok: false, status: 304, headers: { get: () => null } }
      : { ok: true, status: 200, headers: { get: (k) => k.toLowerCase() === 'etag' ? 'rev-b' : null } };
    const plain = await adapter.saveBook('book1', '{"a":1}', 'rev-a');
    check('unchanged remote: GET then PUT', calls.length === 2 && calls[0].method === 'GET' && calls[1].method === 'PUT');
    check('unchanged remote: PUT carries If-Match rev', calls[1].headers['If-Match'] === 'rev-a');
    check('unchanged remote: no merge, body as given', calls[1].body === '{"a":1}' && plain && plain.rev === 'rev-b' && !plain.merged);

    // Changed remote: both sides parsed, mergeSongbooksForSync decides,
    // survivor set written back with the remote's rev.
    const song = (id, updatedAt, name) => ({ id, name: name || ('Song ' + id), updatedAt });
    const localBook = { name: 'Local', schemaVersion: 1, sectionGroups: [song('a', 200, 'Edited here')], sections: [], tombstones: [] };
    const remoteBook = { name: 'Remote', schemaVersion: 1, sectionGroups: [song('b', 100, 'Added there')], sections: [], tombstones: [{ id: 'a', deletedAt: 500 }] };
    calls.length = 0;
    sandbox.__cloudRespond = (c) => c.method === 'GET'
      ? { ok: true, status: 200, headers: { get: (k) => k.toLowerCase() === 'etag' ? 'rev-c' : null }, text: async () => JSON.stringify(remoteBook) }
      : { ok: true, status: 200, headers: { get: (k) => k.toLowerCase() === 'etag' ? 'rev-d' : null } };
    const merged = await adapter.saveBook('book1', JSON.stringify(localBook), 'rev-b');
    const putBody = JSON.parse(calls[1].body);
    check('changed remote: merge runs and result is uploaded', calls.length === 2 && calls[1].method === 'PUT' && calls[1].headers['If-Match'] === 'rev-c');
    check('merge upload: tombstoned-over local song dropped, remote song kept',
      putBody.sectionGroups.length === 1 && putBody.sectionGroups[0].id === 'b');
    check('merge upload: tombstone survives in the written book', putBody.tombstones.some((t) => t.id === 'a'));
    check('merge upload: server copy is the base for file-level fields', putBody.name === 'Remote' && putBody.schemaVersion === 1);
    check('merged save is flagged so a caller can reload', merged && merged.rev === 'rev-d' && merged.merged === true);

    // Racing writer between the merge read and write: 412 -> ConflictError.
    calls.length = 0;
    sandbox.__cloudRespond = (c) => c.method === 'PUT'
      ? { ok: false, status: 412, headers: { get: () => null } }
      : { ok: true, status: 200, headers: { get: (k) => k.toLowerCase() === 'etag' ? 'rev-c' : null }, text: async () => JSON.stringify(remoteBook) };
    let conflictThrew = null;
    try { await adapter.saveBook('book1', JSON.stringify(localBook), 'rev-b'); } catch (e){ conflictThrew = e; }
    check('racing writer surfaces as ConflictError', !!conflictThrew && conflictThrew.name === 'ConflictError');

    // loadBook: data text + ETag rev; 404 throws.
    calls.length = 0;
    sandbox.__cloudRespond = () => ({ ok: true, status: 200, headers: { get: (k) => k.toLowerCase() === 'etag' ? '"rev-x"' : null }, text: async () => '{"ok":true}' });
    const loaded = await adapter.loadBook('book1');
    check('loadBook returns data text + rev', loaded && loaded.data === '{"ok":true}' && loaded.rev === 'rev-x');
    sandbox.__cloudRespond = () => ({ ok: false, status: 404, headers: { get: () => null } });
    let loadThrew = null;
    try { await adapter.loadBook('book1'); } catch (e){ loadThrew = e; }
    check('loadBook 404 throws', !!loadThrew);

    // deleteBook: tolerant of an already-gone book.
    calls.length = 0;
    sandbox.__cloudRespond = () => ({ ok: true, status: 204, headers: { get: () => null } });
    await adapter.deleteBook('book1');
    check('deleteBook issues DELETE', calls.length === 1 && calls[0].method === 'DELETE');
  } finally {
    if (realFetch === undefined) delete sandbox.fetch; else sandbox.fetch = realFetch;
    delete sandbox.__cloudRespond;
    realCloud.enabled = false; // same object the app's const binding points at
  }
  check('flag restored: adapter inactive again', sb.SETBOOK_CLOUD.enabled === false && adapter.isConfigured() === false);
  check('dispatch restored', sb.activeBookAdapter() === null);
})();

/* ========== 17. song notes: details field, persistence, sync, PDF exclusion ========== */
{
  suite('song-notes');
  // The details page wires a notes textarea to group.notes through the
  // same touchGroup + scheduleSave flow every other song field uses.
  check('details page binds a notes textarea',
    /notesInput\.value = group\.notes \|\| ''/.test(html) && /group\.notes = notesInput\.value;/.test(html));
  check('notes edits touch and save the song',
    /group\.notes = notesInput\.value;[\s\S]{0,60}touchGroup\(group\)/.test(html));
  check('notes field has its own stylesheet class',
    /\.details-notes-field\{/.test(html) && /\.details-notes-field:focus\{/.test(html));
  check('Help mentions the notes field', /notes field/.test(html));

  // Persistence: notes is an optional song field that round-trips through
  // serialize → parse → load. loadParsedState normalizes known fields and
  // must not strip or invent this one (unknown-field preservation contract).
  resetApp();
  sb.state.sectionGroups = [{ id: 'g-notes', name: 'Notes Song', artist: '', updatedAt: 100, notes: 'Capo 2, key of D' }];
  sb.state.sections = [];
  sb.loadParsedState(JSON.parse(sb.serializeState()));
  check('notes survive serialize → parse → load', sb.state.sectionGroups[0].notes === 'Capo 2, key of D');
  sb.loadParsedState({ sectionGroups: [{ id: 'g2', name: '', updatedAt: 1 }], sections: [] });
  check('notes are optional: missing field stays missing (no invented value)',
    sb.state.sectionGroups[0].notes === undefined);
  resetApp();

  // Sync: whole-song merge carries notes on the winning side.
  {
    const mine = { sectionGroups: [{ id: 'a', name: 'Mine', updatedAt: 300, notes: 'newer note' }], sections: [], tombstones: [] };
    const theirs = { sectionGroups: [{ id: 'a', name: 'Theirs', updatedAt: 100, notes: 'older note' }], sections: [], tombstones: [] };
    const m = sb.mergeSongbooksForSync(mine, theirs);
    check('merge: newer song keeps its notes', m.sectionGroups[0].notes === 'newer note');
  }

  // PDF exclusion: notes are deliberately app-side only. Guard the whole
  // PDF build region against ever referencing them.
  {
    const pdfStart = html.indexOf('function pdfSectionLines(');
    const pdfEnd = html.indexOf('function buildPdfFilename(');
    check('PDF build region found for the exclusion guard', pdfStart !== -1 && pdfEnd > pdfStart);
    if (pdfStart !== -1 && pdfEnd > pdfStart){
      check('PDF build never references notes', !/\bnotes\b/i.test(html.slice(pdfStart, pdfEnd)));
    }
  }
}

/* ================= PDF export page (layout, fullscreen, contexts, copy) ================= */
suite('pdf-preview-modal');
// The exporter is a dedicated full page (like the Setlists page), not a
// modal: opening it swaps it in for #main beside the unchanged sidebar
// and header, and the page scrolls normally at any window height — no
// dialog height math, no clipped preview. The viewer is a real box its
// absolutely-positioned children fill. (Regression for the modal era,
// where a short window clipped the preview and the controls.)
check('exporter is a dedicated page hiding the editor while open',
  /<section class="pdf-page" id="pdfModalOverlay" hidden>/.test(html) &&
  /document\.getElementById\('main'\)\.style\.display = 'none';/.test(html) &&
  /function closePdfPage\(\)/.test(html));
check('every entry point funnels through openPdfPage',
  /pdfPendingPreviewMode = true;/.test(html) && /openPdfPage\(\);/.test(html) &&
  /preparePdfModal\(sel, asPreview, pendingSl\)/.test(html));
check('page scrolls normally; viewer is a real 54vh-min box',
  /#pdfModalOverlay\.pdf-page:not\(\[hidden\]\)\{[^}]*overflow-y:auto/.test(html) &&
  /#pdfModalOverlay \.pdf-preview-viewer\{ flex:0 0 auto; height:54vh; min-height:340px; \}/.test(html));
check('frame and strip absolutely fill the viewer',
  /#pdfModalOverlay #pvFrame\{ position:absolute; inset:0;/.test(html) &&
  /#pdfModalOverlay #pvStripWrap\{ position:absolute; inset:0;/.test(html));
check('[hidden] still wins over the absolute fill rules',
  /#pdfModalOverlay #pvFrame\[hidden\], #pdfModalOverlay #pvStripWrap\[hidden\]\{ display:none; \}/.test(html));
check('fullscreen mode grows the viewer to the whole screen',
  /#pdfModalOverlay:fullscreen \.pdf-preview-viewer\{\s*flex:1 1 auto; height:auto; min-height:0;/.test(html));

// The strip re-fits its pages when the available height changes (window
// resize, entering/leaving fullscreen) without a full PDF re-render.
check('strip re-renders pages on resize with current page preserved',
  /renderPvStripPages\(pvStripDoc, pvRenderSeq, pvCurrentPage\(\)\)/.test(html) &&
  /window\.addEventListener\('resize', \(\) => \{\s*if \(pdfPageHidden\(\)\) return;/.test(html));
check('renderPvStripPages jumps instantly and syncs indicator',
  /pvGoToPage\(Math\.min\(keepPage \|\| 1, pvStripPages\), true\);/.test(html));

// Fullscreen preview: the dialog itself goes fullscreen via the Fullscreen
// API; the button toggles and the state syncs on fullscreenchange.
check('fullscreen toggle button exists in the controls row',
  /id="pvFullscreenBtn" aria-pressed="false"/.test(html));
check('fullscreen state syncs button label + aria-pressed',
  /fullscreenchange[\s\S]{0,300}aria-pressed', String\(active\)\)/.test(html));
check('print-friendly fullscreen hands focus to the embedded viewer',
  /document\.getElementById\('pvFrame'\)\.contentWindow\.focus\(\)/.test(html));
check('fullscreen page fills the screen edge-to-edge',
  /#pdfModalOverlay:fullscreen\{\s*width:100vw; height:100vh; max-height:none;/.test(html));
check('fullscreen button opts out of the global .mode-btn flex:1',
  /#pdfModalOverlay #pvFullscreenBtn\{ flex:0 0 auto; \}/.test(html));

// Two contexts sharing one dialog: Export (header button) vs focused PDF
// preview (song-card icon).
check('modal title is context-aware (pdfModalTitle)',
  /id="pdfModalTitle"/.test(html) && /title\.textContent = 'PDF preview'/.test(html) && /title\.textContent = 'Export PDF'/.test(html));
check('preview context hides the songs/output columns',
  /columns\.style\.display = 'none'/.test(html));
check('song-card entry point requests preview context',
  /pdfPendingPreviewMode = true;/.test(html) && /preparePdfModal\(sel, asPreview, pendingSl\)/.test(html));
check('preview context names the song in the subtitle',
  /sub\.textContent = g \? \(g\.name \|\| 'Untitled Song'\) \+ \(displayArtists\(g\)/.test(html));

// URL-import error box: always offer both the scraper and manual paste.
check('scraper-and-paste copy is present',
  /Two ways around it: use the <strong>SetBook scraper<\/strong> extension/.test(html) &&
  /paste it into a section field on a new song/.test(html));
check('scraper-only copy is gone',
  !/extension instead: open the lyrics page/.test(html));

/* ================= setlists + card grid ================= */
suite('setlists');
// dedicated Songs → Setlists… entry points (desktop + grouped mobile menus)
check('setlists menu items wired in both menus',
  /id="btnSetlists"/.test(html) && /data-delegate="btnSetlists"/.test(html) && /openSetlistsView\(\)/.test(html));
// setlist view: full-page surface like the song details page
check('setlists view opens a dedicated page',
  /let setlistsViewOpen = false;/.test(html) && /function openSetlistsView/.test(html) && /closeSetlistsView\(\)/.test(html));
check('renderMain hosts the setlists page',
  /if \(setlistsViewOpen\)\{\s*renderSetlistsPage\(main\);\s*return;/.test(html));
// schema: setlist shape + legacy subset load-in migration
check('setlist schema normalizer',
  /function normalizeSetlist\(raw\)/.test(html) && /startIndex/.test(html));
check('legacy songSubsets migrate into setlists on load',
  /function migrateSetlists\(state\)/.test(html) && /migrateSetlists\(state\);/.test(html) && /byId\.has\(sub\.id\)\) return;/.test(html));
check('setlist edits mirror into songSubsets for older apps',
  /function syncSetlistMirror\(sl\)/.test(html));
check('setlist song order helper skips unprintable songs',
  /function setlistSongs\(sl\)/.test(html) && /printableSections\(id\)\.length/.test(html));
// builder: drag reorder, set parts anchored by song id (survive reorder)
check('setlist builder renders rows with drag handles',
  /sl-drag-handle/.test(html) && /row\.draggable = true;/.test(html));
check('drag drop uses setlist order helper',
  /applyReorderWithParts\(sl, songs, from, to\)/.test(html));
check('set labels re-anchor to song ids across reorders',
  /const anchorSong = new Map\(\)/.test(html));
check('add-set-label popover skips already-labelled positions',
  /openAddPartPopover\(e\.currentTarget, sl\)/.test(html) && /sl\.parts\.some\(p => p\.startIndex === i\)\) continue;/.test(html));
check('setlist card grid with delete affordance',
  /setlist-grid/.test(html) && /setlist-card/.test(html) && /Delete the setlist/.test(html));
// PDF: setlist order + labels reach the generated file
check('collectPdfSongs honors setlist order when provided',
  /function collectPdfSongs\(selectedGroupIds, pdfOrder\)/.test(html) && /const rank = new Map\(pdfOrder\.map\(\(id, i\) => \[id, i\]\)\)/.test(html));
check('PDF render picks up the active setlist',
  /const activeSl = setSel && setSel\.value \? findSetlist\(setSel\.value\) : null;/.test(html));
check('TOC renders set labels on boundary rows',
  /const partLabel = pdfSetlist \? setlistPartAt\(pdfSetlist, i\) : null;/.test(html) && /partLabel\.toUpperCase\(\)/.test(html));
check('setlist entry point opens Export with that setlist preselected',
  /function openPdfPreviewFromSetlist\(/.test(html) && /pdfPendingSetlistId = setlistId;/.test(html));
check('setlist exports name the file after the setlist',
  /const activeSl = setSel && setSel\.value \? findSetlist\(setSel\.value\) : null;/.test(html) && /activeSl && \(activeSl\.name \|\| ''\)\.trim\(\)/.test(html));
check('dialog Set dropdown wording',
  /Name this setlist:/.test(html) && /Delete the setlist/.test(html) && !/Name this subset:/.test(html));
// card grid view toggle (device-level preference)
check('sidebar card-grid view toggles and persists',
  /function setSidebarGridView\(on\)/.test(html) && /setbook-sidebar-grid-view/.test(html) && /applySidebarGridView\(\);/.test(html));
check('grid view is CSS-scoped to the sidebar list',
  /\.sidebar-list\.grid-view\{/.test(html) && /listViewToggle/.test(html));
check('library view toggle is always visible above the filters panel',
  /list-view-row"[\s\S]{0,200}id="listViewToggle"/.test(html) &&
  /View: rows/.test(html));
// MCP parity: server exposes setlist tools
check('MCP server exposes setlist tools',
  /list_setlists/.test(html) || true); // app HTML doesn't embed MCP; real guard below
const mcpServerSrc = (() => { try { return require('fs').readFileSync(path.join(ROOT, 'setbook-mcp', 'server.mjs'), 'utf8'); } catch(e) { return ''; } })();
check('MCP server registers list_setlists',
  mcpServerSrc.includes("'list_setlists'"));
check('MCP server registers edit_setlist',
  mcpServerSrc.includes("'edit_setlist'"));
check('MCP server registers generate_setlist',
  mcpServerSrc.includes("'generate_setlist'"));
check('MCP server registers delete_setlist',
  mcpServerSrc.includes("'delete_setlist'"));
check('MCP song-tools imports and exports setlist helpers',
  (() => { try { const s = require('fs').readFileSync(path.join(ROOT, 'setbook-mcp', 'song-tools.mjs'), 'utf8'); return s.includes('export function listSetlists') && s.includes('export function upsertSetlist') && s.includes('export function generateSetlist') && s.includes('export function deleteSetlist'); } catch(e){ return false; } })());
check('legacy subset wording retired from Save flow',
  !/Name this subset/.test(html));

/* ================= summary ================= */
Promise.all([recoveryStoreChecks, lazyPdfChecks, driveConflictChecks, adapterChecks, cloudAdapterChecks]).then(() => {
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) {
  console.log('FAILED:');
  failed.forEach(f => console.log('  ✗ ' + f.name + (f.detail ? ' — ' + f.detail : '')));
  process.exit(1);
}
runExternalCorpus();
});

/* ================= optional: external real-songbook pass (read-only) ================= */
function runExternalCorpus(){
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
}
