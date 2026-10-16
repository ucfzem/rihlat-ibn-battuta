'use strict';

const DATA_URL = './data/chapters.json';
const app = document.getElementById('app');

let BOOK = null;
let chapters = [];
let flat = null;              // [{ci, pi, norm}] for full-text search
let currentQuery = '';        // active in-chapter search term (raw)
let occMarks = [];            // current <mark> occurrences in reader
let occCur = -1;              // index of current occurrence

/* ---------- Arabic text helpers ---------- */
const DIAC = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/;

function normalize(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (DIAC.test(c)) continue;
    if (c === 'إ' || c === 'أ' || c === 'آ' || c === 'ٱ') out += 'ا';
    else if (c === 'ى') out += 'ي';
    else if (c === 'ؤ') out += 'و';
    else if (c === 'ئ') out += 'ي';
    else if (c === 'ة') out += 'ه';
    else out += c.toLowerCase();
  }
  return out;
}

// normalized string + map from normalized index -> original index
function buildNormMap(text) {
  const out = [];
  const map = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (DIAC.test(c)) continue;
    let n = c;
    if (c === 'إ' || c === 'أ' || c === 'آ' || c === 'ٱ') n = 'ا';
    else if (c === 'ى') n = 'ي';
    else if (c === 'ؤ') n = 'و';
    else if (c === 'ئ') n = 'ي';
    else if (c === 'ة') n = 'ه';
    else n = c.toLowerCase();
    out.push(n);
    map.push(i);
  }
  return { out: out.join(''), map };
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// wrap every occurrence of normalized query in <mark class="hl">
function highlight(text, nq) {
  if (!nq) return { html: esc(text), count: 0 };
  const { out, map } = buildNormMap(text);
  let idx = out.indexOf(nq);
  if (idx === -1) return { html: esc(text), count: 0 };
  const segs = [];
  let last = 0, count = 0;
  while (idx !== -1) {
    const s = map[idx];
    const e = map[idx + nq.length - 1] + 1;
    if (s > last) segs.push({ t: text.slice(last, s), m: false });
    segs.push({ t: text.slice(s, e), m: true });
    last = e; count++;
    idx = out.indexOf(nq, idx + nq.length);
  }
  if (last < text.length) segs.push({ t: text.slice(last), m: false });
  return { html: segs.map(x => (x.m ? '<mark class="hl">' + esc(x.t) + '</mark>' : esc(x.t))).join(''), count };
}

function snippet(text, nq) {
  const { out, map } = buildNormMap(text);
  const idx = out.indexOf(nq);
  if (idx === -1) return esc(text.slice(0, 140));
  const start = map[idx];
  const a = Math.max(0, start - 70);
  const b = Math.min(text.length, start + nq.length + 110);
  const { html } = highlight(text.slice(a, b), nq);
  return (a > 0 ? '… ' : '') + html + (b < text.length ? ' …' : '');
}

/* ---------- theme + font ---------- */
function setupTheme() {
  const btn = document.getElementById('themeToggle');
  if (!btn) return;
  const cur = () => document.documentElement.getAttribute('data-theme') || 'light';
  const update = () => { btn.textContent = cur() === 'dark' ? '☀️' : '🌙'; };
  update();
  btn.addEventListener('click', () => {
    const next = cur() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    update();
    try { localStorage.setItem('rihla_theme', next); } catch (e) {}
  });
}

let fontSize = 1;
try { fontSize = parseFloat(localStorage.getItem('rihla_font')) || 1; } catch (e) {}
function applyFontSize() {
  document.documentElement.style.setProperty('--content-font-size', fontSize + 'rem');
  try { localStorage.setItem('rihla_font', String(fontSize)); } catch (e) {}
}
function fontControlsHTML() {
  return '<span class="font-row">' +
    '<button type="button" id="fontDec" title="تصغير الخط">A−</button>' +
    '<button type="button" id="fontReset" title="الخط الافتراضي">A</button>' +
    '<button type="button" id="fontInc" title="تكبير الخط">A+</button>' +
    '</span>';
}
function setupFontControls() {
  const d = document.getElementById('fontDec');
  const r = document.getElementById('fontReset');
  const i = document.getElementById('fontInc');
  if (d) d.onclick = () => { if (fontSize > 0.8) { fontSize = Math.round((fontSize - 0.1) * 10) / 10; applyFontSize(); } };
  if (r) r.onclick = () => { fontSize = 1; applyFontSize(); };
  if (i) i.onclick = () => { if (fontSize < 1.8) { fontSize = Math.round((fontSize + 0.1) * 10) / 10; applyFontSize(); } };
}
applyFontSize();

/* ---------- data ---------- */
async function loadData() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch(DATA_URL, { signal: ctrl.signal, cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    BOOK = await res.json();
    chapters = BOOK.chapters || [];
    if (!chapters.length) throw new Error('empty');
  } finally { clearTimeout(timer); }
}

function buildFlat() {
  if (flat) return flat;
  flat = [];
  chapters.forEach((ch, ci) => {
    ch.content.forEach((p, pi) => flat.push({ ci, pi, norm: normalize(p) }));
  });
  return flat;
}

/* ---------- reader ---------- */
function renderReader(id) {
  const ch = chapters[id - 1];
  if (!ch) return renderHome();
  try { localStorage.setItem('rihla_last', String(id)); } catch (e) {}

  const nq = normalize(currentQuery);
  let total = 0;
  const body = ch.content.map(p => {
    const r = highlight(p, nq);
    total += r.count;
    return '<p>' + r.html + '</p>';
  }).join('');

  const prev = id > 1 ? id - 1 : null;
  const next = id < chapters.length ? id + 1 : null;

  app.innerHTML =
    '<div class="topnav">' + fontControlsHTML() +
      '<button id="copyBtn" type="button">📋 نسخ الفصل</button>' +
      '<button id="homeBtn" type="button">🏠 الفهرس</button>' +
    '</div>' +
    '<div class="searchbar">' +
      '<input id="chapSearch" type="search" placeholder="ابحث في هذا الفصل…" value="' + esc(currentQuery) + '" autocomplete="off">' +
      '<span class="counter" id="occCount">' + (nq ? '٠ / ٠' : '') + '</span>' +
      '<button type="button" class="navbtn" id="occNext" title="النتيجة التالية">▼</button>' +
      '<button type="button" class="navbtn" id="occPrev" title="النتيجة السابقة">▲</button>' +
      '<button type="button" class="clearbtn" id="clearSearch" title="مسح البحث">✕</button>' +
    '</div>' +
    '<div class="card" id="chapterCard">' +
      '<div class="kicker">' + esc(BOOK.meta.author) + ' · الباب ' + id + ' من ' + chapters.length + '</div>' +
      '<h2>' + esc(ch.title) + '</h2>' +
      body +
    '</div>' +
    '<div class="pager">' +
      '<button id="prevBtn"' + (prev ? '' : ' disabled') + '>→ السابق</button>' +
      '<span>الباب ' + id + ' من ' + chapters.length + '</span>' +
      '<button id="nextBtn"' + (next ? '' : ' disabled') + '>التالي ←</button>' +
    '</div>';

  if (prev) document.getElementById('prevBtn').onclick = () => go('#/read/' + prev);
  if (next) document.getElementById('nextBtn').onclick = () => go('#/read/' + next);
  document.getElementById('homeBtn').onclick = () => go('#/');
  document.getElementById('copyBtn').onclick = (e) => copyText(ch.title + '\n\n' + ch.content.join('\n\n'), e.currentTarget);
  setupFontControls();

  const input = document.getElementById('chapSearch');
  input.oninput = debounce(() => {
    currentQuery = input.value.trim();
    renderReader(id);
    const box = document.getElementById('chapSearch');
    if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
  }, 220);
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); goOcc(e.shiftKey ? -1 : 1); }
  };
  document.getElementById('clearSearch').onclick = () => {
    currentQuery = '';
    renderReader(id);
    const box = document.getElementById('chapSearch');
    if (box) box.focus();
  };
  document.getElementById('occNext').onclick = () => goOcc(1);
  document.getElementById('occPrev').onclick = () => goOcc(-1);

  collectMarks();
}

function collectMarks() {
  occMarks = Array.from(document.querySelectorAll('#chapterCard mark.hl'));
  occCur = occMarks.length ? 0 : -1;
  paintMarks(false);
}
function paintMarks(scroll) {
  occMarks.forEach(m => m.classList.remove('hl-cur'));
  const cEl = document.getElementById('occCount');
  const prevB = document.getElementById('occPrev');
  const nextB = document.getElementById('occNext');
  const has = occMarks.length > 0;
  if (prevB) prevB.disabled = !has;
  if (nextB) nextB.disabled = !has;
  if (has && occCur >= 0) {
    const m = occMarks[occCur];
    m.classList.add('hl-cur');
    if (scroll) m.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (cEl) cEl.textContent = toArabicDigits(occCur + 1) + ' / ' + toArabicDigits(occMarks.length);
  } else if (cEl) {
    cEl.textContent = normalize(currentQuery) ? '٠ / ٠' : '';
  }
}
function goOcc(delta) {
  if (!occMarks.length) return;
  occCur = (occCur + delta + occMarks.length) % occMarks.length;
  paintMarks(true);
}

/* ---------- home / TOC / global search ---------- */
function renderHome() {
  let resume = null;
  try { resume = localStorage.getItem('rihla_last'); } catch (e) {}
  const resumeBtn = (resume && chapters[resume - 1])
    ? '<button id="resumeBtn" type="button">↩️ متابعة القراءة — الباب ' + resume + '</button>' : '';

  app.innerHTML =
    '<div class="topnav">' + fontControlsHTML() + resumeBtn + '</div>' +
    '<div class="home">' +
      '<h1>🧭 رحلة ابن بطوطة</h1>' +
      '<p class="desc">«تحفة النظار في غرائب الأمصار وعجائب الأسفار»: رحلة ابن بطوطة (ت 779هـ) من طنجة إلى الصين وعودته إلى المغرب، ' +
        'النص الكامل في ' + chapters.length + ' باباً. ابحث في الكتاب كله في الوقت نفسه، وستُلوَّن النتائج بالأخضر مع عدّاد وتنقّل بين المواضع.</p>' +
      '<div class="searchbar">' +
        '<input id="globalSearch" type="search" placeholder="ابحث في الكتاب كله…" autocomplete="off">' +
        '<button type="button" class="clearbtn" id="clearGlobal" title="مسح">✕</button>' +
      '</div>' +
      '<div class="results" id="searchResults" hidden></div>' +
      '<div id="tocWrap">' +
        '<h2>الأبواب</h2>' +
        '<div class="toc">' +
          chapters.map(ch =>
            '<button type="button" class="toc-item" data-id="' + ch.id + '">' +
              '<span class="num">' + toArabicDigits(ch.id) + '</span><span>' + esc(ch.title) + '</span>' +
            '</button>').join('') +
        '</div>' +
      '</div>' +
    '</div>';

  setupFontControls();
  if (resume && chapters[resume - 1]) {
    document.getElementById('resumeBtn').onclick = () => go('#/read/' + resume);
  }
  app.querySelectorAll('.toc-item').forEach(b => {
    b.onclick = () => { currentQuery = ''; go('#/read/' + b.dataset.id); };
  });

  const gi = document.getElementById('globalSearch');
  const resultsEl = document.getElementById('searchResults');
  const tocWrap = document.getElementById('tocWrap');
  gi.oninput = debounce(() => {
    const q = gi.value.trim();
    const nq = normalize(q);
    if (nq.length < 2) {
      resultsEl.hidden = true; resultsEl.innerHTML = '';
      tocWrap.hidden = false;
      return;
    }
    tocWrap.hidden = true;
    const hits = globalSearch(nq);
    if (!hits.length) {
      resultsEl.hidden = false;
      resultsEl.innerHTML = '<p class="empty">لا نتائج عن «' + esc(q) + '».</p>';
      return;
    }
    const shown = hits.slice(0, 150);
    resultsEl.hidden = false;
    resultsEl.innerHTML =
      '<p class="empty">' + toArabicDigits(hits.length) + ' موضعاً في ' + toArabicDigits(new Set(hits.map(h => h.e.ci)).size) + ' باباً' +
        (hits.length > shown.length ? ' (تُعرض أول ' + toArabicDigits(shown.length) + ')' : '') + ':</p>' +
      shown.map((h, i) =>
        '<div class="result" data-i="' + i + '">' +
          '<div class="rtitle">الباب ' + toArabicDigits(chapters[h.e.ci].id) + ' — ' + esc(chapters[h.e.ci].title) + '</div>' +
          '<div class="rsnip">' + snippet(chapters[h.e.ci].content[h.e.pi], nq) + '</div>' +
        '</div>').join('');
    resultsEl.querySelectorAll('.result').forEach((el) => {
      el.onclick = () => {
        const h = shown[Number(el.dataset.i)];
        currentQuery = q;
        go('#/read/' + chapters[h.e.ci].id);
      };
    });
  }, 200);
  document.getElementById('clearGlobal').onclick = () => {
    gi.value = ''; gi.dispatchEvent(new Event('input')); gi.focus();
  };
}

function globalSearch(nq) {
  const idx = buildFlat();
  const hits = [];
  for (let i = 0; i < idx.length; i++) {
    const e = idx[i];
    if (e.norm.indexOf(nq) !== -1) {
      hits.push({ e });
      if (hits.length >= 400) break;
    }
  }
  return hits;
}

/* ---------- misc ---------- */
function toArabicDigits(n) {
  return String(n).replace(/[0-9]/g, d => '٠١٢٣٤٥٦٧٨٩'[d]);
}
function debounce(fn, ms) {
  let t;
  return function (...a) { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), ms); };
}
function copyText(text, btn) {
  const done = () => { if (!btn) return; btn.textContent = '✓ تم النسخ'; btn.classList.add('copied'); setTimeout(() => { if (btn.isConnected) { btn.textContent = '📋 نسخ الفصل'; btn.classList.remove('copied'); } }, 1600); };
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { if (btn) btn.textContent = '⚠️ تعذّر النسخ'; }
    document.body.removeChild(ta);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
  else fallback();
}

/* ---------- routing ---------- */
function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}
function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const m = /^read\/(\d+)/.exec(h);
  if (m) return { view: 'read', id: parseInt(m[1], 10) };
  return { view: 'home' };
}
function route() {
  const r = parseHash();
  if (r.view === 'read' && chapters[r.id - 1]) renderReader(r.id);
  else renderHome();
  window.scrollTo(0, 0);
}

function renderError() {
  app.innerHTML =
    '<div class="home">' +
      '<p class="empty">⚠️ تعذّر تحميل نص الكتاب. تحقّق من اتصالك ثم أعد المحاولة.</p>' +
      '<p><button id="retryBtn" type="button" class="toc-item" style="display:inline-block">↻ إعادة المحاولة</button></p>' +
    '</div>';
  document.getElementById('retryBtn').onclick = () => init();
}

async function init() {
  setupTheme();
  app.innerHTML = '<div class="home"><p class="empty">⏳ جارٍ تحميل نص الكتاب…</p></div>';
  try {
    await loadData();
  } catch (e) {
    renderError();
    return;
  }
  if (!location.hash) {
    window.addEventListener('hashchange', route);
  }
  route();
}
window.addEventListener('hashchange', route);
init();
