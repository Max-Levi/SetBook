'use strict';
/* SetBook storage-adapter SPIKE — standalone prototype.
 *
 * Proves that SetBook songbook JSON can live wherever the user wants behind
 * one interface. Deliberately NOT wired into setbook_muse.html; a merge plan
 * comes after the spike reports back.
 *
 * Every adapter implements the same contract (all methods async):
 *
 *   id, label, kind            // kind: 'local' | 'browser' | 'cloud'
 *   configFields()             // [{key,label,type:'text'|'password'|'checkbox',secret?,placeholder?}]
 *   configure(opts)            // backend settings; credentials live in memory only
 *   isConfigured() -> bool
 *   listBooks() -> [{id, name, updatedAt}]
 *   loadBook(id) -> {data, rev}            // rev is opaque; see below
 *   saveBook(id, data, rev) -> {rev}       // rev=null means "create"; throws ConflictError
 *   deleteBook(id)
 *
 * `rev` (revision) is how adapters do conflict detection without leaking
 * backend details: GitHub maps it to the blob sha, S3/REST to the ETag,
 * IndexedDB to an incrementing counter, local files to null (no detection).
 * A stale rev on saveBook() must throw ConflictError carrying `currentRev`.
 *
 * Exposed as globalThis.SetBookStorage = { ConflictError, ADAPTERS, s3SignV4, ... }
 */

const SetBookStorage = (() => {

  class ConflictError extends Error {
    constructor(message, currentRev = null) {
      super(message);
      this.name = 'ConflictError';
      this.currentRev = currentRev;
    }
  }

  const b64encode = (str) => btoa(unescape(encodeURIComponent(str)));
  const b64decode = (b64) => decodeURIComponent(escape(atob(b64)));
  const stripQuotes = (s) => (s || '').replace(/^"|"$/g, '');

  /* ------------------------------------------------------------------ */
  /* Local file — mirrors SetBook's current behavior                     */
  /* ------------------------------------------------------------------ */
  class LocalFileAdapter {
    constructor() {
      this.id = 'local-file';
      this.label = 'Local file';
      this.kind = 'local';
      this._dirHandle = null;
    }
    configFields() { return []; }
    async configure() { this._dirHandle = null; }
    isConfigured() { return true; }

    async listBooks() {
      if (!this._dirHandle) return [];
      const out = [];
      for await (const entry of this._dirHandle.values()) {
        if (entry.kind === 'file' && entry.name.endsWith('.json')) {
          const f = await entry.getFile();
          out.push({ id: entry.name.slice(0, -5), name: entry.name.slice(0, -5), updatedAt: new Date(f.lastModified).toISOString() });
        }
      }
      return out;
    }

    async _pickFile() {
      if (window.showOpenFilePicker) {
        const [h] = await window.showOpenFilePicker({
          types: [{ description: 'Songbook JSON', accept: { 'application/json': ['.json'] } }],
          multiple: false,
        });
        return h;
      }
      // Fallback: hidden <input type=file>
      return new Promise((resolve, reject) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.onchange = () => input.files[0] ? resolve(input.files[0]) : reject(new Error('No file chosen'));
        input.click();
      });
    }

    async loadBook() {
      const picked = await this._pickFile();
      const text = picked.getFile ? await (await picked.getFile()).text() : await picked.text();
      return { data: JSON.parse(text), rev: null }; // local files: no revision concept
    }

    async saveBook(id, data) {
      const text = JSON.stringify(data, null, 2);
      if (window.showSaveFilePicker) {
        const handle = await window.showSaveFilePicker({
          suggestedName: `${id}.json`,
          types: [{ description: 'Songbook JSON', accept: { 'application/json': ['.json'] } }],
        });
        const w = await handle.createWritable();
        await w.write(text);
        await w.close();
        return { rev: null };
      }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      a.download = `${id}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      return { rev: null };
    }

    async deleteBook() {
      throw new Error('Local-file delete needs a chosen directory (not in spike scope).');
    }
  }

  /* ------------------------------------------------------------------ */
  /* IndexedDB — zero-config persistent browser storage                  */
  /* ------------------------------------------------------------------ */
  class IndexedDBAdapter {
    constructor(dbName = 'setbook-spike') {
      this.id = 'indexeddb';
      this.label = 'Browser storage (IndexedDB)';
      this.kind = 'browser';
      this._dbName = dbName;
      this._db = null;
    }
    configFields() { return []; }
    async configure() { /* nothing to configure */ }
    isConfigured() { return true; }

    _open() {
      if (this._db) return Promise.resolve(this._db);
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(this._dbName, 1);
        req.onupgradeneeded = () => req.result.createObjectStore('books', { keyPath: 'id' });
        req.onsuccess = () => { this._db = req.result; resolve(this._db); };
        req.onerror = () => reject(req.error);
      });
    }
    _tx(mode, fn) {
      return this._open().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction('books', mode);
        const req = fn(tx.objectStore('books'));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }));
    }

    async listBooks() {
      const all = await this._tx('readonly', (s) => s.getAll());
      return all.map((r) => ({ id: r.id, name: r.name, updatedAt: r.updatedAt }));
    }
    async loadBook(id) {
      const rec = await this._tx('readonly', (s) => s.get(id));
      if (!rec) throw new Error(`Book "${id}" not found in browser storage.`);
      return { data: rec.data, rev: rec.rev };
    }
    async saveBook(id, data, rev = null) {
      const existing = await this._tx('readonly', (s) => s.get(id));
      if (rev === null) {
        if (existing) throw new ConflictError(`Book "${id}" already exists.`, existing.rev);
      } else if (!existing || existing.rev !== rev) {
        throw new ConflictError(`Book "${id}" changed elsewhere.`, existing ? existing.rev : null);
      }
      const nextRev = (existing ? existing.rev : 0) + 1;
      const name = (data && data.name) || id;
      await this._tx('readwrite', (s) => s.put({
        id, name, data, rev: nextRev, updatedAt: new Date().toISOString(),
      }));
      return { rev: nextRev };
    }
    async deleteBook(id) {
      await this._tx('readwrite', (s) => s.delete(id));
    }
  }

  /* ------------------------------------------------------------------ */
  /* GitHub repo — versioned JSON via the Contents API                   */
  /* ------------------------------------------------------------------ */
  class GitHubAdapter {
    constructor() {
      this.id = 'github';
      this.label = 'GitHub repo';
      this.kind = 'cloud';
      this._cfg = null;
    }
    configFields() {
      return [
        { key: 'owner', label: 'Owner', type: 'text', placeholder: 'octocat' },
        { key: 'repo', label: 'Repository', type: 'text', placeholder: 'songbooks' },
        { key: 'path', label: 'Folder in repo', type: 'text', placeholder: 'books/' },
        { key: 'branch', label: 'Branch', type: 'text', placeholder: 'main' },
        { key: 'token', label: 'Token (fine-grained PAT, contents: read+write)', type: 'password', secret: true },
      ];
    }
    async configure(opts) {
      this._cfg = {
        owner: (opts.owner || '').trim(),
        repo: (opts.repo || '').trim(),
        path: (opts.path || '').replace(/^\//, '').replace(/\/?$/, '/'),
        branch: (opts.branch || 'main').trim(),
        token: opts.token || '',
      };
    }
    isConfigured() {
      return !!(this._cfg && this._cfg.owner && this._cfg.repo && this._cfg.token);
    }
    _headers() {
      return {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${this._cfg.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      };
    }
    _filePath(id) { return `${this._cfg.path}${id}.json`; }
    async _api(method, apiPath, body) {
      const res = await fetch(`https://api.github.com/repos/${this._cfg.owner}/${this._cfg.repo}/contents/${apiPath}`, {
        method,
        headers: this._headers(),
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json().catch(() => ({}));
      return { res, json };
    }

    async listBooks() {
      const { res, json } = await this._api('GET', `${this._cfg.path}?ref=${encodeURIComponent(this._cfg.branch)}`);
      if (res.status === 404) return [];
      if (!res.ok) throw new Error(`GitHub list failed: ${res.status} ${json.message || ''}`);
      const items = Array.isArray(json) ? json : [];
      return items
        .filter((it) => it.type === 'file' && it.name.endsWith('.json'))
        .map((it) => ({ id: it.name.slice(0, -5), name: it.name.slice(0, -5), updatedAt: null }));
    }
    async loadBook(id) {
      const { res, json } = await this._api('GET', `${this._filePath(id)}?ref=${encodeURIComponent(this._cfg.branch)}`);
      if (res.status === 404) throw new Error(`Book "${id}" not found in repo.`);
      if (!res.ok) throw new Error(`GitHub load failed: ${res.status} ${json.message || ''}`);
      return { data: JSON.parse(b64decode(json.content.replace(/\n/g, ''))), rev: json.sha };
    }
    async saveBook(id, data, rev = null) {
      const body = {
        message: `SetBook: save ${id}.json`,
        content: b64encode(JSON.stringify(data, null, 2)),
        branch: this._cfg.branch,
      };
      if (rev !== null) body.sha = rev; // stale sha -> 422 -> ConflictError
      const { res, json } = await this._api('PUT', this._filePath(id), body);
      if (res.status === 422) {
        const current = await this.loadBook(id).catch(() => null);
        throw new ConflictError(
          `Book "${id}" changed in the repo since you loaded it.`, current ? current.rev : null);
      }
      if (!res.ok) throw new Error(`GitHub save failed: ${res.status} ${json.message || ''}`);
      return { rev: json.content.sha };
    }
    async deleteBook(id) {
      const current = await this.loadBook(id);
      const { res, json } = await this._api('DELETE', this._filePath(id), {
        message: `SetBook: delete ${id}.json`, sha: current.rev, branch: this._cfg.branch,
      });
      if (!res.ok) throw new Error(`GitHub delete failed: ${res.status} ${json.message || ''}`);
    }
  }

  /* ------------------------------------------------------------------ */
  /* AWS Signature V4 (shared helper, exposed for testing)               */
  /* ------------------------------------------------------------------ */
  const _te = new TextEncoder();
  const _bytes = (s) => (typeof s === 'string' ? _te.encode(s) : s);
  const _hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

  async function _sha256Hex(data) {
    return _hex(await crypto.subtle.digest('SHA-256', _bytes(data)));
  }
  async function _hmac(key, data) {
    const ck = await crypto.subtle.importKey('raw', _bytes(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', ck, _bytes(data)));
  }

  // Returns { authorization, amzDate, payloadHash }. amzDate overridable for tests.
  async function s3SignV4({ method, url, headers = {}, payload = '', accessKey, secretKey, region, service, amzDate }) {
    const u = new URL(url);
    const now = amzDate || new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = now.slice(0, 8);
    const payloadHash = await _sha256Hex(payload);
    const hdrs = {};
    for (const [k, v] of Object.entries(headers)) hdrs[k.toLowerCase()] = String(v).trim();
    hdrs['host'] = u.host;
    hdrs['x-amz-date'] = now;
    const signedNames = Object.keys(hdrs).sort();
    const canonicalHeaders = signedNames.map((n) => `${n}:${hdrs[n]}\n`).join('');
    const query = [...u.searchParams.entries()]
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .sort().join('&');
    const canonicalRequest = [
      method.toUpperCase(), u.pathname, query,
      canonicalHeaders, signedNames.join(';'), payloadHash,
    ].join('\n');
    const scope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', now, scope, await _sha256Hex(canonicalRequest)].join('\n');
    const kDate = await _hmac('AWS4' + secretKey, dateStamp);
    const kRegion = await _hmac(kDate, region);
    const kService = await _hmac(kRegion, service);
    const kSigning = await _hmac(kService, 'aws4_request');
    const signature = _hex(await _hmac(kSigning, stringToSign));
    return {
      authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedNames.join(';')}, Signature=${signature}`,
      amzDate: now,
      payloadHash,
      signedHeaders: { ...hdrs, authorization: undefined },
    };
  }

  /* ------------------------------------------------------------------ */
  /* S3 / S3-compatible — one JSON object per book                       */
  /* ------------------------------------------------------------------ */
  class S3Adapter {
    constructor() {
      this.id = 's3';
      this.label = 'S3 bucket (or S3-compatible)';
      this.kind = 'cloud';
      this._cfg = null;
    }
    configFields() {
      return [
        { key: 'endpoint', label: 'Endpoint', type: 'text', placeholder: 's3.us-east-1.amazonaws.com' },
        { key: 'bucket', label: 'Bucket', type: 'text', placeholder: 'my-songbooks' },
        { key: 'region', label: 'Region', type: 'text', placeholder: 'us-east-1' },
        { key: 'prefix', label: 'Key prefix', type: 'text', placeholder: 'books/' },
        { key: 'pathStyle', label: 'Use path-style URLs (MinIO etc.)', type: 'checkbox' },
        { key: 'accessKey', label: 'Access key ID', type: 'text' },
        { key: 'secretKey', label: 'Secret access key', type: 'password', secret: true },
      ];
    }
    async configure(opts) {
      this._cfg = {
        endpoint: (opts.endpoint || '').trim().replace(/^https?:\/\//, ''),
        bucket: (opts.bucket || '').trim(),
        region: (opts.region || 'us-east-1').trim(),
        prefix: (opts.prefix || '').replace(/^\//, '').replace(/\/?$/, '/'),
        pathStyle: !!opts.pathStyle,
        accessKey: opts.accessKey || '',
        secretKey: opts.secretKey || '',
      };
    }
    isConfigured() {
      return !!(this._cfg && this._cfg.endpoint && this._cfg.bucket && this._cfg.accessKey && this._cfg.secretKey);
    }
    _key(id) { return `${this._cfg.prefix}${id}.json`; }
    _url(key, query = '') {
      const { endpoint, bucket, pathStyle } = this._cfg;
      const base = pathStyle
        ? `https://${endpoint}/${bucket}/${key}`
        : `https://${bucket}.${endpoint}/${key}`;
      return base + query;
    }
    async _signed(method, url, body = '') {
      const { accessKey, secretKey, region } = this._cfg;
      const { authorization, amzDate, payloadHash } = await s3SignV4({
        method, url, payload: body, accessKey, secretKey, region, service: 's3',
      });
      return {
        'Authorization': authorization,
        'x-amz-date': amzDate,
        'x-amz-content-sha256': payloadHash,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      };
    }

    async listBooks() {
      // ListObjectsV2 against the bucket root.
      const { bucket, pathStyle, endpoint } = this._cfg;
      const base = pathStyle ? `https://${endpoint}/${bucket}/` : `https://${bucket}.${endpoint}/`;
      const url = `${base}?list-type=2&prefix=${encodeURIComponent(this._cfg.prefix)}`;
      const headers = await this._signed('GET', url);
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`S3 list failed: ${res.status}`);
      const xml = await res.text();
      const out = [];
      for (const m of xml.matchAll(/<Key>(.*?)<\/Key>/g)) {
        const key = m[1];
        if (key.startsWith(this._cfg.prefix) && key.endsWith('.json')) {
          const id = key.slice(this._cfg.prefix.length, -5);
          out.push({ id, name: id, updatedAt: null });
        }
      }
      return out;
    }
    async loadBook(id) {
      const url = this._url(this._key(id));
      const headers = await this._signed('GET', url);
      const res = await fetch(url, { headers });
      if (res.status === 404 || res.status === 403) throw new Error(`Book "${id}" not found in bucket.`);
      if (!res.ok) throw new Error(`S3 load failed: ${res.status}`);
      return { data: await res.json(), rev: stripQuotes(res.headers.get('ETag')) };
    }
    async saveBook(id, data, rev = null) {
      const body = JSON.stringify(data, null, 2);
      const url = this._url(this._key(id));
      if (rev === null) {
        // Create-only: fail if the key already exists (S3 conditional write).
        const headers = await this._signed('PUT', url, body);
        headers['If-None-Match'] = '*';
        const res = await fetch(url, { method: 'PUT', headers, body });
        if (res.status === 412) throw new ConflictError(`Book "${id}" already exists in the bucket.`);
        if (!res.ok) throw new Error(`S3 save failed: ${res.status}`);
        return { rev: stripQuotes(res.headers.get('ETag')) };
      }
      // Update: best-effort conflict check — S3 has no ETag-conditional write
      // on standard buckets, so compare via HEAD first (documented race).
      const headHeaders = await this._signed('HEAD', url);
      const head = await fetch(url, { method: 'HEAD', headers: headHeaders });
      const current = head.ok ? stripQuotes(head.headers.get('ETag')) : null;
      if (current !== rev) throw new ConflictError(`Book "${id}" changed in the bucket since you loaded it.`, current);
      const headers = await this._signed('PUT', url, body);
      const res = await fetch(url, { method: 'PUT', headers, body });
      if (!res.ok) throw new Error(`S3 save failed: ${res.status}`);
      return { rev: stripQuotes(res.headers.get('ETag')) };
    }
    async deleteBook(id) {
      const url = this._url(this._key(id));
      const headers = await this._signed('DELETE', url);
      const res = await fetch(url, { method: 'DELETE', headers });
      if (!res.ok && res.status !== 404) throw new Error(`S3 delete failed: ${res.status}`);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Generic REST — user-provided endpoint following a tiny convention    */
  /* ------------------------------------------------------------------ */
  class RestAdapter {
    constructor() {
      this.id = 'rest';
      this.label = 'Generic REST endpoint';
      this.kind = 'cloud';
      this._cfg = null;
    }
    configFields() {
      return [
        { key: 'baseUrl', label: 'Base URL', type: 'text', placeholder: 'https://api.example.com/songbooks' },
        { key: 'apiKey', label: 'API key (sent as Bearer, optional)', type: 'password', secret: true },
      ];
    }
    async configure(opts) {
      this._cfg = { baseUrl: (opts.baseUrl || '').trim().replace(/\/$/, ''), apiKey: opts.apiKey || '' };
    }
    isConfigured() { return !!(this._cfg && this._cfg.baseUrl); }
    _headers(extra = {}) {
      return {
        'Content-Type': 'application/json',
        ...(this._cfg.apiKey ? { 'Authorization': `Bearer ${this._cfg.apiKey}` } : {}),
        ...extra,
      };
    }
    // Convention: GET {base}/index.json -> [{id,name,updatedAt}]
    //            GET|PUT|DELETE {base}/{id}.json, revisions via ETag / If-Match
    async listBooks() {
      const res = await fetch(`${this._cfg.baseUrl}/index.json`, { headers: this._headers() });
      if (res.status === 404) return [];
      if (!res.ok) throw new Error(`REST list failed: ${res.status}`);
      return res.json();
    }
    async loadBook(id) {
      const res = await fetch(`${this._cfg.baseUrl}/${encodeURIComponent(id)}.json`, { headers: this._headers() });
      if (res.status === 404) throw new Error(`Book "${id}" not found.`);
      if (!res.ok) throw new Error(`REST load failed: ${res.status}`);
      return { data: await res.json(), rev: stripQuotes(res.headers.get('ETag')) };
    }
    async saveBook(id, data, rev = null) {
      const headers = this._headers(rev !== null ? { 'If-Match': rev } : {});
      const res = await fetch(`${this._cfg.baseUrl}/${encodeURIComponent(id)}.json`, {
        method: 'PUT', headers, body: JSON.stringify(data, null, 2),
      });
      if (res.status === 412) {
        const current = await this.loadBook(id).catch(() => null);
        throw new ConflictError(`Book "${id}" changed on the server since you loaded it.`, current ? current.rev : null);
      }
      if (!res.ok) throw new Error(`REST save failed: ${res.status}`);
      return { rev: stripQuotes(res.headers.get('ETag')) };
    }
    async deleteBook(id) {
      const res = await fetch(`${this._cfg.baseUrl}/${encodeURIComponent(id)}.json`, {
        method: 'DELETE', headers: this._headers(),
      });
      if (!res.ok && res.status !== 404) throw new Error(`REST delete failed: ${res.status}`);
    }
  }

  const ADAPTERS = [LocalFileAdapter, IndexedDBAdapter, GitHubAdapter, S3Adapter, RestAdapter];

  return { ConflictError, ADAPTERS, s3SignV4, LocalFileAdapter, IndexedDBAdapter, GitHubAdapter, S3Adapter, RestAdapter };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SetBookStorage;
if (typeof globalThis !== 'undefined') globalThis.SetBookStorage = SetBookStorage;
