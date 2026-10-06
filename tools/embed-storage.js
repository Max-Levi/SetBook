#!/usr/bin/env node
/* Syncs storage/storage-adapters.js into index.html between the
 * __SETBOOK_STORAGE_BEGIN__ / __SETBOOK_STORAGE_END__ markers (the same
 * extraction discipline as the MCP core, reversed: the app embeds the
 * spike file verbatim). Idempotent: replaces an existing region, or
 * inserts one just before the serialization section on first run.
 *
 * The regression suite fails if the embedded region drifts from the
 * canonical storage/ copy — after editing storage-adapters.js, run:
 *
 *   node tools/embed-storage.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'storage', 'storage-adapters.js');
const APP = path.join(ROOT, 'index.html');

const BEGIN = '/*__SETBOOK_STORAGE_BEGIN__*/';
const END = '/*__SETBOOK_STORAGE_END__*/';
// Insertion anchor: the Phase-0 groundwork section (serializeState and
// friends) — the adapters belong beside the other persistence plumbing.
const ANCHOR = '/* ---------------------------------------------------------\n   Phase-0 groundwork: persistence seam, device persona, ad slots.';

const body = fs.readFileSync(SRC, 'utf8').replace(/\s+$/, '');
const region = `${BEGIN}\n${body}\n${END}`;

let html = fs.readFileSync(APP, 'utf8');
const beginIdx = html.indexOf(BEGIN);

if (beginIdx !== -1){
  const endIdx = html.indexOf(END, beginIdx);
  if (endIdx === -1){ console.error('BEGIN marker found but END marker missing'); process.exit(1); }
  html = html.slice(0, beginIdx) + region + html.slice(endIdx + END.length);
  console.log('embed-storage: replaced existing region in index.html');
} else {
  const anchorIdx = html.indexOf(ANCHOR);
  if (anchorIdx === -1){ console.error('No existing region and insertion anchor not found'); process.exit(1); }
  html = html.slice(0, anchorIdx) + region + '\n\n' + html.slice(anchorIdx);
  console.log('embed-storage: inserted storage-adapter region into index.html');
}

fs.writeFileSync(APP, html);
