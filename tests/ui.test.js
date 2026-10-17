// Headless UI test (Playwright + Chrome/Chromium): node tests/ui.test.js
// Serves the folder locally and drives the interface at 1440 × 900 (desktop) and 390 × 844 (mobile, touch):
// drawing with the pointer (mouse + touch), undo / redo, eraser, frames (add / duplicate / delete / reorder),
// onion skin (tinted ghosts, toggle with O), playback (Space), keyboard shortcuts, FR → EN → Taqbaylit,
// canvas presets, reference image, exports (PNG ZIP checked with `unzip -t`, sprite sheet, JSON round trip, WebM),
// autosave restore after reload, no console errors, no horizontal overflow. Writes the README screenshots.
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const { execFileSync } = require('child_process');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require(path.resolve(__dirname, '../../node_modules/playwright'))); }
const root = path.resolve(__dirname, '..'), shots = path.join(root, 'screenshots');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(req.url.split('?')[0].split('#')[0]).replace(/\/$/, '/index.html'));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res);
});
let checks = 0;
const ok = (cond, msg) => { assert(cond, msg); checks++; };
const A = (page, fn, arg) => page.evaluate(fn, arg);
const pngSize = (buf) => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });
async function download(page, action) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), action()]);
  return { name: dl.suggestedFilename(), buf: fs.readFileSync(await dl.path()) };
}
/** Canvas coordinates (project pixels) → page coordinates. */
async function toPage(page, x, y) {
  const b = await page.locator('#view').boundingBox();
  const [w, h] = await A(page, () => [AnimApp.state.width, AnimApp.state.height]);
  return { x: b.x + (x / w) * b.width, y: b.y + (y / h) * b.height };
}
async function stroke(page, pts) {
  const p0 = await toPage(page, pts[0][0], pts[0][1]);
  await page.mouse.move(p0.x, p0.y); await page.mouse.down();
  for (const [x, y] of pts.slice(1)) { const p = await toPage(page, x, y); await page.mouse.move(p.x, p.y, { steps: 3 }); }
  await page.mouse.up();
}
const circle = (cx, cy, r, sq = 1) => Array.from({ length: 33 }, (_, i) => [cx + r * Math.cos(i / 32 * Math.PI * 2), cy + r * sq * Math.sin(i / 32 * Math.PI * 2)]);
const alphaAt = (page, x, y) => A(page, ([x, y]) => AnimApp.pixel(x, y)[3], [x, y]);
const viewAt = (page, x, y) => A(page, ([x, y]) => AnimApp.viewPixel(x, y), [x, y]);
const count = (page) => A(page, () => AnimApp.state.frames.length);
const index = (page) => A(page, () => AnimApp.state.index);

/** Draw a small bouncing-ball scene over several frames (used for the screenshots too). */
async function drawBall(page, frames) {
  const W = await A(page, () => AnimApp.state.width), H = await A(page, () => AnimApp.state.height);
  const ground = H * 0.82;
  for (let i = 0; i < frames; i++) {
    if (i > 0) await page.click('#addBtn');
    const t = i / (frames - 1), x = W * (0.15 + 0.7 * t), y = ground - H * 0.55 * Math.abs(Math.cos(t * Math.PI * 1.5)) - H * 0.07;
    const squash = y > ground - H * 0.1 ? 0.7 : 1;
    await page.click('.swatch[title="#1b1d29"]');
    await stroke(page, [[W * 0.05, ground], [W * 0.95, ground]]);
    await page.click('.swatch[title="#d64933"]');
    await stroke(page, circle(x, y, H * 0.07, squash));
    await stroke(page, circle(x, y, H * 0.035, squash));
  }
}

async function run(browser, base, vp, name) {
  const mobile = vp.width < 500;
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile, acceptDownloads: true });
  const page = await ctx.newPage(), errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('request', (r) => { if (!r.url().startsWith(base) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) errors.push('external request: ' + r.url()); });
  await page.goto(base + 'index.html');
  await page.waitForFunction(() => window.AnimApp && AnimApp.ready);
  console.log(`\n[${name}] ${vp.width}×${vp.height}`);

  ok(await A(page, () => document.documentElement.lang) === 'fr', 'default language is not French');
  ok((await page.textContent('#hTimeline')) === 'Timeline' && (await page.getAttribute('#playBtn', 'title')) === 'Lecture (Espace)', 'French labels');
  ok(await count(page) === 1, 'starts with one frame');
  ok(await A(page, () => document.documentElement.scrollWidth <= innerWidth + 1), 'horizontal overflow');
  const vb = await page.locator('#view').boundingBox();
  ok(vb.width > (mobile ? 300 : 600) && Math.abs(vb.width / vb.height - 16 / 9) < 0.02, 'canvas is visible with the 16:9 ratio: ' + JSON.stringify(vb));
  console.log('  ✓ boot: French default, one frame, canvas fitted, no overflow');

  // draw, undo, redo, clear
  await stroke(page, [[200, 300], [400, 300], [600, 320]]);
  ok(await alphaAt(page, 400, 300) > 200, 'stroke not painted');
  await page.click('#undoBtn'); ok(await alphaAt(page, 400, 300) === 0, 'undo');
  await page.keyboard.press('Control+y'); ok(await alphaAt(page, 400, 300) > 200, 'redo (Ctrl+Y)');
  await page.keyboard.press('Control+z'); ok(await alphaAt(page, 400, 300) === 0, 'undo (Ctrl+Z)');
  await page.keyboard.press('Control+Shift+z'); ok(await alphaAt(page, 400, 300) > 200, 'redo (Ctrl+Shift+Z)');
  await page.click('#clearBtn'); ok(await alphaAt(page, 400, 300) === 0, 'clear frame');
  await page.keyboard.press('Control+z'); ok(await alphaAt(page, 400, 300) > 200, 'undo clear');
  if (mobile) { const p = await toPage(page, 900, 150); await page.touchscreen.tap(p.x, p.y); ok(await alphaAt(page, 900, 150) > 200, 'touch tap paints a dot'); }
  // eraser
  await page.keyboard.press('e'); ok(await page.getAttribute('#toolEraser', 'aria-checked') === 'true', 'E selects eraser');
  await A(page, () => { const s = document.getElementById('size'); s.value = 40; s.dispatchEvent(new Event('input')); });
  await stroke(page, [[580, 280], [620, 340]]);
  ok(await alphaAt(page, 600, 318) === 0 && await alphaAt(page, 300, 300) > 200, 'eraser removes only where it passes');
  await page.keyboard.press('b'); ok(await page.getAttribute('#toolBrush', 'aria-checked') === 'true', 'B selects brush');
  await page.keyboard.press('['); ok(await A(page, () => AnimApp.state.size) === 36, '[ shrinks brush');
  await A(page, () => { const s = document.getElementById('size'); s.value = 6; s.dispatchEvent(new Event('input')); });
  console.log('  ✓ drawing, undo / redo (buttons + shortcuts), clear, eraser, brush size' + (mobile ? ', touch' : ''));

  // frames and onion skin
  await page.click('#addBtn');
  ok(await count(page) === 2 && await index(page) === 1 && await alphaAt(page, 300, 300) === 0, 'add frame');
  const ghost = await viewAt(page, 300, 300), bg = await viewAt(page, 1100, 650);
  ok(Math.abs(ghost[0] - bg[0]) + Math.abs(ghost[1] - bg[1]) + Math.abs(ghost[2] - bg[2]) > 40 && ghost[0] > ghost[1], 'onion skin shows the previous frame tinted red: ' + ghost + ' vs ' + bg);
  await page.keyboard.press('o');
  ok(await page.getAttribute('#onionBtn', 'aria-pressed') === 'false' && !(await page.isChecked('#onionOn')), 'O toggles onion skin off');
  ok(JSON.stringify(await viewAt(page, 300, 300)) === JSON.stringify(bg), 'ghost hidden when onion skin off');
  await page.click('#onionBtn'); ok(await page.getAttribute('#onionBtn', 'aria-pressed') === 'true', 'onion button toggles back on');
  await stroke(page, [[700, 500], [800, 500]]);
  await page.keyboard.press('ArrowLeft'); ok(await index(page) === 0, 'ArrowLeft');
  const nextGhost = await viewAt(page, 750, 500);
  ok(nextGhost[1] > nextGhost[0], 'next frame ghost tinted teal: ' + nextGhost);
  await page.keyboard.press('ArrowRight'); ok(await index(page) === 1, 'ArrowRight');
  await page.keyboard.press('n'); ok(await count(page) === 3 && await index(page) === 2, 'N adds a frame');
  await page.keyboard.press('ArrowLeft'); await page.click('#dupBtn');
  ok(await count(page) === 4 && await index(page) === 2 && await alphaAt(page, 750, 500) > 200, 'duplicate copies the drawing');
  const ids = await A(page, () => AnimApp.frameIds());
  await page.click('#leftBtn'); const ids2 = await A(page, () => AnimApp.frameIds());
  ok(ids2[1] === ids[2] && ids2[2] === ids[1] && await index(page) === 1, 'move left');
  await page.click('#rightBtn'); ok(JSON.stringify(await A(page, () => AnimApp.frameIds())) === JSON.stringify(ids), 'move right');
  await page.click('#frames li:nth-child(4) .frame'); ok(await index(page) === 3, 'click a thumbnail');
  await page.click('#delBtn'); ok(await count(page) === 3 && await index(page) === 2, 'delete frame');
  ok(await page.locator('#frames .frame').count() === 3 && await page.getAttribute('#frames li:nth-child(3) .frame', 'aria-current') === 'true', 'timeline thumbnails in sync');
  console.log('  ✓ frames: add / duplicate / reorder / delete / select, onion skin tint + toggle, arrows');

  // playback
  await A(page, () => { const f = document.getElementById('fps'); f.value = 24; f.dispatchEvent(new Event('input')); });
  await page.locator('#view').focus().catch(() => {});
  await A(page, () => document.activeElement && document.activeElement.blur());
  const t0 = await A(page, () => AnimApp.playTicks);
  await page.keyboard.press(' ');
  ok(await A(page, () => AnimApp.state.playing) && await page.getAttribute('#playBtn', 'aria-pressed') === 'true', 'Space starts playback');
  await page.waitForTimeout(600);
  await page.keyboard.press(' ');
  const ticks = (await A(page, () => AnimApp.playTicks)) - t0;
  ok(!(await A(page, () => AnimApp.state.playing)) && ticks >= 3, 'playback advanced ' + ticks + ' frames then paused');
  await page.check('#pingpong'); await page.click('#playBtn'); await page.waitForTimeout(300); await page.click('#playBtn');
  ok(!(await A(page, () => AnimApp.state.playing)), 'play button toggles');
  await page.uncheck('#pingpong');
  console.log(`  ✓ playback (${ticks} frames in 0.6 s at 24 i/s), ping-pong`);

  // languages
  await page.selectOption('#lang', 'en');
  ok(await page.getAttribute('#playBtn', 'title') === 'Play (Space)' && await A(page, () => document.documentElement.lang) === 'en', 'English');
  await page.selectOption('#lang', 'kab');
  ok(await page.getAttribute('#playBtn', 'title') === 'Urar (Tallunt)' && (await page.textContent('#frameBadge')).startsWith('Tugna'), 'Taqbaylit');
  ok(await A(page, () => document.documentElement.scrollWidth <= innerWidth + 1), 'overflow in Taqbaylit');
  await page.selectOption('#lang', 'fr');
  ok((await page.textContent('#frameBadge')).startsWith('Image'), 'back to French');
  await A(page, () => document.activeElement && document.activeElement.blur());
  await page.keyboard.press('?'); ok(await page.isVisible('#helpDlg'), 'help dialog');
  await page.keyboard.press('Escape'); ok(!(await page.isVisible('#helpDlg')), 'help closes');
  console.log('  ✓ FR → EN → Taqbaylit → FR, shortcuts dialog');

  if (!mobile) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-ui-'));
    // PNG sequence ZIP
    const zip = await download(page, () => page.click('#exportZip'));
    const zp = path.join(tmp, zip.name); fs.writeFileSync(zp, zip.buf);
    try {
      ok(/No errors detected/.test(execFileSync('unzip', ['-t', zp], { encoding: 'utf8' })), 'unzip -t');
      const names = execFileSync('unzip', ['-Z1', zp], { encoding: 'utf8' }).trim().split('\n');
      ok(JSON.stringify(names) === JSON.stringify(['frame_0001.png', 'frame_0002.png', 'frame_0003.png']), 'zip entries ' + names);
      execFileSync('unzip', ['-o', '-q', zp, '-d', tmp]);
      ok(JSON.stringify(pngSize(fs.readFileSync(path.join(tmp, 'frame_0002.png')))) === '{"w":1280,"h":720}', 'frame PNG size');
    } catch (e) { if (e.code !== 'ENOENT') throw e; console.log('  (unzip missing — zip check skipped)'); }
    // sprite sheet
    const sheet = await download(page, () => page.click('#exportSprite'));
    ok(sheet.name.endsWith('.png') && JSON.stringify(pngSize(sheet.buf)) === JSON.stringify({ w: 2560, h: 1440 }), 'sprite sheet 2×2 grid: ' + JSON.stringify(pngSize(sheet.buf)));
    // JSON save → modify → load
    const json = await download(page, () => page.click('#saveBtn'));
    const proj = JSON.parse(json.buf.toString('utf8'));
    ok(proj.app === 'animation-atelier' && proj.frames.length === 3 && proj.fps === 24, 'project JSON');
    const jp = path.join(tmp, 'p.json'); fs.writeFileSync(jp, json.buf);
    const before = await A(page, () => AnimApp.state.frames.map((f) => f.canvas.toDataURL()));
    await page.click('#addBtn'); await page.click('#addBtn');
    await page.setInputFiles('#loadFile', jp);
    await page.waitForFunction(() => AnimApp.state.frames.length === 3);
    ok(JSON.stringify(await A(page, () => AnimApp.state.frames.map((f) => f.canvas.toDataURL()))) === JSON.stringify(before), 'JSON round trip keeps pixels');
    await page.setInputFiles('#loadFile', { name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"hello":1}') });
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('non reconnu'));
    ok(await count(page) === 3, 'invalid file ignored');
    // WebM
    if (await A(page, () => AnimApp.canRecord())) {
      const webm = await download(page, () => page.click('#exportWebm'));
      ok(webm.name.endsWith('.webm') && webm.buf.length > 500 && webm.buf.readUInt32BE(0) === 0x1a45dfa3, 'WebM (EBML header), ' + webm.buf.length + ' bytes');
    } else console.log('  (MediaRecorder unavailable here — WebM skipped)');
    // reference image
    await page.setInputFiles('#refFile', path.join(tmp, 'frame_0002.png'));
    await page.waitForFunction(() => !document.getElementById('refControls').hidden);
    ok(await A(page, () => !!AnimApp.state.ref), 'reference image loaded');
    await page.click('#refRemove'); ok(await A(page, () => !AnimApp.state.ref), 'reference removed');
    // presets
    await page.selectOption('#sizePreset', '1:1');
    ok(await A(page, () => [view.width, view.height, AnimApp.state.frames[0].canvas.width].join()) === '1080,1080,1080', 'resize to 1:1');
    const vb2 = await page.locator('#view').boundingBox(); ok(Math.abs(vb2.width - vb2.height) < 2, 'square canvas on screen');
    await page.selectOption('#sizePreset', '16:9');
    console.log('  ✓ exports: PNG ZIP (unzip -t), sprite sheet, JSON round trip, invalid file, WebM; reference; presets');
    // autosave → reload restores
    await A(page, () => AnimApp.autosave());
    await page.reload(); await page.waitForFunction(() => window.AnimApp && AnimApp.ready);
    ok(await count(page) === 3 && await A(page, () => AnimApp.state.fps) === 24, 'autosave restored after reload');
    console.log('  ✓ autosave restored after reload');
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // screenshot scene: new project, bouncing ball over 6 frames, onion skin 2 before / 1 after
  page.once('dialog', (d) => d.accept());
  await page.click('#newBtn');
  ok(await count(page) === 1, 'new project');
  await drawBall(page, 6);
  await A(page, () => { const b = document.getElementById('onionBefore'); b.value = 2; b.dispatchEvent(new Event('input')); });
  await page.click('#frames li:nth-child(4) .frame');
  await A(page, () => document.activeElement && document.activeElement.blur());
  await page.waitForTimeout(300);
  ok(await A(page, () => document.documentElement.scrollWidth <= innerWidth + 1), 'no overflow with 6 frames');
  if (!mobile) ok(await A(page, () => document.documentElement.scrollHeight <= innerHeight + 1 && scrollY === 0), 'desktop layout fits the viewport (no page scroll)');
  await page.screenshot({ path: path.join(shots, mobile ? 'mobile.png' : 'desktop.png'), fullPage: mobile });
  ok(!errors.length, 'console errors: ' + errors.join(' | '));
  console.log('  ✓ no console errors, no network calls; screenshot written');
  await ctx.close();
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const exe = process.env.CHROME_PATH || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
  const browser = await chromium.launch({ ...(exe ? { executablePath: exe } : {}) });
  try {
    fs.mkdirSync(shots, { recursive: true });
    await run(browser, base, { width: 1440, height: 900 }, 'desktop');
    await run(browser, base, { width: 390, height: 844 }, 'mobile');
    console.log(`\nUI tests passed (${checks} checks)`);
  } finally { await browser.close(); server.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
