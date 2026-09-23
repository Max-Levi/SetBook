// SetBook storage-adapter spike — Playwright verification.
// IndexedDB runs for real; GitHub / S3 / REST run against mocked fetch
// (route interception); LocalFile is interface-checked only.
const { chromium } = require('playwright-core');

const SPIKE = '/home/hatch/workspace/setbook-storage-spike';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/meta-chromium/chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  /* ---------------- mocked backends ---------------- */
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-GitHub-Api-Version, x-amz-date, x-amz-content-sha256, If-Match, If-None-Match',
    'Access-Control-Expose-Headers': 'ETag',
  };
  const ghB64 = Buffer.from(JSON.stringify({ title: 'Demo' })).toString('base64');

  await page.route('**/api.github.com/**', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 200, headers: CORS, body: '' });
    const url = req.url();
    const json = (status, body) => route.fulfill({ status, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (url.includes('/contents/books/?ref=main')) return json(200, [{ type: 'file', name: 'demo.json' }]);
    if (url.includes('/contents/books/demo.json?ref=main')) return json(200, { content: ghB64, sha: 'sha-aaa' });
    if (url.includes('/contents/books/demo.json') && req.method() === 'PUT') {
      const body = req.postDataJSON();
      if (body.sha && body.sha !== 'sha-aaa') return json(422, { message: '"sha" wasn\'t supplied.' });
      return json(200, { content: { sha: 'sha-bbb' } });
    }
    if (url.includes('/contents/books/demo.json') && req.method() === 'DELETE') return json(200, {});
    return json(404, { message: 'not mocked: ' + url });
  });

  await page.route('**/s3.test.local/**', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 200, headers: CORS, body: '' });
    const url = req.url();
    const ok = (status, headers, body) => route.fulfill({ status, headers: { ...CORS, ...headers }, body });
    if (url.includes('?list-type=2')) {
      return ok(200, { 'Content-Type': 'application/xml' },
        '<?xml version="1.0"?><ListBucketResult><Contents><Key>books/demo.json</Key></Contents></ListBucketResult>');
    }
    if (url.endsWith('/books/demo.json') && req.method() === 'HEAD') return ok(200, { ETag: '"etag-1"' }, '');
    if (url.endsWith('/books/demo.json') && req.method() === 'GET') return ok(200, { ETag: '"etag-1"', 'Content-Type': 'application/json' }, JSON.stringify({ title: 'Demo' }));
    if (/\/books\/[^/]+\.json$/.test(url) && req.method() === 'PUT') {
      if (req.headers()['if-none-match'] === '*') return ok(200, { ETag: '"etag-new"' }, '');
      return ok(200, { ETag: '"etag-2"' }, '');
    }
    if (url.endsWith('/books/demo.json') && req.method() === 'DELETE') return ok(200, {}, '');
    return ok(404, {}, '');
  });

  await page.route('**/api.test.local/**', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 200, headers: CORS, body: '' });
    const url = req.url();
    const json = (status, body, etag) => route.fulfill({
      status, headers: { ...CORS, 'Content-Type': 'application/json', ...(etag ? { ETag: `"${etag}"` } : {}) },
      body: JSON.stringify(body),
    });
    if (url.endsWith('/sb/index.json')) return json(200, [{ id: 'demo', name: 'demo', updatedAt: null }]);
    if (url.endsWith('/sb/demo.json') && req.method() === 'GET') return json(200, { title: 'Demo' }, 'r1');
    if (url.endsWith('/sb/demo.json') && req.method() === 'PUT') {
      if (req.headers()['if-match'] && req.headers()['if-match'] !== 'r1') return json(412, { error: 'precondition' });
      return json(200, {}, 'r2');
    }
    if (url.endsWith('/sb/demo.json') && req.method() === 'DELETE') return json(200, {});
    return json(404, {});
  });

  await page.goto('file://' + SPIKE + '/spike-demo.html');
  await page.waitForTimeout(800);
  check('demo page loads without errors', pageErrors.length === 0, pageErrors.join(' ;; '));
  check('crypto.subtle available (needed for SigV4)', await page.evaluate(() => !!crypto.subtle));

  /* ---------------- UI smoke ---------------- */
  const ui = await page.evaluate(() => {
    const sel = document.getElementById('adapterSelect');
    sel.value = 'GitHubAdapter';
    sel.dispatchEvent(new Event('change'));
    return {
      options: sel.options.length,
      ghFields: document.querySelectorAll('#configForm [data-key]').length,
    };
  });
  check('adapter picker lists 5 backends', ui.options === 5, `${ui.options} found`);
  check('GitHub config form renders 5 fields', ui.ghFields === 5, `${ui.ghFields} found`);

  /* ---------------- adapter behavior ---------------- */
  const out = await page.evaluate(async () => {
    const { ADAPTERS, ConflictError } = window.SetBookStorage;
    const R = [];
    const t = (name, ok, detail = '') => R.push({ name, ok, detail });
    const byName = (n) => ADAPTERS.find((a) => a.name === n);

    // IndexedDB — real round trip
    try {
      const a = new (byName('IndexedDBAdapter'))('setbook-spike-testdb');
      await a.configure();
      t('idb: isConfigured', a.isConfigured());
      let r = await a.saveBook('b1', { name: 'B1', v: 1 }, null);
      t('idb: create rev=1', r.rev === 1, 'rev=' + r.rev);
      try { await a.saveBook('b1', { v: 9 }, null); t('idb: create-existing conflicts', false); }
      catch (e) { t('idb: create-existing conflicts', e instanceof ConflictError); }
      const loaded = await a.loadBook('b1');
      t('idb: load round-trips data', loaded.data.v === 1 && loaded.rev === 1);
      r = await a.saveBook('b1', { name: 'B1', v: 2 }, 1);
      t('idb: update with fresh rev', r.rev === 2);
      try { await a.saveBook('b1', { v: 3 }, 1); t('idb: stale rev conflicts', false); }
      catch (e) { t('idb: stale rev conflicts', e instanceof ConflictError && e.currentRev === 2, 'currentRev=' + e.currentRev); }
      const list = await a.listBooks();
      t('idb: listBooks', list.length === 1 && list[0].id === 'b1');
      await a.deleteBook('b1');
      t('idb: delete', (await a.listBooks()).length === 0);
      try { await a.loadBook('b1'); t('idb: load missing throws', false); }
      catch (e) { t('idb: load missing throws', true); }
    } catch (e) { t('idb: suite', false, e.message); }

    // GitHub — mocked API
    try {
      const a = new (byName('GitHubAdapter'))();
      await a.configure({ owner: 'o', repo: 'r', path: 'books/', branch: 'main', token: 't' });
      t('github: isConfigured', a.isConfigured());
      const loaded = await a.loadBook('demo');
      t('github: load (rev=sha)', loaded.data.title === 'Demo' && loaded.rev === 'sha-aaa');
      const r = await a.saveBook('demo', { title: 'D2' }, 'sha-aaa');
      t('github: save with fresh sha', r.rev === 'sha-bbb');
      try { await a.saveBook('demo', { title: 'D3' }, 'stale-sha'); t('github: stale sha conflicts', false); }
      catch (e) { t('github: stale sha conflicts', e instanceof ConflictError, e.message.slice(0, 40)); }
      const list = await a.listBooks();
      t('github: listBooks', list.length === 1 && list[0].id === 'demo');
    } catch (e) { t('github: suite', false, e.message); }

    // S3 — mocked endpoint (also exercises real SigV4 signing in-page)
    try {
      const a = new (byName('S3Adapter'))();
      await a.configure({ endpoint: 's3.test.local', bucket: 'mybucket', region: 'us-east-1', prefix: 'books/', pathStyle: true, accessKey: 'AKID', secretKey: 'SECRET' });
      t('s3: isConfigured', a.isConfigured());
      const loaded = await a.loadBook('demo');
      t('s3: load (rev=etag)', loaded.data.title === 'Demo' && loaded.rev === 'etag-1', 'rev=' + loaded.rev);
      const r = await a.saveBook('demo', { title: 'D2' }, 'etag-1');
      t('s3: save with fresh etag', r.rev === 'etag-2', 'rev=' + r.rev);
      try { await a.saveBook('demo', { title: 'D3' }, 'stale-etag'); t('s3: stale etag conflicts', false); }
      catch (e) { t('s3: stale etag conflicts', e instanceof ConflictError, e.message.slice(0, 40)); }
      const created = await a.saveBook('newbook', { title: 'N' }, null);
      t('s3: create-only (If-None-Match)', created.rev === 'etag-new');
      const list = await a.listBooks();
      t('s3: listBooks parses XML', list.length === 1 && list[0].id === 'demo');
      await a.deleteBook('demo');
      t('s3: delete ok', true);
    } catch (e) { t('s3: suite', false, e.message); }

    // REST — mocked endpoint
    try {
      const a = new (byName('RestAdapter'))();
      await a.configure({ baseUrl: 'https://api.test.local/sb', apiKey: '' });
      t('rest: isConfigured', a.isConfigured());
      const loaded = await a.loadBook('demo');
      t('rest: load (rev=etag)', loaded.rev === 'r1');
      const r = await a.saveBook('demo', { title: 'D2' }, 'r1');
      t('rest: save with fresh etag', r.rev === 'r2');
      try { await a.saveBook('demo', { title: 'D3' }, 'stale'); t('rest: stale etag conflicts', false); }
      catch (e) { t('rest: stale etag conflicts', e instanceof ConflictError); }
      const list = await a.listBooks();
      t('rest: listBooks', list.length === 1 && list[0].id === 'demo');
    } catch (e) { t('rest: suite', false, e.message); }

    // LocalFile — interface only (pickers can't run headless)
    try {
      const a = new (byName('LocalFileAdapter'))();
      await a.configure();
      t('localfile: isConfigured', a.isConfigured());
      t('localfile: listBooks empty without directory', (await a.listBooks()).length === 0);
      t('localfile: load/save/delete methods exist',
        ['loadBook', 'saveBook', 'deleteBook'].every((m) => typeof a[m] === 'function'));
    } catch (e) { t('localfile: suite', false, e.message); }

    // Interface conformance for all adapters
    const methods = ['configure', 'isConfigured', 'listBooks', 'loadBook', 'saveBook', 'deleteBook', 'configFields'];
    for (const A of ADAPTERS) {
      const a = new A();
      t(`${a.id}: implements full contract`, methods.every((m) => typeof a[m] === 'function') && !!a.label && !!a.kind);
    }
    return R;
  });

  for (const r of out) check(r.name, r.ok, r.detail);
  check('no page errors during adapter runs', pageErrors.length === 0, pageErrors.join(' ;; '));
  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n==== RESULT: ${results.length - failed.length} passed, ${failed.length} failed ====`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('SCRIPT ERROR:', e.message); process.exit(1); });
