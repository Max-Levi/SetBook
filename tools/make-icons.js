'use strict';
/* One-off generator for SetBook's PWA icons: dependency-free PNG encoder
 * writing solid brand-green rounded squares at 192px and 512px.
 * Run:  node tools/make-icons.js
 * (Replace these placeholder marks with real artwork whenever available;
 * the app and manifest only need the files to exist at these paths.)
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf){
  let c, crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++){
    c = (crc ^ buf[i]) & 0xFF;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data){
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function makePng(size){
  const w = size, h = size, r = Math.round(size * 0.18);
  const bg = [27, 27, 30];      // --bg dark
  const fg = [163, 227, 178];   // --brand-green
  const raw = Buffer.alloc(h * (1 + w * 4));
  let off = 0;
  for (let y = 0; y < h; y++){
    raw[off++] = 0; // filter: none
    for (let x = 0; x < w; x++){
      const dx = Math.min(x, w - 1 - x), dy = Math.min(y, h - 1 - y);
      const inside = dx >= r || dy >= r || (dx * dx + dy * dy) <= r * r;
      const c = inside ? fg : bg;
      raw[off++] = c[0]; raw[off++] = c[1]; raw[off++] = c[2]; raw[off++] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [192, 512]){
  fs.writeFileSync(path.join(outDir, `icon-${size}.png`), makePng(size));
  console.log(`wrote icons/icon-${size}.png (${size}x${size})`);
}
