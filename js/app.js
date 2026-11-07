import * as db from './db.js';
import { refreshInstalledApp } from './updates.js';
import { BookReader } from './book-reader.js';
import { openAudiobookZip } from './audiobook-zip.js';
import { createNarrationJob, readNarrationPackage, validateManifest, NarrationPlayer } from './narration.js';
import {
  buildIndex, buildSegments, chunkAt, estimateMs, formatDuration, lowerBound, rampFactor, splitAtPivot, tokenize, wordDelay,
} from './engine.js';
import { ImportError, finishPdf, importFile, textToBook } from './importers.js';
import { defaultCleanOptions, parsePageList } from './pdfclean.js';
import { anchorPosition, blockChoice, CLEAN_ROLES, cleanBook, defaultBookOptions, positionAnchor } from './bookclean.js';
import { computeStreaks, monthGrid } from './streaks.js';
import {
  SOUND_OPTIONS, analyzeTrack, dropTrack, playSound, setTrackLevel, setTrackSource, setVolume, stopSound, unlockAudio,
} from './sounds.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const fmt = n => Math.round(n).toLocaleString('en-US');

const ICON = {
  back: '<path d="M15 5l-7 7 7 7"/>', plus: '<path d="M12 5v14M5 12h14"/>',
  chart: '<path d="M5 20v-7M12 20V5M19 20v-11"/>',
  gear: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>', list: '<path d="M4 7h16M4 12h16M4 17h10"/>',
  mark: '<path d="M7 4h10v16l-5-4-5 4z"/>', sound: '<path d="M4 10v4h3l5 4V6L7 10zM16 9a4 4 0 010 6M18.5 6.5a8 8 0 010 11"/>',
  book: '<path d="M12 5v15M3 4c3-1 6-1 9 1 3-2 6-2 9-1v15c-3-1-6-1-9 1-3-2-6-2-9-1z"/>',
  back10: '<path d="M4 12a8 8 0 108-8H8"/><path d="M11 1L8 4l3 3"/>',
  minus: '<path d="M5 12h14"/>', trash: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>',
  play: '<path d="M7 4.5v15l13-7.5z"/>', pause: '<rect x="6" y="4.5" width="4.5" height="15" rx="1"/><rect x="13.5" y="4.5" width="4.5" height="15" rx="1"/>',
};
const icon = name => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICON[name]}</svg>`;

/* ---------- Settings ---------- */
const THEMES = {
  tide: { name: 'Tide', bg: '#0C2533', ink: '#DCE9E6', hi: '#FFB347' },
  oled: { name: 'Black', bg: '#000000', ink: '#D9D9D9', hi: '#FF5A4F' },
  dusk: { name: 'Dusk', bg: '#221B33', ink: '#E8E1F2', hi: '#7FE3C5' },
  moss: { name: 'Moss', bg: '#18241C', ink: '#DDE6D3', hi: '#E9C46A' },
  paper: { name: 'Paper', bg: '#F7F8F5', ink: '#1D2526', hi: '#C81E5B' },
  sepia: { name: 'Sepia', bg: '#EBDDC3', ink: '#3B2F20', hi: '#B3261E' },
  fog: { name: 'Fog', bg: '#DDE3E6', ink: '#1F2A30', hi: '#0B62B8' },
  custom: { name: 'Custom' },
};
const FONTS = {
  newyork: ['New York', "ui-serif, Georgia, 'Lora', serif"],
  iowan: ['Iowan Old Style', "'Iowan Old Style', Georgia, 'Lora', serif"],
  georgia: ['Georgia', "Georgia, 'Lora', serif"],
  charter: ['Charter', "Charter, Georgia, 'Lora', serif"],
  palatino: ['Palatino', "Palatino, 'Palatino Linotype', Georgia, serif"],
  baskerville: ['Baskerville', 'Baskerville, Georgia, serif'],
  literata: ['Literata', "Literata, Georgia, serif"],
  sf: ['San Francisco', "-apple-system, system-ui, 'Inter', sans-serif"],
  rounded: ['SF Rounded', "ui-rounded, -apple-system, system-ui, sans-serif"],
  avenir: ['Avenir Next', "'Avenir Next', -apple-system, sans-serif"],
  helvetica: ['Helvetica Neue', "'Helvetica Neue', Arial, sans-serif"],
  verdana: ['Verdana', 'Verdana, sans-serif'],
  lexend: ['Lexend', 'Lexend, -apple-system, sans-serif'],
  atkinson: ['Atkinson Hyperlegible', "'Atkinson Hyperlegible', -apple-system, sans-serif"],
  dyslexic: ['OpenDyslexic', 'OpenDyslexic, -apple-system, sans-serif'],
  mono: ['Menlo', "ui-monospace, Menlo, 'DejaVu Sans Mono', monospace"],
};
const DOWNLOADED_FONTS = { lexend: 'Lexend', atkinson: 'Atkinson Hyperlegible', dyslexic: 'OpenDyslexic', literata: 'Literata' };
const fontOptions = Object.entries(FONTS).map(([k, v]) => [k, v[0]]);

const DEFAULTS = {
  theme: 'tide', customBg: '#102A2A', customInk: '#E6EFE8', customHi: '#FF9F5A',
  wordFont: 'newyork', wordSize: 48, wordWeight: 500, wordY: 42, pivotX: 50, pivotMode: 'orp', pivotStyle: 'color',
  guides: true, guideDist: 100, wordsPerFlash: 1, liveProgress: true, liveText: false, chapterCall: true,
  textFont: 'iowan', textSize: 19, textLead: 1.6, textMargin: 22, textAlign: 'left',
  textWeight: 400, bookIndent: true, bookAnimation: true, bookDim: 0, bookProgress: 'page',
  wpm: 300, wpmStep: 25, wpmMin: 50, wpmMax: 1500, perBookWpm: true, countdown: 3, ramp: 5, rewind: 10, resumeBack: 0,
  smartPacing: true, commaPause: 1.4, sentencePause: 1.9, paragraphPause: 2.2, longWordPause: 1, chapterPause: 1500,
  sound: 'off', volume: 0.5, soundMode: 'reading', hiddenSounds: [], backupTracks: true, backupNarration: true,
  dailyGoal: 10, weekGoalDays: 1, weekStart: 0,
  swipeSize: 36, openLast: true, keepAwake: true,
};
let S = { ...DEFAULTS };

const pct = v => `${Math.round(v * 100)}%`;
const GOAL_SETTINGS = [
  { k: 'dailyGoal', label: 'Daily minimum', help: 'Read at least this long for a day to count toward your streak.', type: 'range', min: 1, max: 120, step: 1, unit: ' min' },
  { k: 'weekGoalDays', label: 'Goal days for a week to count', type: 'range', min: 1, max: 7, step: 1 },
  { k: 'weekStart', label: 'Weeks start on', type: 'select', num: true, options: [[0, 'Sunday'], [1, 'Monday']] },
];
const SETTINGS = [
  ['Colors', [{ type: 'themes' }, { type: 'custom' }]],
  ['RSVP word', [
    { k: 'wordFont', label: 'Font', type: 'select', options: fontOptions },
    { k: 'wordSize', label: 'Word size', type: 'range', min: 24, max: 96, step: 1, unit: ' pt' },
    { k: 'wordWeight', label: 'Weight', type: 'select', options: [[300, 'Light'], [400, 'Regular'], [500, 'Medium'], [600, 'Semibold'], [700, 'Bold']], num: true },
    { k: 'pivotMode', label: 'Highlighted letter', help: 'Best spot sits slightly left of center, where word recognition tends to be fastest.', type: 'select', options: [['orp', 'Best spot'], ['middle', 'True middle']] },
    { k: 'pivotStyle', label: 'Highlight style', type: 'select', options: [['color', 'Color'], ['bold', 'Color and bold'], ['underline', 'Color and underline'], ['plain', 'None']] },
    { k: 'guides', label: 'Focus marks', help: 'Two small marks above and below the highlighted letter.', type: 'toggle' },
    { k: 'guideDist', label: 'Focus mark distance', help: 'How far the marks sit from the word. 100% is the standard distance.', type: 'range', min: 100, max: 200, step: 5, unit: '%' },
    { k: 'pivotX', label: 'Horizontal position', help: '50% puts the highlighted letter in the center of the screen.', type: 'range', min: 25, max: 65, step: 1, unit: '%' },
    { k: 'wordY', label: 'Vertical position', type: 'range', min: 20, max: 70, step: 1, unit: '%' },
    { k: 'wordsPerFlash', label: 'Words per flash', type: 'range', min: 1, max: 5, step: 1 },
    { k: 'liveProgress', label: 'Progress line while reading', type: 'toggle' },
    { k: 'liveText', label: 'Time left while reading', type: 'toggle' },
    { k: 'chapterCall', label: 'Show chapter names while reading', type: 'toggle' },
  ]],
  ['Scrolling text', [
    { k: 'textFont', label: 'Font', type: 'select', options: fontOptions },
    { k: 'textSize', label: 'Text size', type: 'range', min: 13, max: 34, step: 1, unit: ' pt' },
    { k: 'textLead', label: 'Line spacing', type: 'range', min: 1.2, max: 2.2, step: 0.05, fixed: 2 },
    { k: 'textMargin', label: 'Side margins', type: 'range', min: 8, max: 56, step: 2, unit: ' pt' },
    { k: 'textAlign', label: 'Alignment', type: 'select', options: [['left', 'Left'], ['justify', 'Justified']] },
  ]],
  ['Speed', [
    { k: 'wpm', label: 'Speed for new books', type: 'range', min: 50, max: 1500, step: 25, unit: ' WPM' },
    { k: 'wpmStep', label: 'Speed change per step', type: 'range', min: 5, max: 100, step: 5, unit: ' WPM' },
    { k: 'swipeSize', label: 'Swipe distance per step', type: 'range', min: 16, max: 80, step: 2, unit: ' pt' },
    { k: 'perBookWpm', label: 'Remember speed for each book', type: 'toggle' },
    { k: 'countdown', label: 'Countdown before reading', type: 'range', min: 0, max: 5, step: 1, unit: ' s' },
    { k: 'ramp', label: 'Ease up to speed over', type: 'range', min: 0, max: 30, step: 1, unit: ' words' },
    { k: 'rewind', label: 'Words to rewind on a flick', type: 'range', min: 3, max: 60, step: 1 },
    { k: 'resumeBack', label: 'Back up when resuming', type: 'range', min: 0, max: 20, step: 1, unit: ' words' },
  ]],
  ['Pacing', [
    { k: 'smartPacing', label: 'Natural pauses', help: 'Pauses make your actual speed a little slower than the set WPM.', type: 'toggle' },
    { k: 'commaPause', label: 'Commas and dashes', type: 'range', min: 1, max: 3, step: 0.1, fixed: 1, unit: '×' },
    { k: 'sentencePause', label: 'Sentence endings', type: 'range', min: 1, max: 4, step: 0.1, fixed: 1, unit: '×' },
    { k: 'paragraphPause', label: 'Paragraph endings', type: 'range', min: 1, max: 5, step: 0.1, fixed: 1, unit: '×' },
    { k: 'longWordPause', label: 'Extra time for long words', type: 'range', min: 0, max: 2, step: 0.1, format: pct },
    { k: 'chapterPause', label: 'Pause between chapters', type: 'range', min: 0, max: 5000, step: 250, format: v => `${(v / 1000).toFixed(2).replace(/0$/, '')} s` },
  ]],
  ['Ambient sound', [
    { type: 'tracks' },
    { k: 'volume', label: 'Volume', type: 'range', min: 0, max: 1, step: 0.05, format: pct },
    { k: 'soundMode', label: 'Play', type: 'select', options: [['reading', 'Only while reading'], ['reader', 'Whenever a book is open']] },
  ]],
  ['Reading goal', GOAL_SETTINGS],
  ['Controls', [
    { k: 'keepAwake', label: 'Keep the screen on while reading', type: 'toggle' },
    { k: 'openLast', label: 'Open your last book on launch', type: 'toggle' },
  ]],
];

function themeColors() {
  if (S.theme === 'custom') return { bg: S.customBg, ink: S.customInk, hi: S.customHi };
  return THEMES[S.theme] || THEMES.tide;
}
function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  return (0.2126 * (n >> 16 & 255) + 0.7152 * (n >> 8 & 255) + 0.0722 * (n & 255)) / 255;
}
function applySettings() {
  const root = document.documentElement;
  const c = themeColors();
  const vars = {
    '--bg': c.bg, '--ink': c.ink, '--hi': c.hi,
    '--word-font': FONTS[S.wordFont]?.[1], '--word-size': `${S.wordSize}px`, '--word-weight': S.wordWeight,
    '--word-y': `${S.wordY}%`, '--pivot-x': `${S.pivotX}%`,
    '--guide-dist': S.guideDist / 100, '--guide-shift': S.guides ? (S.guideDist / 100 - 1) * 0.86 : 0,
    '--text-font': FONTS[S.textFont]?.[1], '--text-size': `${S.textSize}px`, '--text-lead': S.textLead,
    '--text-margin': `${S.textMargin}px`, '--text-align': S.textAlign, '--text-weight': S.textWeight,
    '--book-indent': S.bookIndent ? '1.2em' : '0', '--book-dim': S.bookDim || 0,
  };
  Object.entries(vars).forEach(([k, v]) => root.style.setProperty(k, v));
  root.dataset.pivot = S.pivotStyle;
  root.dataset.guides = S.guides ? 'on' : 'off';
  root.dataset.liveprogress = S.liveProgress ? 'on' : 'off';
  root.dataset.livetext = S.liveText ? 'on' : 'off';
  if (luminance(c.bg) > 0.5) root.setAttribute('data-light', ''); else root.removeAttribute('data-light');
  $('meta[name=theme-color]').content = c.bg;
  if (R) renderWord(R.lastText || R.words[R.pos] || '');
  if (R?.bookView) {
    const owner = R, anchor = R.pos;
    clearTimeout(R.bookReflowTimer);
    R.bookReflowTimer = setTimeout(() => { if (R === owner) R.bookView?.reflow(anchor); }, 60);
  }
  for (const key of [S.wordFont, S.textFont]) {
    if (!DOWNLOADED_FONTS[key]) continue;
    document.fonts.load(`16px "${DOWNLOADED_FONTS[key]}"`).then(found => {
      if (!found.length) toast(`${DOWNLOADED_FONTS[key]} needs an internet connection the first time.`);
    }).catch(() => {});
  }
}
let saveTimer;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => db.put('kv', S, 'settings').catch(() => {}), 200);
}

/* ---------- Shared UI ---------- */
let toastTimer;
function toast(message, ms = 2600) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), ms);
}
const activeScrim = () => $('#sheets > .scrim:not(.leaving)');
let sheetClose = null;
let blockScrim = false;

function openSheet(title, bodyHTML, { tall = false, onClose } = {}) {
  const root = $('#sheets');
  const replacing = !!activeScrim();
  const previousClose = sheetClose;
  sheetClose = null;
  root.innerHTML = '';
  previousClose?.();
  root.innerHTML = `<div class="scrim ${replacing ? 'swap' : ''}"><section class="sheet ${tall ? 'tall' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <header class="sheet-head"><h2>${esc(title)}</h2><button class="icon-btn" data-close aria-label="Close">${icon('close')}</button></header>
    <div class="sheet-slot" style="display:contents">${bodyHTML}</div></section></div>`;
  sheetClose = onClose || null;
  const scrim = $('.scrim', root);
  const sheet = $('.sheet', root);
  scrim.addEventListener('click', e => {
    if (e.target === scrim && blockScrim) return;
    if (e.target === scrim || e.target.closest('[data-close]')) closeSheet();
  });
  bindSheetDrag(sheet);
  return sheet;
}
function closeSheet() {
  const scrim = activeScrim();
  if (!scrim) return;
  scrim.classList.remove('swap');
  const sheet = $('.sheet', scrim);
  sheet.classList.remove('dragging', 'settling');
  scrim.classList.add('leaving');
  const remove = () => scrim.remove();
  scrim.addEventListener('animationend', e => { if (e.target === scrim) remove(); });
  setTimeout(remove, reducedMotion() ? 0 : 320);
  if (sheetClose) { const fn = sheetClose; sheetClose = null; fn(); }
}
// Drag the top of a sheet down to dismiss it.
function bindSheetDrag(sheet) {
  const head = $('.sheet-head', sheet);
  let start = null;
  head.addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;
    start = { y: e.clientY, t: performance.now(), id: e.pointerId };
    sheet.classList.add('dragging');
    sheet.classList.remove('settling');
    try { head.setPointerCapture(e.pointerId); } catch {}
  });
  head.addEventListener('pointermove', e => {
    if (!start || e.pointerId !== start.id) return;
    const dy = Math.max(0, e.clientY - start.y);
    sheet.style.animation = 'none';
    sheet.style.transform = `translateY(${dy}px)`;
  });
  const end = e => {
    if (!start || e.pointerId !== start.id) return;
    const dy = Math.max(0, e.clientY - start.y);
    const fast = dy > 30 && performance.now() - start.t < 220;
    start = null;
    sheet.classList.remove('dragging');
    if (dy > 110 || fast) {
      sheet.style.animation = '';
      sheet.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(100%)' }], { duration: 220, easing: 'ease-in', fill: 'forwards' });
      const scrim = sheet.parentElement;
      closeSheet();
      scrim.querySelector('.sheet').style.animation = 'none';
    } else {
      sheet.classList.add('settling');
      sheet.style.transform = '';
    }
  };
  head.addEventListener('pointerup', end);
  head.addEventListener('pointercancel', end);
}
function confirmSheet(title, message, action, onYes) {
  const sheet = openSheet(title, `<div class="sheet-body"><p class="muted">${esc(message)}</p>
    <div class="row-btns"><button class="primary" data-yes>${esc(action)}</button><button class="secondary" data-close>Cancel</button></div></div>`);
  $('[data-yes]', sheet).onclick = () => { closeSheet(); onYes(); };
}

function isStandalone() {
  return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}
const looksLikeIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/* ---------- Screen changes ---------- */
let booted = false;
function navigate(direction, render) {
  const root = document.documentElement;
  if (!booted || !document.startViewTransition || reducedMotion() || document.visibilityState !== 'visible') {
    render();
    return;
  }
  root.dataset.nav = direction;
  const transition = document.startViewTransition(render);
  transition.ready.catch(() => {});
  transition.updateCallbackDone.catch(error => console.error(error));
  transition.finished.catch(() => {}).finally(() => { delete root.dataset.nav; });
  return transition.updateCallbackDone;
}

/* ---------- Library ---------- */
let libQuery = '';
let libSort = 'recent';

const cleanAuthor = author => String(author || '').replace(/[;,\s]+$/, '');

async function showLibrary(direction = 'back') {
  history.replaceState(null, '', '#');
  await db.put('kv', null, 'lastBook').catch(() => {});
  document.title = 'Stillpoint';
  const books = await db.getAll('books');
  navigate(direction, () => renderLibrary(books));
}

function renderLibrary(books) {
  const app = $('#app');
  const installNote = looksLikeIOS() && !isStandalone()
    ? `<div class="install-note"><strong>Install Stillpoint before adding books</strong>Tap Share in Safari, then Add to Home Screen. Books added in Safari may not appear in the installed app.</div>` : '';
  app.innerHTML = `<main class="screen">
    <header class="screen-head">
      <h1 class="wordmark">Stillpoint<span class="p">.</span></h1>
      <button class="icon-btn" id="go-stats" aria-label="Reading stats">${icon('chart')}</button>
      <button class="icon-btn" id="go-settings" aria-label="Settings">${icon('gear')}</button>
      <button class="icon-btn" id="go-add" aria-label="Add a book">${icon('plus')}</button>
    </header>
    <div class="screen-body" id="lib-body"></div></main>`;
  $('#go-stats').onclick = showStats;
  $('#go-settings').onclick = () => showSettings();
  $('#go-add').onclick = showAdd;
  const body = $('#lib-body');
  if (!books.length) {
    body.innerHTML = `<div class="empty"><h2>One word at a time, right where your eyes rest.</h2>
      <p>Add an EPUB, PDF, or other document. Your books stay on this device.</p>
      ${installNote}
      <button class="primary" id="empty-add">Add a book</button></div>`;
    $('#empty-add').onclick = showAdd;
    return;
  }
  body.innerHTML = `${installNote}<div class="lib-tools">
      <input id="lib-search" type="search" placeholder="Search your library" aria-label="Search your library" value="${esc(libQuery)}">
      <select id="lib-sort" aria-label="Sort books">
        <option value="recent">Recent</option><option value="title">Title</option><option value="progress">Progress</option>
      </select></div><div id="lib-list"></div>`;
  $('#lib-sort').value = libSort;
  const draw = () => {
    const q = libQuery.trim().toLowerCase();
    const list = books.filter(b => !q || `${b.title} ${b.author}`.toLowerCase().includes(q));
    const progress = b => (b.wordCount ? b.pos / b.wordCount : 0);
    list.sort(libSort === 'title' ? (a, b) => a.title.localeCompare(b.title)
      : libSort === 'progress' ? (a, b) => progress(b) - progress(a)
        : (a, b) => (b.lastReadAt || b.addedAt) - (a.lastReadAt || a.addedAt));
    $('#lib-list').innerHTML = list.length ? list.map(b => {
      const done = b.finishedAt || b.pos >= b.wordCount - 1;
      const p = Math.round(progress(b) * 100);
      const wpm = b.wpm || S.wpm;
      const left = done ? 'Finished' : `${formatDuration(estimateMs(b.wordCount - b.pos, wpm, S.smartPacing))} left`;
      return `<article class="book-row">
        <button class="book-open" data-open="${esc(b.id)}">
          <h2 class="book-title">${esc(b.title)}</h2>
          ${b.author ? `<div class="book-author">${esc(cleanAuthor(b.author))}</div>` : ''}
          <div class="book-progress"><i style="width:${done ? 100 : p}%"></i></div>
          <div class="book-meta"><span>${done ? 100 : p}%</span><span>${left}</span></div>
        </button>
        <button class="icon-btn" data-more="${esc(b.id)}" aria-label="More options for ${esc(b.title)}">${icon('more')}</button>
      </article>`;
    }).join('') : `<p class="muted" style="padding:20px 0">No books match that search.</p>`;
  };
  draw();
  $('#lib-search').oninput = e => { libQuery = e.target.value; draw(); };
  $('#lib-sort').onchange = e => { libSort = e.target.value; draw(); };
  body.onclick = e => {
    const open = e.target.closest('[data-open]');
    if (open) { openBook(open.dataset.open); return; }
    const more = e.target.closest('[data-more]');
    if (more) showBookMenu(books.find(b => b.id === more.dataset.more));
  };
}

function showBookMenu(book) {
  const sheet = openSheet(book.title, `<div class="sheet-body">
    <button class="menu-btn" data-a="rename">Rename</button>
    ${book.hasCleanup ? '<button class="menu-btn" data-a="cleanup">Review reading text</button>' : ''}
    <button class="menu-btn" data-a="narration">Audiobook</button>
    <button class="menu-btn" data-a="restart">Read again from the start</button>
    <button class="menu-btn danger" data-a="delete">Delete book</button></div>`);
  sheet.onclick = async e => {
    const action = e.target.closest('[data-a]')?.dataset.a;
    if (action === 'rename') {
      const s2 = openSheet('Rename book', `<div class="sheet-body stack">
        <input class="field-text" id="name" aria-label="Title" value="${esc(book.title)}">
        <input class="field-text" id="auth" aria-label="Author" placeholder="Author" value="${esc(book.author || '')}">
        <button class="primary" id="save">Save name</button></div>`);
      $('#save', s2).onclick = async () => {
        book.title = $('#name', s2).value.trim() || book.title;
        book.author = $('#auth', s2).value.trim();
        await db.put('books', book);
        closeSheet();
        showLibrary();
      };
    } else if (action === 'cleanup') {
      try { await editBookCleanup(book); }
      catch (error) { console.error(error); toast('Changes could not be saved. Try again.'); }
    } else if (action === 'narration') {
      showNarration(book).catch(error => toast(error.message));
    } else if (action === 'restart') {
      book.pos = 0;
      book.finishedAt = null;
      await db.put('books', book);
      closeSheet();
      openBook(book.id);
    } else if (action === 'delete') {
      confirmSheet('Delete this book?', `“${book.title}” and its progress and bookmarks will be removed from this device.`, 'Delete book', async () => {
        await db.deleteBook(book.id);
        toast('Book deleted');
        showLibrary();
      });
    }
  };
}

/* ---------- Adding books ---------- */
function showAdd() {
  const sheet = openSheet('Add a book', `<div class="sheet-body">
    <label class="menu-btn" for="file-pick" style="cursor:pointer">Choose files
      <small>EPUB, audiobook ZIP, PDF, DOCX, TXT, Markdown, HTML, RTF, MOBI, and FB2</small></label>
    <input id="file-pick" type="file" multiple style="position:absolute;opacity:0;width:1px;height:1px">
    <button class="menu-btn" id="try-audiobook-demo">Try audiobook sample<small>Loads a short book with its narration</small></button>
    <button class="menu-btn" id="paste-go">Paste text</button></div>`);
  $('#try-audiobook-demo', sheet).onclick = () => location.assign(new URL('demo/', location.href));
  $('#file-pick', sheet).onchange = e => {
    const files = [...e.target.files];
    closeSheet();
    importQueue(files);
  };
  $('#paste-go', sheet).onclick = showPaste;
}

function showPaste() {
  const sheet = openSheet('Paste text', `<div class="sheet-body stack">
    <input class="field-text" id="paste-title" aria-label="Title" placeholder="Title">
    <textarea class="field-text" id="paste-text" aria-label="Text" placeholder="Paste your text here"></textarea>
    <button class="primary" id="paste-save">Add to library</button></div>`, { tall: true });
  $('#paste-save', sheet).onclick = async () => {
    const text = $('#paste-text', sheet).value;
    if (!text.trim()) { toast('Paste some text first.'); return; }
    const title = $('#paste-title', sheet).value.trim() || text.trim().split(/\s+/).slice(0, 6).join(' ');
    const id = await storeBook({ ...textToBook(text, title, 'pasted') });
    closeSheet();
    openBook(id);
  };
}

async function storeBook(parsed) {
  const blocks = parsed.blocks;
  const { words } = buildIndex(blocks);
  if (!words.length) throw new ImportError('No readable text was found in this file.');
  const id = uid();
  const now = Date.now();
  const book = {
    id, title: parsed.title || 'Untitled', author: cleanAuthor(parsed.author), format: parsed.format,
    addedAt: now, lastReadAt: 0, wordCount: words.length, pos: 0, finishedAt: null, wpm: null,
    chapters: parsed.chapters || [], bookmarks: [], hasCleanup: !!parsed.cleanup,
  };
  await db.saveBook(book, { id, blocks, ...(parsed.cleanup ? { cleanup: parsed.cleanup } : {}) });
  return id;
}

async function importGeneratedPackage(file, onProgress = () => {}) {
  onProgress('Reading the ZIP directory…');
  const zip = await openAudiobookZip(file);
  if (!zip.has('reading-book.json')) {
    if (zip.has('audiobook.json')) throw new ImportError('This ZIP contains audio and timings, but no book text. Open the matching book’s speaker menu → Import audiobook, or download the combined book ZIP from Studio.');
    return null;
  }
  onProgress('Reading the included book text…');
  const payload = await zip.json('reading-book.json');
  if (payload.format !== 'stillpoint-reading-book' || payload.version !== 1 || !Array.isArray(payload.content?.blocks)) throw new ImportError('This audiobook package has no supported reading text.');
  const blocks = payload.content.blocks;
  if (!blocks.length || blocks.some(b => typeof b.t !== 'string' || typeof b.sid !== 'string')) throw new ImportError('The reading text in this audiobook is incomplete.');
  const id = uid(), now = Date.now();
  const chapters = (payload.book?.chapters || []).filter(c => Number.isInteger(c.block) && c.block >= 0 && c.block < blocks.length).map(c => ({ ...c, title: String(c.title || 'Section') }));
  const book = { id, title: String(payload.book?.title || 'Untitled'), author: cleanAuthor(payload.book?.author || ''),
    format: 'epub', addedAt: now, lastReadAt: 0, wordCount: buildIndex(blocks).words.length, pos: 0,
    finishedAt: null, wpm: null, chapters, bookmarks: [], hasCleanup: !!payload.content.cleanup,
    readingView: 'book', bookLayout: 'pages', audioMode: 'page', audioRate: 1 };
  const content = { id, blocks, ...(payload.content.cleanup ? { cleanup: payload.content.cleanup } : {}) };
  await db.put('kv', { name: file.name, bookId: id, startedAt: Date.now() }, 'pendingAudiobookImport');
  onProgress('Checking that the book and narration match…');
  const job = await createNarrationJob(book, content);
  const { manifest, audio } = await readNarrationPackage(file, job, { archive: zip, onProgress });
  onProgress('Saving audio to this device — 0%. Keep Stillpoint open…');
  await db.saveGeneratedBook(book, content, manifest, audio, (written, total) => {
    onProgress(`Saving audio to this device — ${Math.round(written / Math.max(1, total) * 100)}%. Keep Stillpoint open…`);
  });
  return id;
}

async function importQueue(files) {
  const failures = [];
  let added = 0;
  let lastId = null;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    let generatedSaved = false;
    const sheet = openSheet('Adding books', `<div class="sheet-body"><p class="spinner-line" id="imp-status">Opening ${esc(file.name)}${files.length > 1 ? ` (${i + 1} of ${files.length})` : ''}</p></div>`);
    try {
      if (/\.zip$/i.test(file.name)) {
        await db.put('kv', { name: file.name, startedAt: Date.now() }, 'pendingAudiobookImport');
        const generated = await importGeneratedPackage(file, status => { const el = $('#imp-status', sheet); if (el) el.textContent = status; });
        if (generated) { generatedSaved = true; lastId = generated; added++; closeSheet(); continue; }
      }
      const result = await importFile(file, status => { const el = $('#imp-status', sheet); if (el) el.textContent = status; });
      if (result.review) {
        const parsed = await reviewPdf(result.review, file.name);
        if (parsed) { lastId = await storeBook(parsed); added++; }
      } else {
        const parsed = result.cleanup ? await reviewBook(result.cleanup.source, result.cleanup.options) : result;
        if (parsed) { lastId = await storeBook(parsed); added++; }
      }
    } catch (error) {
      if (!(error instanceof ImportError)) console.error(error);
      const quota = error?.name === 'QuotaExceededError';
      failures.push([file.name, quota ? 'There is not enough storage left on this device.'
        : error instanceof ImportError || /\.zip$/i.test(file.name) ? error?.message || 'Audiobook import was interrupted. Try again with the original ZIP.' : 'This file could not be read.']);
    } finally {
      if (/\.zip$/i.test(file.name) && !generatedSaved) await db.del('kv', 'pendingAudiobookImport').catch(() => {});
    }
  }
  closeSheet();
  if (failures.length) {
    openSheet(failures.length === 1 ? 'A file was not added' : 'Some files were not added', `<div class="sheet-body">
      ${failures.map(([n, m]) => `<div class="menu-btn"><b>${esc(n)}</b><small>${esc(m)}</small></div>`).join('')}
      ${added ? `<p class="muted">${added} added successfully.</p>` : ''}</div>`);
    showLibraryKeepSheet();
  } else if (files.length === 1 && lastId) {
    try { await openBook(lastId); }
    catch (error) {
      R?.narration?.dispose(); R?.bookView?.destroy(); R = null;
      await showLibrary();
      openSheet('Book saved', `<div class="sheet-body"><p>The book was added, but the reader could not open it: ${esc(error.message || 'unknown error')}. You can reopen it from the library.</p></div>`);
    }
  } else {
    if (added) toast(`${added} ${added === 1 ? 'book' : 'books'} added`);
    showLibrary();
  }
  if (files.some(file => /\.zip$/i.test(file.name))) await db.del('kv', 'pendingAudiobookImport').catch(() => {});
}
function showLibraryKeepSheet() { if (!R) showLibrary(); }

function reviewBook(source, saved = defaultBookOptions(), editing = false) {
  return new Promise(resolve => {
    const options = { ...defaultBookOptions(), ...saved, overrides: { ...saved.overrides } };
    let cursor = 0, mode = 'source', query = '', parsed, words = 0;
    const pageSize = 30;
    const counts = Object.fromEntries(Object.keys(CLEAN_ROLES).map(role => [role, source.blocks.filter(b => b.roles?.includes(role)).length]));
    const sheet = openSheet('Review reading text', `<div class="sheet-body">
      <p class="muted">Choose what belongs in ${esc(source.title)}. Omitted text stays on your device so you can restore it later.</p>
      ${Object.entries(CLEAN_ROLES).filter(([role]) => counts[role]).map(([role, label]) => `<div class="clean-row"><label for="keep-${role}">Include ${esc(label.toLowerCase())}<small>${fmt(counts[role])} passages identified</small></label><input id="keep-${role}" class="switch" type="checkbox" role="switch" data-keep="${role}" ${options[role] ? 'checked' : ''}></div>`).join('')}
      <div class="clean-row"><label for="announcements">Chapter announcements<small>Navigation keeps all included sections.</small></label><select id="announcements"><option value="chapters">Major chapters</option><option value="all">All sections</option><option value="none">None</option></select></div>
      <div class="clean-row"><label for="preview-mode">Preview</label><select id="preview-mode"><option value="source">All source text</option><option value="reading">Included reading text</option></select></div>
      <p class="muted" id="clean-summary" aria-live="polite"></p>
      <input class="field-text" id="clean-search" type="search" aria-label="Find text or a source page" placeholder="Find text${source.format === 'pdf' ? ' or a page number' : ' or a section'}">
      <div id="clean-preview"></div>
      <div class="clean-pager"><button id="clean-prev">Previous</button><span id="clean-page"></span><button id="clean-next">Next</button></div>
      <div class="sticky-foot"><span id="clean-words"></span><button class="primary" id="book-add">${editing ? 'Save changes' : 'Add to library'}</button></div>
    </div>`, { tall: true, onClose: () => resolve(null) });
    sheet.classList.add('cleanup-sheet');
    $('#announcements', sheet).value = options.announcements;
    const draw = (rebuild = false) => {
      if (rebuild || !parsed) {
        parsed = cleanBook(source, options);
        words = parsed.blocks.reduce((sum, b) => sum + tokenize(b.t).length, 0);
      }
      const rows = source.blocks.filter(b => (mode === 'source' || blockChoice(b, options))
        && (!query || (source.format === 'pdf' && /^\d+$/.test(query) ? b.page === Number(query)
          : `${b.location || ''} ${b.t}`.toLowerCase().includes(query))));
      cursor = Math.min(cursor, Math.max(0, Math.ceil(rows.length / pageSize) - 1));
      const start = cursor * pageSize;
      $('#clean-preview', sheet).innerHTML = rows.slice(start, start + pageSize).map(b => {
        const included = blockChoice(b, options), choice = options.overrides[b.sid] || 'auto';
        return `<article class="clean-block ${included ? '' : 'omitted'}"><div class="clean-label"><small>${esc(b.location || (b.page ? `Page ${b.page}` : 'Text'))} · ${esc((b.roles || []).map(r => CLEAN_ROLES[r] || r).join(', ') || (b.k === 'h' ? 'Heading' : 'Body text'))}${included ? '' : ' · Omitted'}</small><select data-block="${esc(b.sid)}" aria-label="Treatment of passage ${b.order + 1}">${[['auto', 'Automatic'], ['keep', 'Keep'], ['exclude', 'Exclude'], ['body', 'Read as body text']].map(([v, t]) => `<option value="${v}" ${choice === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div><p class="${b.k === 'h' && choice !== 'body' ? 'clean-heading' : ''}">${esc(b.t)}</p></article>`;
      }).join('');
      $('#clean-words', sheet).textContent = `${fmt(words)} words`;
      $('#clean-summary', sheet).textContent = `${fmt(source.blocks.length - parsed.blocks.length)} passages omitted. ${parsed.chapters.filter(c => c.announce).length} chapter announcements.`;
      $('#clean-page', sheet).textContent = `${rows.length ? start + 1 : 0}–${Math.min(start + pageSize, rows.length)} of ${fmt(rows.length)}`;
      $('#clean-prev', sheet).disabled = cursor === 0;
      $('#clean-next', sheet).disabled = start + pageSize >= rows.length;
      $('#book-add', sheet).disabled = !words;
      return parsed;
    };
    const move = step => {
      cursor += step; draw();
      const body = $('.sheet-body', sheet);
      body.scrollTop += $('#clean-preview', sheet).getBoundingClientRect().top - body.getBoundingClientRect().top;
    };
    $('#clean-prev', sheet).onclick = () => move(-1);
    $('#clean-next', sheet).onclick = () => move(1);
    $('#clean-search', sheet).oninput = e => { query = e.target.value.trim().toLowerCase(); cursor = 0; draw(); };
    sheet.addEventListener('change', e => {
      const t = e.target;
      if (t.dataset.keep) options[t.dataset.keep] = t.checked;
      else if (t.dataset.block) {
        if (t.value === 'auto') delete options.overrides[t.dataset.block];
        else options.overrides[t.dataset.block] = t.value;
      } else if (t.id === 'announcements') options.announcements = t.value;
      else if (t.id === 'preview-mode') { mode = t.value; cursor = 0; }
      draw(t.id !== 'preview-mode');
    });
    $('#book-add', sheet).onclick = () => {
      const parsed = draw();
      if (!parsed.blocks.length) return;
      sheetClose = null; closeSheet(); resolve(parsed);
    };
    draw();
  });
}

async function editBookCleanup(book) {
  if (R?.book.id === book.id) { pause({ animate: false }); await saveProgress(true); }
  const content = await db.get('contents', book.id);
  if (!content?.cleanup) { toast('Reimport this book to review its reading text.'); return; }
  const parsed = await reviewBook(content.cleanup.source, content.cleanup.options, true);
  if (!parsed) return;
  const current = await db.get('books', book.id);
  const { source } = parsed.cleanup;
  const anchor = positionAnchor(content.blocks, current.pos);
  current.pos = anchorPosition(source, parsed.blocks, anchor);
  current.bookmarks = (current.bookmarks || []).map(mark => {
    const cleanupAnchor = mark.cleanupAnchor || positionAnchor(content.blocks, mark.word);
    return { ...mark, cleanupAnchor, word: anchorPosition(source, parsed.blocks, cleanupAnchor) };
  });
  current.chapters = parsed.chapters;
  current.wordCount = buildIndex(parsed.blocks).words.length;
  await db.saveBook(current, { ...content, blocks: parsed.blocks, cleanup: parsed.cleanup });
  if (R?.book.id === book.id) await openBook(book.id);
  else await showLibrary();
}

function reviewPdf(extracted, fileName) {
  return new Promise(resolve => {
    const options = defaultCleanOptions();
    const { found, pages } = extracted.analysis;
    const row = (key, label, count, help) => `<div class="clean-row"><label for="c-${key}"><span>${label}</span><small>${help}</small></label>
      <input class="switch" type="checkbox" role="switch" id="c-${key}" data-c="${key}" ${options[key] ? 'checked' : ''}></div>`;
    const sheet = openSheet('Clean up this PDF', `<div class="sheet-body">
      <p class="muted">${esc(fileName)} has ${pages.length} ${pages.length === 1 ? 'page' : 'pages'}. Choose what to remove before adding it.</p>
      ${row('headers', 'Repeated headers and footers', found.headers, `${fmt(found.headers)} found`)}
      ${row('numbers', 'Page numbers', found.numbers, `${fmt(found.numbers)} found`)}
      ${row('hyphens', 'Rejoin split words', found.hyphens, `${fmt(found.hyphens)} found at line ends`)}
      ${row('footnotes', 'Footnotes', found.footnotes, `${fmt(found.footnotes)} lines found. Detection is approximate.`)}
      <div style="padding:14px 0 6px"><label for="skip-list">Pages to skip</label>
        <input class="field-text" id="skip-list" inputmode="text" placeholder="For example 1-4, 210" style="margin-top:6px"></div>
      <div id="page-list"></div>
      <div class="sticky-foot"><span class="muted" id="word-est"></span><button class="primary" id="pdf-add">Review reading text</button></div>
    </div>`, { tall: true, onClose: () => resolve(null) });
    const pageList = $('#page-list', sheet);
    const drawPages = () => {
      pageList.innerHTML = pages.map(page => {
        const parts = page.lines.slice(0, 7).map(l => {
          const removed = (l.role === 'header' && options.headers) || (l.role === 'number' && options.numbers) || (l.role === 'footnote' && options.footnotes);
          return removed ? `<s class="cut">${esc(l.text)}</s>` : esc(l.text);
        }).join(' ');
        return `<label class="page-row ${options.skip.has(page.n) ? 'skipped' : ''}"><b>${page.n}</b><span class="page-text">${parts || 'No text on this page'}</span>
          <input class="switch" type="checkbox" role="switch" aria-label="Keep page ${page.n}" data-page="${page.n}" ${options.skip.has(page.n) ? '' : 'checked'}></label>`;
      }).join('');
      const parsed = finishPdf(extracted, options);
      const words = parsed.blocks.reduce((a, b) => a + b.t.split(/\s+/).length, 0);
      $('#word-est', sheet).textContent = `About ${fmt(words)} words`;
    };
    drawPages();
    sheet.addEventListener('change', e => {
      if (e.target.dataset.c) { options[e.target.dataset.c] = e.target.checked; drawPages(); }
      else if (e.target.dataset.page) {
        const n = Number(e.target.dataset.page);
        if (e.target.checked) options.skip.delete(n); else options.skip.add(n);
        $('#skip-list', sheet).value = '';
        drawPages();
      } else if (e.target.id === 'skip-list') {
        options.skip = parsePageList(e.target.value, pages.length);
        drawPages();
      }
    });
    $('#pdf-add', sheet).onclick = async () => {
      const parsed = finishPdf(extracted, options);
      sheetClose = null;
      closeSheet();
      resolve(await reviewBook(parsed.cleanup.source, parsed.cleanup.options));
    };
  });
}

/* ---------- Audiobooks ---------- */
function narrating() { return !!R?.narration && ['page', 'rsvp'].includes(R.book.audioMode); }
function bookMode() { return R?.book.readingView === 'book'; }

async function setReadingView(view) {
  if (!R) return;
  pause({ animate: false });
  R.book.readingView = view;
  if (view === 'book' && R.book.audioMode === 'rsvp') R.book.audioMode = 'page';
  await saveProgress(true);
  renderReader();
}

function showBookAppearance() {
  const sheet = openSheet('Reading appearance', `<div class="tabs book-appearance-tabs" role="tablist">
    <button role="tab" data-appearance="font">Font</button><button role="tab" data-appearance="layout">Layout</button><button role="tab" data-appearance="themes">Themes</button></div>
    <div class="sheet-body" id="book-appearance-body"></div>`, { tall: true });
  const body = $('#book-appearance-body', sheet);
  const field = (label, html) => `<label class="book-setting">${label}${html}</label>`;
  const select = (key, values) => `<select class="field-text" data-book-setting="${key}">${values.map(([value, label]) => `<option value="${value}" ${String(S[key]) === String(value) ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
  const draw = tab => {
    $$('[data-appearance]', sheet).forEach(button => button.setAttribute('aria-selected', button.dataset.appearance === tab));
    if (tab === 'font') body.innerHTML = `<p class="book-type-preview">A little more space for the story.</p>
      ${field('Font', select('textFont', fontOptions))}
      ${field('Text size', `<input type="range" aria-label="Book text size" data-book-setting="textSize" min="13" max="38" step="1" value="${S.textSize}">`)}
      ${field('Boldness', select('textWeight', [[400, 'Regular'], [500, 'Medium'], [600, 'Bold']]))}`;
    else if (tab === 'layout') body.innerHTML = `<div class="book-layout-choices" role="group" aria-label="Page layout">
      <button data-book-layout="pages" aria-pressed="${(R.book.bookLayout || 'pages') === 'pages'}"><b>▥</b>Pages</button>
      <button data-book-layout="scroll" aria-pressed="${R.book.bookLayout === 'scroll'}"><b>☷</b>Continuous scroll</button></div>
      ${field('Line spacing', select('textLead', [[1.4, 'Compact'], [1.65, 'Comfortable'], [1.9, 'Spacious']]))}
      ${field('Margins', `<input type="range" aria-label="Book margins" data-book-setting="textMargin" min="12" max="52" step="2" value="${S.textMargin}">`)}
      ${field('Alignment', select('textAlign', [['left', 'Left aligned'], ['justify', 'Justified']]))}
      ${field('Reading progress', select('bookProgress', [['page', 'Page in section'], ['percent', 'Book percentage'], ['time', 'Estimated time left'], ['none', 'Hidden']]))}
      <label class="book-check"><input type="checkbox" data-book-setting="bookIndent" ${S.bookIndent ? 'checked' : ''}>Indent paragraphs</label>
      <label class="book-check"><input type="checkbox" data-book-setting="bookAnimation" ${S.bookAnimation ? 'checked' : ''}>Page-turn animation</label>`;
    else body.innerHTML = `<div class="book-theme-choices">${['paper', 'sepia', 'oled', 'moss'].map(key => `<button data-book-theme="${key}" aria-pressed="${S.theme === key}" style="background:${THEMES[key].bg};color:${THEMES[key].ink}"><b>Aa</b>${THEMES[key].name}</button>`).join('')}</div>
      ${field('Dim the reading page', `<input type="range" aria-label="Reading page dimming" data-book-setting="bookDim" min="0" max="0.6" step="0.05" value="${S.bookDim}">`)}
      <p class="muted">Use the center of the page to show or hide reading controls.</p>`;
    body.insertAdjacentHTML('beforeend', '<button class="menu-btn" id="all-reader-settings">All Stillpoint settings</button>');
    $('#all-reader-settings', body).onclick = () => showSettings();
  };
  sheet.addEventListener('input', event => {
    const key = event.target.dataset.bookSetting;
    if (!key) return;
    S[key] = event.target.type === 'checkbox' ? event.target.checked
      : ['textFont', 'textAlign', 'bookProgress'].includes(key) ? event.target.value : Number(event.target.value);
    R.animate = S.bookAnimation;
    applySettings(); saveSettings(); R.bookView?.folio();
  });
  sheet.addEventListener('click', event => {
    const tab = event.target.closest('[data-appearance]');
    if (tab) { draw(tab.dataset.appearance); return; }
    const layout = event.target.closest('[data-book-layout]');
    if (layout) { R.book.bookLayout = layout.dataset.bookLayout; saveProgress(true); renderReader(); draw('layout'); return; }
    const theme = event.target.closest('[data-book-theme]');
    if (theme) { S.theme = theme.dataset.bookTheme; applySettings(); saveSettings(); draw('themes'); }
  });
  draw('font');
}

async function attachNarration() {
  const owner = R;
  const record = await db.get('narrations', owner.book.id);
  if (!record || R !== owner) return;
  try {
    validateManifest(record.manifest, await createNarrationJob(owner.book, { blocks: owner.blocks }));
    owner.narration = new NarrationPlayer(record.manifest,
      file => db.readNarrationAudio(owner.book.id, file),
      {
        onWord: pos => {
          if (R !== owner) return;
          owner.sessionWords += Math.max(0, pos - owner.pos);
          owner.pos = pos;
          if (!document.hidden) {
            if (owner.book.audioMode === 'page') showFlowAt(pos, true);
            else renderWord(owner.words[pos]);
            if (!owner.scrubbing && !owner.jump) updateMeta();
          }
          saveProgress();
        },
        onEnd: () => { if (R === owner) finishBook(); },
        onPause: () => { if (R === owner) pause({ animate: false }); },
        onResume: () => {
          if (R === owner && narrating() && owner.state === 'paused') {
            owner.sessionStart ||= performance.now(); setMode('playing');
          }
        },
        onError: error => { if (R === owner) { pause({ animate: false }); toast(error.message, 7000); } },
      });
    owner.narration.setRate(owner.book.audioRate || 1);
    // Fetch the local Blob before the tap so play() stays inside the user's gesture.
    await owner.narration.prepare(owner.pos);
  } catch (error) { owner.narration?.dispose(); owner.narration = null; owner.narrationError = error.message; }
}

function applyNarrationMode() {
  if (!R || !$('#reader')) return;
  const active = narrating();
  $('#reader').classList.toggle('book-reading', bookMode());
  $('#r-book')?.setAttribute('aria-pressed', bookMode());
  $('#reader').classList.toggle('audio-page', active && R.book.audioMode === 'page');
  $('#r-audio').setAttribute('aria-pressed', active);
  if (active) {
    $('#wpm-v').textContent = `${(R.book.audioRate || 1).toFixed(1)}×`;
    $('#wpm-box small').textContent = 'Audio';
    $('#wpm-box').setAttribute('aria-label', 'Audiobook playback settings');
  } else {
    R.narration?.releaseMediaSession();
    $('#wpm-box small').textContent = 'WPM';
    $('#wpm-box').setAttribute('aria-label', 'Choose reading speed');
  }
  $('#play').setAttribute('aria-label', bookMode() && !active ? 'Start RSVP' : R.state === 'paused' ? 'Play' : 'Pause');
}

async function playNarration({ resume = true } = {}) {
  const owner = R;
  const run = ++owner.run;
  clearTimeout(owner.timer);
  if (owner.jump) clearJump();
  hideJumpBar();
  setMode('starting');
  // Narration does not need a lit screen. Pure RSVP still uses the normal wake lock.
  releaseWake();
  owner.narration.claimMediaSession(owner.book, {
    play: () => { if (R === owner && narrating() && owner.state === 'paused') playNarration(); },
    pause: () => { if (R === owner) pause({ animate: false }); },
    seek: pos => { if (R === owner && narrating()) seek(pos); },
  });
  try {
    if (!await owner.narration.playAt(owner.pos, { resume }) || R !== owner || run !== owner.run) return;
    owner.sessionStart ||= performance.now();
    setMode('playing');
  } catch (error) {
    if (R === owner && run === owner.run) { pause({ animate: false }); toast(error.message || 'Audio playback could not start.', 7000); }
  }
}

async function shareNarrationFile(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; }
    catch (error) { if (error.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

async function showNarration(book) {
  if (R?.book.id === book.id) pause({ animate: false });
  const content = await db.get('contents', book.id);
  if (!content) throw new Error('This book could not be found.');
  const job = await createNarrationJob(book, content);
  const record = await db.get('narrations', book.id);
  let valid = false, message = 'Export the reviewed reading text, generate its narration on your computer, then import the audiobook here.';
  if (record) {
    try {
      validateManifest(record.manifest, job); valid = true;
      message = record.manifest.clips.length === 1
        ? 'Audiobook saved on this device. Start playback before locking your screen.'
        : 'This older audiobook uses separate clips. Regenerate it as continuous audio for screen-off listening.';
    }
    catch (error) { message = error.message; }
  }
  const sheet = openSheet('Audiobook', `<div class="sheet-body stack">
    <section class="narration-mode-panel" aria-label="Reading mode">
      <label for="narration-mode">Reading mode</label>
      <select class="field-text" id="narration-mode" aria-describedby="narration-mode-help">
        <option value="off">Read without narration</option><option value="book">Book · pages or scrolling</option>${valid ? '<option value="page">Listen and follow text</option><option value="rsvp">Listen and follow RSVP</option>' : ''}
      </select>
      <p id="narration-mode-help">Choose how you want to read or listen.</p>
    </section>
    ${valid ? `<label class="book-check" id="book-audio-option" hidden><input id="book-audio-enabled" type="checkbox" ${book.audioMode === 'page' ? 'checked' : ''}>Listen along in book mode</label>
    <label for="narration-rate">Playback speed</label><select class="field-text" id="narration-rate">${[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map(n => `<option value="${n}">${n}×</option>`).join('')}</select>` : ''}
    <p class="muted" id="narration-status">${esc(message)}</p>
    <button class="menu-btn" id="narration-export">Export narration job<small>Uses your current reading-text choices</small></button>
    <label class="menu-btn" for="narration-import">Import audiobook<small>Choose the generated audiobook ZIP</small></label>
    <input type="file" id="narration-import" accept=".zip,application/zip" hidden>
    ${record ? '<button class="menu-btn danger" id="narration-remove">Remove audiobook</button>' : ''}
    </div>`);
  $('#narration-export', sheet).onclick = async () => {
    try { await shareNarrationFile(new Blob([JSON.stringify(job)], { type: 'application/json' }), `${book.id}-narration.json`); }
    catch (error) { toast(error.message); }
  };
  $('#narration-import', sheet).onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    $('#narration-status', sheet).textContent = 'Importing audiobook…';
    try {
      const { manifest, audio } = await readNarrationPackage(file, job);
      await db.saveNarration(book.id, manifest, audio);
      book.audioMode = 'page'; book.audioRate ||= 1;
      await db.put('books', book);
      closeSheet();
      if (R?.book.id === book.id) await openBook(book.id);
      toast('Audiobook ready. Press play to listen.');
    } catch (error) { $('#narration-status', sheet).textContent = error.name === 'QuotaExceededError' ? 'There is not enough storage for this audiobook.' : error.message; }
  };
  {
    $('#narration-mode', sheet).value = book.readingView === 'book' ? 'book' : valid ? book.audioMode || 'off' : 'off';
    const rate = $('#narration-rate', sheet), follow = $('#book-audio-enabled', sheet);
    if (rate) {
    if (![...rate.options].some(o => Number(o.value) === (book.audioRate || 1))) rate.add(new Option(`${book.audioRate}×`, book.audioRate));
    rate.value = book.audioRate || 1;
    }
    if ($('#book-audio-option', sheet)) $('#book-audio-option', sheet).hidden = book.readingView !== 'book';
    const update = async () => {
      const mode = $('#narration-mode', sheet).value;
      book.readingView = mode === 'book' ? 'book' : 'rsvp';
      book.audioMode = mode === 'book' ? follow?.checked ? 'page' : 'off' : mode;
      book.audioRate = rate ? Number(rate.value) : 1;
      if ($('#book-audio-option', sheet)) $('#book-audio-option', sheet).hidden = mode !== 'book';
      await db.put('books', book);
      if (R?.book.id === book.id) {
        R.book.audioMode = book.audioMode; R.book.audioRate = book.audioRate; R.book.readingView = book.readingView;
        R.narration?.setRate(book.audioRate);
        renderReader();
      }
    };
    $('#narration-mode', sheet).onchange = () => update().catch(error => toast(error.message));
    if (rate) rate.onchange = () => update().catch(error => toast(error.message));
    if (follow) follow.onchange = () => update().catch(error => toast(error.message));
  }
  if (record) $('#narration-remove', sheet).onclick = async () => {
    try {
      await db.removeNarration(book.id);
      if (R?.book.id === book.id) { R.narration?.dispose(); R.narration = null; applyNarrationMode(); updateWpm(); updateMeta(); }
      closeSheet(); toast('Audiobook removed');
    } catch (error) { toast(error.message); }
  };
}

/* ---------- Reader ---------- */
let R = null;
let wakeLock = null;
const SEG_WINDOW = 7;

async function openBook(id) {
  R?.bookView?.destroy();
  R?.narration?.dispose();
  const [book, content] = await Promise.all([db.get('books', id), db.get('contents', id)]);
  if (!book || !content) { toast('This book could not be found.'); showLibrary(); return; }
  const index = buildIndex(content.blocks);
  const chapterStarts = book.chapters.map(c => index.blockStart[c.block] ?? 0);
  R = {
    book, blocks: content.blocks, ...index,
    segs: buildSegments(content.blocks, index.blockStart, book.chapters.map(c => c.block)),
    chapterStarts,
    pos: clamp(book.pos, 0, Math.max(0, index.words.length - 1)),
    wpm: (S.perBookWpm && book.wpm) || S.wpm,
    state: 'paused', timer: null, run: 0, sinceplay: 0,
    loaded: [0, -1], sessionWords: 0, sessionStart: 0, lastSave: 0, lastText: '',
    extraChapterPause: 0,
  };
  await attachNarration();
  segStartsCache = R.segs.map(s => s.start);
  book.lastReadAt = Date.now();
  db.put('books', book).catch(() => {});
  db.put('kv', id, 'lastBook').catch(() => {});
  document.title = book.title;
  history.replaceState(null, '', '#reading');
  closeSheet();
  await navigate('forward', renderReader);
}
let segStartsCache = [];

function renderReader() {
  R.bookView?.destroy(); R.bookView = null;
  R.loaded = [0, -1]; R.animate = S.bookAnimation;
  R.jump = null;
  $('#app').innerHTML = `<div id="reader">
    <div id="flow" tabindex="-1"><div id="flow-inner"></div></div>
    <div id="book-view" hidden></div><div id="book-dimmer" aria-hidden="true"></div>
    <div id="stage" aria-live="off">
      <div id="rail">
        <div id="chapter-call"></div>
        <div class="tick" id="tick-a"></div><div class="tick" id="tick-b"></div>
        <div id="word"><span id="w-left"></span><span id="w-pivot"></span><span id="w-right"></span></div>
        <div id="count"></div>
      </div>
      <div id="live-text"></div>
      <div id="live-progress"></div>
    </div>
    <div id="wpm-badge" aria-hidden="true"></div>
    <button id="back-place" hidden>Back to my place</button>
    <div id="jump-bar" role="group" aria-label="Jump in book" hidden>
      <span id="jump-text"></span>
      <span class="jump-btns"><button class="primary" id="jump-go"></button><button class="secondary" id="jump-back">Back to my spot</button></span>
    </div>
    <div id="wpm-pop">
      <div class="pop-value"><span id="pop-v"></span><small>WPM</small></div>
      <input id="wpm-slider" type="range" step="5" aria-label="Reading speed in words per minute">
      <div class="pop-ends"><span id="pop-min"></span><span id="pop-time"></span><span id="pop-max"></span></div>
    </div>
    <header class="bar" id="top-bar">
      <button class="icon-btn" id="r-back" aria-label="Back to library">${icon('back')}</button>
      <button id="chapter-btn" aria-label="Open chapters"><b id="c-title"></b><small id="c-book"></small></button>
      <button class="icon-btn" id="r-book" aria-label="Book reading mode">${icon('book')}</button>
      <button class="icon-btn" id="r-audio" aria-label="Audiobook">${icon('sound')}</button>
      <button class="icon-btn" id="r-mark" aria-label="Add a bookmark">${icon('mark')}</button>
      <button class="icon-btn" id="r-settings" aria-label="Settings">${icon('gear')}</button>
    </header>
    <footer class="bar" id="bottom-bar">
      <div id="book-navigation" hidden><button id="book-prev" aria-label="Previous page">‹</button><span id="book-page-info"></span><button id="book-next" aria-label="Next page">›</button></div>
      <div id="scrub-wrap"><div id="scrub-track"><div id="scrub-fill"></div></div>
        <input id="scrub" type="range" min="0" max="${Math.max(0, R.words.length - 1)}" step="1" value="${R.pos}" aria-label="Position in book"></div>
      <div id="read-meta"><span id="m-pct"></span><span id="m-left"></span></div>
      <div id="controls">
        <div class="side">
          <button class="icon-btn" id="r-toc" aria-label="Chapters, bookmarks, and search">${icon('list')}</button>
          <button class="icon-btn" id="r-rew" aria-label="Rewind">${icon('back10')}</button>
        </div>
        <button id="play" aria-label="Play">${icon('play')}</button>
        <div class="side right">
          <button class="icon-btn" id="w-down" aria-label="Slower">${icon('minus')}</button>
          <button id="wpm-box" aria-label="Choose reading speed" aria-expanded="false" aria-controls="wpm-pop"><b id="wpm-v"></b><small>WPM</small></button>
          <button class="icon-btn" id="w-up" aria-label="Faster">${icon('plus')}</button>
          <button class="icon-btn" id="r-sound" aria-label="Ambient sound">${icon('sound')}</button>
        </div>
      </div>
    </footer></div>`;
  $('#c-book').textContent = R.book.title;
  const track = $('#scrub-track');
  if (R.words.length > 1 && R.chapterStarts.length < 80) {
    R.chapterStarts.forEach(s => {
      const u = document.createElement('u');
      u.style.left = `${(s / (R.words.length - 1)) * 100}%`;
      track.appendChild(u);
    });
  }
  bindReader();
  applyNarrationMode();
  if (bookMode()) {
    $('#book-view').hidden = false; $('#book-navigation').hidden = false;
    $('#r-settings').textContent = 'Aa'; $('#r-settings').setAttribute('aria-label', 'Reading appearance');
    R.bookView = new BookReader($('#book-view'), R, {
      onPosition: pos => {
        if (!R) return;
        if (narrating()) seek(pos);
        else { R.pos = pos; updateMeta(); saveProgress(true); }
      },
      onWordMenu: pos => { pause({ animate: false }); showWordMenu(pos); },
      onToggleChrome: () => $('#reader').classList.toggle('book-chrome-hidden'),
      onPage: info => {
        const el = $('#book-page-info'); if (el) el.textContent = info.label;
        const folio = $('#book-view .book-page-count');
        if (folio) {
          folio.hidden = S.bookProgress === 'none';
          folio.textContent = S.bookProgress === 'percent' ? `${Math.round(R.pos / Math.max(1, R.words.length - 1) * 100)}%`
            : S.bookProgress === 'time' ? `${formatDuration(estimateMs(R.words.length - R.pos, R.wpm, S.smartPacing))} left` : info.label;
        }
      },
    });
    R.bookView.setCurrent(R.pos, narrating());
  }
  updateWpm();
  updateMeta();
  renderWord(R.words[R.pos] || '');
  showFlowAt(R.pos, true);
  if (S.soundMode === 'reader' && S.sound !== 'off') {
    const once = () => { playSound(S.sound, S.volume); };
    $('#reader').addEventListener('pointerup', once, { once: true });
  }
}

/* Scrolling text */
function segHTML(i) {
  const seg = R.segs[i];
  const parts = [];
  for (let b = seg.first; b <= seg.last; b++) {
    const block = R.blocks[b];
    const start = R.blockStart[b];
    const end = b + 1 < R.blocks.length ? R.blockStart[b + 1] : R.words.length;
    if (end === start) continue;
    let inner = '';
    for (let w = start; w < end; w++) {
      inner += `<span class="w" data-i="${w}">${esc(R.words[w])}</span>${R.glue[w] ? '' : ' '}`;
    }
    const tag = block.k === 'h' ? 'h2' : block.k === 'q' ? 'blockquote' : 'p';
    parts.push(`<${tag}>${inner}</${tag}>`);
  }
  return `<div class="seg" data-s="${i}">${parts.join('')}</div>`;
}
const segOf = word => clamp(lowerBound(segStartsCache, word), 0, R.segs.length - 1);

function loadWindow(center) {
  const a = Math.max(0, center - 1);
  const b = Math.min(R.segs.length - 1, center + 1);
  let html = '';
  for (let i = a; i <= b; i++) html += segHTML(i);
  $('#flow-inner').innerHTML = html;
  R.loaded = [a, b];
  paintMarks();
}
function paintMarks() {
  const inner = $('#flow-inner');
  (R.book.bookmarks || []).forEach(m => $(`[data-i="${m.word}"]`, inner)?.classList.add('marked'));
}
function wordEl(i) { return bookMode() ? R.bookView?.wordEl(i) : $(`#flow-inner [data-i="${i}"]`); }
function setCurrentClass() {
  $('#flow-inner .w.cur')?.classList.remove('cur');
  wordEl(R.pos)?.classList.add('cur');
}
function showFlowAt(pos, center) {
  if (bookMode() && R.bookView) { R.bookView.showWord(pos, center && !R.bookView.manualPosition); R.bookView.setCurrent(pos, narrating()); return; }
  const flow = $('#flow');
  const seg = segOf(pos);
  if (seg < R.loaded[0] || seg > R.loaded[1]) loadWindow(seg);
  setCurrentClass();
  if (center) {
    const el = wordEl(pos);
    if (el) {
      const fr = flow.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      flow.scrollTop += er.top - fr.top - fr.height * 0.38;
    }
  }
  R.ignoreScrollUntil = performance.now() + 250;
  $('#back-place').hidden = true;
}
function onFlowScroll() {
  if (!R || R.state !== 'paused') return;
  const flow = $('#flow');
  const inner = $('#flow-inner');
  if (flow.scrollTop + flow.clientHeight > flow.scrollHeight - 1400 && R.loaded[1] < R.segs.length - 1) {
    R.loaded[1]++;
    inner.insertAdjacentHTML('beforeend', segHTML(R.loaded[1]));
    paintMarks();
    setCurrentClass();
    if (R.loaded[1] - R.loaded[0] > SEG_WINDOW) {
      const first = inner.firstElementChild;
      const h = first.getBoundingClientRect().height;
      first.remove();
      flow.scrollTop -= h;
      R.loaded[0]++;
    }
  } else if (flow.scrollTop < 1000 && R.loaded[0] > 0) {
    R.loaded[0]--;
    const before = flow.scrollHeight;
    inner.insertAdjacentHTML('afterbegin', segHTML(R.loaded[0]));
    paintMarks();
    setCurrentClass();
    flow.scrollTop += flow.scrollHeight - before;
    if (R.loaded[1] - R.loaded[0] > SEG_WINDOW) {
      inner.lastElementChild.remove();
      R.loaded[1]--;
    }
  }
  if (performance.now() > (R.ignoreScrollUntil || 0) && !R.jump) {
    const el = wordEl(R.pos);
    let away = true;
    if (el) {
      const fr = flow.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      away = er.bottom < fr.top + 60 || er.top > fr.bottom - 180;
    }
    $('#back-place').hidden = !away;
  }
}

/* RSVP word */
function renderWord(text) {
  if (!R) return;
  R.lastText = text;
  const left = $('#w-left');
  if (!left) return;
  const pivot = $('#w-pivot');
  const right = $('#w-right');
  const parts = splitAtPivot(text, S.pivotMode);
  left.textContent = parts.left;
  pivot.textContent = parts.pivot;
  right.textContent = parts.right;
  layoutWord(left, pivot, right, $('#word'), S.wordSize);
}
function layoutWord(left, pivot, right, box, size) {
  box.style.fontSize = `${size}px`;
  const place = () => {
    const width = box.clientWidth || box.parentElement.clientWidth || innerWidth;
    const anchor = width * (S.pivotX / 100);
    const pw = pivot.offsetWidth;
    return { width, anchor, pw };
  };
  let { width, anchor, pw } = place();
  const margin = 10;
  const scale = Math.min(1,
    left.offsetWidth ? (anchor - pw / 2 - margin) / left.offsetWidth : 1,
    right.offsetWidth ? (width - anchor - pw / 2 - margin) / right.offsetWidth : 1);
  // A word too long to fit around the anchor is centered so it stays readable.
  if (scale < 0.6) {
    const total = left.offsetWidth + pw + right.offsetWidth;
    box.style.fontSize = `${Math.max(11, Math.floor(size * Math.min(1, (width - margin * 2) / total)))}px`;
    const lw = left.offsetWidth;
    const pw2 = pivot.offsetWidth;
    const start = Math.max(margin, (width - (lw + pw2 + right.offsetWidth)) / 2);
    left.style.right = 'auto';
    left.style.left = `${start}px`;
    pivot.style.left = `${start + lw}px`;
    right.style.left = `${start + lw + pw2}px`;
    return;
  }
  if (scale < 1) {
    box.style.fontSize = `${Math.floor(size * scale)}px`;
    ({ width, anchor, pw } = place());
  }
  pivot.style.left = `${anchor - pw / 2}px`;
  left.style.right = `${width - anchor + pw / 2}px`;
  left.style.left = 'auto';
  right.style.left = `${anchor + pw / 2}px`;
}

function updateMeta() {
  if (!R) return;
  const total = Math.max(1, R.words.length - 1);
  // While a jump waits for confirmation, the bar shows where it would land and the saved spot stays put.
  const pos = R.jump ? R.jump.to : R.pos;
  const ratio = pos / total;
  const fill = $('#scrub-fill');
  if (fill) fill.style.width = `${ratio * 100}%`;
  const scrub = $('#scrub');
  if (scrub && !R.scrubbing) scrub.value = pos;
  const pctEl = $('#m-pct');
  const left = formatDuration(narrating() ? R.narration.remainingMs(pos) : estimateMs(R.words.length - pos, R.wpm, S.smartPacing));
  if (pctEl) {
    pctEl.textContent = `${Math.round(ratio * 100)}%`;
    $('#m-left').textContent = `${left} left`;
  }
  const lp = $('#live-progress');
  if (lp) lp.style.width = `${ratio * 100}%`;
  const lt = $('#live-text');
  if (lt) lt.textContent = `${left} left`;
  const ch = currentChapter(pos);
  const title = $('#c-title');
  if (title) {
    title.textContent = ch ? ch.title : R.book.title;
    $('#c-book').hidden = !ch || ch.title === R.book.title;
  }
}
function currentChapter(pos) {
  if (!R.chapterStarts.length) return null;
  const sorted = R.chapterStarts;
  let found = -1;
  for (let i = 0; i < sorted.length && sorted[i] <= pos; i++) found = i;
  return found < 0 ? null : R.book.chapters[found];
}
function updateWpm(showBadge) {
  if (narrating()) { applyNarrationMode(); updateMeta(); return; }
  const v = $('#wpm-v');
  if (v) v.textContent = R.wpm;
  const popValue = $('#pop-v');
  if (popValue) {
    popValue.textContent = R.wpm;
    $('#wpm-slider').value = R.wpm;
    $('#pop-time').textContent = `${formatDuration(estimateMs(R.words.length - R.pos, R.wpm, S.smartPacing))} left`;
  }
  if (showBadge && !wpmPopOpen()) {
    const badge = $('#wpm-badge');
    badge.textContent = `${R.wpm} WPM`;
    badge.classList.add('on');
    clearTimeout(R.badgeTimer);
    R.badgeTimer = setTimeout(() => badge.classList.remove('on'), 900);
  }
  updateMeta();
}
const wpmPopOpen = () => !!$('#wpm-pop')?.classList.contains('open');
function toggleWpmPop(open) {
  if (narrating()) { if (open) showNarration(R.book).catch(error => toast(error.message)); return; }
  const pop = $('#wpm-pop');
  if (!pop) return;
  if (open) {
    pop.style.bottom = `${$('#bottom-bar').offsetHeight + 8}px`;
    const slider = $('#wpm-slider');
    slider.min = S.wpmMin;
    slider.max = S.wpmMax;
    $('#pop-min').textContent = S.wpmMin;
    $('#pop-max').textContent = S.wpmMax;
    updateWpm();
  }
  pop.classList.toggle('open', open);
  $('#wpm-box').setAttribute('aria-expanded', open);
}
function setWpm(value) {
  const next = clamp(value, S.wpmMin, S.wpmMax);
  if (next === R.wpm) return;
  R.wpm = next;
  R.book.wpm = next;
  updateWpm();
  saveProgress();
}
function changeWpm(steps) {
  if (narrating()) {
    R.book.audioRate = clamp(Math.round(((R.book.audioRate || 1) + steps * 0.1) * 10) / 10, 0.5, 2);
    R.narration.setRate(R.book.audioRate); applyNarrationMode(); saveProgress(true); return;
  }
  const next = clamp(Math.round((R.wpm + steps * S.wpmStep) / S.wpmStep) * S.wpmStep, S.wpmMin, S.wpmMax);
  if (next !== R.wpm) {
    R.wpm = next;
    R.book.wpm = next;
    saveProgress(true);
  }
  updateWpm(true);
}

/* Playback */
function setMode(mode) {
  const el = $('#reader');
  el.classList.toggle('playing', mode === 'playing');
  el.classList.toggle('starting', mode === 'starting');
  R.state = mode;
  const play = $('#play');
  play.innerHTML = icon(mode === 'paused' ? 'play' : 'pause');
  play.setAttribute('aria-label', mode === 'paused' ? 'Play' : 'Pause');
}
async function acquireWake() {
  if (!S.keepAwake || !navigator.wakeLock) return;
  try {
    if (!wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch {}
}
function releaseWake() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}
function flyWord(fromRect, toRect, text, fontCSS, done) {
  if (reducedMotion() || !fromRect || !toRect || !fromRect.width) { done?.(); return; }
  const fly = document.createElement('div');
  fly.id = 'fly';
  fly.textContent = text;
  fly.style.cssText = `left:${fromRect.left}px;top:${fromRect.top}px;${fontCSS}`;
  $('#reader').appendChild(fly);
  const own = fly.getBoundingClientRect();
  const scale = (toRect.width || own.width) / (own.width || 1);
  const dx = toRect.left - fromRect.left;
  const dy = toRect.top - fromRect.top;
  const animation = fly.animate(
    [{ transform: 'none' }, { transform: `translate(${dx}px, ${dy}px) scale(${scale})` }],
    { duration: 300, easing: 'cubic-bezier(.3,.7,.2,1)', fill: 'forwards' });
  animation.onfinish = () => { fly.remove(); done?.(); };
  animation.oncancel = () => { fly.remove(); done?.(); };
}
function play(options = {}) {
  if (!R || R.state !== 'paused') return;
  if (bookMode() && !narrating()) { R.book.readingView = 'rsvp'; renderReader(); saveProgress(true); }
  if (narrating()) { playNarration(); return; }
  toggleWpmPop(false);
  if (R.pos >= R.words.length - 1) R.pos = 0;
  unlockAudio();
  if (R.jump) clearJump();
  hideJumpBar();
  if (S.sound !== 'off') playSound(S.sound, S.volume);
  acquireWake();
  if (S.resumeBack && !options.fromSeek) R.pos = Math.max(0, R.pos - S.resumeBack);
  const run = ++R.run;
  R.sinceplay = 0;
  R.sessionStart = 0;
  R.sessionWords = 0;
  $('#back-place').hidden = true;
  const source = wordEl(R.pos);
  const from = source?.getBoundingClientRect();
  const chunk = chunkAt(R.pos, R.words, R.wordBlock, S.wordsPerFlash, R.glue);
  setMode('starting');
  renderWord(chunk.text);
  $('#word').style.visibility = 'hidden';
  const wordBox = wordRect();
  const flowStyle = getComputedStyle($('#flow'));
  const start = () => {
    if (run !== R.run) return;
    $('#word').style.visibility = '';
    const n = options.instant ? 0 : S.countdown;
    const count = $('#count');
    let left = n;
    const stepCount = () => {
      if (run !== R.run) return;
      if (left <= 0) {
        count.textContent = '';
        setMode('playing');
        R.sessionStart = performance.now();
        R.nextAt = performance.now();
        tick(run);
        return;
      }
      count.textContent = left;
      left--;
      R.timer = setTimeout(stepCount, 1000);
    };
    stepCount();
  };
  if (options.instant || !from) start();
  else flyWord(from, wordBox, R.words[R.pos], `font:${flowStyle.fontSize}/1.2 ${flowStyle.fontFamily};`, start);
}
function wordRect() {
  const a = $('#w-left').getBoundingClientRect();
  const b = $('#w-pivot').getBoundingClientRect();
  const c = $('#w-right').getBoundingClientRect();
  const left = a.width ? a.left : b.left;
  const right = c.width ? c.right : b.right;
  return { left, top: b.top, width: right - left, height: b.height };
}
function tick(run) {
  if (run !== R.run || R.state !== 'playing') return;
  const chunk = chunkAt(R.pos, R.words, R.wordBlock, S.wordsPerFlash, R.glue);
  renderWord(chunk.text);
  const nextIndex = R.pos + chunk.count;
  const endOfParagraph = nextIndex < R.words.length && R.wordBlock[nextIndex] !== R.wordBlock[R.pos]
    && !R.blocks[R.wordBlock[nextIndex]].continues;
  let delay = wordDelay(chunk.text, chunk.count, { ...S, wpm: R.wpm }, endOfParagraph)
    * rampFactor(R.sinceplay, S.ramp);
  // Keeps long-run timing accurate if a frame runs late.
  const now = performance.now();
  if (now - R.nextAt < 40) delay -= Math.max(0, now - R.nextAt);
  const chapterIndex = R.chapterStarts.indexOf(nextIndex);
  const announce = chapterIndex >= 0 && R.book.chapters[chapterIndex].announce !== false;
  if (announce) delay += S.chapterPause;
  R.nextAt = now + delay;
  R.timer = setTimeout(() => {
    if (run !== R.run) return;
    R.sinceplay += chunk.count;
    R.sessionWords += chunk.count;
    if (nextIndex >= R.words.length) {
      R.pos = R.words.length - 1;
      finishBook();
      return;
    }
    R.pos = nextIndex;
    if (announce && S.chapterCall) showChapterCall(R.book.chapters[chapterIndex].title);
    updateMeta();
    if (now - R.lastSave > 5000) saveProgress();
    tick(run);
  }, Math.max(8, delay));
}
function showChapterCall(title) {
  const el = $('#chapter-call');
  el.textContent = title;
  el.classList.add('on');
  clearTimeout(R.callTimer);
  R.callTimer = setTimeout(() => el.classList.remove('on'), 2400);
}
function commitSession() {
  if (!R || !R.sessionStart) return;
  const ms = performance.now() - R.sessionStart;
  const words = R.sessionWords;
  R.sessionStart = 0;
  R.sessionWords = 0;
  if (words < 5 || ms < 1000) return;
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  db.put('sessions', { bookId: R.book.id, title: R.book.title, day, at: Date.now(), ms: Math.round(ms), words }).catch(() => {});
}
function pause({ animate = true } = {}) {
  if (!R || R.state === 'paused') return;
  R.run++;
  R.narration?.pause();
  clearTimeout(R.timer);
  commitSession();
  releaseWake();
  if (S.soundMode !== 'reader') stopSound();
  $('#count').textContent = '';
  const toFrom = animate ? wordRect() : null;
  const flow = $('#flow');
  setMode('paused');
  showFlowAt(R.pos, true);
  updateMeta();
  saveProgress(true);
  const target = wordEl(R.pos);
  if (animate && target && toFrom) {
    const style = getComputedStyle($('#word'));
    flyWord(toFrom, target.getBoundingClientRect(), R.words[R.pos], `font:${style.fontWeight} ${style.fontSize}/1.25 ${style.fontFamily};`);
  }
  flow.focus?.({ preventScroll: true });
}
function togglePlay() { if (R.state === 'paused') play(); else pause(); }
function finishBook() {
  R.book.finishedAt = Date.now();
  pause();
  toast('You finished this book.');
}
function saveProgress(force) {
  if (!R) return;
  const now = performance.now();
  if (!force && now - R.lastSave < 2000) return;
  R.lastSave = now;
  R.book.pos = R.pos;
  R.book.lastReadAt = Date.now();
  return db.put('books', R.book).catch(() => {});
}
function seek(pos, { undo = false } = {}) {
  const from = R.pos;
  if (R.jump) clearJump();
  hideJumpBar();
  R.pos = clamp(pos, 0, R.words.length - 1);
  if (narrating()) {
    if (R.state !== 'paused') playNarration({ resume: false });
    else R.narration.playAt(R.pos, { paused: true, resume: false }).catch(error => toast(error.message));
  }
  updateMeta();
  renderWord(R.words[R.pos]);
  if (R.state === 'paused') showFlowAt(R.pos, true);
  saveProgress(true);
  if (undo && Math.abs(R.pos - from) > 200) showJumpBar('undo', from);
}
function clearJump() {
  if (!R) return;
  R.jump = null;
  R.scrubbing = false;
  hideJumpBar();
  updateMeta();
}
function hideJumpBar() {
  if (R) clearTimeout(R.jumpTimer);
  const bar = $('#jump-bar');
  if (bar) bar.hidden = true;
}
// 'confirm' asks before a drag on the progress bar moves you; 'undo' offers a way back after a chapter, bookmark, or search jump.
function showJumpBar(kind, from) {
  const bar = $('#jump-bar');
  if (!bar) return;
  clearTimeout(R.jumpTimer);
  const total = Math.max(1, R.words.length - 1);
  const at = kind === 'confirm' ? R.jump.to : R.pos;
  const chapter = currentChapter(at);
  const label = `${Math.round((at / total) * 100)}%${chapter ? ` · ${chapter.title}` : ''}`;
  $('#jump-text').textContent = kind === 'confirm' ? `Jump to ${label}?` : `Jumped to ${label}`;
  $('#jump-go').textContent = kind === 'confirm' ? 'Jump here' : 'Undo';
  $('#jump-back').hidden = kind !== 'confirm';
  bar.dataset.kind = kind;
  R.undoFrom = from;
  bar.hidden = false;
  $('#back-place').hidden = true;
  if (kind === 'undo') R.jumpTimer = setTimeout(hideJumpBar, 8000);
}
function rewindBy(n) {
  seek(R.pos - n);
}

/* Gestures */
function bindReader() {
  const reader = $('#reader');
  const flow = $('#flow');
  flow.addEventListener('scroll', onFlowScroll, { passive: true });
  $('#r-back').onclick = () => { pause({ animate: false }); saveProgress(true); stopSound(); R.narration?.dispose(); R.bookView?.destroy(); R = null; showLibrary(); };
  $('#chapter-btn').onclick = () => showToc('chapters');
  $('#r-toc').onclick = () => showToc('chapters');
  $('#r-mark').onclick = addBookmark;
  $('#r-audio').onclick = () => showNarration(R.book).catch(error => toast(error.message));
  $('#r-settings').onclick = () => bookMode() ? showBookAppearance() : showSettings();
  $('#r-book').onclick = () => setReadingView(bookMode() ? 'rsvp' : 'book');
  $('#book-prev').onclick = () => R.bookView?.turn(-1);
  $('#book-next').onclick = () => R.bookView?.turn(1);
  $('#r-rew').onclick = () => rewindBy(S.rewind);
  $('#w-up').onclick = () => changeWpm(1);
  $('#w-down').onclick = () => changeWpm(-1);
  $('#r-sound').onclick = showSoundSheet;
  $('#play').onclick = () => togglePlay();
  $('#wpm-box').onclick = () => toggleWpmPop(!wpmPopOpen());
  $('#wpm-slider').oninput = e => setWpm(Number(e.target.value));
  $('#wpm-slider').onchange = () => saveProgress(true);
  $('#back-place').onclick = () => showFlowAt(R.pos, true);
  const scrub = $('#scrub');
  scrub.oninput = () => {
    R.scrubbing = true;
    hideJumpBar();
    R.jump = { from: R.jump ? R.jump.from : R.pos, to: Number(scrub.value) };
    updateMeta();
  };
  scrub.onchange = () => {
    R.scrubbing = false;
    if (!R.jump) return;
    if (R.jump.to === R.jump.from) clearJump();
    else showJumpBar('confirm', R.jump.from);
  };
  $('#jump-go').onclick = () => {
    if ($('#jump-bar').dataset.kind === 'confirm') {
      const to = R.jump.to;
      clearJump();
      seek(to);
    } else {
      const back = R.undoFrom;
      hideJumpBar();
      seek(back);
    }
  };
  $('#jump-back').onclick = clearJump;

  let g = null;
  const isControl = t => t.closest('button, input, .bar, label, select, a, #wpm-pop');
  reader.addEventListener('pointerdown', e => {
    // A tap anywhere else leaves the pending jump behind and keeps your spot.
    if (R.jump && !e.target.closest('#jump-bar, #scrub-wrap')) clearJump();
    if (wpmPopOpen() && !e.target.closest('#wpm-pop, #wpm-box')) {
      toggleWpmPop(false);
      if (!e.target.closest('button, input, .bar')) { g = null; return; }
    }
    if (isControl(e.target) || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (bookMode() && e.target.closest('#book-view')) return;
    g = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), mode: null, wpmSteps: 0, startPos: R.pos, wasPlaying: R.state === 'playing' };
    if (R.state === 'paused') {
      const word = e.target.closest('.w');
      if (word) {
        g.pressTimer = setTimeout(() => {
          if (!g || g.mode) return;
          g.mode = 'menu';
          blockScrim = true;
          showWordMenu(Number(word.dataset.i));
        }, 480);
        word.classList.add('pressed');
        g.pressed = word;
      }
    }
  });
  const clearPress = () => {
    if (!g) return;
    clearTimeout(g.pressTimer);
    g.pressed?.classList.remove('pressed');
    g.pressed = null;
  };
  reader.addEventListener('pointermove', e => {
    if (!g || e.pointerId !== g.id) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (!g.mode || g.mode === 'pending') {
      if (Math.abs(dx) > 10 || Math.abs(dy) > 10) clearPress();
      if (Math.abs(dx) > 14 && Math.abs(dx) > Math.abs(dy) * 1.3) {
        g.mode = 'wpm';
        try { reader.setPointerCapture(g.id); } catch {}
      } else if (dy > 14 && dy > Math.abs(dx) * 1.3 && R.state !== 'paused') {
        g.mode = 'rewind';
        R.run++;
        clearTimeout(R.timer);
        if (narrating()) R.narration.pause();
        try { reader.setPointerCapture(g.id); } catch {}
      }
    }
    if (g.mode === 'wpm') {
      const steps = Math.trunc(dx / S.swipeSize);
      if (steps !== g.wpmSteps) {
        changeWpm(steps - g.wpmSteps);
        g.wpmSteps = steps;
      }
    } else if (g.mode === 'rewind') {
      const back = Math.round((dy - 14) / 9);
      R.pos = clamp(g.startPos - Math.max(0, back), 0, R.words.length - 1);
      renderWord(R.words[R.pos]);
      updateMeta();
    }
  });
  reader.addEventListener('contextmenu', e => e.preventDefault());
  const finish = e => {
    if (!g || e.pointerId !== g.id) return;
    const current = g;
    g = null;
    clearTimeout(current.pressTimer);
    current.pressed?.classList.remove('pressed');
    if (e.type === 'pointercancel') {
      if (current.mode === 'menu') setTimeout(() => { blockScrim = false; }, 400);
      if (current.mode === 'rewind') resumeAfterRewind();
      return;
    }
    if (current.mode === 'menu') setTimeout(() => { blockScrim = false; }, 400);
    const elapsed = performance.now() - current.t;
    const moved = Math.hypot(e.clientX - current.x, e.clientY - current.y);
    if (current.mode === 'rewind') {
      const dy = e.clientY - current.y;
      if (elapsed < 260 && dy > 24) {
        R.pos = clamp(current.startPos - S.rewind, 0, R.words.length - 1);
        renderWord(R.words[R.pos]);
        updateMeta();
      }
      resumeAfterRewind();
      return;
    }
    if (current.mode || moved > 12) return;
    // Text taps exit playback, but only the explicit Play control starts it.
    if (R.state !== 'paused') pause();
  };
  reader.addEventListener('pointerup', finish);
  reader.addEventListener('pointercancel', finish);
}
function resumeAfterRewind() {
  saveProgress(true);
  if (narrating()) { if (R.state !== 'paused') playNarration(); return; }
  if (R.state === 'playing') {
    const run = ++R.run;
    R.sinceplay = 0;
    R.nextAt = performance.now();
    R.timer = setTimeout(() => tick(run), 260);
  } else if (R.state === 'starting') {
    pause({ animate: false });
  }
}

/* Word menu, bookmarks */
function showWordMenu(i) {
  const excerpt = R.words.slice(Math.max(0, i - 3), i + 6).join(' ');
  const sheet = openSheet('This word', `<div class="sheet-body">
    <p class="muted">${esc(excerpt)}</p>
    <button class="menu-btn" data-a="start">Read from here</button>
    <button class="menu-btn" data-a="mark">Add a bookmark here</button></div>`);
  sheet.onclick = e => {
    const action = e.target.closest('[data-a]')?.dataset.a;
    if (action === 'start') { closeSheet(); pause({ animate: false }); seek(i); }
    if (action === 'mark') { closeSheet(); addBookmark(i); }
  };
}
function addBookmark(at) {
  const word = typeof at === 'number' ? at : R.pos;
  R.book.bookmarks = R.book.bookmarks || [];
  if (!R.book.bookmarks.some(m => m.word === word)) {
    R.book.bookmarks.push({ word, at: Date.now(), label: R.words.slice(word, word + 8).join(' ') });
    R.book.bookmarks.sort((a, b) => a.word - b.word);
    wordEl(word)?.classList.add('marked');
    saveProgress(true);
    toast('Bookmark added');
  } else toast('This word is already bookmarked');
}

/* Chapters, bookmarks, search */
function showToc(tab) {
  const total = Math.max(1, R.words.length - 1);
  const percent = w => `${Math.round((w / total) * 100)}%`;
  const sheet = openSheet(R.book.title, `<div class="tabs" role="tablist">
      <button role="tab" data-t="chapters">Chapters</button><button role="tab" data-t="bookmarks">Bookmarks</button><button role="tab" data-t="search">Search</button>
    </div><button class="menu-btn clean-open" id="reader-audiobook">Audiobook</button>${R.book.hasCleanup ? '<button class="menu-btn clean-open" id="reader-cleanup">Review reading text</button>' : ''}<div class="sheet-body" id="toc-body"></div>`, { tall: true });
  $('#reader-audiobook', sheet).onclick = () => showNarration(R.book).catch(error => toast(error.message));
  if ($('#reader-cleanup', sheet)) $('#reader-cleanup', sheet).onclick = () => editBookCleanup(R.book).catch(error => { console.error(error); toast('Changes could not be saved. Try again.'); });
  const body = $('#toc-body', sheet);
  const go = word => { closeSheet(); seek(word, { undo: true }); };
  const draw = name => {
    $$('.tabs button', sheet).forEach(b => b.setAttribute('aria-selected', b.dataset.t === name));
    if (name === 'chapters') {
      const now = currentChapter(R.pos);
      body.innerHTML = R.book.chapters.length ? R.book.chapters.map((c, i) => `
        <button class="toc-item ${c === now ? 'now' : ''}" data-word="${R.chapterStarts[i]}" style="padding-left:${(c.depth || 0) * 16}px">
          <span class="t">${esc(c.title)}</span><span class="pct">${percent(R.chapterStarts[i])}</span></button>`).join('')
        : `<p class="muted">This document has no chapters. Use the progress bar or search to move around.</p>`;
      $('.toc-item.now', body)?.scrollIntoView({ block: 'center' });
    } else if (name === 'bookmarks') {
      const marks = R.book.bookmarks || [];
      body.innerHTML = marks.length ? marks.map((m, i) => `<div class="mark-row">
        <button class="toc-item" data-word="${m.word}"><span class="t">${esc(m.label)}</span><span class="pct">${percent(m.word)}</span></button>
        <button class="icon-btn" data-del="${i}" aria-label="Remove bookmark">${icon('trash')}</button></div>`).join('')
        : `<p class="muted">Add a bookmark with the bookmark button, or press and hold a word in the text.</p>`;
    } else {
      body.innerHTML = `<input class="field-text" id="q" type="search" placeholder="Search for a word or phrase" aria-label="Search this book"><div id="hits"></div>`;
      const q = $('#q', body);
      let timer;
      q.oninput = () => { clearTimeout(timer); timer = setTimeout(() => runSearch(q.value, $('#hits', body)), 180); };
      q.focus();
    }
    body.classList.remove('fade-in');
    void body.offsetWidth;
    body.classList.add('fade-in');
  };
  sheet.onclick = e => {
    const tabBtn = e.target.closest('[data-t]');
    if (tabBtn) { draw(tabBtn.dataset.t); return; }
    const del = e.target.closest('[data-del]');
    if (del) {
      const [removed] = R.book.bookmarks.splice(Number(del.dataset.del), 1);
      wordEl(removed.word)?.classList.remove('marked');
      saveProgress(true);
      draw('bookmarks');
      return;
    }
    const target = e.target.closest('[data-word]');
    if (target) go(Number(target.dataset.word));
  };
  draw(tab);
}
function runSearch(query, out) {
  const q = query.trim().toLowerCase();
  if (q.length < 2) { out.innerHTML = ''; return; }
  const hits = [];
  for (let b = 0; b < R.blocks.length && hits.length < 200; b++) {
    const start = R.blockStart[b];
    const end = b + 1 < R.blocks.length ? R.blockStart[b + 1] : R.words.length;
    if (end === start) continue;
    let text = '';
    const offsets = [];
    for (let w = start; w < end; w++) {
      offsets.push(text.length);
      text += R.words[w] + (R.glue[w] ? '' : ' ');
    }
    const lower = text.toLowerCase();
    let at = lower.indexOf(q);
    while (at >= 0 && hits.length < 200) {
      const wordIndex = start + Math.max(0, lowerBound(offsets, at));
      const from = Math.max(0, at - 44);
      hits.push({
        word: wordIndex,
        html: `${from ? '…' : ''}${esc(text.slice(from, at))}<mark>${esc(text.slice(at, at + q.length))}</mark>${esc(text.slice(at + q.length, at + q.length + 54))}…`,
      });
      at = lower.indexOf(q, at + q.length);
    }
  }
  out.innerHTML = hits.length
    ? `<p class="muted">${hits.length === 200 ? 'First 200 results' : `${hits.length} ${hits.length === 1 ? 'result' : 'results'}`}</p>`
      + hits.map(h => `<button class="hit" data-word="${h.word}">${h.html}</button>`).join('')
    : `<p class="muted">No results for “${esc(query)}”.</p>`;
}

/* ---------- Sound tracks ---------- */
let tracks = [];
const soundOptions = () => [
  ['off', 'Off'],
  ...SOUND_OPTIONS.filter(([k]) => k !== 'off' && !S.hiddenSounds.includes(k)),
  ...tracks.map(t => [`c:${t.id}`, t.name]),
];
const soundLabel = key => soundOptions().find(([k]) => k === key)?.[1] || 'Off';
// Switches to Off when the chosen track has been removed.
function fixSound() {
  if (S.sound === 'off' || soundOptions().some(([k]) => k === S.sound)) return;
  S.sound = 'off';
  stopSound();
  saveSettings();
}
const MAX_TRACK_FILE = 60 * 1048576;
const trackMb = bytes => `${(bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0)} MB`;
const trackLength = seconds => {
  const total = Math.max(1, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};
const trackName = fileName => fileName.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim().slice(0, 60) || 'Untitled track';

// Reads each chosen file, checks that it can be played, and keeps it on the device.
async function addTracks(files) {
  let added = 0;
  const notes = [];
  for (const file of files) {
    const name = trackName(file.name);
    if (file.size > MAX_TRACK_FILE) { notes.push(`“${name}” is over ${trackMb(MAX_TRACK_FILE)}`); continue; }
    toast(`Adding “${name}”`, 20000);
    try {
      const data = await file.arrayBuffer();
      const info = await analyzeTrack(data);
      if (info.tooLong) {
        notes.push(`“${name}” is too long to loop, so try one under about ${Math.floor(info.maxSeconds / 60)} minutes`);
        continue;
      }
      const track = { id: uid(), name, size: file.size, duration: info.duration, norm: info.norm, level: 1, addedAt: Date.now() };
      await db.saveTrack(track, data);
      tracks.push(track);
      added++;
      if (info.decodedBytes > 100 * 1048576) notes.push(`“${name}” is long, so it uses about ${trackMb(info.decodedBytes)} of memory while it plays`);
    } catch (error) {
      console.error(error);
      notes.push(error?.name === 'QuotaExceededError' ? 'There is not enough storage for this file' : `“${name}” could not be read as audio`);
    }
  }
  const summary = [added ? `Added ${added} ${added === 1 ? 'track' : 'tracks'}` : '', ...notes].filter(Boolean).join('. ');
  toast(`${summary}.`, notes.length ? 6000 : 2600);
  return added;
}
async function removeTrack(key) {
  if (key.startsWith('c:')) {
    const id = key.slice(2);
    await db.deleteTrack(id);
    tracks = tracks.filter(t => t.id !== id);
    dropTrack(id);
  } else if (!S.hiddenSounds.includes(key)) S.hiddenSounds = [...S.hiddenSounds, key];
  fixSound();
  saveSettings();
}

function showSoundSheet() {
  const sheet = openSheet('Ambient sound', `<div class="sheet-body">
    ${soundOptions().map(([k, label]) => `<button class="menu-btn" data-s="${k}" ${S.sound === k ? 'style="color:var(--hi);font-weight:600"' : ''}>${esc(label)}</button>`).join('')}
    <button class="menu-btn" data-manage>Add or remove tracks</button>
    <div class="set-row"><div class="set-line"><label for="vol">Volume</label><span class="set-value" id="vol-v">${pct(S.volume)}</span></div>
    <input id="vol" type="range" min="0" max="1" step="0.05" value="${S.volume}"></div>
    <p class="muted">Sounds may stop when you lock your phone or leave the app.</p></div>`, {
    onClose: () => { if (!R || (R.state === 'paused' && S.soundMode !== 'reader')) stopSound(); },
  });
  sheet.onclick = e => {
    if (e.target.closest('[data-manage]')) { showSettings('Ambient sound'); return; }
    const choice = e.target.closest('[data-s]');
    if (!choice) return;
    S.sound = choice.dataset.s;
    saveSettings();
    playSound(S.sound, S.volume);
    $$('[data-s]', sheet).forEach(b => { b.style.cssText = b === choice ? 'color:var(--hi);font-weight:600' : ''; });
  };
  $('#vol', sheet).oninput = e => {
    S.volume = Number(e.target.value);
    $('#vol-v', sheet).textContent = pct(S.volume);
    setVolume(S.volume);
    saveSettings();
  };
}

/* ---------- Settings screen ---------- */
function showSettings(startPage = null) {
  const valueText = c => {
    const v = S[c.k];
    if (c.format) return c.format(v);
    if (c.fixed !== undefined) return `${v.toFixed(c.fixed)}${c.unit || ''}`;
    return `${v}${c.unit || ''}`;
  };
  const control = c => {
    if (c.type === 'themes') {
      return `<div class="set-row"><div class="themes">${Object.entries(THEMES).map(([k, t]) => {
        const tc = k === 'custom' ? { bg: S.customBg, ink: S.customInk, hi: S.customHi } : t;
        return `<button class="theme-chip" data-theme-pick="${k}" aria-pressed="${S.theme === k}" style="background:${tc.bg};color:${tc.ink}"><b>a<span style="color:${tc.hi}">b</span>c</b>${t.name}</button>`;
      }).join('')}</div></div>`;
    }
    if (c.type === 'custom') {
      const row = (k, label) => `<div class="set-row"><div class="set-line"><span class="set-label">${label}</span><span class="color-line">
        <input type="color" data-color="${k}" value="${S[k]}" aria-label="${label} color picker">
        <input type="text" data-hex="${k}" value="${S[k]}" maxlength="7" autocapitalize="none" autocorrect="off" spellcheck="false" aria-label="${label} hex code"></span></div></div>`;
      return `<div class="custom-rows" ${S.theme === 'custom' ? '' : 'hidden'}>${row('customBg', 'Custom background')}${row('customInk', 'Custom text')}${row('customHi', 'Custom highlight')}</div>`;
    }
    if (c.type === 'tracks') return tracksPanel();
    const help = c.help ? `<small class="set-help">${esc(c.help)}</small>` : '';
    if (c.type === 'toggle') {
      return `<div class="set-row"><div class="set-line"><label for="s-${c.k}">${esc(c.label)}${help}</label>
        <input class="switch" type="checkbox" role="switch" id="s-${c.k}" data-k="${c.k}" ${S[c.k] ? 'checked' : ''}></div></div>`;
    }
    if (c.type === 'select') {
      return `<div class="set-row"><div class="set-line"><label for="s-${c.k}">${esc(c.label)}${help}</label>
        <select id="s-${c.k}" data-k="${c.k}" ${c.num ? 'data-num' : ''}>${c.options.map(([v, l]) => `<option value="${v}" ${String(S[c.k]) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div></div>`;
    }
    return `<div class="set-row"><div class="set-line"><label for="s-${c.k}">${esc(c.label)}${help}</label><span class="set-value" data-v="${c.k}">${valueText(c)}</span></div>
      <input id="s-${c.k}" type="range" data-k="${c.k}" data-num min="${c.min}" max="${c.max}" step="${c.step}" value="${S[c.k]}"></div>`;
  };
  let removing = null;
  const tracksPanel = () => {
    const row = ([key, label]) => {
      const custom = key.startsWith('c:');
      const meta = custom ? tracks.find(t => t.id === key.slice(2)) : null;
      const detail = key === 'off' ? 'No sound' : meta ? `${trackLength(meta.duration)} · ${trackMb(meta.size)}` : 'Built in';
      const trash = key === 'off' ? '' : removing === key
        ? `<span class="track-ask"><button class="secondary" data-remove="${esc(key)}">Remove</button><button class="secondary" data-keep>Keep</button></span>`
        : `<button class="icon-btn" data-ask="${esc(key)}" aria-label="Remove ${esc(label)}">${icon('trash')}</button>`;
      return `<div class="track-row"><button class="track-pick" data-pick="${esc(key)}" aria-pressed="${S.sound === key}"><b>${esc(label)}</b><small>${detail}</small></button>${trash}</div>`;
    };
    const current = S.sound.startsWith('c:') ? tracks.find(t => t.id === S.sound.slice(2)) : null;
    const level = current ? `<div class="set-row"><div class="set-line"><label for="track-level">Level for this track</label><span class="set-value" id="track-level-v">${pct(current.level)}</span></div>
      <input id="track-level" type="range" data-level="${current.id}" min="0.25" max="2" step="0.05" value="${current.level}"></div>` : '';
    return `<div class="set-row"><div class="set-line"><span class="set-label">Tracks<small class="set-help">Tap a track to choose it and hear it. Your own files loop over and over.</small></span></div>
      <div class="track-list">${soundOptions().map(row).join('')}</div></div>${level}
      <label class="menu-btn" for="add-track" style="cursor:pointer">Add audio files<small>MP3, M4A, WAV, or AAC. They stay on this device, and loud ones are evened out.</small></label>
      <input id="add-track" type="file" multiple accept="audio/*,.mp3,.m4a,.aac,.wav,.caf" style="position:absolute;opacity:0;width:1px;height:1px">
      <button class="menu-btn" data-a="restore-sounds">Restore built-in tracks<small>${S.hiddenSounds.length ? `Brings back ${S.hiddenSounds.length} you removed. Your own files stay.` : 'None are removed. Your own files stay either way.'}</small></button>`;
  };
  const redrawPage = () => {
    const top = body.scrollTop;
    body.innerHTML = SETTINGS.find(([n]) => n === currentPage)[1].map(control).join('');
    body.scrollTop = top;
  };
  const all = SETTINGS.flatMap(([, list]) => list);
  const fontName = k => FONTS[k]?.[0] || '';
  const SUMMARY = {
    Colors: () => `${THEMES[S.theme]?.name || 'Custom'} theme`,
    'RSVP word': () => `${fontName(S.wordFont)}, ${S.wordSize} pt`,
    'Scrolling text': () => `${fontName(S.textFont)}, ${S.textSize} pt`,
    Speed: () => `${S.countdown} s countdown, ${S.wpm} WPM for new books`,
    Pacing: () => (S.smartPacing ? 'Natural pauses on' : 'Natural pauses off'),
    'Ambient sound': () => soundLabel(S.sound),
    'Reading goal': () => `${S.dailyGoal} min a day`,
    Controls: () => 'Press Play to start; tap to pause',
    'Library and data': () => 'Backup, restore, and storage',
  };
  const PREVIEW = { Colors: 'word', 'RSVP word': 'word', 'Scrolling text': 'text' };
  const dataPage = () => `
    <button class="menu-btn" data-a="app-update">Check for app updates<small>Load the latest reader and keep your place</small></button>
    <button class="menu-btn" data-a="backup">Save a backup<small>Includes your books, progress, bookmarks, stats, and settings</small></button>
    <label class="menu-btn" for="restore" style="cursor:pointer">Restore from a backup<small>Adds its books and replaces your settings</small></label>
    <input id="restore" type="file" accept=".zip,application/zip" style="position:absolute;opacity:0;width:1px;height:1px">
    <div class="set-row"><div class="set-line"><label for="s-backupTracks">Include your audio files in backups<small class="set-help">${tracks.length ? `Your files take about ${trackMb(tracks.reduce((n, t) => n + t.size, 0))}, which makes backups larger.` : 'Applies to audio files you add.'}</small></label>
      <input class="switch" type="checkbox" role="switch" id="s-backupTracks" data-k="backupTracks" ${S.backupTracks ? 'checked' : ''}></div></div>
    <div class="set-row"><div class="set-line"><label for="s-backupNarration">Include audiobooks in backups<small class="set-help">Audiobooks can make backups much larger.</small></label><input class="switch" type="checkbox" role="switch" id="s-backupNarration" data-k="backupNarration" ${S.backupNarration ? 'checked' : ''}></div></div>
    <div class="menu-btn" id="storage-info"><span>Storage</span><small>Checking</small></div>
    <button class="menu-btn" data-a="reset">Reset settings to defaults</button>
    <button class="menu-btn danger" data-a="clear-stats">Clear reading stats</button>`;
  const pageNames = [...SETTINGS.map(([name]) => name), 'Library and data'];
  let previewedSound = false;
  const sheet = openSheet('Settings', `<div id="set-preview"></div><div class="sheet-body" id="set-body"></div>`, {
    tall: true,
    onClose: () => { if (previewedSound && (!R || (R.state === 'paused' && S.soundMode !== 'reader'))) stopSound(); },
  });
  const head = $('.sheet-head', sheet);
  const heading = $('h2', head);
  head.insertAdjacentHTML('afterbegin', `<button class="icon-btn set-back" id="set-back" aria-label="Back to settings" hidden>${icon('back')}</button>`);
  const body = $('#set-body', sheet);
  const previewSlot = $('#set-preview', sheet);
  let currentPage = null;

  const preview = () => {
    const rail = $('.pv-rail', sheet);
    if (!rail) return;
    const parts = splitAtPivot('stillpoint', S.pivotMode);
    const l = $('.pv-l', sheet); const p = $('.pv-p', sheet); const r = $('.pv-r', sheet);
    l.textContent = parts.left; p.textContent = parts.pivot; r.textContent = parts.right;
    const width = rail.clientWidth;
    const anchor = width * S.pivotX / 100;
    const pw = p.offsetWidth;
    p.style.left = `${anchor - pw / 2}px`;
    l.style.right = `${width - anchor + pw / 2}px`;
    r.style.left = `${anchor + pw / 2}px`;
    $('.pv-tick', sheet).style.left = `${anchor - 1}px`;
  };
  const slide = direction => {
    if (reducedMotion()) return;
    const from = direction === 'in' ? 28 : -28;
    const frames = [{ opacity: 0, transform: `translateX(${from}px)` }, { opacity: 1, transform: 'none' }];
    const timing = { duration: 240, easing: 'cubic-bezier(.2,.8,.2,1)' };
    body.animate(frames, timing);
    if (previewSlot.firstChild) previewSlot.animate(frames, timing);
  };
  const showPage = (name, direction = 'in') => {
    currentPage = name;
    body.scrollTop = 0;
    heading.textContent = name || 'Settings';
    $('#set-back', sheet).hidden = !name;
    head.classList.toggle('sub', !!name);
    const kind = PREVIEW[name];
    previewSlot.innerHTML = kind === 'word'
      ? `<div class="preview" aria-hidden="true"><div class="pv-tick"></div><div class="pv-rail"><span class="pv-l"></span><span class="pv-p"></span><span class="pv-r"></span></div></div>`
      : kind === 'text'
        ? `<div class="preview text" aria-hidden="true"><p>Each word arrives where your eyes already rest. When you pause, the page returns and your place is marked.</p></div>`
        : '';
    if (!name) {
      body.innerHTML = pageNames.map(n => `<button class="set-nav" data-page="${esc(n)}"><span><b>${esc(n)}</b><small>${esc(SUMMARY[n]())}</small></span>${icon('back')}</button>`).join('');
    } else if (name === 'Library and data') {
      body.innerHTML = dataPage();
      storageInfo($('#storage-info', sheet));
    } else {
      body.innerHTML = SETTINGS.find(([n]) => n === name)[1].map(control).join('');
    }
    preview();
    slide(direction);
  };
  showPage(startPage, 'none');

  sheet.addEventListener('input', e => {
    const t = e.target;
    if (t.dataset.level) {
      const track = tracks.find(x => x.id === t.dataset.level);
      if (!track) return;
      track.level = Number(t.value);
      $('#track-level-v', sheet).textContent = pct(track.level);
      setTrackLevel(`c:${track.id}`, track.level);
      return;
    }
    if (t.dataset.k) {
      const k = t.dataset.k;
      S[k] = t.type === 'checkbox' ? t.checked : (t.dataset.num !== undefined ? Number(t.value) : t.value);
      const label = $(`[data-v="${k}"]`, sheet);
      const def = all.find(c => c.k === k);
      if (label) label.textContent = valueText(def);
      if (k === 'sound' && S.sound === 'off') stopSound();
      if (k === 'volume') setVolume(S.volume);
    } else if (t.dataset.color) {
      S[t.dataset.color] = t.value;
      $(`[data-hex="${t.dataset.color}"]`, sheet).value = t.value;
      S.theme = 'custom';
    } else if (t.dataset.hex) {
      const v = t.value.trim();
      if (!/^#[0-9a-fA-F]{6}$/.test(v)) return;
      S[t.dataset.hex] = v.toLowerCase();
      $(`[data-color="${t.dataset.hex}"]`, sheet).value = v.toLowerCase();
      S.theme = 'custom';
    } else return;
    applySettings();
    preview();
    saveSettings();
    if (t.dataset.color || t.dataset.hex) {
      $$('[data-theme-pick]', sheet).forEach(b => b.setAttribute('aria-pressed', b.dataset.themePick === 'custom'));
      const chip = $('[data-theme-pick=custom]', sheet);
      chip.style.background = S.customBg; chip.style.color = S.customInk;
      chip.querySelector('span').style.color = S.customHi;
    }
    if (R) { updateWpm(); }
  });
  sheet.addEventListener('change', e => {
    if (e.target.id === 'restore' && e.target.files[0]) importBackup(e.target.files[0]);
    if (e.target.dataset.level) {
      const track = tracks.find(x => x.id === e.target.dataset.level);
      if (track) db.put('tracks', track).catch(() => {});
    }
    if (e.target.id === 'add-track' && e.target.files.length) {
      const files = [...e.target.files];
      e.target.value = '';
      addTracks(files).then(() => { if (currentPage === 'Ambient sound') redrawPage(); });
    }
  });
  sheet.addEventListener('click', e => {
    const nav = e.target.closest('[data-page]');
    if (nav) { showPage(nav.dataset.page, 'in'); return; }
    if (e.target.closest('#set-back')) { showPage(null, 'out'); return; }
    const pick = e.target.closest('[data-theme-pick]');
    if (pick) {
      S.theme = pick.dataset.themePick;
      $$('[data-theme-pick]', sheet).forEach(b => b.setAttribute('aria-pressed', b === pick));
      const rows = $('.custom-rows', sheet);
      if (rows) rows.hidden = S.theme !== 'custom';
      navigate('fade', () => { applySettings(); preview(); });
      saveSettings();
      return;
    }
    const pickBtn = e.target.closest('[data-pick]');
    if (pickBtn) {
      S.sound = pickBtn.dataset.pick;
      previewedSound = true;
      saveSettings();
      playSound(S.sound, S.volume);
      removing = null;
      redrawPage();
      return;
    }
    const ask = e.target.closest('[data-ask]');
    if (ask) {
      const key = ask.dataset.ask;
      if (key.startsWith('c:')) { removing = key; redrawPage(); return; }
      removeTrack(key).then(() => { toast('Track removed. You can bring it back below.'); redrawPage(); });
      return;
    }
    if (e.target.closest('[data-keep]')) { removing = null; redrawPage(); return; }
    const gone = e.target.closest('[data-remove]');
    if (gone) {
      removing = null;
      removeTrack(gone.dataset.remove).then(() => { toast('Track removed'); redrawPage(); });
      return;
    }
    const action = e.target.closest('[data-a]')?.dataset.a;
    if (action === 'restore-sounds') {
      if (!S.hiddenSounds.length) { toast('All built-in tracks are already here.'); return; }
      S.hiddenSounds = [];
      saveSettings();
      redrawPage();
      toast('Built-in tracks restored');
      return;
    }
    if (action === 'backup') exportBackup().catch(error => toast(error.message || 'The backup could not be saved.', 7000));
    if (action === 'app-update') {
      const button = e.target.closest('[data-a="app-update"]');
      button.disabled = true;
      toast('Checking for an update…', 16000);
      refreshInstalledApp(async () => {
        if (R) { pause({ animate: false }); await saveProgress(true); }
      }).catch(error => { button.disabled = false; toast(error.message || 'The update could not be checked.', 7000); });
    }
    if (action === 'reset') {
      confirmSheet('Reset settings?', 'Your books, progress, and stats will stay as they are.', 'Reset settings', () => {
        S = { ...DEFAULTS, settingsVersion: 2 };
        applySettings();
        saveSettings();
        toast('Settings reset');
      });
    }
    if (action === 'clear-stats') {
      confirmSheet('Clear reading stats?', 'This removes your reading history. Books and progress will stay.', 'Clear stats', async () => {
        await db.clear('sessions');
        toast('Stats cleared');
      });
    }
  });
}
async function storageInfo(el) {
  const small = $('small', el);
  try {
    const persisted = await navigator.storage?.persisted?.();
    const estimate = await navigator.storage?.estimate?.();
    const mb = estimate ? (estimate.usage / 1048576).toFixed(1) : '?';
    small.textContent = `${mb} MB used. ${persisted ? 'Protected from automatic deletion.' : 'Not yet protected from automatic deletion, so keep a backup.'}`;
  } catch { small.textContent = 'Storage details are not available.'; }
}

/* ---------- Backup ---------- */
async function exportBackup() {
  toast('Preparing your backup', 8000);
  const zip = new window.JSZip();
  const [books, contents, sessions] = await Promise.all([db.getAll('books'), db.getAll('contents'), db.getAll('sessions')]);
  const kept = S.backupTracks ? tracks : [];
  const narrations = S.backupNarration ? await db.getAll('narrations') : [];
  for (const record of narrations) {
    zip.file(`narrations/${record.id}.json`, JSON.stringify(record.manifest));
    for (const clip of record.manifest.clips) {
      const audio = await db.readNarrationAudio(record.id, clip.file);
      if (!audio) throw new Error('An audiobook clip is missing. Import it again before backing up.');
      zip.file(`narrations/${record.id}/${clip.file}`, audio);
    }
  }
  zip.file('stillpoint.json', JSON.stringify({ app: 'stillpoint', version: 1, createdAt: Date.now(), settings: S, books, sessions, tracks: kept, narrationIds: narrations.map(n => n.id) }));
  contents.forEach(c => zip.file(`books/${c.id}.json`, JSON.stringify(c)));
  for (const track of kept) {
    const record = await db.get('trackdata', track.id);
    // Audio is already compressed, so it is stored as it is.
    if (record) zip.file(`tracks/${track.id}.bin`, record.data, { compression: 'STORE' });
  }
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  const name = `stillpoint-backup-${new Date().toISOString().slice(0, 10)}.zip`;
  const file = new File([blob], name, { type: 'application/zip' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Stillpoint backup' });
      toast('Backup ready');
      return;
    } catch (error) {
      if (error.name === 'AbortError') { toast('Backup canceled'); return; }
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  toast('Backup saved');
}
async function importBackup(file) {
  if (R) pause({ animate: false });
  try {
    const zip = await window.JSZip.loadAsync(await file.arrayBuffer());
    const manifestFile = zip.file('stillpoint.json');
    if (!manifestFile) throw new Error('not a backup');
    const data = JSON.parse(await manifestFile.async('string'));
    if (data.app !== 'stillpoint') throw new Error('not a backup');
    let restored = 0;
    for (const book of data.books || []) {
      const contentFile = zip.file(`books/${book.id}.json`);
      if (!contentFile) continue;
      const content = JSON.parse(await contentFile.async('string'));
      if (!Array.isArray(content.blocks) || typeof book.id !== 'string') continue;
      await db.saveBook(book, content);
      restored++;
    }
    let skippedNarrations = 0;
    for (const id of data.narrationIds || []) {
      if (typeof id !== 'string' || !/^[\w-]+$/.test(id)) continue;
      try {
        const entry = zip.file(`narrations/${id}.json`);
        if (!entry) throw new Error('Missing audiobook');
        const book = await db.get('books', id), content = await db.get('contents', id);
        if (!book || !content) throw new Error('Missing book');
        const manifest = validateManifest(JSON.parse(await entry.async('string')), await createNarrationJob(book, content));
        const audio = [];
        for (const clip of manifest.clips) {
          const file = zip.file(`narrations/${id}/${clip.file}`);
          if (!file) throw new Error('Missing audio clip');
          audio.push({ file: clip.file, data: await file.async('blob') });
        }
        await db.saveNarration(id, manifest, audio);
      } catch (error) { console.error(error); skippedNarrations++; }
    }
    const existing = new Set((await db.getAll('sessions')).map(s => `${s.bookId}|${s.at}`));
    for (const session of data.sessions || []) {
      const { id, ...rest } = session;
      if (!existing.has(`${rest.bookId}|${rest.at}`)) await db.put('sessions', rest);
    }
    let restoredTracks = 0;
    for (const t of data.tracks || []) {
      if (typeof t?.id !== 'string' || !/^[\w-]+$/.test(t.id) || tracks.some(x => x.id === t.id)) continue;
      const audio = zip.file(`tracks/${t.id}.bin`);
      if (!audio) continue;
      const track = {
        id: t.id, name: String(t.name || 'Untitled track').slice(0, 60), size: Number(t.size) || 0, duration: Number(t.duration) || 0,
        norm: clamp(Number(t.norm) || 1, 0.1, 8), level: clamp(Number(t.level) || 1, 0.25, 2), addedAt: Number(t.addedAt) || Date.now(),
      };
      await db.saveTrack(track, await audio.async('arraybuffer'));
      tracks.push(track);
      restoredTracks++;
    }
    if (data.settings) {
      S = { ...DEFAULTS, ...data.settings };
      applySettings();
      saveSettings();
    }
    fixSound();
    closeSheet();
    toast(`Restored ${restored} ${restored === 1 ? 'book' : 'books'}${restoredTracks ? ` and ${restoredTracks} ${restoredTracks === 1 ? 'track' : 'tracks'}` : ''}${skippedNarrations ? `. ${skippedNarrations} audiobook(s) could not be restored` : ''}`);
    if (R) await openBook(R.book.id);
    else showLibrary();
  } catch (error) {
    console.error(error);
    toast('This file is not a Stillpoint backup.');
  }
}

/* ---------- Stats ---------- */
const dayKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function lastDays(n) {
  const out = [];
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - n + 1);
  for (let i = 0; i < n; i++) { out.push(dayKey(d)); d.setDate(d.getDate() + 1); }
  return out;
}
const shortDay = key => {
  const [, m, d] = key.split('-').map(Number);
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${d}`;
};
function niceMax(value) {
  if (value <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(value));
  const n = value / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}
function chartSVG(kind, days, values) {
  const W = 340; const H = 150; const left = 34; const bottom = 22; const top = 8;
  const max = niceMax(Math.max(...values.filter(v => v != null), 0));
  const x = i => left + (i + 0.5) * ((W - left) / days.length);
  const y = v => top + (H - top - bottom) * (1 - v / max);
  const label = v => (v >= 1000 ? `${+(v / 1000).toFixed(1)}k` : `${Math.round(v)}`);
  let marks = '';
  if (kind === 'bar') {
    const bw = Math.max(5, ((W - left) / days.length) - 2);
    values.forEach((v, i) => {
      if (!v) return;
      const yy = y(v);
      const h = H - bottom - yy;
      const r = Math.min(3, bw / 2, h);
      marks += `<path fill="var(--hi)" d="M${x(i) - bw / 2} ${H - bottom}V${yy + r}Q${x(i) - bw / 2} ${yy} ${x(i) - bw / 2 + r} ${yy}H${x(i) + bw / 2 - r}Q${x(i) + bw / 2} ${yy} ${x(i) + bw / 2} ${yy + r}V${H - bottom}Z"/>`;
    });
  } else {
    let path = '';
    values.forEach((v, i) => { if (v != null) path += `${path ? 'L' : 'M'}${x(i)} ${y(v)}`; });
    marks = `<path d="${path}" fill="none" stroke="var(--hi)" stroke-width="2" stroke-linejoin="round"/>`;
    values.forEach((v, i) => { if (v != null) marks += `<circle cx="${x(i)}" cy="${y(v)}" r="4" fill="var(--hi)" stroke="var(--bg)" stroke-width="2"/>`; });
  }
  const hit = days.map((d, i) => `<rect data-i="${i}" x="${x(i) - (W - left) / days.length / 2}" y="0" width="${(W - left) / days.length}" height="${H}" fill="transparent"/>`).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${kind === 'bar' ? 'Words read per day' : 'Average speed per day'}">
    <line x1="${left}" x2="${W}" y1="${y(max)}" y2="${y(max)}" stroke="var(--faint)"/>
    <line x1="${left}" x2="${W}" y1="${y(max / 2)}" y2="${y(max / 2)}" stroke="var(--faint)"/>
    <line x1="${left}" x2="${W}" y1="${H - bottom}" y2="${H - bottom}" stroke="var(--dim)"/>
    <text x="${left - 6}" y="${y(max) + 4}" text-anchor="end">${label(max)}</text>
    <text x="${left - 6}" y="${y(max / 2) + 4}" text-anchor="end">${label(max / 2)}</text>
    <text x="${left - 6}" y="${H - bottom + 4}" text-anchor="end">0</text>
    <text x="${left}" y="${H - 4}">${shortDay(days[0])}</text>
    <text x="${W}" y="${H - 4}" text-anchor="end">Today</text>
    ${marks}${hit}</svg>`;
}
const formatTime = ms => (ms < 60000 ? (ms ? 'under a minute' : 'no reading') : formatDuration(ms));
let calMonth = null;
let calSelected = null;

function statsNumbers(sessions) {
  const dayMs = new Map();
  const dayWords = new Map();
  sessions.forEach(s => {
    dayMs.set(s.day, (dayMs.get(s.day) || 0) + s.ms);
    dayWords.set(s.day, (dayWords.get(s.day) || 0) + s.words);
  });
  const today = dayKey(new Date());
  const streaks = computeStreaks({ dayMs, goalMs: S.dailyGoal * 60000, weekGoalDays: S.weekGoalDays, weekStart: S.weekStart, today });
  return { dayMs, dayWords, today, streaks };
}

function streakHTML(n) {
  const { streaks } = n;
  const goalMs = S.dailyGoal * 60000;
  const ratio = Math.min(1, streaks.todayMs / goalMs);
  const minutes = Math.floor(streaks.todayMs / 60000);
  const weekNeed = S.weekGoalDays === 1 ? 'Any goal day counts the week' : `${S.weekGoalDays} goal days count the week`;
  return `<div class="streak-pair">
      <div><div class="streak-num" id="streak-days">${streaks.days}</div><div class="streak-label">${streaks.days === 1 ? 'day' : 'days'} in a row</div><div class="streak-best">Best: ${streaks.bestDays}</div></div>
      <div><div class="streak-num" id="streak-weeks">${streaks.weeks}</div><div class="streak-label">${streaks.weeks === 1 ? 'week' : 'weeks'} in a row</div><div class="streak-best">Best: ${streaks.bestWeeks}</div></div>
    </div>
    <div class="goal-today">
      <div class="goal-line"><span id="goal-text">${streaks.todayHit ? `Goal met today: ${minutes} of ${S.dailyGoal} min` : `${minutes} of ${S.dailyGoal} min today`}</span><button class="goal-edit" id="goal-edit">Change goal</button></div>
      <div class="goal-bar"><i style="width:${ratio * 100}%"></i></div>
      <div class="streak-best" style="margin-top:7px">${weekNeed}. ${streaks.goalDaysThisWeek} so far this week.</div>
    </div>`;
}

function calendarHTML(n) {
  const [year, month] = calMonth;
  const cells = monthGrid(year, month, S.weekStart);
  const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const dow = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  const header = Array.from({ length: 7 }, (_, i) => `<div class="cal-dow" aria-hidden="true">${dow[(i + S.weekStart) % 7]}</div>`).join('');
  const goalMs = S.dailyGoal * 60000;
  const days = cells.map(key => {
    if (!key) return '<div></div>';
    const ms = n.dayMs.get(key) || 0;
    const future = key > n.today;
    const state = ms >= goalMs ? 'hit' : ms > 0 ? 'read' : '';
    const status = state === 'hit' ? 'goal met' : state === 'read' ? 'read' : 'no reading';
    return `<button class="cal-day ${state} ${key === n.today ? 'today' : ''}" data-day="${key}" ${future ? 'disabled' : ''} aria-pressed="${key === calSelected}" aria-label="${shortDay(key)}, ${status}">${Number(key.slice(8))}</button>`;
  }).join('');
  const now = new Date();
  const atCurrent = year === now.getFullYear() && month === now.getMonth();
  return `<div class="cal-head"><h3 id="cal-title">${names[month]} ${year}</h3>
      <div class="cal-nav"><button class="icon-btn" id="cal-prev" aria-label="Previous month">${icon('back')}</button>
      <button class="icon-btn cal-next" id="cal-next" aria-label="Next month" ${atCurrent ? 'disabled' : ''}>${icon('back')}</button></div></div>
    <div class="cal-grid fade-in">${header}${days}</div>
    <div class="cal-legend"><span><i class="fill"></i>Goal met</span><span><i></i>Read</span></div>
    <div class="cal-detail" id="cal-detail" role="status"></div>`;
}

function dayDetail(n, key) {
  const ms = n.dayMs.get(key) || 0;
  if (!ms) return `${shortDay(key)}: no reading.`;
  const met = ms >= S.dailyGoal * 60000 ? 'Goal met.' : `Under your ${S.dailyGoal} min goal.`;
  return `${shortDay(key)}: ${formatTime(ms)}, ${fmt(n.dayWords.get(key) || 0)} words. ${met}`;
}

function showGoalSheet(onChange) {
  const value = c => `${S[c.k]}${c.unit || ''}`;
  const sheet = openSheet('Reading goal', `<div class="sheet-body">
    ${GOAL_SETTINGS.filter(c => c.type === 'range').map(c => `<div class="set-row"><div class="set-line"><label for="g-${c.k}">${esc(c.label)}${c.help ? `<small class="set-help">${esc(c.help)}</small>` : ''}</label><span class="set-value" data-gv="${c.k}">${value(c)}</span></div>
      <input id="g-${c.k}" type="range" data-gk="${c.k}" min="${c.min}" max="${c.max}" step="${c.step}" value="${S[c.k]}"></div>`).join('')}
    <div class="set-row"><div class="set-line"><label for="g-weekStart">Weeks start on</label><select id="g-weekStart" data-gk="weekStart"><option value="0" ${S.weekStart === 0 ? 'selected' : ''}>Sunday</option><option value="1" ${S.weekStart === 1 ? 'selected' : ''}>Monday</option></select></div></div>
    <p class="muted">Changes apply to your past days too, so your streak may change.</p></div>`);
  sheet.addEventListener('input', e => {
    const k = e.target.dataset.gk;
    if (!k) return;
    S[k] = Number(e.target.value);
    const label = $(`[data-gv="${k}"]`, sheet);
    if (label) label.textContent = value(GOAL_SETTINGS.find(c => c.k === k));
    saveSettings();
    onChange();
  });
}

async function showStats() {
  const [sessions, books] = await Promise.all([db.getAll('sessions'), db.getAll('books')]);
  const words = sessions.reduce((a, s) => a + s.words, 0);
  const ms = sessions.reduce((a, s) => a + s.ms, 0);
  const avg = ms ? Math.round(words / (ms / 60000)) : 0;
  const byDay = new Map();
  sessions.forEach(s => {
    const e = byDay.get(s.day) || { words: 0, ms: 0 };
    e.words += s.words; e.ms += s.ms;
    byDay.set(s.day, e);
  });
  const days = lastDays(14);
  const dayWords = days.map(d => byDay.get(d)?.words || 0);
  const dayWpm = days.map(d => { const e = byDay.get(d); return e ? Math.round(e.words / (e.ms / 60000)) : null; });
  const byBook = new Map();
  sessions.forEach(s => {
    const e = byBook.get(s.bookId) || { title: s.title, words: 0, ms: 0 };
    e.words += s.words; e.ms += s.ms;
    byBook.set(s.bookId, e);
  });
  const finished = books.filter(b => b.finishedAt).length;
  const numbers = statsNumbers(sessions);
  const nowDate = new Date();
  calMonth = [nowDate.getFullYear(), nowDate.getMonth()];
  calSelected = null;
  navigate('forward', () => {
  $('#app').innerHTML = `<main class="screen">
    <header class="screen-head" style="padding-left:calc(var(--safe-l) + 8px)">
      <button class="icon-btn" id="stats-back" aria-label="Back to library">${icon('back')}</button>
      <h1 class="wordmark" style="font-size:26px">Reading stats</h1></header>
    <div class="screen-body">
      <div id="streak-box">${streakHTML(numbers)}</div>
      <div id="cal-box">${calendarHTML(numbers)}</div>
      ${sessions.length ? `<div class="chart-head"><h3>All time</h3></div><div class="tile-grid">
        <div class="tile"><b>${words >= 100000 ? `${+(words / 1000).toFixed(0)}k` : fmt(words)}</b><span>words read</span></div>
        <div class="tile"><b>${formatDuration(ms).replace('under a minute', '<1 min')}</b><span>reading time</span></div>
        <div class="tile"><b>${fmt(sessions.length)}</b><span>${sessions.length === 1 ? 'session' : 'sessions'}</span></div>
        <div class="tile"><b>${fmt(avg)}</b><span>average WPM, including pauses</span></div>
        <div class="tile"><b>${fmt(finished)}</b><span>${finished === 1 ? 'book' : 'books'} finished</span></div>
      </div>
      <div class="chart-head"><h3>Words per day</h3><span class="chart-read" id="read-a">Last 14 days</span></div>
      <div id="chart-a">${chartSVG('bar', days, dayWords)}</div>
      <div class="chart-head"><h3>Average WPM</h3><span class="chart-read" id="read-b">Last 14 days</span></div>
      <div id="chart-b">${dayWpm.some(v => v != null) ? chartSVG('line', days, dayWpm) : '<p class="muted">No reading in the last 14 days.</p>'}</div>
      <div class="chart-head"><h3>By book</h3></div>
      ${[...byBook.values()].sort((a, b) => b.words - a.words).map(b => `<div class="book-stat"><span>${esc(b.title)}</span><span>${fmt(b.words)} words</span></div>`).join('')}`
    : `<p class="muted">Open a book and press play to record your first session.</p>`}
    </div></main>`;
  $('#stats-back').onclick = () => showLibrary('back');
  const redrawStreaks = () => {
    const fresh = statsNumbers(sessions);
    $('#streak-box').innerHTML = streakHTML(fresh);
    $('#cal-box').innerHTML = calendarHTML(fresh);
    if (calSelected) $('#cal-detail').textContent = dayDetail(fresh, calSelected);
    return fresh;
  };
  const statsBody = $('.screen-body');
  statsBody.addEventListener('click', e => {
    const fresh = statsNumbers(sessions);
    if (e.target.closest('#goal-edit')) { showGoalSheet(redrawStreaks); return; }
    if (e.target.closest('#cal-prev') || e.target.closest('#cal-next')) {
      const delta = e.target.closest('#cal-prev') ? -1 : 1;
      const d = new Date(calMonth[0], calMonth[1] + delta, 1);
      calMonth = [d.getFullYear(), d.getMonth()];
      calSelected = null;
      redrawStreaks();
      return;
    }
    const day = e.target.closest('[data-day]');
    if (day) {
      calSelected = day.dataset.day;
      $$('[data-day]', statsBody).forEach(b => b.setAttribute('aria-pressed', b === day));
      $('#cal-detail').textContent = dayDetail(fresh, calSelected);
    }
  });
  const wire = (id, read, text) => {
    const box = $(id);
    if (!box) return;
    const handler = e => {
      const i = e.target.dataset?.i;
      if (i !== undefined) $(read).textContent = text(Number(i));
    };
    box.addEventListener('pointerover', handler);
    box.addEventListener('click', handler);
  };
  wire('#chart-a', '#read-a', i => `${shortDay(days[i])}: ${fmt(dayWords[i])} words`);
  wire('#chart-b', '#read-b', i => `${shortDay(days[i])}: ${dayWpm[i] == null ? 'no reading' : `${fmt(dayWpm[i])} WPM`}`);
  });
}

/* ---------- App lifecycle ---------- */
document.addEventListener('selectstart', event => {
  const target = event.target instanceof Element ? event.target : event.target?.parentElement;
  if (!target?.closest('input, textarea, [contenteditable="true"]')) event.preventDefault();
});
document.addEventListener('contextmenu', event => {
  const target = event.target instanceof Element ? event.target : event.target?.parentElement;
  if (!target?.closest('input, textarea, [contenteditable="true"]')) event.preventDefault();
});
document.addEventListener('keydown', e => {
  if (!R || activeScrim() || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
  if (bookMode() && R.bookView) {
    if (['ArrowLeft', 'PageUp', 'ArrowRight', 'PageDown'].includes(e.key)) {
      e.preventDefault(); R.bookView.turn(['ArrowLeft', 'PageUp'].includes(e.key) ? -1 : 1); return;
    }
    if (e.key === ' ' && !narrating()) { e.preventDefault(); R.bookView.turn(e.shiftKey ? -1 : 1); return; }
    if (['ArrowUp', 'ArrowDown'].includes(e.key)) return;
  }
  if (e.key === ' ') { e.preventDefault(); togglePlay(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); changeWpm(1); }
  if (e.key === 'ArrowDown') { e.preventDefault(); changeWpm(-1); }
  if (e.key === 'ArrowLeft') rewindBy(S.rewind);
  if (e.key === 'ArrowRight') seek(R.pos + S.rewind);
});
document.addEventListener('visibilitychange', () => {
  if (!R) return;
  if (document.hidden) {
    if (bookMode() && R.bookView && !narrating()) R.pos = R.bookView.firstVisible();
    if (narrating()) {
      R.narration.setBackground(true);
      R.narration.update(true);
      releaseWake();
      stopSound();
    } else if (R.state !== 'paused') pause({ animate: false });
  } else if (narrating()) {
    R.narration.setBackground(false);
    if (R.book.audioMode === 'page') showFlowAt(R.pos, true);
    else renderWord(R.words[R.pos]);
    updateMeta();
  }
  if (document.hidden || narrating()) saveProgress(true);
});
addEventListener('pagehide', () => { if (R) { commitSession(); saveProgress(true); } });
addEventListener('resize', () => { if (R) renderWord(R.lastText); });

async function boot() {
  try {
    await db.openDB();
  } catch (error) {
    $('#app').innerHTML = `<div class="screen"><div class="screen-body"><div class="empty"><h2>Storage is not available.</h2>
      <p>Stillpoint needs on-device storage to keep your books. Turn off private browsing and open the app again.</p></div></div></div>`;
    return;
  }
  const saved = await db.get('kv', 'settings').catch(() => null);
  if (saved) S = { ...DEFAULTS, ...saved };
  // Moves anyone still on the old off-center default to the new centered one.
  if (saved && !saved.settingsVersion && saved.pivotX === 40) S.pivotX = 50;
  S.settingsVersion = 2;
  tracks = (await db.getAll('tracks').catch(() => [])).sort((a, b) => a.addedAt - b.addedAt);
  setTrackSource(async id => {
    const [record, meta] = [await db.get('trackdata', id), tracks.find(t => t.id === id)];
    if (!record || !meta) throw new Error('missing track');
    return { data: record.data, norm: meta.norm, level: meta.level };
  }, () => toast('This track could not be played.'));
  fixSound();
  applySettings();
  navigator.storage?.persist?.().catch(() => {});
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
  }
  const last = await db.get('kv', 'lastBook').catch(() => null);
  const interrupted = await db.get('kv', 'pendingAudiobookImport').catch(() => null);
  if (!interrupted && S.openLast && last && await db.get('books', last)) await openBook(last);
  else await showLibrary();
  booted = true;
  if (interrupted) {
    await db.del('kv', 'pendingAudiobookImport').catch(() => {});
    const stored = interrupted.bookId && await db.get('books', interrupted.bookId);
    if (interrupted.bookId && !stored) await db.removeNarration(interrupted.bookId).catch(() => {});
    openSheet('Audiobook import interrupted', `<div class="sheet-body"><p>${esc(interrupted.name || 'The last audiobook')} was being imported when the app stopped.</p><p>${stored ? 'Its book was saved. Check the library before importing it again.' : 'The import did not finish. Check for an app update, keep Stillpoint open, then choose the original ZIP again.'}</p></div>`);
  }
}
// The edge strips sit above the reader, so a tap on them still pauses reading.
$$('.edge').forEach(el => el.addEventListener('click', () => { if (R && R.state !== 'paused') pause(); }));
// iOS only shows :active styles once a touch listener exists.
document.addEventListener('touchstart', () => {}, { passive: true });
boot();

// Lets the automated tests read state.
window.__stillpoint = { get R() { return R; }, get S() { return S; } };
