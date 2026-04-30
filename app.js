'use strict';

// ── DOM shorthand ──────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ── State ─────────────────────────────────────────────────────
let words    = [];   // tokenized word array
let normWords= [];   // pre-normalized version for O(1) lookup
let cursor   = 0;
let wpm      = 300;
let playing  = false;
let timer    = null;
let chunkSize  = 1;
let focusOn    = true;
let pausePunct = true;
let isDark     = true;
let sidebarOpen= false;
let contextOn  = false;
let adaptiveOn = false;

// session tracking
let sessionStart   = null;
let totalReadMs    = 0;
let wordsReadCount = 0;
let lastPlayStart  = null;
let adaptToastTimer= null;

// jump-to
let pendingJump = -1;

// focus-letter HTML is cached per unique word so it is never rebuilt twice
const focusHTMLCache = new Map();

const isMob = () => window.innerWidth <= 640;

// ── Layout ────────────────────────────────────────────────────
function applyLayout() {
  const mob = isMob();
  document.querySelectorAll('.desk-only').forEach(el => el.style.display = mob ? 'none' : '');
  $('mob-row1').style.display = mob ? 'flex' : 'none';
  $('mob-row2').style.display = mob ? 'flex' : 'none';
  syncWPM();
}
window.addEventListener('resize', applyLayout);

// ── Theme ─────────────────────────────────────────────────────
function applyTheme() {
  document.body.setAttribute('data-theme', isDark ? 'dark' : 'light');
  ['theme-upload', 'theme-reader'].forEach(id => {
    const el = $(id);
    if (el) el.innerHTML = `<i data-lucide="${isDark ? 'sun' : 'moon'}"></i>`;
  });
  lucide.createIcons();
}
$('theme-upload').onclick = $('theme-reader').onclick = () => { isDark = !isDark; applyTheme(); };

// ── Settings panel ────────────────────────────────────────────
$('settings-btn').onclick = e => { e.stopPropagation(); $('settings-panel').classList.toggle('open'); };
document.addEventListener('click', e => {
  if (!e.target.closest('#settings-panel') && !e.target.closest('#settings-btn'))
    $('settings-panel').classList.remove('open');
});
$('focus-tog').onchange  = e => { focusOn    = e.target.checked; updateWord(); };
$('punct-tog').onchange  = e => { pausePunct = e.target.checked; };
$('chunk-sel').onchange  = e => { chunkSize  = +e.target.value;  updateWord(); };
$('ctx-tog').onchange    = e => { contextOn  = e.target.checked; updateWord(); };
$('adapt-tog').onchange  = e => { adaptiveOn = e.target.checked; };
$('sb-width').onchange   = e => {
  document.documentElement.style.setProperty('--sidebar', e.target.value + 'px');
};

// ── Sidebar ───────────────────────────────────────────────────
function setSidebar(open) {
  sidebarOpen = open;
  $('book-sidebar').classList.toggle('collapsed', !open);
  $('sidebar-btn').innerHTML = `<i data-lucide="${open ? 'book' : 'book-open'}"></i>`;
  lucide.createIcons();
}
$('sidebar-btn').onclick = () => setSidebar(!sidebarOpen);

// ── Error toast ───────────────────────────────────────────────
function showErr(msg) {
  const t = $('err');
  t.textContent = msg;
  t.style.display = 'block';
  setTimeout(() => t.style.display = 'none', 4000);
}

// ── Screen switch ─────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
}

// ── Upload: drop zone ─────────────────────────────────────────
const dropZone  = $('drop-zone');
const fileInput = $('file-input');
dropZone.onclick    = () => fileInput.click();
dropZone.ondragover = e => { e.preventDefault(); dropZone.classList.add('drag-over'); };
dropZone.ondragleave= () => dropZone.classList.remove('drag-over');
dropZone.ondrop     = e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
};
fileInput.onchange  = e => { if (e.target.files[0]) handleFile(e.target.files[0]); };

// ── Upload: paste text ────────────────────────────────────────
$('paste-btn').onclick = () => {
  const text = $('paste-input').value.trim();
  if (!text) { showErr('Paste some text first.'); return; }
  const tokens = tokenize(text);
  if (tokens.length < 5) { showErr('Text is too short.'); return; }

  loadWords(tokens, 'PASTED TEXT');

  // Build sidebar for pasted text
  $('book-pages').innerHTML = '';
  const wrap  = document.createElement('div'); wrap.className = 'page-wrap'; wrap.style.background = 'var(--surface2)';
  const label = document.createElement('div'); label.className = 'page-label'; label.textContent = 'PASTED TEXT';
  const td    = document.createElement('div'); td.className = 'epub-text';
  text.split(/\n\n+/).filter(p => p.trim()).forEach(p => {
    const el = document.createElement('p'); el.textContent = p.trim(); td.appendChild(el);
  });
  if (!td.children.length) { const p = document.createElement('p'); p.textContent = text; td.appendChild(p); }
  wrap.appendChild(label); wrap.appendChild(td); $('book-pages').appendChild(wrap);
  const ct = text;
  wrap.addEventListener('mouseup',  () => handleSel(ct));
  wrap.addEventListener('touchend', () => setTimeout(() => handleSel(ct), 120));

  startReader();
};

// ── File handler ──────────────────────────────────────────────
async function handleFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  dropZone.querySelector('h2').textContent = 'Processing…';
  try {
    let text = '';
    if      (ext === 'pdf')  text = await loadPDF(file);
    else if (ext === 'epub') text = await loadEPUB(file);
    else if (ext === 'txt')  text = await file.text();
    else {
      showErr('Only PDF, EPUB or TXT supported.');
      dropZone.querySelector('h2').textContent = 'Drop your book here';
      return;
    }

    const tokens = tokenize(text);
    if (tokens.length < 5) { showErr('Could not extract text.'); return; }

    loadWords(tokens, file.name.replace(/\.[^.]+$/, '').toUpperCase().slice(0, 24));
    startReader();
  } catch (err) {
    console.error(err);
    showErr('Parse error: ' + err.message);
    dropZone.querySelector('h2').textContent = 'Drop your book here';
  }
}

// ── Tokenize — single-pass O(n) ───────────────────────────────
// Split on any whitespace in one pass; no intermediate string rebuilding.
function tokenize(t) {
  return t.trim().split(/\s+/).filter(w => w.length > 0);
}

// ── Load words + pre-build normalised lookup array ────────────
// Pre-normalising once here means findBlockStart / findWordFrom
// never call norm() inside their loops — they index normWords[i] directly.
function loadWords(tokens, title) {
  words     = tokens;
  normWords = new Array(tokens.length);
  for (let i = 0; i < tokens.length; i++) normWords[i] = norm(tokens[i]);
  focusHTMLCache.clear();
  $('sb-title').textContent = title;
}

// ── PDF — parallel text + lazy canvas rendering ───────────────
// Text from all pages is extracted in parallel with Promise.all so the
// words array is ready immediately. Canvas rendering is deferred to an
// IntersectionObserver so pages only render when scrolled into view —
// a large PDF never blocks the main thread upfront.
async function loadPDF(file) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  const data = await file.arrayBuffer();
  const pdf  = await pdfjsLib.getDocument({ data }).promise;
  const n    = pdf.numPages;

  // Phase 1: extract text from every page concurrently
  let done = 0;
  const pageTexts = await Promise.all(
    Array.from({ length: n }, (_, i) =>
      pdf.getPage(i + 1)
         .then(page => page.getTextContent())
         .then(content => {
           done++;
           dropZone.querySelector('h2').textContent = `Extracting ${done} / ${n}…`;
           return content.items.map(s => s.str).join(' ');
         })
    )
  );

  // Phase 2: build sidebar with lazy canvas rendering via IntersectionObserver
  $('book-pages').innerHTML = '';

  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const wrap = entry.target;
      if (wrap.dataset.rendered) return;
      wrap.dataset.rendered = '1';
      observer.unobserve(wrap);

      const pageNum = +wrap.dataset.page;
      pdf.getPage(pageNum).then(page => {
        const canvas = wrap.querySelector('canvas');
        const ctx    = canvas.getContext('2d');
        const vp     = page.getViewport({ scale: 1.4 });
        canvas.width  = vp.width;
        canvas.height = vp.height;
        page.render({ canvasContext: ctx, viewport: vp });
      });
    });
  }, { rootMargin: '200px' });

  const frag = document.createDocumentFragment();
  pageTexts.forEach((pt, i) => {
    const wrap   = document.createElement('div');
    wrap.className    = 'page-wrap';
    wrap.dataset.page = i + 1;

    const label  = document.createElement('div');
    label.className   = 'page-label';
    label.textContent = 'PAGE ' + (i + 1);

    const canvas = document.createElement('canvas');
    canvas.style.width      = '100%';
    canvas.style.aspectRatio = '0.77';   // A4 proportion placeholder

    wrap.appendChild(canvas);
    wrap.appendChild(label);

    const captured = pt;
    wrap.addEventListener('mouseup',  () => handleSel(captured));
    wrap.addEventListener('touchend', () => setTimeout(() => handleSel(captured), 120));

    frag.appendChild(wrap);
    observer.observe(wrap);
  });
  $('book-pages').appendChild(frag);

  return pageTexts.join(' ');
}

// ── EPUB — parallel chapter extraction ───────────────────────
// All chapter files are read concurrently with Promise.all so I/O
// waiting on one chapter doesn't block the others.
async function loadEPUB(file) {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());

  // Resolve spine
  let opfPath = '';
  const cf = zip.file('META-INF/container.xml');
  if (cf) {
    const xml = await cf.async('text');
    const m   = xml.match(/full-path="([^"]+\.opf)"/i);
    if (m) opfPath = m[1];
  }

  let spine = [];
  if (opfPath) {
    const opfXml = await zip.file(opfPath).async('text');
    const doc    = new DOMParser().parseFromString(opfXml, 'application/xml');
    const base   = opfPath.includes('/') ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) : '';
    const mf     = {};
    doc.querySelectorAll('manifest item').forEach(el => { mf[el.getAttribute('id')] = base + el.getAttribute('href'); });
    doc.querySelectorAll('spine itemref').forEach(el => { const id = el.getAttribute('idref'); if (mf[id]) spine.push(mf[id]); });
  }
  if (!spine.length) {
    zip.forEach(p => { if (/\.(html|xhtml|htm)$/i.test(p)) spine.push(p); });
    spine.sort();
  }

  // Extract all chapters in parallel — each file parsed independently
  const chapterTexts = await Promise.all(
    spine.map(async path => {
      const f = zip.file(path);
      if (!f) return null;
      const html = await f.async('text');
      const tmp  = document.createElement('div');
      tmp.innerHTML = html;
      tmp.querySelectorAll('script,style,nav').forEach(n => n.remove());
      return (tmp.textContent || tmp.innerText).replace(/\s+/g, ' ').trim();
    })
  );

  const valid = chapterTexts.filter(Boolean);

  // Build sidebar (synchronous DOM work, already have all text)
  $('book-pages').innerHTML = '';
  const frag = document.createDocumentFragment();
  valid.forEach((ct, si) => {
    const wrap  = document.createElement('div');
    wrap.className = 'page-wrap'; wrap.style.background = 'var(--surface2)';

    const label = document.createElement('div');
    label.className = 'page-label'; label.textContent = 'CHAPTER ' + (si + 1);

    const td = document.createElement('div'); td.className = 'epub-text';
    ct.split(/(?<=[.!?])\s{2,}|\n\n+/).filter(p => p.trim().length > 2).forEach(p => {
      const el = document.createElement('p'); el.textContent = p.trim(); td.appendChild(el);
    });
    if (!td.children.length) { const p = document.createElement('p'); p.textContent = ct; td.appendChild(p); }

    wrap.appendChild(label); wrap.appendChild(td);

    const captured = ct;
    wrap.addEventListener('mouseup',  () => handleSel(captured));
    wrap.addEventListener('touchend', () => setTimeout(() => handleSel(captured), 120));

    frag.appendChild(wrap);
  });
  $('book-pages').appendChild(frag);

  return valid.join(' ');
}

// ── Start reader after words are loaded ───────────────────────
function startReader() {
  cursor = 0; sessionStart = null; totalReadMs = 0; wordsReadCount = 0; lastPlayStart = null;
  showScreen('reader-screen');
  $('reader-toolbar').style.display = 'flex';
  $('upload-toolbar').style.display = 'none';
  applyLayout();
  updateWord(); updateCounter(); showOverlay(true);
  setSidebar(!isMob());
}

// ── Selection jump ────────────────────────────────────────────
const jumpTip = $('jump-tip');

function handleSel(ctxText) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) { jumpTip.style.display = 'none'; return; }
  const txt = sel.toString().trim();
  if (!txt) { jumpTip.style.display = 'none'; return; }
  const fw = tokenize(txt)[0];
  if (!fw) return;

  const ctxWords    = tokenize(ctxText);
  const blockStart  = findBlockStart(ctxWords);
  const idx         = findWordFrom(norm(fw), blockStart);
  if (idx === -1) { jumpTip.style.display = 'none'; return; }

  pendingJump = idx;
  const range = sel.getRangeAt(0);
  const rect  = range.getBoundingClientRect();
  const left  = Math.max(70, Math.min(rect.left + rect.width / 2, window.innerWidth - 70));
  jumpTip.style.left    = left + 'px';
  jumpTip.style.top     = (rect.top - 46) + 'px';
  jumpTip.style.display = 'block';
}

// findBlockStart uses pre-built normWords[] — O(n) with no per-call norm() overhead
function findBlockStart(bw) {
  if (!bw.length) return 0;
  const t0 = norm(bw[0]), t1 = bw[1] ? norm(bw[1]) : null;
  for (let i = 0; i < normWords.length; i++) {
    if (normWords[i] === t0) {
      if (!t1 || (i + 1 < normWords.length && normWords[i + 1] === t1)) return i;
    }
  }
  return 0;
}

// findWordFrom uses pre-built normWords[] — O(n) with no per-call norm() overhead
function findWordFrom(nw, from) {
  for (let i = from; i < normWords.length; i++) if (normWords[i] === nw) return i;
  for (let i = 0; i < from; i++)               if (normWords[i] === nw) return i;
  return -1;
}

function norm(w) { return w.toLowerCase().replace(/[^a-z0-9]/g, ''); }

jumpTip.onclick = () => {
  if (pendingJump >= 0) {
    pause(); cursor = pendingJump; updateWord(); updateCounter();
    window.getSelection()?.removeAllRanges();
    jumpTip.style.display = 'none'; pendingJump = -1;
    if (isMob()) setSidebar(false);
    setTimeout(play, 150);
  }
};
document.addEventListener('mousedown', e => {
  if (!e.target.closest('#jump-tip')) jumpTip.style.display = 'none';
});

// ── Word display ──────────────────────────────────────────────
// Focus-letter HTML is built once per unique word and cached in a Map,
// so repeated words (the, a, and, …) cost only a Map lookup.
function buildFocusHTML(word) {
  if (focusHTMLCache.has(word)) return focusHTMLCache.get(word);
  const letterCount = word.replace(/[^a-zA-Z]/g, '').length;
  const target      = Math.floor(letterCount * 0.33);
  let lc = 0, html = '', done = false;
  for (const c of word) {
    if (!done && /[a-zA-Z]/.test(c)) {
      if (lc === target) { html += `<span class="fl">${c}</span>`; done = true; lc++; continue; }
      lc++;
    }
    html += c;
  }
  focusHTMLCache.set(word, html);
  return html;
}

function updateWord() {
  const el    = $('display-word');
  const chunk = words.slice(cursor, cursor + chunkSize).join(' ');

  if (focusOn && chunkSize === 1 && chunk.length > 1) {
    el.innerHTML = buildFocusHTML(chunk);
  } else {
    el.textContent = chunk || '—';
  }

  // Context words — read from words[] directly, no extra allocation
  const prevEl = $('ctx-prev'), nextEl = $('ctx-next');
  if (contextOn && words.length > 0) {
    const prev = cursor > 0                          ? words[cursor - 1]          : '';
    const next = cursor + chunkSize < words.length   ? words[cursor + chunkSize]  : '';
    prevEl.textContent = prev; prevEl.classList.toggle('visible', !!prev);
    nextEl.textContent = next; nextEl.classList.toggle('visible', !!next);
  } else {
    prevEl.textContent = ''; prevEl.classList.remove('visible');
    nextEl.textContent = ''; nextEl.classList.remove('visible');
  }
}

function updateCounter() {
  $('word-counter').textContent = `${cursor + 1} / ${words.length}`;
  const pct = words.length > 1 ? (cursor / (words.length - 1)) * 100 : 0;
  $('prog-bar').style.width = pct + '%';
}

function showOverlay(show) { $('overlay').classList.toggle('show', show); }

// ── Playback ──────────────────────────────────────────────────
// getDelay reads the last character of the last word in the chunk directly
// instead of slice+join+regex — no array or string allocation per tick.
function getDelay() {
  const base = 60000 / wpm;
  if (pausePunct) {
    const lastWord = words[cursor + chunkSize - 1] || '';
    const last     = lastWord[lastWord.length - 1];
    if (last === '.' || last === '!' || last === '?') return base * 3.5;
    if (last === ',' || last === ';' || last === ':') return base * 1.8;
  }
  return base * chunkSize;
}

function tick() {
  if (cursor >= words.length) {
    if (lastPlayStart) { totalReadMs += Date.now() - lastPlayStart; lastPlayStart = null; }
    playing = false; clearTimeout(timer);
    setPlayState(false);
    showStats();
    return;
  }
  updateWord(); updateCounter();
  wordsReadCount += chunkSize;
  cursor += chunkSize;
  timer = setTimeout(tick, getDelay());
}

function play() {
  if (playing) return;
  if (cursor >= words.length) cursor = 0;
  playing       = true;
  lastPlayStart = Date.now();
  if (!sessionStart) sessionStart = Date.now();
  setPlayState(true);
  showOverlay(false);
  tick();
}

function pause() {
  if (playing && lastPlayStart) {
    totalReadMs += Date.now() - lastPlayStart;
    if (adaptiveOn) {
      const secs = (Date.now() - lastPlayStart) / 1000;
      if (secs < 4 && wordsReadCount > 0) { setWPM(wpm - 10); showAdaptToast('↓ Speed reduced'); }
      else if (secs > 25)                 { setWPM(wpm + 10); showAdaptToast('↑ Speed increased'); }
    }
    lastPlayStart = null;
  }
  playing = false; clearTimeout(timer);
  setPlayState(false);
  showOverlay(true);
}

function showAdaptToast(msg) {
  const t = $('adapt-toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(adaptToastTimer);
  adaptToastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

function setPlayState(on) {
  const label     = on ? 'PAUSE' : 'PLAY';
  const pillLabel = on ? 'PLAYING' : 'PAUSED';
  $('play-btn').textContent = label;
  $('m-play').textContent   = label;
  $('pill').textContent   = pillLabel; $('pill').classList.toggle('on', on);
  $('m-pill').textContent = pillLabel; $('m-pill').classList.toggle('on', on);
}

function togglePlay() { playing ? pause() : play(); }

// ── WPM ───────────────────────────────────────────────────────
function syncWPM() {
  $('wpm-num').textContent  = wpm; $('wpm-range').value  = wpm;
  $('m-wnum').textContent   = wpm; $('m-wrange').value   = wpm;
}
function setWPM(v) { wpm = Math.max(50, Math.min(1000, v)); syncWPM(); }

// ── Stats ─────────────────────────────────────────────────────
function showStats() {
  const totalSec = Math.round(totalReadMs / 1000);
  const mins     = Math.floor(totalSec / 60);
  const secs     = totalSec % 60;
  const timeStr  = mins > 0 ? `${mins}m ${secs}s` : `${totalSec}s`;
  const avgWpm   = totalReadMs > 0 ? Math.round(wordsReadCount / (totalReadMs / 60000)) : wpm;
  $('stat-wpm').textContent   = avgWpm;
  $('stat-time').textContent  = timeStr || '—';
  $('stat-words').textContent = words.length;
  $('stats-overlay').classList.add('show');
  showOverlay(false);
}

$('stats-again').onclick = () => {
  $('stats-overlay').classList.remove('show');
  cursor = 0; sessionStart = null; totalReadMs = 0; wordsReadCount = 0; lastPlayStart = null;
  updateWord(); updateCounter(); showOverlay(true);
};

// ── Desktop controls ──────────────────────────────────────────
$('play-btn').onclick      = togglePlay;
$('restart-btn').onclick   = () => { pause(); cursor = 0; updateWord(); updateCounter(); };
$('skip-back-btn').onclick = () => { cursor = Math.max(0, cursor - 10); if (!playing) { updateWord(); updateCounter(); } };
$('skip-fwd-btn').onclick  = () => { cursor = Math.min(words.length - 1, cursor + 10); if (!playing) { updateWord(); updateCounter(); } };
$('wpm-dec').onclick       = () => setWPM(wpm - 25);
$('wpm-inc').onclick       = () => setWPM(wpm + 25);
$('wpm-range').oninput     = e  => setWPM(+e.target.value);
$('close-btn-desk').onclick= closeReader;

// ── Mobile controls ───────────────────────────────────────────
$('m-play').onclick    = togglePlay;
$('m-restart').onclick = () => { pause(); cursor = 0; updateWord(); updateCounter(); };
$('m-back').onclick    = () => { cursor = Math.max(0, cursor - 10); if (!playing) { updateWord(); updateCounter(); } };
$('m-fwd').onclick     = () => { cursor = Math.min(words.length - 1, cursor + 10); if (!playing) { updateWord(); updateCounter(); } };
$('m-wdec').onclick    = () => setWPM(wpm - 25);
$('m-winc').onclick    = () => setWPM(wpm + 25);
$('m-wrange').oninput  = e  => setWPM(+e.target.value);
$('close-btn-mob').onclick = closeReader;

// ── Word area click ───────────────────────────────────────────
$('word-area').onclick = e => {
  if (e.target.closest('.prog-wrap')) return;
  if (isMob() && sidebarOpen) { setSidebar(false); return; }
  togglePlay();
};

// ── Keyboard ──────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (!$('reader-screen').classList.contains('active')) return;
  if (e.code === 'Space')      { e.preventDefault(); togglePlay(); }
  if (e.code === 'ArrowRight') { cursor = Math.min(words.length - 1, cursor + 10); updateWord(); updateCounter(); }
  if (e.code === 'ArrowLeft')  { cursor = Math.max(0, cursor - 10);                updateWord(); updateCounter(); }
  if (e.code === 'ArrowUp')    setWPM(wpm + 25);
  if (e.code === 'ArrowDown')  setWPM(wpm - 25);
});

// ── Close ─────────────────────────────────────────────────────
function closeReader() {
  pause(); words = []; normWords = []; cursor = 0;
  sessionStart = null; totalReadMs = 0; wordsReadCount = 0; lastPlayStart = null;
  focusHTMLCache.clear();
  $('stats-overlay').classList.remove('show');
  $('book-pages').innerHTML = '';
  fileInput.value = '';
  dropZone.querySelector('h2').textContent = 'Drop your book here';
  $('reader-toolbar').style.display = 'none';
  $('upload-toolbar').style.display = 'flex';
  setSidebar(false);
  showScreen('upload-screen');
}

// ── Init ──────────────────────────────────────────────────────
lucide.createIcons();
applyLayout();
