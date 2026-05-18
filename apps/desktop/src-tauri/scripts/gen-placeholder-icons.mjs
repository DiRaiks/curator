#!/usr/bin/env node
// Generates placeholder icon files for Tauri so a fresh checkout can run
// `tauri dev` without manually installing tooling.
//
// PNGs are real, valid 32x32 / 128x128 PNG files. The .icns and .ico files
// are placeholder copies of the 128x128 PNG — they let `tauri dev` start;
// for a real bundle (`tauri build`) you should regenerate icons with:
//   npx @tauri-apps/cli icon path/to/your/icon.png

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));
const iconDir = resolve(__dirname, "..", "icons");
mkdirSync(iconDir, { recursive: true });

// CRC-32 table (IEEE 802.3 polynomial 0xedb88320)
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const c = crc32(Buffer.concat([t, data]));
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(c, 0);
  return Buffer.concat([len, t, data, crc]);
}

function makePng(size, [r, g, b, a]) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA — Tauri requires 4 channels
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  // raw scanlines: 1 filter byte + 4*size pixel bytes per row
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    const off = y * (1 + size * 4);
    raw[off] = 0; // filter: None
    for (let x = 0; x < size; x++) {
      const o = off + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const idat = deflateSync(raw);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const color = [44, 90, 160, 255]; // a calm blue, fully opaque

const png32 = makePng(32, color);
const png128 = makePng(128, color);
const png256 = makePng(256, color);

writeFileSync(resolve(iconDir, "32x32.png"), png32);
writeFileSync(resolve(iconDir, "128x128.png"), png128);
writeFileSync(resolve(iconDir, "128x128@2x.png"), png256);
// Placeholder copies so Tauri's bundler doesn't error on missing files.
// These are NOT valid .icns/.ico — replace before shipping a real build.
writeFileSync(resolve(iconDir, "icon.icns"), png128);
writeFileSync(resolve(iconDir, "icon.ico"), png32);

console.log("Wrote placeholder icons to", iconDir);
