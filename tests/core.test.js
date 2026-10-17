// Unit tests for the pure logic (Node, no dependency): node tests/core.test.js
// Frame operations, playback order, onion skin, sprite layout, CRC-32, the store-only ZIP writer (checked with
// `unzip -t` when available and with an independent parser), i18n completeness and the project JSON round trip.
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), { execFileSync } = require('child_process');
const C = require('../js/core.js'), I = require('../js/i18n.js');
let n = 0;
const test = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };

console.log('core');
test('insertAfter / duplicateAt / removeAt / moveFrame', () => {
  let r = C.insertAfter(['a', 'b', 'c'], 0, 'x');
  assert.deepStrictEqual(r, { list: ['a', 'x', 'b', 'c'], index: 1 });
  r = C.insertAfter(['a'], -1, 'x'); assert.deepStrictEqual(r.list, ['x', 'a']); assert.strictEqual(r.index, 0);
  const src = ['a', 'b']; r = C.insertAfter(src, 1, 'z'); assert.deepStrictEqual(src, ['a', 'b'], 'immutable');
  r = C.duplicateAt([{ v: 1 }, { v: 2 }], 0, (f) => ({ v: f.v * 10 }));
  assert.deepStrictEqual(r.list.map((f) => f.v), [1, 10, 2]); assert.strictEqual(r.index, 1);
  r = C.removeAt(['a', 'b', 'c'], 1); assert.deepStrictEqual(r.list, ['a', 'c']); assert.strictEqual(r.index, 1); assert.strictEqual(r.removed, 'b');
  r = C.removeAt(['a', 'b', 'c'], 2); assert.deepStrictEqual(r.list, ['a', 'b']); assert.strictEqual(r.index, 1);
  r = C.removeAt(['only'], 0); assert.deepStrictEqual(r.list, ['only']); assert.strictEqual(r.removed, null);
  r = C.moveFrame(['a', 'b', 'c'], 0, 1); assert.deepStrictEqual(r, { list: ['b', 'a', 'c'], index: 1 });
  r = C.moveFrame(['a', 'b', 'c'], 2, -1); assert.deepStrictEqual(r, { list: ['a', 'c', 'b'], index: 1 });
  r = C.moveFrame(['a', 'b', 'c'], 0, -1); assert.deepStrictEqual(r, { list: ['a', 'b', 'c'], index: 0 });
  r = C.moveFrame(['a', 'b', 'c'], 2, 5); assert.deepStrictEqual(r, { list: ['a', 'b', 'c'], index: 2 });
});
test('nextIndex: loop, once, ping-pong', () => {
  const seq = (n, opts, steps) => { let i = 0, dir = 1; const out = [0]; for (let k = 0; k < steps; k++) { const r = C.nextIndex(i, n, dir, opts); i = r.index; dir = r.dir; out.push(r.stop ? 'stop' : i); if (r.stop) break; } return out; };
  assert.deepStrictEqual(seq(3, { loop: true }, 6), [0, 1, 2, 0, 1, 2, 0]);
  assert.deepStrictEqual(seq(3, { loop: false }, 6), [0, 1, 2, 'stop']);
  assert.deepStrictEqual(seq(4, { loop: true, pingpong: true }, 8), [0, 1, 2, 3, 2, 1, 0, 1, 2]);
  assert.deepStrictEqual(seq(3, { loop: false, pingpong: true }, 8), [0, 1, 2, 1, 0, 'stop']);
  assert.deepStrictEqual(C.nextIndex(0, 1, 1, { loop: true }), { index: 0, dir: 1, stop: false });
  assert.deepStrictEqual(C.playOrder(4, true), [0, 1, 2, 3, 2, 1]);
  assert.deepStrictEqual(C.playOrder(3, false), [0, 1, 2]);
  assert.deepStrictEqual(C.playOrder(1, true), [0]);
});
test('onion skin selection and fading', () => {
  assert.deepStrictEqual(C.onionFrames(2, 5, 2, 1, false), [{ index: 0, offset: -2 }, { index: 1, offset: -1 }, { index: 3, offset: 1 }]);
  assert.deepStrictEqual(C.onionFrames(0, 3, 2, 0, false), []);
  assert.deepStrictEqual(C.onionFrames(0, 3, 1, 0, true), [{ index: 2, offset: -1 }]);
  assert.deepStrictEqual(C.onionFrames(0, 2, 3, 3, true).map((o) => o.index), [1]);
  assert.strictEqual(C.onionAlpha(-1, 3, 0.6), 0.6);
  assert(Math.abs(C.onionAlpha(3, 3, 0.6) - 0.2) < 1e-9);
  assert.strictEqual(C.onionAlpha(4, 3, 0.6), 0);
});
test('sprite sheet layout', () => {
  const L = C.spriteLayout(12, 1280, 720);
  assert.strictEqual(L.cols * L.rows >= 12, true); assert.strictEqual(L.scale, 1);
  assert.deepStrictEqual(L.pos(4), { x: L.cellW * (4 % L.cols), y: L.cellH * Math.floor(4 / L.cols) });
  const big = C.spriteLayout(200, 1280, 720, 8192);
  assert(big.width <= 8192 && big.height <= 8192 && big.scale < 1 && big.cols * big.rows >= 200);
  const one = C.spriteLayout(1, 720, 1280); assert.deepStrictEqual([one.cols, one.rows, one.width, one.height], [1, 1, 720, 1280]);
});
test('CRC-32 matches known vectors', () => {
  assert.strictEqual(C.crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.strictEqual(C.crc32(new Uint8Array(0)), 0);
  assert.strictEqual(C.crc32(Buffer.from('The quick brown fox jumps over the lazy dog')), 0x414fa339);
});
test('frame names are zero-padded', () => {
  assert.strictEqual(C.frameName(0, 12), 'frame_0001.png');
  assert.strictEqual(C.frameName(41, 12345), 'frame_00042.png');
});

console.log('zip');
test('zipStore produces a valid archive (independent parser + unzip -t)', () => {
  const pngLike = Uint8Array.from({ length: 3000 }, (_, i) => (i * 37 + 11) & 255);
  const files = [
    { name: 'frame_0001.png', data: pngLike },
    { name: 'frame_0002.png', data: new Uint8Array(0) },
    { name: 'dossier/é-àccent.txt', data: new TextEncoder().encode('Azul fellawen — bonjour') },
  ];
  const zip = Buffer.from(C.zipStore(files, new Date(2026, 9, 17, 15, 30, 10)));
  // parse back from the end-of-central-directory record
  const eocd = zip.length - 22;
  assert.strictEqual(zip.readUInt32LE(eocd), 0x06054b50);
  assert.strictEqual(zip.readUInt16LE(eocd + 10), 3);
  let p = zip.readUInt32LE(eocd + 16);
  for (const f of files) {
    assert.strictEqual(zip.readUInt32LE(p), 0x02014b50);
    const crc = zip.readUInt32LE(p + 16), size = zip.readUInt32LE(p + 24), nl = zip.readUInt16LE(p + 28), off = zip.readUInt32LE(p + 42);
    assert.strictEqual(zip.slice(p + 46, p + 46 + nl).toString('utf8'), f.name);
    assert.strictEqual(zip.readUInt32LE(off), 0x04034b50);
    const lnl = zip.readUInt16LE(off + 26), data = zip.slice(off + 30 + lnl, off + 30 + lnl + size);
    assert.deepStrictEqual(new Uint8Array(data), f.data); assert.strictEqual(crc, C.crc32(f.data));
    p += 46 + nl;
  }
  const tmp = path.join(os.tmpdir(), 'aa-test-' + process.pid + '.zip');
  fs.writeFileSync(tmp, zip);
  try {
    let out;
    try { out = execFileSync('unzip', ['-t', tmp], { encoding: 'utf8' }); } catch (e) {
      if (e.code === 'ENOENT') { console.log('    (unzip not installed — skipped the unzip -t check)'); return; }
      throw new Error('unzip -t failed: ' + (e.stdout || e.message));
    }
    assert(/No errors detected/.test(out), out);
    const list = execFileSync('unzip', ['-Z1', tmp], { encoding: 'utf8' }).trim().split('\n');
    // unzip's listing depends on the terminal locale, so only ASCII names are compared byte for byte
    assert.strictEqual(list.length, files.length);
    assert.deepStrictEqual(list.slice(0, 2), ['frame_0001.png', 'frame_0002.png']);
  } finally { fs.unlinkSync(tmp); }
});

console.log('project JSON');
const PNG1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
test('serialize → JSON → parse round trip', () => {
  const p = { width: 720, height: 1280, background: '#112233', transparent: true, fps: 24, loop: false, pingpong: true,
    onion: { enabled: false, before: 3, after: 2, opacity: 0.5 }, frames: [PNG1, PNG1, null], reference: PNG1, referenceOpacity: 0.3 };
  const out = C.parseProject(JSON.stringify(C.serializeProject(p)));
  assert.strictEqual(out.preset, '9:16');
  for (const k of ['width', 'height', 'background', 'transparent', 'fps', 'loop', 'pingpong']) assert.strictEqual(out[k], p[k], k);
  assert.deepStrictEqual(out.onion, p.onion); assert.deepStrictEqual(out.frames, p.frames);
  assert.strictEqual(out.reference, PNG1); assert.strictEqual(out.referenceOpacity, 0.3);
  // a second round trip is stable
  assert.deepStrictEqual(C.parseProject(JSON.stringify(C.serializeProject(out))), out);
});
test('parse clamps values and rejects foreign files', () => {
  const out = C.parseProject({ app: 'animation-atelier', frames: [PNG1], fps: 99, width: 99999, height: 2, background: 'red', onion: { before: 40, opacity: 9 } });
  assert.strictEqual(out.fps, 30); assert.strictEqual(out.width, 4096); assert.strictEqual(out.height, 16);
  assert.strictEqual(out.background, C.defaults().background); assert.strictEqual(out.onion.before, 5); assert.strictEqual(out.onion.opacity, 1);
  assert.strictEqual(out.preset, 'custom');
  assert.strictEqual(C.parseProject({ app: 'animation-atelier', frames: [PNG1], fps: 0 }).fps, 1);
  for (const bad of ['{nope', '{}', JSON.stringify({ app: 'other', frames: [PNG1] }), JSON.stringify({ app: 'animation-atelier', frames: [] }),
    JSON.stringify({ app: 'animation-atelier', frames: ['javascript:alert(1)'] })]) {
    assert.throws(() => C.parseProject(bad), (e) => e.code === 'invalid');
  }
  assert.deepStrictEqual(C.PRESETS['2.39:1'], [1280, 536]);
});

console.log('i18n');
test('every key has non-empty FR / EN / Taqbaylit texts with the same placeholders', () => {
  assert.deepStrictEqual(I.LANGS, ['fr', 'en', 'kab']);
  for (const [k, v] of Object.entries(I.S)) {
    assert(Array.isArray(v) && v.length === 3, k);
    v.forEach((s, i) => assert(typeof s === 'string' && s.trim(), `${k}[${I.LANGS[i]}] empty`));
    const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join();
    assert.strictEqual(ph(v[1]), ph(v[0]), k + ' en placeholders'); assert.strictEqual(ph(v[2]), ph(v[0]), k + ' kab placeholders');
  }
  assert.strictEqual(I.t('kab', 'frameCount', { i: 2, n: 5 }), 'Tugna 2 / 5');
  assert.strictEqual(I.t('xx', 'loop'), 'Boucle');
});
test('every key used by index.html and app.js exists', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8'), js = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');
  const used = new Set();
  for (const m of html.matchAll(/data-i18n(?:-title|-aria)?="([^"]+)"/g)) used.add(m[1]);
  for (const m of js.matchAll(/\b(?:tr|status)\('([A-Za-z0-9]+)'/g)) used.add(m[1]);
  assert(used.size > 50, 'found only ' + used.size + ' keys');
  const missing = [...used].filter((k) => !(k in I.S));
  assert.deepStrictEqual(missing, []);
});

console.log(`\nUnit tests passed (${n} groups)`);
