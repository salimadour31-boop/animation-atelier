/* app.js — Animation Atelier user interface: drawing (pointer events + stylus pressure), per-frame undo/redo,
 * timeline, onion skin, playback, canvas formats, rotoscoping reference, exports (WebM / sprite sheet / PNG ZIP),
 * JSON projects, autosave and the FR / EN / Taqbaylit switcher. Everything runs locally: no network request.
 * Original code, MIT licence — © 2026 Amirouche Amwanes. */
(function () {
  'use strict';
  const C = window.AnimCore, I = window.I18N;
  const LS_PROJECT = 'animation-atelier:project', LS_LANG = 'animation-atelier:lang';
  const UNDO_LIMIT = 30;
  const ONION_PREV = '#e0563b', ONION_NEXT = '#1fa99b';
  const SWATCHES = ['#1b1d29', '#ffffff', '#d64933', '#f2b84b', '#2a9d8f', '#3d5a80', '#8e5bd6', '#7a5c3e'];

  const $ = (id) => document.getElementById(id);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };

  /* ---------- state ---------- */
  const d = C.defaults();
  const state = {
    ...d, onion: { ...d.onion }, frames: [], index: 0, tool: 'brush', color: '#1b1d29', size: 6,
    playing: false, dir: 1, lang: 'fr',
    ref: null, refShow: true, refOpacity: 0.5, refInExport: false, refFollow: false,
  };
  let nextId = 1, busy = false, quotaWarned = false;
  const app = { state, ready: false, playTicks: 0, saves: 0 };
  window.AnimApp = app;

  const view = $('view'), vctx = view.getContext('2d');
  const under = mk(state.width, state.height), uctx = under.getContext('2d'); // background + reference + onion skin
  const tint = mk(state.width, state.height), tctx = tint.getContext('2d');   // scratch for tinting ghosts
  const backup = mk(state.width, state.height), bctx = backup.getContext('2d', { willReadFrequently: true }); // pre-stroke copy
  let underDirty = true;

  const tr = (key, vars) => I.t(state.lang, key, vars);
  const cur = () => state.frames[state.index];

  /** A frame: its own full-size canvas, an undo/redo stack of changed regions and a cached PNG data URL. */
  function makeFrame(src) {
    const c = mk(state.width, state.height);
    if (src) c.getContext('2d').drawImage(src, 0, 0, state.width, state.height);
    return { id: nextId++, canvas: c, ctx: c.getContext('2d', { willReadFrequently: true }), undo: [], redo: [], url: null, thumb: null };
  }
  const touched = (f) => { f.url = null; };

  /* ---------- status line ---------- */
  let statusTimer = 0;
  function status(key, vars, sticky) {
    const el = $('status');
    el.textContent = tr(key, vars);
    el.classList.add('show');
    clearTimeout(statusTimer);
    if (!sticky) statusTimer = setTimeout(() => el.classList.remove('show'), 3800);
  }

  /* ---------- rendering ---------- */
  let checker = null;
  function checkerPattern(ctx) {
    if (!checker) {
      const p = mk(32, 32), c = p.getContext('2d');
      c.fillStyle = '#cfcfd6'; c.fillRect(0, 0, 32, 32);
      c.fillStyle = '#f2f2f5'; c.fillRect(0, 0, 16, 16); c.fillRect(16, 16, 16, 16);
      checker = p;
    }
    return ctx.createPattern(checker, 'repeat');
  }
  /** Draw `src` (sw×sh) centred and scaled to fit inside W×H ("contain"). */
  function drawContain(ctx, src, sw, sh, W, H) {
    if (!sw || !sh) return;
    const s = Math.min(W / sw, H / sh), w = sw * s, h = sh * s;
    ctx.drawImage(src, (W - w) / 2, (H - h) / 2, w, h);
  }
  function drawReference(ctx, W, H) {
    const r = state.ref;
    if (!r || !state.refShow) return;
    ctx.save(); ctx.globalAlpha = state.refOpacity;
    drawContain(ctx, r.canvas, r.canvas.width, r.canvas.height, W, H);
    ctx.restore();
  }
  /** Rebuild the layer under the current frame: paper, reference and tinted neighbouring frames. */
  function buildUnder() {
    const W = state.width, H = state.height;
    uctx.globalAlpha = 1; uctx.globalCompositeOperation = 'source-over';
    uctx.clearRect(0, 0, W, H);
    if (state.transparent) { uctx.fillStyle = checkerPattern(uctx); uctx.fillRect(0, 0, W, H); }
    else { uctx.fillStyle = state.background; uctx.fillRect(0, 0, W, H); }
    drawReference(uctx, W, H);
    const o = state.onion;
    if (o.enabled && !state.playing && state.frames.length > 1) {
      const count = Math.max(o.before, o.after, 1);
      for (const g of C.onionFrames(state.index, state.frames.length, o.before, o.after, false)) {
        tctx.globalCompositeOperation = 'source-over';
        tctx.clearRect(0, 0, W, H);
        tctx.drawImage(state.frames[g.index].canvas, 0, 0);
        tctx.globalCompositeOperation = 'source-in';
        tctx.fillStyle = g.offset < 0 ? ONION_PREV : ONION_NEXT;
        tctx.fillRect(0, 0, W, H);
        uctx.globalAlpha = C.onionAlpha(g.offset, count, o.opacity);
        uctx.drawImage(tint, 0, 0);
      }
      tctx.globalCompositeOperation = 'source-over';
      uctx.globalAlpha = 1;
    }
    underDirty = false;
  }
  function render() {
    if (underDirty) buildUnder();
    vctx.clearRect(0, 0, view.width, view.height);
    vctx.drawImage(under, 0, 0);
    const f = cur();
    if (f) vctx.drawImage(f.canvas, 0, 0);
    $('frameBadge').textContent = tr('frameCount', { i: state.index + 1, n: state.frames.length });
  }
  let renderQueued = false;
  const queueRender = () => { if (!renderQueued) { renderQueued = true; requestAnimationFrame(() => { renderQueued = false; render(); }); } };

  /** Size the canvas element to fit its box while keeping the project's aspect ratio. */
  function fitCanvas() {
    const wrap = $('canvasWrap');
    const mobile = matchMedia('(max-width: 900px)').matches;
    const ww = wrap.clientWidth;
    if (mobile) wrap.style.height = Math.round(Math.min(innerHeight * 0.6, ww * state.height / state.width)) + 'px';
    else wrap.style.height = '';
    const wh = wrap.clientHeight;
    const s = Math.max(0.01, Math.min(ww / state.width, wh / state.height));
    view.style.width = Math.floor(state.width * s) + 'px';
    view.style.height = Math.floor(state.height * s) + 'px';
  }

  /* ---------- timeline ---------- */
  function thumbSize() {
    const max = 104, s = Math.min(max / state.width, 64 / state.height);
    return [Math.max(8, Math.round(state.width * s)), Math.max(8, Math.round(state.height * s))];
  }
  function updateThumb(f) {
    if (!f.thumb) return;
    const c = f.thumb, x = c.getContext('2d');
    x.clearRect(0, 0, c.width, c.height);
    if (state.transparent) { x.fillStyle = checkerPattern(x); x.fillRect(0, 0, c.width, c.height); }
    else { x.fillStyle = state.background; x.fillRect(0, 0, c.width, c.height); }
    x.drawImage(f.canvas, 0, 0, c.width, c.height);
  }
  function buildTimeline() {
    const ol = $('frames');
    ol.textContent = '';
    const [tw, th] = thumbSize();
    state.frames.forEach((f, i) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'frame'; b.dataset.index = i;
      b.setAttribute('aria-label', tr('frameN', { n: i + 1 }));
      f.thumb = mk(tw, th); f.thumb.setAttribute('aria-hidden', 'true');
      const n = document.createElement('span'); n.className = 'num'; n.textContent = i + 1;
      b.append(f.thumb, n);
      b.addEventListener('click', () => { if (state.playing) stop(); goTo(i); });
      li.append(b); ol.append(li);
      updateThumb(f);
    });
    updateSelection();
  }
  function updateSelection() {
    $$('#frames .frame').forEach((b, i) => {
      const on = i === state.index;
      b.classList.toggle('current', on);
      if (on) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
    });
    // keep the current thumbnail visible by scrolling the strip only (never the page)
    const ol = $('frames'), el = $$('#frames .frame')[state.index];
    if (el) {
      const left = el.offsetLeft, right = left + el.offsetWidth;
      if (left < ol.scrollLeft) ol.scrollLeft = left - 8;
      else if (right > ol.scrollLeft + ol.clientWidth) ol.scrollLeft = right - ol.clientWidth + 8;
    }
    $('delBtn').disabled = state.frames.length <= 1;
    $('leftBtn').disabled = state.index === 0;
    $('rightBtn').disabled = state.index >= state.frames.length - 1;
    updateUndoButtons();
  }
  function updateUndoButtons() {
    const f = cur();
    $('undoBtn').disabled = !f || !f.undo.length;
    $('redoBtn').disabled = !f || !f.redo.length;
  }
  function goTo(i) {
    const n = state.frames.length;
    state.index = C.clamp(i, 0, n - 1);
    underDirty = true;
    render(); updateSelection();
    if (state.ref && state.ref.video && state.refFollow) seekVideo(state.index / state.fps);
  }
  function structureChanged(r) {
    state.frames = r.list; state.index = r.index;
    underDirty = true; buildTimeline(); render(); scheduleSave();
  }
  const addFrame = () => { if (state.playing) stop(); structureChanged(C.insertAfter(state.frames, state.index, makeFrame())); };
  const dupFrame = () => { if (state.playing) stop(); structureChanged(C.duplicateAt(state.frames, state.index, (f) => makeFrame(f.canvas))); };
  function delFrame() {
    if (state.playing) stop();
    const r = C.removeAt(state.frames, state.index);
    if (!r.removed) return status('stLastFrame');
    structureChanged(r);
  }
  const moveBy = (delta) => { if (state.playing) stop(); structureChanged(C.moveFrame(state.frames, state.index, delta)); };

  /* ---------- drawing ---------- */
  let stroke = null;
  function pointFrom(e) {
    const r = view.getBoundingClientRect();
    const pen = e.pointerType === 'pen';
    const p = pen ? (e.pressure > 0 ? e.pressure : 0.5) : 1;
    return {
      x: (e.clientX - r.left) * view.width / r.width,
      y: (e.clientY - r.top) * view.height / r.height,
      w: Math.max(0.5, state.size * (pen ? 0.15 + 0.85 * p : 1)),
    };
  }
  function grow(p) {
    const m = p.w / 2 + 2;
    stroke.x0 = Math.min(stroke.x0, p.x - m); stroke.y0 = Math.min(stroke.y0, p.y - m);
    stroke.x1 = Math.max(stroke.x1, p.x + m); stroke.y1 = Math.max(stroke.y1, p.y + m);
  }
  function paintSegment(a, b) {
    const x = cur().ctx;
    x.save();
    x.globalCompositeOperation = stroke.eraser ? 'destination-out' : 'source-over';
    x.strokeStyle = x.fillStyle = state.color;
    x.lineCap = 'round'; x.lineJoin = 'round';
    if (a === b) { x.beginPath(); x.arc(a.x, a.y, a.w / 2, 0, Math.PI * 2); x.fill(); }
    else { x.lineWidth = (a.w + b.w) / 2; x.beginPath(); x.moveTo(a.x, a.y); x.lineTo(b.x, b.y); x.stroke(); }
    x.restore();
    grow(b);
  }
  view.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (stroke || !cur()) return;
    e.preventDefault();
    if (state.playing) stop();
    try { view.setPointerCapture(e.pointerId); } catch (_) { /* synthetic events */ }
    bctx.clearRect(0, 0, backup.width, backup.height);
    bctx.drawImage(cur().canvas, 0, 0);
    const p = pointFrom(e);
    stroke = { id: e.pointerId, last: p, eraser: state.tool === 'eraser', x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    paintSegment(p, p);
    queueRender();
  });
  view.addEventListener('pointermove', (e) => {
    if (!stroke || e.pointerId !== stroke.id) return;
    const list = (e.getCoalescedEvents && e.getCoalescedEvents().length) ? e.getCoalescedEvents() : [e];
    for (const ev of list) { const p = pointFrom(ev); paintSegment(stroke.last, p); stroke.last = p; }
    queueRender();
  });
  function endStroke(e) {
    if (!stroke || (e && e.pointerId !== stroke.id)) return;
    const f = cur(), W = state.width, H = state.height;
    const x = Math.max(0, Math.floor(stroke.x0)), y = Math.max(0, Math.floor(stroke.y0));
    const w = Math.min(W, Math.ceil(stroke.x1)) - x, h = Math.min(H, Math.ceil(stroke.y1)) - y;
    stroke = null;
    if (w > 0 && h > 0) pushUndo(f, { x, y, data: bctx.getImageData(x, y, w, h) });
    touched(f); updateThumb(f); render(); updateUndoButtons(); scheduleSave();
  }
  view.addEventListener('pointerup', endStroke);
  view.addEventListener('pointercancel', endStroke);
  view.addEventListener('lostpointercapture', endStroke);

  function pushUndo(f, entry) {
    f.undo.push(entry);
    if (f.undo.length > UNDO_LIMIT) f.undo.shift();
    f.redo = [];
  }
  /** Swap a stored region with the frame's current pixels and move it to the other stack. */
  function swapRegion(from, to) {
    const f = cur();
    if (!f || !f[from].length) return;
    const e = f[from].pop();
    const now = f.ctx.getImageData(e.x, e.y, e.data.width, e.data.height);
    f.ctx.putImageData(e.data, e.x, e.y);
    f[to].push({ x: e.x, y: e.y, data: now });
    touched(f); updateThumb(f); render(); updateUndoButtons(); scheduleSave();
  }
  const undo = () => swapRegion('undo', 'redo');
  const redo = () => swapRegion('redo', 'undo');
  function clearFrame() {
    const f = cur();
    pushUndo(f, { x: 0, y: 0, data: f.ctx.getImageData(0, 0, state.width, state.height) });
    f.ctx.clearRect(0, 0, state.width, state.height);
    touched(f); updateThumb(f); render(); updateUndoButtons(); scheduleSave();
    status('stCleared');
  }
  function setTool(t) {
    state.tool = t;
    $('toolBrush').setAttribute('aria-checked', String(t === 'brush'));
    $('toolEraser').setAttribute('aria-checked', String(t === 'eraser'));
    view.dataset.tool = t;
  }
  function setSize(v) {
    state.size = C.clamp(Math.round(v), 1, 80);
    $('size').value = state.size; $('sizeOut').textContent = state.size;
  }

  /* ---------- playback ---------- */
  let raf = 0, lastT = 0, acc = 0;
  function play() {
    if (state.playing) return;
    const n = state.frames.length;
    if (!state.loop && !state.pingpong && state.index >= n - 1) state.index = 0;
    state.playing = true; state.dir = 1; underDirty = true; acc = 0; lastT = performance.now();
    render(); updatePlayButton();
    raf = requestAnimationFrame(tick);
  }
  function tick(now) {
    if (!state.playing) return;
    acc += now - lastT; lastT = now;
    const step = 1000 / state.fps;
    if (acc > 1000) acc = step;
    let changed = false;
    while (acc >= step) {
      acc -= step;
      const r = C.nextIndex(state.index, state.frames.length, state.dir, { loop: state.loop, pingpong: state.pingpong });
      state.index = r.index; state.dir = r.dir; changed = true; app.playTicks++;
      if (r.stop) { stop(); return; }
    }
    if (changed) { render(); updateSelection(); }
    raf = requestAnimationFrame(tick);
  }
  function stop() {
    if (!state.playing) return;
    state.playing = false; cancelAnimationFrame(raf);
    underDirty = true; render(); updateSelection(); updatePlayButton();
  }
  const togglePlay = () => (state.playing ? stop() : play());
  function updatePlayButton() {
    const b = $('playBtn'), key = state.playing ? 'pause' : 'play';
    b.dataset.i18nTitle = key; b.dataset.i18nAria = key;
    b.title = tr(key); b.setAttribute('aria-label', tr(key));
    b.setAttribute('aria-pressed', String(state.playing));
    b.querySelector('use').setAttribute('href', state.playing ? '#i-pause' : '#i-play');
  }

  /* ---------- canvas format ---------- */
  function resizeProject(w, h) {
    if (w === state.width && h === state.height) return;
    const old = state.frames;
    state.width = w; state.height = h;
    state.preset = Object.keys(C.PRESETS).find((k) => C.PRESETS[k][0] === w && C.PRESETS[k][1] === h) || 'custom';
    for (const c of [view, under, tint, backup]) { c.width = w; c.height = h; }
    state.frames = old.map((f) => {
      const nf = makeFrame();
      drawContain(nf.ctx, f.canvas, f.canvas.width, f.canvas.height, w, h);
      return nf;
    });
    syncControls(); fitCanvas(); underDirty = true; buildTimeline(); render(); scheduleSave();
    status('stResized', { w, h });
  }
  function setOnion(on) {
    state.onion.enabled = on;
    $('onionOn').checked = on; $('onionBtn').setAttribute('aria-pressed', String(on));
    underDirty = true; render(); scheduleSave();
  }

  /* ---------- reference layer (image or video frame) ---------- */
  function setReferenceFromSource(src, w, h, video) {
    const s = Math.min(1, 2048 / Math.max(w, h));
    const c = mk(Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s)));
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    if (state.ref && state.ref.video && state.ref.video !== video) dropVideo(state.ref.video);
    state.ref = { canvas: c, video: video || null };
    $('refControls').hidden = false;
    $('refControls').closest('details').open = true;
    $('refVideo').hidden = !video;
    underDirty = true; render();
  }
  function dropVideo(v) { try { v.pause(); URL.revokeObjectURL(v.src); v.removeAttribute('src'); v.load(); } catch (_) { /* ignore */ } }
  function seekVideo(t) {
    const v = state.ref && state.ref.video;
    if (!v || !Number.isFinite(v.duration)) return;
    v.currentTime = C.clamp(t, 0, Math.max(0, v.duration - 0.001));
    $('refTime').value = v.currentTime;
  }
  function loadReference(file) {
    if (!file) return;
    const url = URL.createObjectURL(file);
    if (file.type.startsWith('video/')) {
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.preload = 'auto';
      v.addEventListener('loadeddata', () => {
        $('refTime').max = String(v.duration || 1);
        $('refTime').step = String(1 / Math.max(1, state.fps));
        setReferenceFromSource(v, v.videoWidth, v.videoHeight, v);
        status('stRefLoaded');
      }, { once: true });
      v.addEventListener('seeked', () => { if (state.ref && state.ref.video === v) setReferenceFromSource(v, v.videoWidth, v.videoHeight, v); });
      v.addEventListener('error', () => { status('stRefFail'); URL.revokeObjectURL(url); }, { once: true });
      v.src = url;
    } else {
      const img = new Image();
      img.onload = () => { setReferenceFromSource(img, img.naturalWidth, img.naturalHeight, null); URL.revokeObjectURL(url); status('stRefLoaded'); scheduleSave(); };
      img.onerror = () => { status('stRefFail'); URL.revokeObjectURL(url); };
      img.src = url;
    }
  }
  function removeReference() {
    if (state.ref && state.ref.video) dropVideo(state.ref.video);
    state.ref = null; $('refControls').hidden = true; $('refFile').value = '';
    underDirty = true; render(); scheduleSave();
  }

  /* ---------- exports ---------- */
  /** Paint frame i as it should appear in an export (paper unless transparent, optional reference, drawing). */
  function composeFrame(i, ctx, W, H, forcePaper) {
    ctx.clearRect(0, 0, W, H);
    if (!state.transparent || forcePaper) { ctx.fillStyle = state.background; ctx.fillRect(0, 0, W, H); }
    if (state.refInExport) drawReference(ctx, W, H);
    ctx.drawImage(state.frames[i].canvas, 0, 0, W, H);
  }
  const toBlob = (c, type, q) => new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('toBlob'))), type || 'image/png', q));
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    status('stExported', { f: name });
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const canRecord = () => typeof MediaRecorder !== 'undefined' && !!HTMLCanvasElement.prototype.captureStream;
  async function guarded(fn) {
    if (busy) return;
    busy = true; $$('.panel .btn').forEach((b) => b.setAttribute('aria-busy', 'true'));
    if (state.playing) stop();
    try { await fn(); } catch (e) { console.warn(e); status('stExportFail'); }
    finally { busy = false; $$('.panel .btn').forEach((b) => b.removeAttribute('aria-busy')); }
  }
  async function exportWebm() {
    if (!canRecord()) { status('stNoWebm', null, true); return; }
    const W = state.width - (state.width % 2), H = state.height - (state.height % 2);
    // the recorded canvas is attached off-screen: some browsers only produce frames for canvases in the document
    const c = mk(W, H), x = c.getContext('2d');
    c.setAttribute('aria-hidden', 'true');
    c.style.cssText = 'position:fixed;left:-99999px;top:0;width:2px;height:2px';
    document.body.append(c);
    try { await recordInto(c, x, W, H); } finally { c.remove(); }
  }
  async function recordInto(c, x, W, H) {
    const types = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    const mime = types.find((t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || '';
    const order = C.playOrder(state.frames.length, state.pingpong);
    const loops = C.clamp(Math.round(Number($('exportLoops').value) || 1), 1, 10);
    const seq = []; for (let k = 0; k < loops; k++) seq.push(...order);
    composeFrame(seq[0], x, W, H, true);
    const stream = c.captureStream(state.fps);
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 6e6 } : undefined);
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise((r) => { rec.onstop = r; });
    const started = new Promise((r) => { rec.onstart = r; });
    rec.start(250);
    await started;
    const step = 1000 / state.fps, t0 = performance.now();
    for (let k = 0; k < seq.length; k++) {
      composeFrame(seq[k], x, W, H, true);
      status('stRecording', { p: Math.round((k / seq.length) * 100) }, true);
      await wait(Math.max(0, t0 + (k + 1) * step - performance.now()));
    }
    rec.stop(); await stopped;
    stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(chunks, { type: 'video/webm' });
    if (!blob.size) { status('stNoWebm', null, true); return; }
    download(blob, 'animation-atelier.webm');
  }
  async function exportSprite() {
    const L = C.spriteLayout(state.frames.length, state.width, state.height, 8192);
    const sheet = mk(L.width, L.height), sx = sheet.getContext('2d');
    const tmp = mk(state.width, state.height), tx = tmp.getContext('2d');
    state.frames.forEach((f, i) => {
      composeFrame(i, tx, state.width, state.height, false);
      const p = L.pos(i);
      sx.drawImage(tmp, p.x, p.y, L.cellW, L.cellH);
    });
    download(await toBlob(sheet), 'animation-atelier-planche.png');
  }
  async function exportZip() {
    const tmp = mk(state.width, state.height), tx = tmp.getContext('2d');
    const files = [];
    for (let i = 0; i < state.frames.length; i++) {
      composeFrame(i, tx, state.width, state.height, false);
      const b = await toBlob(tmp);
      files.push({ name: C.frameName(i, state.frames.length), data: new Uint8Array(await b.arrayBuffer()) });
    }
    download(new Blob([C.zipStore(files)], { type: 'application/zip' }), 'animation-atelier-sequence.zip');
  }

  /* ---------- projects: JSON, autosave ---------- */
  function projectData(withReference) {
    const p = {
      width: state.width, height: state.height, background: state.background, transparent: state.transparent,
      fps: state.fps, loop: state.loop, pingpong: state.pingpong, onion: { ...state.onion },
      frames: state.frames.map((f) => f.url || (f.url = f.canvas.toDataURL('image/png'))),
    };
    if (withReference && state.ref) { p.reference = state.ref.canvas.toDataURL('image/jpeg', 0.85); p.referenceOpacity = state.refOpacity; }
    return C.serializeProject(p);
  }
  let saveTimer = 0;
  function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(autosave, 900); }
  function autosave() {
    if (stroke) return scheduleSave();
    try {
      localStorage.setItem(LS_PROJECT, JSON.stringify(projectData(true)));
      app.saves++;
    } catch (e) {
      try { localStorage.setItem(LS_PROJECT, JSON.stringify(projectData(false))); app.saves++; }
      catch (e2) { try { localStorage.removeItem(LS_PROJECT); } catch (_) { /* ignore */ } if (!quotaWarned) { quotaWarned = true; status('stQuota', null, true); } }
    }
  }
  const loadImage = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
  /** Replace the whole animation with a parsed project (see AnimCore.parseProject). */
  async function applyProject(p) {
    if (state.playing) stop();
    const imgs = await Promise.all(p.frames.map((u) => (u ? loadImage(u) : null)));
    Object.assign(state, {
      width: p.width, height: p.height, preset: p.preset, background: p.background, transparent: p.transparent,
      fps: p.fps, loop: p.loop, pingpong: p.pingpong, onion: { ...p.onion },
    });
    for (const c of [view, under, tint, backup]) { c.width = p.width; c.height = p.height; }
    state.frames = imgs.map((img, i) => { const f = makeFrame(img); f.url = p.frames[i] || null; return f; });
    state.index = 0;
    if (state.ref && state.ref.video) dropVideo(state.ref.video);
    state.ref = null; $('refControls').hidden = true;
    if (p.reference) {
      const img = await loadImage(p.reference);
      state.refOpacity = p.referenceOpacity;
      setReferenceFromSource(img, img.naturalWidth, img.naturalHeight, null);
    }
    syncControls(); fitCanvas(); underDirty = true; buildTimeline(); render();
  }
  function newProject() {
    if (state.playing) stop();
    const keepSize = [state.width, state.height];
    const dd = C.defaults();
    Object.assign(state, { ...dd, onion: { ...dd.onion }, width: keepSize[0], height: keepSize[1] });
    state.preset = Object.keys(C.PRESETS).find((k) => C.PRESETS[k][0] === keepSize[0] && C.PRESETS[k][1] === keepSize[1]) || 'custom';
    state.frames = [makeFrame()]; state.index = 0;
    syncControls(); underDirty = true; buildTimeline(); render(); scheduleSave();
  }

  /* ---------- controls ---------- */
  function syncControls() {
    $('sizePreset').value = state.preset;
    $('sizePreset').querySelector('[value="custom"]').hidden = state.preset !== 'custom';
    $('bgColor').value = state.background; $('bgTransparent').checked = state.transparent;
    $('fps').value = state.fps; $('fpsOut').textContent = state.fps;
    $('loop').checked = state.loop; $('pingpong').checked = state.pingpong;
    $('onionOn').checked = state.onion.enabled; $('onionBtn').setAttribute('aria-pressed', String(state.onion.enabled));
    $('onionBefore').value = state.onion.before; $('onionAfter').value = state.onion.after;
    $('onionOpacity').value = Math.round(state.onion.opacity * 100);
    $('refOpacity').value = Math.round(state.refOpacity * 100);
    $('color').value = state.color; setSize(state.size); setTool(state.tool);
  }
  function applyLang(lang) {
    state.lang = I.LANGS.includes(lang) ? lang : 'fr';
    document.documentElement.lang = state.lang;
    $('lang').value = state.lang;
    $$('[data-i18n]').forEach((el) => { el.textContent = tr(el.dataset.i18n); });
    $$('[data-i18n-title]').forEach((el) => { el.title = tr(el.dataset.i18nTitle); });
    $$('[data-i18n-aria]').forEach((el) => { el.setAttribute('aria-label', tr(el.dataset.i18nAria)); });
    $$('#frames .frame').forEach((b, i) => b.setAttribute('aria-label', tr('frameN', { n: i + 1 })));
    updatePlayButton(); render();
    try { localStorage.setItem(LS_LANG, state.lang); } catch (_) { /* private mode */ }
  }
  const on = (id, ev, fn) => $(id).addEventListener(ev, fn);
  function wire() {
    on('lang', 'change', (e) => applyLang(e.target.value));
    on('toolBrush', 'click', () => setTool('brush'));
    on('toolEraser', 'click', () => setTool('eraser'));
    on('color', 'input', (e) => { state.color = e.target.value; setTool('brush'); });
    on('size', 'input', (e) => setSize(e.target.value));
    on('undoBtn', 'click', undo); on('redoBtn', 'click', redo); on('clearBtn', 'click', clearFrame);
    on('prevBtn', 'click', () => { if (state.playing) stop(); goTo(state.index - 1); });
    on('nextBtn', 'click', () => { if (state.playing) stop(); goTo(state.index + 1); });
    on('playBtn', 'click', togglePlay);
    on('addBtn', 'click', addFrame); on('dupBtn', 'click', dupFrame); on('delBtn', 'click', delFrame);
    on('leftBtn', 'click', () => moveBy(-1)); on('rightBtn', 'click', () => moveBy(1));
    on('onionBtn', 'click', () => setOnion(!state.onion.enabled));
    on('onionOn', 'change', (e) => setOnion(e.target.checked));
    const onionNum = (id, key) => on(id, 'input', (e) => { state.onion[key] = C.clamp(Math.round(Number(e.target.value) || 0), 0, 5); underDirty = true; render(); scheduleSave(); });
    onionNum('onionBefore', 'before'); onionNum('onionAfter', 'after');
    on('onionOpacity', 'input', (e) => { state.onion.opacity = Number(e.target.value) / 100; underDirty = true; render(); scheduleSave(); });
    on('fps', 'input', (e) => { state.fps = C.clampFps(e.target.value); $('fpsOut').textContent = state.fps; scheduleSave(); });
    on('loop', 'change', (e) => { state.loop = e.target.checked; scheduleSave(); });
    on('pingpong', 'change', (e) => { state.pingpong = e.target.checked; scheduleSave(); });
    on('sizePreset', 'change', (e) => { const p = C.PRESETS[e.target.value]; if (p) resizeProject(p[0], p[1]); });
    on('bgColor', 'input', (e) => { state.background = e.target.value; underDirty = true; render(); state.frames.forEach(updateThumb); scheduleSave(); });
    on('bgTransparent', 'change', (e) => { state.transparent = e.target.checked; underDirty = true; render(); state.frames.forEach(updateThumb); scheduleSave(); });
    on('refFile', 'change', (e) => loadReference(e.target.files[0]));
    on('refShow', 'change', (e) => { state.refShow = e.target.checked; underDirty = true; render(); });
    on('refOpacity', 'input', (e) => { state.refOpacity = Number(e.target.value) / 100; underDirty = true; render(); scheduleSave(); });
    on('refTime', 'input', (e) => seekVideo(Number(e.target.value)));
    on('refFollow', 'change', (e) => { state.refFollow = e.target.checked; if (state.refFollow) seekVideo(state.index / state.fps); });
    on('refInExport', 'change', (e) => { state.refInExport = e.target.checked; });
    on('refRemove', 'click', removeReference);
    on('exportWebm', 'click', () => guarded(exportWebm));
    on('exportSprite', 'click', () => guarded(exportSprite));
    on('exportZip', 'click', () => guarded(exportZip));
    on('saveBtn', 'click', () => guarded(async () => download(new Blob([JSON.stringify(projectData(true))], { type: 'application/json' }), 'animation-atelier-projet.json')));
    on('loadFile', 'change', async (e) => {
      const file = e.target.files[0]; e.target.value = '';
      if (!file) return;
      try { await applyProject(C.parseProject(await file.text())); scheduleSave(); status('stLoaded'); }
      catch (err) { status('stInvalid'); }
    });
    on('newBtn', 'click', () => { if (confirm(tr('newConfirm'))) { newProject(); status('stNew'); } });
    on('helpBtn', 'click', () => $('helpDlg').showModal());

    const sw = $('swatches');
    for (const c of SWATCHES) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'swatch'; b.style.background = c; b.title = c; b.setAttribute('aria-label', c);
      b.addEventListener('click', () => { state.color = c; $('color').value = c; setTool('brush'); });
      sw.append(b);
    }

    document.addEventListener('keydown', onKey);
    addEventListener('resize', fitCanvas);
    if (window.ResizeObserver) new ResizeObserver(() => fitCanvas()).observe($('stage'));
    addEventListener('beforeunload', () => { if (saveTimer) autosave(); });
  }
  function onKey(e) {
    if ($('helpDlg').open) return;
    const t = e.target, tag = t.tagName;
    const textual = tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && /^(text|number|search|email|url)$/.test(t.type));
    const k = e.key;
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      if (textual) return;
      const l = k.toLowerCase();
      if (l === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (l === 'y' || (l === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
      return;
    }
    if (e.altKey || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (k === ' ' && (tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY')) return; // keep native activation
    switch (k) {
      case 'ArrowLeft': e.preventDefault(); if (state.playing) stop(); goTo(state.index - 1); break;
      case 'ArrowRight': e.preventDefault(); if (state.playing) stop(); goTo(state.index + 1); break;
      case ' ': e.preventDefault(); togglePlay(); break;
      case 'b': case 'B': setTool('brush'); break;
      case 'e': case 'E': setTool('eraser'); break;
      case 'o': case 'O': setOnion(!state.onion.enabled); break;
      case 'n': case 'N': addFrame(); break;
      case 'd': case 'D': dupFrame(); break;
      case '[': setSize(state.size - (state.size > 10 ? 4 : 1)); break;
      case ']': setSize(state.size + (state.size >= 10 ? 4 : 1)); break;
      case '?': $('helpDlg').showModal(); break;
      default: return;
    }
  }

  /* ---------- boot ---------- */
  async function boot() {
    wire();
    let lang = 'fr';
    try { lang = localStorage.getItem(LS_LANG) || 'fr'; } catch (_) { /* ignore */ }
    let restored = false;
    try {
      const raw = localStorage.getItem(LS_PROJECT);
      if (raw) { await applyProject(C.parseProject(raw)); restored = true; }
    } catch (e) { console.warn('autosave ignored', e); }
    if (!restored) { state.frames = [makeFrame()]; syncControls(); buildTimeline(); }
    applyLang(lang);
    fitCanvas(); render();
    if (restored) status('stRestored');
    app.ready = true;
  }
  Object.assign(app, {
    render, goTo, play, stop, undo, redo, addFrame, dupFrame, delFrame, moveBy, setOnion, resizeProject, applyLang,
    autosave, projectData, applyProject, exportZip, exportSprite, exportWebm, canRecord,
    /** RGBA of the current frame's own pixel (not the composited view) — used by the tests. */
    pixel: (x, y) => Array.from(cur().ctx.getImageData(x, y, 1, 1).data),
    viewPixel: (x, y) => Array.from(vctx.getImageData(x, y, 1, 1).data),
    frameIds: () => state.frames.map((f) => f.id),
  });
  boot();
})();
