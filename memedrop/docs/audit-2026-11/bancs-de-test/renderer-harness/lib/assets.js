'use strict';
// Deterministic test media, generated in Node (PNG, GIF, WAV) or in a helper
// page (WebM via canvas.captureStream + MediaRecorder). Every byte of the
// Node-generated assets is a pure function of the parameters, so data: URLs
// are identical from one run to the next.

const zlib = require('zlib');

// ── PNG ──────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
// pixel(x, y) -> [r, g, b]
function encodePng(w, h, pixel) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const [r, g, b] = pixel(x, y);
      raw[o++] = r; raw[o++] = g; raw[o++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
function memePattern(w, h, hue) {
  return (x, y) => {
    const stripe = ((x >> 4) + (y >> 4)) & 1;
    const r = Math.round((x / w) * 200 + 30 + (stripe ? 25 : 0));
    const g = Math.round((y / h) * 160 + 40);
    const b = (hue + (stripe ? 60 : 0)) & 0xFF;
    return [r & 0xFF, g & 0xFF, b];
  };
}

// ── GIF (animated, 4-colour, "uncompressed" LZW) ────────────────────────
// Every 2 pixels a CLEAR code is emitted so the code size stays at 3 bits —
// valid LZW that any decoder accepts, no dictionary logic needed.
function encodeGif(w, h, frames /* [{ pixel(x,y)->0..3, delayCs }] */, palette) {
  const out = [];
  const u16 = (v) => [v & 0xFF, (v >> 8) & 0xFF];
  out.push(...Buffer.from('GIF89a', 'ascii'));
  out.push(...u16(w), ...u16(h), 0xF1 /* GCT, 2 bits/colour */, 0, 0);
  for (const [r, g, b] of palette) out.push(r, g, b);
  // NETSCAPE2.0 infinite loop
  out.push(0x21, 0xFF, 0x0B, ...Buffer.from('NETSCAPE2.0', 'ascii'), 0x03, 0x01, 0x00, 0x00, 0x00);
  for (const fr of frames) {
    out.push(0x21, 0xF9, 0x04, 0x00, ...u16(fr.delayCs), 0x00, 0x00);
    out.push(0x2C, 0, 0, 0, 0, ...u16(w), ...u16(h), 0x00);
    const MIN = 2, CLEAR = 4, EOI = 5;
    out.push(MIN);
    // bit packer, 3-bit codes
    const bytes = [];
    let acc = 0, nbits = 0;
    const emit = (code) => {
      acc |= code << nbits; nbits += 3;
      while (nbits >= 8) { bytes.push(acc & 0xFF); acc >>= 8; nbits -= 8; }
    };
    let n = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (n % 2 === 0) emit(CLEAR);
        emit(fr.pixel(x, y) & 3);
        n++;
      }
    }
    emit(EOI);
    if (nbits > 0) bytes.push(acc & 0xFF);
    for (let i = 0; i < bytes.length; i += 255) {
      const chunk = bytes.slice(i, i + 255);
      out.push(chunk.length, ...chunk);
    }
    out.push(0x00);
  }
  out.push(0x3B);
  return Buffer.from(out);
}

// ── WAV (PCM 16-bit mono) ───────────────────────────────────────────────
function encodeWav(seconds, freq, sampleRate = 8000) {
  const n = Math.round(seconds * sampleRate);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'ascii'); buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8, 'ascii'); buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii'); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.sin((i / sampleRate) * 2 * Math.PI * freq) * 6000), 44 + i * 2);
  }
  return buf;
}

// ── WebM duration patch ─────────────────────────────────────────────────
// MediaRecorder writes live WebM files without a Duration element, so
// <video>.duration is Infinity at 'loadedmetadata'. Inserting Segment/Info/
// Duration gives a regular file (like the MP4/WebM files sent through
// Discord) whose duration is known as soon as the metadata is loaded.
function readVint(buf, pos, keepMarker) {
  const first = buf[pos];
  let len = 1, mask = 0x80;
  while (len <= 8 && !(first & mask)) { len++; mask >>= 1; }
  let val = keepMarker ? first : (first & (mask - 1));
  for (let i = 1; i < len; i++) val = val * 256 + buf[pos + i];
  return { len, val };
}
function patchWebmDuration(input, durationMs) {
  const buf = Buffer.from(input);
  // EBML header
  let pos = 0;
  const hid = readVint(buf, pos, true); const hsz = readVint(buf, pos + hid.len, false);
  pos += hid.len + hsz.len + hsz.val;
  // Segment
  const sid = readVint(buf, pos, true);
  if (sid.val !== 0x18538067) throw new Error('no Segment');
  const ssz = readVint(buf, pos + sid.len, false);
  let p = pos + sid.len + ssz.len;
  while (p < buf.length) {
    const id = readVint(buf, p, true); const sz = readVint(buf, p + id.len, false);
    const dataStart = p + id.len + sz.len;
    if (id.val === 0x1549A966) { // Info
      const children = buf.subarray(dataStart, dataStart + sz.val);
      // already has a Duration? (0x4489)
      for (let q = 0; q < children.length;) {
        const cid = readVint(children, q, true); const csz = readVint(children, q + cid.len, false);
        if (cid.val === 0x4489) throw new Error('Duration already present');
        q += cid.len + csz.len + csz.val;
      }
      const dur = Buffer.alloc(11);
      dur[0] = 0x44; dur[1] = 0x89; dur[2] = 0x88; dur.writeDoubleBE(durationMs, 3);
      const newSize = children.length + dur.length;
      // 8-byte size vint: always valid whatever the size
      const szBytes = Buffer.alloc(8); szBytes[0] = 0x01;
      let v = newSize;
      for (let i = 7; i >= 1; i--) { szBytes[i] = v & 0xFF; v = Math.floor(v / 256); }
      return Buffer.concat([
        buf.subarray(0, p),
        buf.subarray(p, p + id.len),
        szBytes,
        children,
        dur,
        buf.subarray(dataStart + sz.val),
      ]);
    }
    if (sz.val === 0 || dataStart + sz.val > buf.length) break;
    p = dataStart + sz.val;
  }
  throw new Error('no Info element');
}

// Records several WebM clips at once (one canvas stream, one MediaRecorder per
// clip, stopped at different times) inside a helper page. Returns
// { [name]: Buffer }. `page` must be a loaded page (any origin).
async function recordWebmClips(page, clips /* [{name, ms}] */) {
  const res = await page.evaluate(async (clips) => {
    const c = document.createElement('canvas');
    c.width = 320; c.height = 240;
    const g = c.getContext('2d');
    const stream = c.captureStream(30);
    let frame = 0;
    const draw = () => {
      g.fillStyle = `hsl(${(frame * 9) % 360}, 75%, 45%)`;
      g.fillRect(0, 0, 320, 240);
      g.fillStyle = '#fff';
      g.fillRect((frame * 6) % 300, 110, 20, 20);
      frame++;
    };
    draw();
    const iv = setInterval(draw, 33);
    const done = clips.map((clip) => new Promise((resolve) => {
      const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = async () => {
        const u8 = new Uint8Array(await new Blob(chunks).arrayBuffer());
        let s = '';
        for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
        resolve([clip.name, btoa(s)]);
      };
      rec.start(100);
      setTimeout(() => rec.stop(), clip.ms);
    }));
    const out = await Promise.all(done);
    clearInterval(iv);
    return out;
  }, clips);
  const map = {};
  for (const [name, b64] of res) map[name] = Buffer.from(b64, 'base64');
  return map;
}

function dataUrl(mime, buf) {
  return `data:${mime};base64,${buf.toString('base64')}`;
}

// Static assets (Node-generated). Labels are what the transcripts show
// instead of the (long) URLs.
function buildStaticAssets() {
  const pal = [[255, 94, 138], [255, 180, 94], [40, 30, 60], [250, 250, 250]];
  const gif = encodeGif(240, 180, [
    { delayCs: 20, pixel: (x, y) => (((x >> 3) + (y >> 3)) & 1) ? 0 : 2 },
    { delayCs: 20, pixel: (x, y) => (((x >> 3) + (y >> 3)) & 1) ? 1 : 3 },
  ], pal);
  return {
    png400x300: dataUrl('image/png', encodePng(400, 300, memePattern(400, 300, 120))),
    png200x500: dataUrl('image/png', encodePng(200, 500, memePattern(200, 500, 30))),
    png1200x900: dataUrl('image/png', encodePng(1200, 900, memePattern(1200, 900, 200))),
    png100x80: dataUrl('image/png', encodePng(100, 80, memePattern(100, 80, 80))),
    avatar64: dataUrl('image/png', encodePng(64, 64, memePattern(64, 64, 10))),
    gif240x180: dataUrl('image/gif', gif),
    // WAV bytes (turned into blob: URLs inside each page)
    wavShort: encodeWav(0.5, 440),
    wavMid: encodeWav(1.5, 392),
    wavLong: encodeWav(6, 330),
    wavMusic: encodeWav(6, 523),
  };
}

module.exports = {
  encodePng, encodeGif, encodeWav, patchWebmDuration, recordWebmClips, buildStaticAssets, dataUrl,
};
