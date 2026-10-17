/* core.js — Animation Atelier pure logic (no DOM): frame list operations, playback order, onion-skin selection,
 * sprite-sheet layout, a tiny store-only ZIP writer (CRC-32 written from scratch) and project JSON (de)serialisation.
 * Works in the browser (window.AnimCore) and in Node (module.exports) so it can be unit-tested. Original code, MIT. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AnimCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const APP_ID = 'animation-atelier';
  const VERSION = 1;
  /** Canvas size presets: key → [width, height]. 2.39:1 is rounded to an even height. */
  const PRESETS = { '16:9': [1280, 720], '1:1': [1080, 1080], '9:16': [720, 1280], '2.39:1': [1280, 536] };
  const FPS_MIN = 1, FPS_MAX = 30;
  const MAX_SIDE = 4096;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const toInt = (v, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : d; };
  const clampFps = (v) => clamp(toInt(v, 12), FPS_MIN, FPS_MAX);
  const isHexColor = (s) => typeof s === 'string' && /^#[0-9a-f]{6}$/i.test(s);
  const isImageDataURL = (s) => typeof s === 'string' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]*$/.test(s);

  /* ---------- frame list operations (immutable: always return a new array + the new current index) ---------- */

  /** Insert `item` right after `index` (index -1 inserts at the start). */
  function insertAfter(list, index, item) {
    const a = list.slice();
    const at = clamp(index + 1, 0, a.length);
    a.splice(at, 0, item);
    return { list: a, index: at };
  }
  /** Duplicate the frame at `index` using `cloneFn(frame)`; the copy is placed right after and becomes current. */
  function duplicateAt(list, index, cloneFn) {
    if (!list.length) return { list: [], index: 0 };
    const i = clamp(index, 0, list.length - 1);
    return insertAfter(list, i, cloneFn(list[i]));
  }
  /** Remove the frame at `index`. The last remaining frame is never removed (an animation always has one frame). */
  function removeAt(list, index) {
    if (list.length <= 1) return { list: list.slice(), index: 0, removed: null };
    const a = list.slice();
    const i = clamp(index, 0, a.length - 1);
    const removed = a.splice(i, 1)[0];
    return { list: a, index: Math.min(i, a.length - 1), removed };
  }
  /** Move the frame at `index` by `delta` positions (−1 = left, +1 = right), clamped to the list bounds. */
  function moveFrame(list, index, delta) {
    const a = list.slice();
    if (!a.length) return { list: a, index: 0 };
    const from = clamp(index, 0, a.length - 1);
    const to = clamp(from + delta, 0, a.length - 1);
    const [f] = a.splice(from, 1);
    a.splice(to, 0, f);
    return { list: a, index: to };
  }

  /* ---------- playback ---------- */

  /**
   * Next frame for playback. `dir` is +1 / −1 (only used by ping-pong).
   * Returns { index, dir, stop } — stop is true when a non-looping animation reached its end.
   */
  function nextIndex(i, n, dir, opts) {
    const loop = !opts || opts.loop !== false;
    const ping = !!(opts && opts.pingpong);
    if (n <= 1) return { index: 0, dir: 1, stop: !loop };
    if (!ping) {
      if (i + 1 < n) return { index: i + 1, dir: 1, stop: false };
      return loop ? { index: 0, dir: 1, stop: false } : { index: n - 1, dir: 1, stop: true };
    }
    let d = dir < 0 ? -1 : 1;
    let j = i + d;
    if (j >= n) { d = -1; j = n - 2; }
    if (j < 0) {
      if (!loop) return { index: 0, dir: -1, stop: true };
      d = 1; j = 1;
    }
    return { index: j, dir: d, stop: false };
  }
  /** Frame order of one full playback pass (used by the video export). */
  function playOrder(n, pingpong) {
    const order = [];
    for (let i = 0; i < n; i++) order.push(i);
    if (pingpong) for (let i = n - 2; i > 0; i--) order.push(i);
    return order;
  }

  /* ---------- onion skin ---------- */

  /**
   * Frames to show as onion skin around `i`: up to `before` previous and `after` next frames
   * (wrapping around when `wrap` is true). Sorted farthest first, so nearer ghosts are painted on top.
   * Each entry: { index, offset } where offset < 0 for previous frames.
   */
  function onionFrames(i, n, before, after, wrap) {
    const out = [];
    const add = (off) => {
      let j = i + off;
      if (wrap) j = ((j % n) + n) % n;
      if (j < 0 || j >= n || j === i) return;
      if (out.some((o) => o.index === j)) return;
      out.push({ index: j, offset: off });
    };
    for (let k = 1; k <= before; k++) add(-k);
    for (let k = 1; k <= after; k++) add(k);
    return out.sort((a, b) => Math.abs(b.offset) - Math.abs(a.offset));
  }
  /** Opacity of an onion ghost: full `base` for the nearest frame, fading linearly with distance. */
  function onionAlpha(offset, count, base) {
    const d = Math.abs(offset);
    if (!d || d > count) return 0;
    return base * (1 - (d - 1) / Math.max(1, count));
  }

  /* ---------- sprite sheet ---------- */

  /**
   * Grid layout for `n` cells of w×h. Roughly square grid; the sheet is scaled down so no side exceeds `maxSide`.
   * Returns { cols, rows, cellW, cellH, width, height, scale, pos(i) → {x, y} }.
   */
  function spriteLayout(n, w, h, maxSide) {
    const lim = maxSide || 8192;
    const count = Math.max(1, n);
    const cols = Math.min(count, Math.max(1, Math.ceil(Math.sqrt(count * h / w))));
    const rows = Math.ceil(count / cols);
    const scale = Math.min(1, lim / (cols * w), lim / (rows * h));
    const cellW = Math.max(1, Math.floor(w * scale)), cellH = Math.max(1, Math.floor(h * scale));
    return {
      cols, rows, cellW, cellH, scale, width: cols * cellW, height: rows * cellH,
      pos: (i) => ({ x: (i % cols) * cellW, y: Math.floor(i / cols) * cellH }),
    };
  }

  /* ---------- ZIP writer (store / no compression) ---------- */

  let CRC_TABLE = null;
  /** Standard CRC-32 (IEEE 802.3, reflected polynomial 0xEDB88320). */
  function crc32(bytes) {
    if (!CRC_TABLE) {
      CRC_TABLE = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        CRC_TABLE[n] = c >>> 0;
      }
    }
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }
  const utf8 = (s) => (typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s) : Uint8Array.from(Buffer.from(s, 'utf8')));
  /** MS-DOS time/date words for a JS Date (ZIP stores local time with 2-second precision). */
  function dosDateTime(d) {
    const year = Math.max(1980, d.getFullYear());
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
  }
  /**
   * Build a ZIP archive with every file stored uncompressed (method 0).
   * files: [{ name: string, data: Uint8Array }]. Returns a Uint8Array.
   */
  function zipStore(files, date) {
    const { time, date: day } = dosDateTime(date || new Date());
    const locals = [], centrals = [];
    let offset = 0;
    for (const f of files) {
      const name = utf8(f.name), data = f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data);
      const crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);   // local file header signature
      lh.setUint16(4, 20, true);           // version needed (2.0)
      lh.setUint16(6, 0x0800, true);       // flags: UTF-8 names
      lh.setUint16(8, 0, true);            // method: store
      lh.setUint16(10, time, true);
      lh.setUint16(12, day, true);
      lh.setUint32(14, crc, true);
      lh.setUint32(18, data.length, true); // compressed size
      lh.setUint32(22, data.length, true); // uncompressed size
      lh.setUint16(26, name.length, true);
      lh.setUint16(28, 0, true);           // extra length
      locals.push(new Uint8Array(lh.buffer), name, data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true);   // central directory signature
      ch.setUint16(4, 20, true);           // version made by
      ch.setUint16(6, 20, true);           // version needed
      ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true);
      ch.setUint16(12, time, true);
      ch.setUint16(14, day, true);
      ch.setUint32(16, crc, true);
      ch.setUint32(20, data.length, true);
      ch.setUint32(24, data.length, true);
      ch.setUint16(28, name.length, true);
      // extra, comment, disk number, internal attrs = 0
      ch.setUint32(38, 0, true);           // external attrs
      ch.setUint32(42, offset, true);      // local header offset
      centrals.push(new Uint8Array(ch.buffer), name);
      offset += 30 + name.length + data.length;
    }
    const cdSize = centrals.reduce((s, b) => s + b.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);    // end of central directory signature
    end.setUint16(8, files.length, true);  // entries on this disk
    end.setUint16(10, files.length, true); // total entries
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);       // central directory offset
    const parts = locals.concat(centrals, [new Uint8Array(end.buffer)]);
    const out = new Uint8Array(parts.reduce((s, b) => s + b.length, 0));
    let p = 0;
    for (const b of parts) { out.set(b, p); p += b.length; }
    return out;
  }
  /** Zero-padded file name for frame i (0-based) of n: frame_0001.png … */
  function frameName(i, n, prefix) {
    const digits = Math.max(4, String(n).length);
    return (prefix || 'frame') + '_' + String(i + 1).padStart(digits, '0') + '.png';
  }

  /* ---------- project JSON ---------- */

  /** Default project settings (no frames). */
  function defaults() {
    return {
      width: 1280, height: 720, preset: '16:9', background: '#f4efe6', transparent: false, fps: 12,
      loop: true, pingpong: false, onion: { enabled: true, before: 1, after: 1, opacity: 0.35 },
    };
  }
  /** Build the JSON-ready object for a project. `p.frames` is an array of PNG data URLs. */
  function serializeProject(p) {
    const d = parseSettings(p);
    const out = { app: APP_ID, version: VERSION, ...d, frames: (p.frames || []).slice() };
    if (p.reference && isImageDataURL(p.reference)) { out.reference = p.reference; out.referenceOpacity = clamp(Number(p.referenceOpacity) || 0.5, 0, 1); }
    return out;
  }
  /** Normalise / clamp the settings part of a project (shared by serialise and parse). */
  function parseSettings(p) {
    const d = defaults();
    const o = p.onion || {};
    let width = clamp(toInt(p.width, d.width), 16, MAX_SIDE), height = clamp(toInt(p.height, d.height), 16, MAX_SIDE);
    const preset = Object.keys(PRESETS).find((k) => PRESETS[k][0] === width && PRESETS[k][1] === height) || 'custom';
    return {
      width, height, preset,
      background: isHexColor(p.background) ? p.background.toLowerCase() : d.background,
      transparent: !!p.transparent,
      fps: clampFps(p.fps),
      loop: p.loop !== false,
      pingpong: !!p.pingpong,
      onion: {
        enabled: o.enabled !== false,
        before: clamp(toInt(o.before, 1), 0, 5),
        after: clamp(toInt(o.after, 1), 0, 5),
        opacity: clamp(Number.isFinite(Number(o.opacity)) ? Number(o.opacity) : d.onion.opacity, 0.05, 1),
      },
    };
  }
  /** Parse a project (object or JSON string). Throws an Error with code 'invalid' when it is not ours / broken. */
  function parseProject(input) {
    let obj = input;
    if (typeof input === 'string') {
      try { obj = JSON.parse(input); } catch (e) { throw Object.assign(new Error('invalid JSON'), { code: 'invalid' }); }
    }
    if (!obj || typeof obj !== 'object' || obj.app !== APP_ID || !Array.isArray(obj.frames) || !obj.frames.length)
      throw Object.assign(new Error('not an Animation Atelier project'), { code: 'invalid' });
    if (!obj.frames.every((f) => f === null || isImageDataURL(f)))
      throw Object.assign(new Error('bad frame data'), { code: 'invalid' });
    const out = { ...parseSettings(obj), frames: obj.frames.slice() };
    if (isImageDataURL(obj.reference)) { out.reference = obj.reference; out.referenceOpacity = clamp(Number(obj.referenceOpacity) || 0.5, 0, 1); }
    return out;
  }

  return {
    APP_ID, VERSION, PRESETS, FPS_MIN, FPS_MAX, clamp, clampFps, isHexColor, isImageDataURL,
    insertAfter, duplicateAt, removeAt, moveFrame, nextIndex, playOrder, onionFrames, onionAlpha, spriteLayout,
    crc32, zipStore, frameName, defaults, serializeProject, parseProject,
  };
});
