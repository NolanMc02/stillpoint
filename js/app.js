import * as db from './db.js';
import { fitAppViewport } from './viewport.js';
fitAppViewport();
import { createBackup, inspectBackup, restoreBackup } from './backups.js';
import { refreshInstalledApp } from './updates.js';
import { BookReader } from './book-reader.js';
import { MODE_LABELS, savedMode, selectMode, summarizeAudio } from './reading-state.js';
import { SleepTimer } from './sleep-timer.js';
import { buildStoryPrompt } from './story-context.js';
import { FollowScroll } from './follow-scroll.js';
import { makeCover, validCover } from './covers.js';
import { openAudiobookZip } from './audiobook-zip.js';
import { createNarrationJob, readNarrationPackage, validateManifest, NarrationPlayer } from './narration.js';
import {
  buildIndex, buildSegments, chunkAt, estimateMs, formatDuration, lowerBound, rampFactor, splitAtPivot, tokenize, wordDelay,
} from './engine.js';
import { ImportError, finishPdf, importFile, readEpubCover, textToBook } from './importers.js';
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
  expand: '<path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>', list: '<path d="M4 7h16M4 12h16M4 17h10"/>',
  mark: '<path d="M7 4h10v16l-5-4-5 4z"/>', sound: '<path d="M4 10v4h3l5 4V6L7 10zM16 9a4 4 0 010 6M18.5 6.5a8 8 0 010 11"/>',
  explain: '<path d="M5 4h14a2 2 0 012 2v10a2 2 0 01-2 2h-7l-5 3v-3H5a2 2 0 01-2-2V6a2 2 0 012-2z"/><path d="M9.5 8a2.5 2.5 0 015 0c0 2-2.5 2-2.5 4"/><path d="M12 15h.01"/>',
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
  contextWords: false, contextCount: 2,
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
    { k: 'contextWords', label: 'Surrounding words', help: 'Show faint previous and upcoming words beside the RSVP word.', type: 'toggle' },
    { k: 'contextCount', label: 'Words on each side', type: 'range', min: 1, max: 3, step: 1 },
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
    const owner = R, anchor = R.appearanceAnchor ?? (R.bookView.browsing ? R.bookView.pos : R.pos);
    clearTimeout(R.bookReflowTimer);
    R.bookReflowTimer = setTimeout(() => { if (R === owner) { if (R.appearanceAnchor !== undefined) R.bookView?.showWord(anchor, true); else R.bookView?.reflow(anchor); } }, 60);
  }
  for (const key of [S.wordFont, S.textFont]) {
    if (!DOWNLOADED_FONTS[key]) continue;
    document.fonts.load(`16px "${DOWNLOADED_FONTS[key]}"`).then(found => {
      if (!found.length) toast(`${DOWNLOADED_FONTS[key]} needs an internet connection the first time.`);
      else if (key === S.textFont && R?.bookView) {
        if (R.appearanceAnchor !== undefined) R.bookView.showWord(R.appearanceAnchor, true);
        else R.bookView.reflow(R.bookView.browsing ? R.bookView.pos : R.pos);
      }
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
  // Backfill lightweight metadata once for older imports, one manifest at a time.
  for (const book of books) if (book.audioReady === undefined) {
    const record = await db.get('narrations', book.id);
    try { if (record) summarizeAudio(book, record.manifest); else book.audioReady = false; }
    catch { book.audioReady = false; }
    await db.put('books', book);
  }
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
  const recent = books.filter(book => !book.finishedAt && book.pos < book.wordCount - 1)
    .sort((a, b) => (b.lastReadAt || b.addedAt) - (a.lastReadAt || a.addedAt))[0];
  const resumeLabel = book => savedMode(book) === 'listen' ? book.audioReady ? 'Continue listening' : 'Open book' : savedMode(book) === 'rsvp' ? 'Continue RSVP' : 'Continue reading';
  const remaining = (book, label = true) => {
    if (savedMode(book) === 'listen' && !book.audioReady) return 'Audio unavailable — open to recover';
    const audio = book.audioReady && (savedMode(book) === 'listen' || (savedMode(book) === 'rsvp' && (book.rsvpAudio || book.audioMode === 'rsvp')));
    const time = audio ? audioClock(book.audioRemainingMs / 1000 / (book.audioRate || 1)) : formatDuration(estimateMs(book.wordCount - book.pos, book.wpm || S.wpm, S.smartPacing));
    return `${label ? audio ? 'Audio · ' : 'Reading · ' : ''}${time} left`;
  };
  body.innerHTML = `${installNote}${recent ? `<button class="continue-card" data-open="${esc(recent.id)}"><span class="book-cover" aria-hidden="true">${validCover(recent.cover) ? `<img src="${recent.cover}" alt="">` : icon('book')}</span><span><small>${resumeLabel(recent)}</small><b>${esc(recent.title)}</b><span>${esc(recent.currentChapterTitle || recent.chapters?.[0]?.title || 'Your saved place')}</span><span>${esc(remaining(recent, false))}</span></span><span aria-hidden="true">→</span></button>` : ''}<div class="lib-tools">
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
      const left = done ? 'Finished' : remaining(b);
      return `<article class="book-row">
        <button class="book-open" data-open="${esc(b.id)}">
          <span class="book-cover" aria-hidden="true">${validCover(b.cover) ? `<img src="${b.cover}" alt="" loading="lazy">` : `<span>${esc(String(b.title || 'Untitled').slice(0, 1))}</span>`}</span><span class="book-details">
          <h2 class="book-title">${esc(b.title)}</h2>
          ${b.author ? `<div class="book-author">${esc(cleanAuthor(b.author))}</div>` : ''}
          <div class="book-badges"><span>${b.audioReady ? 'Audio available' : savedMode(b) === 'listen' ? 'Audio unavailable' : 'Text only'}</span><span>${MODE_LABELS[savedMode(b)]}</span></div>
          <div class="book-progress"><i style="width:${done ? 100 : p}%"></i></div>
          <div class="book-meta"><span>${done ? 100 : p}%</span><span>${left}</span></div>
          </span>
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
    <label class="menu-btn" for="cover-pick">${book.cover ? 'Change' : 'Add'} cover<small>Choose the original EPUB or a cover image</small></label>
    <input id="cover-pick" type="file" accept=".epub,image/jpeg,image/png,image/webp" hidden>
    ${book.hasCleanup ? '<button class="menu-btn" data-a="cleanup">Review reading text</button>' : ''}
    <button class="menu-btn" data-a="narration">Audiobook</button>
    <button class="menu-btn" data-a="restart">Read again from the start</button>
    <button class="menu-btn danger" data-a="delete">Delete book</button></div>`);
  $('#cover-pick', sheet).onchange = async event => {
    const file = event.target.files[0]; if (!file) return;
    try {
      const cover = /\.epub$/i.test(file.name) ? await readEpubCover(file) : await makeCover(file);
      if (!cover) throw new Error('No cover was found in that EPUB. Choose an image instead.');
      const saved = await db.get('books', book.id); saved.cover = cover; await db.put('books', saved);
      closeSheet(); await showLibrary(); toast('Cover updated');
    } catch (error) { toast(error.message, 6000); }
  };
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
    readerMode: 'read', readingView: 'book', audioMode: 'off', chapters: parsed.chapters || [], bookmarks: [], hasCleanup: !!parsed.cleanup, cover: validCover(parsed.cover),
  };
  await db.saveBook(book, { id, blocks, ...(parsed.cleanup ? { cleanup: parsed.cleanup } : {}) });
  return id;
}

async function importGeneratedPackage(file, onProgress = () => {}) {
  onProgress('Reading the ZIP directory…');
  const zip = await openAudiobookZip(file);
  if (!zip.has('reading-book.json')) {
    if (zip.has('audiobook.json')) throw new ImportError('This ZIP contains audio and timings, but no book text. Open the matching book → reading mode → Manage audiobook → Import audiobook, or download the combined book ZIP from Studio.');
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
    readerMode: 'listen', listenFollow: true, readingView: 'book', bookLayout: 'pages', audioMode: 'page', audioRate: 1, cover: validCover(payload.book?.cover) };
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
function readerMode() { return R ? savedMode(R.book) : 'read'; }
function bookMode() { return R?.book.readingView === 'book' && !(readerMode() === 'listen' && R.book.listenFollow === false); }
function listenOnly() { return readerMode() === 'listen' && R.book.listenFollow === false; }

async function setReaderMode(mode) {
  if (!R || (mode === 'listen' && !R.narration)) return;
  pause({ animate: false });
  R.book.rsvpAudio ??= R.book.audioMode === 'rsvp';
  selectMode(R.book, mode);
  if (!narrating()) { R.sleepTimer?.clear(); R.narration?.releaseMediaSession(); }
  await saveProgress(true);
  renderReader();
}

function showReaderModes() {
  const sheet = openSheet('Reading mode', '<div class="sheet-body" id="mode-body"></div>');
  const draw = () => {
    const mode = readerMode(), audio = !!R.narration;
    $('#mode-body', sheet).innerHTML = `<div class="mode-choices" role="group" aria-label="Reading mode">${Object.entries(MODE_LABELS).map(([key, name]) => `<button data-mode="${key}" aria-pressed="${mode === key}" ${key === 'listen' && !audio ? 'disabled' : ''}>${name}</button>`).join('')}</div>
      <p class="settings-intro">${mode === 'read' ? 'Read at your own pace with pages or scrolling.' : mode === 'listen' ? 'Listen to your audiobook, with or without text following.' : 'Press Play to start words arriving at your focus point.'} Switching modes keeps your place and pauses playback.</p>
      ${mode === 'read' ? `<div class="book-layout-choices"><button data-mode-layout="pages" aria-pressed="${(R.book.bookLayout || 'pages') === 'pages'}">Pages</button><button data-mode-layout="scroll" aria-pressed="${R.book.bookLayout === 'scroll'}">Continuous scroll</button></div>` : ''}
      ${mode === 'listen' ? `<label class="book-check"><input id="listen-follow" type="checkbox" ${R.book.listenFollow !== false ? 'checked' : ''}>Follow along with text</label>` : ''}
      ${mode === 'rsvp' ? `<label class="book-check"><input id="rsvp-audio" type="checkbox" ${R.book.rsvpAudio ? 'checked' : ''} ${audio ? '' : 'disabled'}>Use audiobook voice and timing</label><button class="menu-btn" id="rsvp-options">RSVP appearance and surrounding words</button>` : ''}
      ${!audio ? '<p class="muted">Add an audiobook to enable Listen and narrated RSVP.</p>' : ''}
      <button class="menu-btn" id="mode-audiobook">${audio ? 'Manage audiobook' : 'Add audiobook'}<small>Import narration or check saved audio</small></button>`;
    $('#mode-audiobook', sheet).onclick = () => showNarration(R.book).catch(error => toast(error.message));
    $('#rsvp-options', sheet)?.addEventListener('click', () => showSettings('RSVP'));
    for (const id of ['listen-follow', 'rsvp-audio']) $(`#${id}`, sheet)?.addEventListener('change', async event => {
      if (id === 'listen-follow') R.book.listenFollow = event.target.checked;
      else R.book.rsvpAudio = event.target.checked;
      await setReaderMode(mode); draw();
    });
  };
  sheet.addEventListener('click', async event => {
    const mode = event.target.closest('[data-mode]');
    if (mode) { await setReaderMode(mode.dataset.mode); draw(); }
    const layout = event.target.closest('[data-mode-layout]');
    if (layout) { R.book.bookLayout = layout.dataset.modeLayout; await setReaderMode('read'); draw(); }
  });
  draw();
}

function audioClock(seconds) {
  seconds = Math.max(0, Math.ceil(seconds || 0));
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}` : `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}
function chapterEndSeconds() {
  const next = R.chapterStarts.find(pos => pos > R.pos);
  return next === undefined ? R.narration.durationSeconds() : R.narration.timeAtWord(next);
}
function updateListeningControls() {
  if (!R?.narration) return;
  const timer = R.sleepTimer?.state();
  if ($('#audio-options')) {
    const sleep = timer?.kind === 'duration' ? ` · ◷ ${audioClock(timer.remainingMs / 1000)}` : timer?.kind === 'chapter' ? ' · ◷ Ch' : '';
    $('#audio-options').textContent = `${R.book.audioRate || 1}×${sleep} ▾`;
    $('#audio-options').setAttribute('aria-label', `Listening options, speed ${R.book.audioRate || 1} times${sleep ? ', sleep timer active' : ''}`);
  }
  if ($('#audio-times')) {
    const position = R.narration.positionSeconds(), rate = R.book.audioRate || 1;
    const chapter = audioClock(Math.max(0, chapterEndSeconds() - position) / rate), book = audioClock(Math.max(0, R.narration.durationSeconds() - position) / rate);
    $('#audio-times').textContent = `Ch ${chapter} · Book ${book}`;
    $('#audio-times').setAttribute('aria-label', `${chapter} remaining in chapter; ${book} remaining in book`);
  }
}
function showListeningOptions() {
  if (!R?.narration) return;
  const sheet = openSheet('Listening controls', `<div class="sheet-body stack">
    <label for="audio-rate">Playback speed</label><select class="field-text" id="audio-rate">${[.5,.75,1,1.25,1.5,1.75,2].map(rate => `<option value="${rate}">${rate}×</option>`).join('')}</select>
    <label for="sleep-choice">Sleep timer</label><select class="field-text" id="sleep-choice"><option value="off">Off</option>${[5,10,15,30,45,60].map(minutes => `<option value="${minutes}">${minutes} minutes from now</option>`).join('')}<option value="chapter">End of this chapter</option></select>
    <p class="muted" id="sleep-status"></p><button class="menu-btn" id="audio-background">Background sound</button></div>`);
  const rate = $('#audio-rate', sheet), timer = R.sleepTimer.state();
  if (![...rate.options].some(option => Number(option.value) === (R.book.audioRate || 1))) rate.add(new Option(`${R.book.audioRate}×`, R.book.audioRate));
  rate.value = R.book.audioRate || 1;
  $('#sleep-choice', sheet).value = timer.kind === 'chapter' ? 'chapter' : timer.kind === 'duration' ? String(timer.minutes) : 'off';
  $('#sleep-status', sheet).textContent = timer.kind === 'duration' ? `Stops in ${audioClock(timer.remainingMs / 1000)}. Choose Off to cancel.` : timer.kind === 'chapter' ? 'Stops at the end of the current chapter.' : 'Stops narration and background sound when the timer finishes.';
  rate.onchange = () => { R.book.audioRate = Number(rate.value); R.narration.setRate(R.book.audioRate); saveProgress(true); updateListeningControls(); updateMeta(); };
  $('#sleep-choice', sheet).onchange = event => {
    const value = event.target.value;
    if (value === 'off') R.sleepTimer.clear();
    else if (value === 'chapter') R.sleepTimer.chapter(chapterEndSeconds());
    else R.sleepTimer.duration(Number(value));
    $('#sleep-status', sheet).textContent = value === 'off' ? 'Sleep timer is off.' : value === 'chapter' ? 'Stops at the end of this chapter.' : `Stops in ${value} minutes, including time spent paused.`;
    updateListeningControls();
  };
  $('#audio-background', sheet).onclick = showSoundSheet;
}
async function skipAudio(seconds) {
  if (!R?.narration || !narrating()) return;
  const owner = R, paused = owner.state === 'paused';
  try {
    await owner.narration.seekSeconds(owner.narration.positionSeconds() + seconds, { paused });
    if (R !== owner) return;
    if (paused) showFlowAt(owner.pos, true);
    updateMeta(); await saveProgress(true);
  } catch (error) { if (R === owner) reportPlaybackError(error); }
}
function reportPlaybackError(error) {
  if (!R) return;
  pause({ animate: false });
  R.playbackError = error.name === 'NotAllowedError' ? 'Audio needs a tap to start. Press Play again; your place is saved.'
    : error.name === 'NotSupportedError' ? 'The saved audio could not be opened. Reload it, or import the original Studio ZIP again.'
    : error.message || 'Audio could not start. Your place is saved.';
  const banner = $('#playback-error');
  if (banner) { banner.hidden = false; $('#playback-error-message').textContent = R.playbackError; }
}

function setReaderFullscreen(hidden) {
  if (!R || !bookMode()) return;
  R.fullscreen = hidden;
  $('#reader').classList.toggle('book-chrome-hidden', hidden);
  $('#r-fullscreen')?.setAttribute('aria-pressed', String(hidden));
}

function showBookAppearance() {
  if (!R?.bookView) return;
  pause({ animate: false });
  const owner = R;
  let previewResize;
  owner.appearanceAnchor = owner.bookView.browsing ? owner.bookView.pos : owner.pos;
  const sheet = openSheet('Reading appearance', `<div class="tabs book-appearance-tabs" role="tablist">
    <button role="tab" data-appearance="font">Font</button><button role="tab" data-appearance="layout">Layout</button><button role="tab" data-appearance="themes">Themes</button></div>
    <div class="sheet-body" id="book-appearance-body"></div>`, { onClose: () => {
      previewResize?.disconnect();
      const anchor = owner.appearanceAnchor;
      delete owner.appearanceAnchor;
      if (R === owner && $('#reader')) {
        $('#reader').classList.remove('appearance-open');
        $('#reader').style.removeProperty('--appearance-height');
        owner.bookView?.showWord(anchor ?? owner.pos, true);
      }
    } });
  sheet.parentElement.classList.add('appearance-scrim');
  sheet.setAttribute('aria-modal', 'false');
  const previewPage = () => {
    if (R !== owner || !sheet.isConnected) return;
    const reader = $('#reader');
    reader.classList.add('appearance-open');
    reader.style.setProperty('--appearance-height', `${Math.ceil(sheet.getBoundingClientRect().height)}px`);
    owner.bookView?.showWord(owner.appearanceAnchor, true);
  };
  previewResize = new ResizeObserver(previewPage); previewResize.observe(sheet);
  previewPage();
  const body = $('#book-appearance-body', sheet);
  const field = (label, html) => `<label class="book-setting">${label}${html}</label>`;
  const select = (key, values) => `<select class="field-text" data-book-setting="${key}">${values.map(([value, label]) => `<option value="${value}" ${String(S[key]) === String(value) ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
  const draw = tab => {
    $$('[data-appearance]', sheet).forEach(button => button.setAttribute('aria-selected', button.dataset.appearance === tab));
    if (tab === 'font') body.innerHTML = `${field('Font', select('textFont', fontOptions))}
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
    owner.bookView.suppressUntil = performance.now() + 300;
    S[key] = event.target.type === 'checkbox' ? event.target.checked
      : ['textFont', 'textAlign', 'bookProgress'].includes(key) ? event.target.value : Number(event.target.value);
    R.animate = S.bookAnimation;
    applySettings(); saveSettings(); R.bookView?.folio();
  });
  sheet.addEventListener('click', event => {
    const tab = event.target.closest('[data-appearance]');
    if (tab) { draw(tab.dataset.appearance); return; }
    const layout = event.target.closest('[data-book-layout]');
    if (layout) { R.book.bookLayout = layout.dataset.bookLayout; saveProgress(true); renderReader(); previewPage(); draw('layout'); return; }
    const theme = event.target.closest('[data-book-theme]');
    if (theme) { S.theme = theme.dataset.bookTheme; applySettings(); saveSettings(); draw('themes'); }
  });
  draw('font');
}

async function attachNarration() {
  const owner = R;
  const record = await db.get('narrations', owner.book.id);
  if (!record || R !== owner) {
    if (!record) { owner.book.audioReady = false; owner.book.rsvpAudio = false; if (savedMode(owner.book) === 'listen') owner.narrationError = 'The saved audiobook is missing. Import its original ZIP, or choose Read instead.'; }
    return;
  }
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
            if (owner.book.audioMode === 'page') showFlowAt(pos, true, owner.state === 'playing');
            else renderWord(owner.words[pos]);
            if (!owner.scrubbing && !owner.jump) updateMeta();
          }
          saveProgress();
        },
        onEnd: () => {
          if (R !== owner) return;
          if (owner.sleepTimer?.state().kind !== 'off') stopSound();
          owner.sleepTimer?.clear(); finishBook();
        },
        onPause: () => { if (R === owner) pause({ animate: false }); },
        onResume: () => {
          if (R === owner && narrating() && owner.state === 'paused') {
            owner.sessionStart ||= performance.now(); setMode('playing');
          }
        },
        onError: error => { if (R === owner) reportPlaybackError(error); },
      });
    owner.narration.setRate(owner.book.audioRate || 1);
    // Fetch the local Blob before the tap so play() stays inside the user's gesture.
    await owner.narration.prepare(owner.pos);
    summarizeAudio(owner.book, record.manifest);
    owner.book.rsvpAudio ??= owner.book.audioMode === 'rsvp';
    owner.sleepTimer = new SleepTimer(owner.narration.audio, () => owner.narration.positionSeconds(), expired => {
      if (R !== owner) return;
      pause({ animate: false }); stopSound();
      if (expired.kind === 'chapter') owner.narration.seekSeconds(expired.endSeconds, { paused: true }).then(() => { if (R === owner) saveProgress(true); }).catch(error => { if (R === owner) reportPlaybackError(error); });
      toast('Sleep timer finished. Your place is saved.');
    }, () => { if (R === owner && !document.hidden) updateListeningControls(); });
  } catch (error) { owner.narration?.dispose(); owner.narration = null; owner.narrationError = error.message; owner.book.audioReady = false; owner.book.rsvpAudio = false; }
}

function applyNarrationMode() {
  if (!R || !$('#reader')) return;
  const active = narrating();
  $('#reader').classList.toggle('book-reading', bookMode());
  $('#reader').classList.toggle('listen-only', listenOnly());
  $('#reader').classList.toggle('has-audio', active);
  $('#reader').classList.toggle('read-mode', readerMode() === 'read');
  $('#r-mode').textContent = `${MODE_LABELS[readerMode()]} ▾`;
  $('#reader').classList.toggle('audio-page', active && R.book.audioMode === 'page');
  $('#audio-toolbar').hidden = !active;
  if (active) {
    $('#wpm-v').textContent = `${(R.book.audioRate || 1).toFixed(1)}×`;
    $('#wpm-box small').textContent = 'Audio';
    $('#wpm-box').setAttribute('aria-label', 'Audiobook playback settings');
  } else {
    R.narration?.releaseMediaSession();
    $('#wpm-box small').textContent = 'WPM';
    $('#wpm-box').setAttribute('aria-label', 'Choose reading speed');
  }
  $('#play').setAttribute('aria-label', readerMode() === 'read' ? 'Start RSVP' : R.state === 'paused' ? 'Play' : 'Pause');
  $('#play').disabled = readerMode() === 'listen' && !R.narration;
  if (readerMode() === 'read') $('#play').textContent = 'Start RSVP';
  $('#r-rew').hidden = !active;
  $('#audio-forward').hidden = !active;
  updateListeningControls();
}

async function playNarration({ resume = true } = {}) {
  unlockAudio();
  if (S.sound !== 'off') playSound(S.sound, S.volume);
  const owner = R;
  owner.playbackError = null; if ($('#playback-error')) $('#playback-error').hidden = true;
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
    seekSeconds: seconds => { if (R === owner && narrating()) skipAudio(seconds - owner.narration.positionSeconds()); },
  });
  try {
    if (!await owner.narration.playAt(owner.pos, { resume }) || R !== owner || run !== owner.run) return;
    owner.sessionStart ||= performance.now();
    setMode('playing');
  } catch (error) {
    if (R === owner && run === owner.run) reportPlaybackError(error);
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
    <button class="menu-btn" id="manage-reading-mode">Reading mode<small>Choose Read, Listen, or RSVP</small></button>
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
      book.audioRate ||= 1; summarizeAudio(book, manifest); selectMode(book, 'listen');
      await db.put('books', book);
      closeSheet();
      if (R?.book.id === book.id) await openBook(book.id);
      else await showLibrary();
      toast('Audiobook ready. Press play to listen.');
    } catch (error) { $('#narration-status', sheet).textContent = error.name === 'QuotaExceededError' ? 'There is not enough storage for this audiobook.' : error.message; }
  };
  $('#manage-reading-mode', sheet).onclick = async () => { if (R?.book.id !== book.id) await openBook(book.id); showReaderModes(); };
  if (record) $('#narration-remove', sheet).onclick = async () => {
    try {
      await db.removeNarration(book.id);
      if (R?.book.id === book.id) {
        R.narration?.dispose(); R.narration = null; R.sleepTimer?.dispose(); R.sleepTimer = null;
        Object.assign(R.book, { audioReady: false, rsvpAudio: false, audioDurationMs: 0, audioRemainingMs: 0 });
        selectMode(R.book, 'read'); await saveProgress(true); renderReader();
      }
      closeSheet(); toast('Audiobook removed');
      if (!R) await showLibrary();
    } catch (error) { toast(error.message); }
  };
}

/* ---------- Reader ---------- */
let R = null;
let wakeLock = null;
const SEG_WINDOW = 7;

async function openBook(id) {
  if (R) { pause({ animate: false }); if (R.book.id !== id) await saveProgress(true); }
  R?.sleepTimer?.dispose();
  R?.chromeResize?.disconnect();
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
  book.currentChapterTitle = currentChapter(R.pos)?.title || '';
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
  R.chromeResize?.disconnect();
  R.bookView?.destroy(); R.bookView = null;
  R.loaded = [0, -1]; R.animate = S.bookAnimation;
  R.jump = null;
  $('#app').innerHTML = `<div id="reader">
    <div id="flow" tabindex="-1"><div id="flow-inner"></div></div>
    <div id="book-view" hidden></div><div id="book-dimmer" aria-hidden="true"></div>
    <section id="listen-view" aria-label="Listening" hidden><div class="listen-cover">${validCover(R.book.cover) ? `<img src="${R.book.cover}" alt="">` : icon('book')}</div><h1>${esc(R.book.title)}</h1><p>${esc(R.book.author || '')}</p><p id="listen-chapter"></p></section>
    <section id="playback-error" role="alert" hidden><p id="playback-error-message"></p><button id="audio-retry">Reload audio</button><button id="audio-recover">Audiobook options</button><button id="audio-read-instead">Read instead</button></section>
    <div id="stage" aria-live="off">
      <div id="rail">
        <div id="chapter-call"></div>
        <div class="tick" id="tick-a"></div><div class="tick" id="tick-b"></div>
        <div id="word"><span id="w-left"></span><span id="w-pivot"></span><span id="w-right"></span></div>
        <span id="context-before" class="rsvp-context" aria-hidden="true"></span><span id="context-after" class="rsvp-context" aria-hidden="true"></span>
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
      <button id="r-mode" aria-label="Choose reading mode" aria-haspopup="dialog">${MODE_LABELS[readerMode()]} ▾</button>
      <button class="icon-btn" id="r-mark" aria-label="Add a bookmark">${icon('mark')}</button>
      <button class="icon-btn" id="r-settings" aria-label="Settings">${icon('gear')}</button>
    </header>
    <footer class="bar" id="bottom-bar">
      <div id="book-navigation" hidden><button id="book-prev" aria-label="Previous page">‹</button><span id="book-page-info"></span><button id="book-next" aria-label="Next page">›</button></div>
      <div id="scrub-wrap"><div id="scrub-track"><div id="scrub-fill"></div></div>
        <input id="scrub" type="range" min="0" max="${Math.max(0, R.words.length - 1)}" step="1" value="${R.pos}" aria-label="Position in book"></div>
      <div id="read-meta"><span id="m-pct"></span><span id="m-left"></span></div>
      <div id="audio-toolbar" hidden><span id="audio-progress"></span><span id="audio-times"></span><button id="audio-options" aria-label="Listening options" aria-haspopup="dialog">1× ▾</button></div>
      <div id="controls">
        <div class="side">
          <button class="icon-btn" id="r-toc" aria-label="Chapters, bookmarks, and search">${icon('list')}</button>
          <button class="icon-btn" id="r-context" aria-label="What’s happening here?" title="What’s happening here?">${icon('explain')}</button>
          <button class="audio-skip" id="r-rew" aria-label="Back 15 seconds">${icon('back10')}<small>15s</small></button>
        </div>
        <button id="play" aria-label="Play">${icon('play')}</button>
        <div class="side right">
          <button class="audio-skip" id="audio-forward" aria-label="Forward 15 seconds" hidden>${icon('back10')}<small>15s</small></button>
          <button class="icon-btn" id="w-down" aria-label="Slower">${icon('minus')}</button>
          <button id="wpm-box" aria-label="Choose reading speed" aria-expanded="false" aria-controls="wpm-pop"><b id="wpm-v"></b><small>WPM</small></button>
          <button class="icon-btn" id="w-up" aria-label="Faster">${icon('plus')}</button>
          <button class="icon-btn" id="r-fullscreen" aria-label="Fullscreen reading" aria-pressed="false" hidden>${icon('expand')}</button>
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
  $('#listen-view').hidden = !listenOnly();
  if ((readerMode() === 'listen' || (readerMode() === 'rsvp' && R.book.rsvpAudio)) && (R.playbackError || R.narrationError)) { $('#playback-error').hidden = false; $('#playback-error-message').textContent = R.playbackError || R.narrationError; }
  if (bookMode()) {
    $('#book-view').hidden = false; $('#book-navigation').hidden = (R.book.bookLayout || 'pages') !== 'pages';
    $('#r-settings').textContent = 'Aa'; $('#r-settings').setAttribute('aria-label', 'Reading appearance');
    R.bookView = new BookReader($('#book-view'), R, {
      onPosition: pos => {
        if (!R) return;
        if (R.appearanceAnchor !== undefined) R.appearanceAnchor = pos;
        if (readerMode() === 'listen') return;
        else { R.pos = pos; updateMeta(); saveProgress(true); }
      },
      isListening: () => readerMode() === 'listen',
      onBrowse: away => { if ($('#back-place')) $('#back-place').hidden = !away; },
      onWordMenu: pos => { pause({ animate: false }); showWordMenu(pos); },
      onToggleChrome: () => { if (R.appearanceAnchor === undefined) setReaderFullscreen(!R.fullscreen); },
      onPage: info => {
        $('#book-navigation').hidden = info.layout !== 'pages';
        const el = $('#book-page-info'); if (el) el.textContent = info.label;
        const folio = $('#book-view .book-page-count');
        if (folio) {
          folio.hidden = S.bookProgress === 'none';
          folio.textContent = S.bookProgress === 'percent' ? `${Math.round(R.pos / Math.max(1, R.words.length - 1) * 100)}%`
            : S.bookProgress === 'time' ? `${formatDuration(narrating() ? R.narration.remainingMs(R.pos) : estimateMs(R.words.length - R.pos, R.wpm, S.smartPacing))} left` : info.label;
        }
      },
    });
    R.bookView.setCurrent(R.pos, narrating());
    $('#r-fullscreen').hidden = false;
    setReaderFullscreen(!!R.fullscreen);
  }
  const owner = R, root = $('#reader'), footer = $('#bottom-bar');
  const header = $('#top-bar');
  const fitControls = () => { if (R === owner && root.isConnected) { root.style.setProperty('--reader-footer', `${Math.ceil(footer.getBoundingClientRect().height)}px`); root.style.setProperty('--reader-header', `${Math.ceil(header.getBoundingClientRect().height)}px`); } };
  fitControls(); R.chromeResize = new ResizeObserver(fitControls); R.chromeResize.observe(footer); R.chromeResize.observe(header);
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
const flowFollower = new FollowScroll();
function showFlowAt(pos, center, following = false) {
  if (bookMode() && R.bookView) {
    if (following) R.bookView.followWord(pos);
    else if (!R.bookView.browsing) R.bookView.showWord(pos, center && !R.bookView.manualPosition);
    R.bookView.setCurrent(pos, narrating()); return;
  }
  const flow = $('#flow');
  const seg = segOf(pos);
  if (seg < R.loaded[0] || seg > R.loaded[1]) loadWindow(seg);
  setCurrentClass();
  if (center) {
    const el = wordEl(pos);
    if (el) {
      const fr = flow.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      if (following) flowFollower.follow(flow, el);
      else { flowFollower.cancel(); flow.scrollTop += er.top - fr.top - fr.height * 0.38; }
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
  const before = $('#context-before'), after = $('#context-after');
  if (!before || !after) return;
  before.hidden = after.hidden = !S.contextWords;
  if (S.contextWords) {
    const end = R.pos + (narrating() ? 1 : chunkAt(R.pos, R.words, R.wordBlock, S.wordsPerFlash, R.glue).count);
    const count = clamp(S.contextCount || 2, 1, 3);
    before.textContent = R.words.slice(Math.max(0, R.pos - count), R.pos).join(' ');
    after.textContent = R.words.slice(end, end + count).join(' ');
    const frame = $('#word').getBoundingClientRect(), first = left.getBoundingClientRect(), last = right.getBoundingClientRect();
    before.style.width = `${Math.max(0, first.left - frame.left - 26)}px`;
    after.style.left = `${last.right - frame.left + 16}px`;
  }
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
    if ($('#audio-progress')) $('#audio-progress').textContent = pctEl.textContent;
    scrub?.setAttribute('aria-valuetext', `${Math.round(ratio * 100)}% through the book`);
    $('#m-left').textContent = `${left} left`;
  }
  const lp = $('#live-progress');
  if (lp) lp.style.width = `${ratio * 100}%`;
  const lt = $('#live-text');
  if (lt) lt.textContent = `${left} left`;
  updateListeningControls();
  const ch = currentChapter(pos);
  if ($('#listen-chapter')) $('#listen-chapter').textContent = ch?.title || '';
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
  if (narrating()) { if (open) showListeningOptions(); return; }
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
  if ((readerMode() === 'listen' || (readerMode() === 'rsvp' && R.book.rsvpAudio)) && !R.narration) { reportPlaybackError(new Error('Add or reload the audiobook before playing, or choose Read instead.')); return; }
  if (readerMode() === 'read') { selectMode(R.book, 'rsvp'); renderReader(); saveProgress(true); }
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
  flowFollower.cancel(); R.bookView?.follower.cancel();
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
  R.book.currentChapterTitle = currentChapter(R.pos)?.title || '';
  if (R.narration) { R.book.audioReady = true; R.book.audioRemainingMs = R.narration.remainingMs(R.pos) * (R.book.audioRate || 1); }
  R.book.lastReadAt = Date.now();
  return db.put('books', R.book).catch(() => {});
}
function seek(pos, { undo = false } = {}) {
  const from = R.pos;
  if (R.jump) clearJump();
  hideJumpBar();
  R.pos = clamp(pos, 0, R.words.length - 1);
  if (R.bookView?.browsing) R.bookView.returnTo(R.pos);
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
  flow.addEventListener('pointerdown', () => flowFollower.cancel(), { passive: true });
  $('#r-back').onclick = async () => { pause({ animate: false }); await saveProgress(true); stopSound(); R.sleepTimer?.dispose(); R.chromeResize?.disconnect(); R.narration?.dispose(); R.bookView?.destroy(); R = null; await showLibrary(); };
  $('#chapter-btn').onclick = () => showToc('chapters');
  $('#r-toc').onclick = () => showToc('chapters');
  $('#r-context').onclick = () => showStoryContext();
  $('#r-mark').onclick = addBookmark;
  $('#r-mode').onclick = showReaderModes;
  $('#r-settings').onclick = () => bookMode() ? showBookAppearance() : showSettings();
  $('#audio-options').onclick = showListeningOptions;
  $('#r-fullscreen').onclick = () => { setReaderFullscreen(true); toast('Tap the center of the page to show controls.'); };
  $('#audio-forward').onclick = () => skipAudio(15);
  $('#audio-recover').onclick = () => showNarration(R.book).catch(error => toast(error.message));
  $('#audio-read-instead').onclick = () => setReaderMode('read');
  $('#audio-retry').onclick = async () => {
    const owner = R;
    try {
      pause({ animate: false });
      if (!owner.narration) { owner.sleepTimer?.dispose(); await attachNarration(); }
      else { owner.narration.clipIndex = -1; await owner.narration.prepare(owner.pos); }
      if (R !== owner) return;
      if (!owner.narration) throw new Error(owner.narrationError || 'Import the original audiobook ZIP again.');
      owner.playbackError = null; owner.narrationError = null;
      $('#playback-error').hidden = true; toast('Audio reloaded. Press Play to listen.'); applyNarrationMode();
    } catch (error) { if (R === owner) reportPlaybackError(error); }
  };
  $('#book-prev').onclick = () => R.bookView?.turn(-1);
  $('#book-next').onclick = () => R.bookView?.turn(1);
  $('#r-rew').onclick = () => skipAudio(-15);
  $('#w-up').onclick = () => changeWpm(1);
  $('#w-down').onclick = () => changeWpm(-1);
  $('#r-sound').onclick = showSoundSheet;
  $('#play').onclick = () => togglePlay();
  $('#wpm-box').onclick = () => toggleWpmPop(!wpmPopOpen());
  $('#wpm-slider').oninput = e => setWpm(Number(e.target.value));
  $('#wpm-slider').onchange = () => saveProgress(true);
  $('#back-place').onclick = () => { if (R.bookView) R.bookView.returnTo(R.pos); else showFlowAt(R.pos, true); };
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

function showStoryContext(position = null) {
  if (!R) return;
  pause({ animate: false });
  if (position === null && readerMode() === 'read' && R.bookView?.layout === 'scroll') {
    clearTimeout(R.bookView.scrollTimer); R.pos = R.bookView.firstVisible(); updateMeta(); saveProgress(true);
  }
  const cutoff = position === null ? R.pos : clamp(position, 0, R.words.length - 1);
  const snapshot = { book: { title: R.book.title, author: R.book.author, chapters: R.book.chapters.map(chapter => ({ ...chapter })) }, words: R.words, glue: R.glue, chapterStarts: [...R.chapterStarts], position: cutoff };
  const sheet = openSheet('Story help', `<div class="sheet-body stack">
    <label for="story-kind">What would you like?</label><select class="field-text" id="story-kind"><option value="scene">Explain this scene</option><option value="summary">Summarize the book so far</option></select>
    <p class="muted">Copy a prompt into your AI chat for a short scene explanation or a recap from the beginning to your cutoff. It includes your book, chapter, and a short passage marking your place. Nothing is sent automatically.</p>
    <button class="primary" id="story-copy">Copy prompt</button><p id="story-copy-status" class="muted" role="status">Only text up to the selected word is included. AI can still make mistakes or include spoilers despite these instructions.</p>
    <label for="story-prompt">Prompt to copy</label><textarea id="story-prompt" readonly spellcheck="false" aria-label="Story help prompt"></textarea>
    <p class="muted">For a more precise cutoff while reading, hold a word and choose “Explain up to this word.” Closing this panel keeps playback paused.</p></div>`, { tall: true });
  const field = $('#story-prompt', sheet);
  const refresh = () => {
    field.value = buildStoryPrompt({ ...snapshot, kind: $('#story-kind', sheet).value });
    $('#story-copy-status', sheet).textContent = 'Only text up to the selected word is included. AI can still make mistakes or include spoilers despite these instructions.';
  };
  $('#story-kind', sheet).onchange = refresh; refresh();
  $('#story-copy', sheet).onclick = async () => {
    const prompt = field.value;
    let copied = false;
    try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(prompt); copied = true; } } catch {}
    if (field.value !== prompt) return;
    if (!copied) {
      field.focus(); field.select(); field.setSelectionRange(0, field.value.length);
      try { copied = document.execCommand('copy'); } catch {}
    }
    $('#story-copy-status', sheet).textContent = copied ? 'Prompt copied. Paste it into your AI chat.' : 'Automatic copying was blocked. Select the prompt below and use Copy.';
    if (copied) toast('Prompt copied');
  };
}

/* Word menu, bookmarks */
function showWordMenu(i) {
  const excerpt = R.words.slice(Math.max(0, i - 3), i + 6).join(' ');
  const sheet = openSheet('This word', `<div class="sheet-body">
    <p class="muted">${esc(excerpt)}</p>
    <button class="menu-btn" data-a="start">Read from here</button>
    <button class="menu-btn" data-a="explain">Explain up to this word</button>
    <button class="menu-btn" data-a="mark">Add a bookmark here</button></div>`);
  sheet.onclick = e => {
    const action = e.target.closest('[data-a]')?.dataset.a;
    if (action === 'start') { closeSheet(); pause({ animate: false }); seek(i); }
    if (action === 'mark') { closeSheet(); addBookmark(i); }
    if (action === 'explain') showStoryContext(i);
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
    body.innerHTML = pageBody(currentPage);
    body.scrollTop = top;
  };
  const all = SETTINGS.flatMap(([, list]) => list);
  const fontName = k => FONTS[k]?.[0] || '';
  const section = name => SETTINGS.find(([n]) => n === name)[1];
  const basics = ['wordFont', 'wordSize', 'contextWords', 'contextCount'];
  const advanced = (title, controls) => `<details class="settings-advanced"><summary>${title}</summary>${controls.map(control).join('')}</details>`;
  const pageBody = name => {
    if (name === 'Appearance') return `<p class="settings-intro">Make the page comfortable to read.</p>`
      + [...section('Colors'), ...section('Scrolling text').slice(0, 2)].map(control).join('')
      + advanced('Spacing and alignment', section('Scrolling text').slice(2));
    if (name === 'RSVP') return `<p class="settings-intro">One word at a time. Only Play starts a session.</p>`
      + [...section('Speed').filter(c => ['wpm', 'countdown'].includes(c.k)), ...section('RSVP word').filter(c => basics.includes(c.k))].map(control).join('')
      + advanced('Word appearance and focus', section('RSVP word').filter(c => !basics.includes(c.k)))
      + advanced('Timing and gestures', [...section('Speed').filter(c => !['wpm', 'countdown'].includes(c.k)), ...section('Pacing')]);
    if (name === 'Audio') return `<p class="settings-intro">Background sound mixes with your audiobook. Adjust its volume here; narration speed is in the book’s audiobook menu.</p>`
      + section('Ambient sound').map(c => control(c.k === 'volume' ? { ...c, label: 'Background volume' } : c)).join('');
    if (name === 'Reading goal') return section(name).map(control).join('');
    return '';
  };
  const SUMMARY = {
    Appearance: () => `${THEMES[S.theme]?.name || 'Custom'} theme · ${fontName(S.textFont)}, ${S.textSize} pt`,
    RSVP: () => `${S.wpm} WPM · surrounding words ${S.contextWords ? 'on' : 'off'}`,
    Audio: () => `Background sound · ${soundLabel(S.sound)}`,
    'Reading goal': () => `${S.dailyGoal} min a day`,
    'Library and data': () => 'App updates, backups, and storage',
  };
  const PREVIEW = { Appearance: 'text', RSVP: 'word' };
  const dataPage = () => `
    <button class="menu-btn" data-a="app-update">Check for app updates<small>Load the latest reader and keep your place</small></button>
    <button class="menu-btn" data-a="backup">Save a backup<small>Includes your books, progress, bookmarks, stats, and settings</small><small id="last-backup">Save a copy outside this app</small></button>
    <label class="menu-btn" for="restore" style="cursor:pointer">Restore from a backup<small>Preview its contents and choose what to restore</small></label>
    <input id="restore" type="file" accept=".zip,application/zip" style="position:absolute;opacity:0;width:1px;height:1px">
    <div class="set-row"><div class="set-line"><label for="s-backupTracks">Include your audio files in backups<small class="set-help">${tracks.length ? `Your files take about ${trackMb(tracks.reduce((n, t) => n + t.size, 0))}, which makes backups larger.` : 'Applies to audio files you add.'}</small></label>
      <input class="switch" type="checkbox" role="switch" id="s-backupTracks" data-k="backupTracks" ${S.backupTracks ? 'checked' : ''}></div></div>
    <div class="set-row"><div class="set-line"><label for="s-backupNarration">Include audiobooks in backups<small class="set-help">Audiobooks can make backups much larger.</small></label><input class="switch" type="checkbox" role="switch" id="s-backupNarration" data-k="backupNarration" ${S.backupNarration ? 'checked' : ''}></div></div>
    <div class="menu-btn" id="storage-info"><span>Storage</span><small>Checking</small></div>
    <button class="menu-btn" data-a="reset">Reset settings to defaults</button>
    <button class="menu-btn danger" data-a="clear-stats">Clear reading stats</button>`;
  const pageNames = ['Appearance', 'RSVP', 'Audio', 'Reading goal', 'Library and data'];
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
      body.innerHTML = dataPage() + advanced('App behavior', section('Controls'));
      storageInfo($('#storage-info', sheet));
      db.get('kv', 'lastBackup').then(last => { const el = $('#last-backup', sheet); if (last && el) el.textContent = `Last sent to device: ${new Date(last.at).toLocaleString()}`; }).catch(() => {});
    } else {
      body.innerHTML = pageBody(name);
    }
    preview();
    slide(direction);
  };
  const aliases = { Colors: 'Appearance', 'Scrolling text': 'Appearance', 'RSVP word': 'RSVP', Speed: 'RSVP', Pacing: 'RSVP', 'Ambient sound': 'Audio', Controls: 'Library and data' };
  showPage(aliases[startPage] || startPage, 'none');

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
    if (nav) { if (nav.dataset.page === 'Appearance' && R && bookMode()) showBookAppearance(); else showPage(nav.dataset.page, 'in'); return; }
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
function backupProgress(title) {
  const controller = new AbortController();
  const sheet = openSheet(title, `<div class="sheet-body"><p id="backup-status" role="status" aria-live="polite">Preparing…</p>
    <progress id="backup-progress" style="width:100%" aria-label="Backup progress"></progress>
    <p class="muted">Keep Stillpoint open until this finishes. Closing this panel cancels the operation.</p>
    <div id="backup-actions"></div></div>`, { onClose: () => controller.abort() });
  return { sheet, signal: controller.signal, progress: (label, n, total) => {
    $('#backup-status', sheet).textContent = label + (total ? ` · ${Math.floor(n / total * 100)}%` : '');
    const bar = $('#backup-progress', sheet);
    if (total) { bar.max = total; bar.value = n; } else bar.removeAttribute('value');
  } };
}
function backupError(error, sheet) {
  console.error(error);
  if (!sheet.isConnected || error.name === 'AbortError') return;
  $('#backup-status', sheet).textContent = error.name === 'QuotaExceededError'
    ? 'There is not enough free space. Free some device storage and try again.'
    : error.message || 'The backup could not be read. Try a fresh copy from Files.';
  $('#backup-progress', sheet)?.remove();
}
async function exportBackup() {
  if (R) pause({ animate: false });
  const operation = backupProgress('Save a backup'), { sheet, signal, progress } = operation;
  try {
    const blob = await createBackup(S, { signal, progress });
    signal.throwIfAborted();
    const name = `stillpoint-backup-${new Date().toISOString().slice(0, 10)}.zip`;
    const file = new File([blob], name, { type: 'application/zip' });
    $('#backup-status', sheet).textContent = `Backup ready · ${trackMb(file.size)}`;
    $('#backup-actions', sheet).innerHTML = '<button class="primary" id="backup-save">Save backup file</button><p class="muted">Save it to Files, iCloud Drive, or your computer. A backup kept only inside Stillpoint cannot protect against losing app storage.</p>';
    $('#backup-save', sheet).onclick = async () => {
      try {
        let shared = false;
        if (navigator.canShare?.({ files: [file] })) {
          try { await navigator.share({ files: [file], title: 'Stillpoint backup' }); shared = true; }
          catch (error) { if (error.name === 'AbortError') return; }
        }
        if (!shared) {
          const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name;
          document.body.append(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 60000);
        }
        await db.put('kv', { at: Date.now(), size: file.size }, 'lastBackup');
        $('#backup-status', sheet).textContent = 'Backup sent to your device. Make sure you save the file.';
      } catch (error) { if (error.name !== 'AbortError') backupError(error, sheet); }
    };
  } catch (error) { backupError(error, sheet); }
}
async function importBackup(file) {
  if (R) pause({ animate: false });
  const operation = backupProgress('Check backup'), { sheet, signal, progress } = operation;
  try {
    const plan = await inspectBackup(file, { signal }); signal.throwIfAborted();
    const current = new Set((await db.getAll('books')).map(b => b.id));
    const duplicates = plan.books.filter(b => current.has(b.book.id)).length;
    const date = new Date(plan.data.createdAt);
    $('#backup-status', sheet).textContent = `${plan.books.length} books · ${plan.data.narrationIds?.length || 0} audiobooks · ${plan.data.tracks?.length || 0} background audio files`;
    $('#backup-progress', sheet).remove();
    $('#backup-actions', sheet).innerHTML = `<p class="muted">${Number.isFinite(date.getTime()) ? `Created ${esc(date.toLocaleString())}. ` : ''}${duplicates} books already on this device. By default, their text, audio, progress, and bookmarks stay as they are.</p>
      <div class="set-line"><label for="restore-replace">Replace existing books and their saved places</label><input type="checkbox" id="restore-replace"></div>
      <p class="set-help">Replacement uses the backup’s copy, including its bookmarks. If audio was excluded, the replacement is text only. Other books stay on this device.</p>
      <div class="set-line"><label for="restore-settings">Restore settings too</label><input type="checkbox" id="restore-settings"></div>
      <p class="muted">Reading history is merged without duplicates. Each book is saved together with its complete audio. If interrupted, completed books remain; you can safely retry.</p>
      <button class="primary" id="restore-start">Restore backup</button>`;
    $('#restore-start', sheet).onclick = async () => {
      const replace = $('#restore-replace', sheet).checked, settings = $('#restore-settings', sheet).checked;
      $('#backup-actions', sheet).innerHTML = '<p class="muted">Checking audio and restoring one book at a time. Closing cancels after the current small chunk; completed books remain.</p>';
      $('#backup-status', sheet).insertAdjacentHTML('afterend', '<progress id="backup-progress" style="width:100%" aria-label="Restore progress"></progress>');
      const returnBookId = R?.book.id;
      try {
        // A stale open reader must not autosave over a restored book on pagehide.
        if (R) {
          await saveProgress(true);
          R.sleepTimer?.dispose(); R.chromeResize?.disconnect(); R.narration?.dispose(); R.bookView?.destroy();
          stopSound(); R = null;
          await showLibrary();
        }
        const result = await restoreBackup(plan, { replace, signal, progress }); signal.throwIfAborted();
        if (settings && plan.data.settings && typeof plan.data.settings === 'object') {
          S = { ...DEFAULTS, ...plan.data.settings }; applySettings(); await db.put('kv', S, 'settings');
        }
        closeSheet();
        toast(`Restored ${result.restored} ${result.restored === 1 ? 'book' : 'books'}${result.skipped ? ` · kept ${result.skipped} existing` : ''}${result.tracks ? ` · ${result.tracks} background audio files` : ''}`, 6000);
      } catch (error) { backupError(error, sheet); }
      finally {
        tracks = await db.getAll('tracks'); fixSound();
        if (returnBookId && await db.get('books', returnBookId)) await openBook(returnBookId);
        else await showLibrary();
      }
    };
  } catch (error) { backupError(error, sheet); }
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
  if (e.key === 'Escape' && R.fullscreen) { setReaderFullscreen(false); return; }
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
  if (e.key === 'ArrowLeft') { if (narrating()) skipAudio(-15); else rewindBy(S.rewind); }
  if (e.key === 'ArrowRight') { if (narrating()) skipAudio(15); else seek(R.pos + S.rewind); }
});
document.addEventListener('visibilitychange', () => {
  if (!R) return;
  if (document.hidden) {
    if (readerMode() === 'read' && R.bookView) R.pos = R.bookView.firstVisible();
    if (narrating()) {
      R.narration.setBackground(true);
      R.narration.update(true);
      releaseWake();
    } else if (R.state !== 'paused') pause({ animate: false });
  } else if (narrating()) {
    if (R.state !== 'paused' && S.sound !== 'off') playSound(S.sound, S.volume);
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
  document.documentElement.dataset.applePwa = looksLikeIOS() && isStandalone() ? 'true' : 'false';
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
