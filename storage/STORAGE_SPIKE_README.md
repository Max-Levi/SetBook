# SetBook storage-adapter spike

**Status:** prototype complete (2026-09-23) · **separate from `setbook_muse.html` by design** · merge plan deferred.

## What this proves

SetBook's songbook JSON can live wherever the user wants behind one interface,
without the app caring which backend is active:

| Backend | Kind | Revision source | Conflict detection | Verified |
|---|---|---|---|---|
| Local file | local | none | n/a (single device) | interface only — file pickers can't run headless |
| Browser (IndexedDB) | browser | incrementing counter | full, real round-trip | ✅ 12 checks, real IndexedDB |
| GitHub repo | cloud | blob sha | 422 on stale sha → `ConflictError` | ✅ mocked Contents API |
| S3 / S3-compatible | cloud | ETag | `If-None-Match: *` on create; HEAD-compare on update (best-effort, documented race) | ✅ mocked endpoint + real in-page SigV4 signing |
| Generic REST | cloud | ETag | `If-Match` → 412 → `ConflictError` | ✅ mocked endpoint |

## The interface

```js
configFields()                 // backend settings for a config UI
configure(opts)                // credentials live in memory only, never persisted
isConfigured() -> bool
listBooks() -> [{id, name, updatedAt}]
loadBook(id) -> {data, rev}    // rev is opaque per backend
saveBook(id, data, rev) -> {rev}   // rev=null means "create"; stale rev throws ConflictError
deleteBook(id)
```

`ConflictError` carries `currentRev` so the UI can offer "reload theirs / overwrite".

## Key findings

1. **One interface really does cover all five.** No backend details leak; the demo
   UI renders each backend's config form from `configFields()` alone.
2. **Conflict detection is feasible everywhere except local files.** GitHub's sha
   and REST's `If-Match` give true conditional writes. S3 standard buckets only
   support `If-None-Match: *` (create-only), so updates do a HEAD ETag compare
   first — a documented read-modify-write race, acceptable for songbooks, and
   worth one line in the future docs.
3. **Per-song JSON sharding is the right shape for cloud backends.** The interface
   is per-book; a "book" can be one song file. That shrinks the conflict surface
   to "same song edited on two devices at once".
4. **Credentials must stay bring-your-own and memory-only.** A static HTML file
   can't hold secrets; every cloud backend is configured by the user pasting
   their own token/keys, kept in JS memory, never written to disk by the app.
5. **SigV4 signing works in-browser** (WebCrypto, no dependency). Two independent
   implementations (JS/WebCrypto here, Python/hashlib in `tests/sigv4-ref.py`)
   produce identical signatures for the documented IAM example input, and the
   canonical request matches the documented format.
6. **Honest gap:** my recalled AWS published test vector for that example did not
   match either implementation, and there is no live AWS/MinIO here to arbitrate.
   The algorithm is a faithful transcription of the documented steps, but **live
   verification against real AWS with real credentials is a merge-phase
   acceptance test** — do not ship the S3 adapter without it.

## What's not in the spike

- No changes to `setbook_muse.html` (untouched).
- No credential persistence UX, no conflict-resolution UI, no per-song sharding
  migration — all merge-phase work.
- Local-file adapter's directory mode and the GitHub/S3 adapters against real
  services (need user credentials).

## Run it

```bash
# Demo UI (open in a browser; use your own credentials for cloud backends)
open spike-demo.html

# Adapter behavior tests (39 checks; needs the Playwright setup from setbook-qa)
NODE_PATH=~/workspace/setbook-qa/node_modules node tests/adapters-test.js

# SigV4 cross-implementation check
./tests/sigv4-crosscheck.sh
```

## Files

- `storage-adapters.js` — the interface + five adapters + `s3SignV4`
- `spike-demo.html` — minimal UI to exercise every adapter
- `tests/adapters-test.js` — Playwright verification (39 checks)
- `tests/sigv4-ref.py`, `tests/sigv4-crosscheck.sh` — SigV4 cross-check
