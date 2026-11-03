// Reading engine: pure text logic with no DOM dependencies.

const DASH_SPLIT = /(?<=\p{L}[—―]|\p{L}--)(?=\S)|(?<=\p{L}–)(?=\p{L})/u;
const ELLIPSIS_SPLIT = /(?<=\p{L}(?:…|\.{3}))(?=\p{L})/u;
const HAS_ALNUM = /[\p{L}\p{N}]/u;
const OPENERS = /^[“‘("'\[{«]+$/u;
const ABBREVIATIONS = /^(mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|e\.g|i\.e|no|fig|inc|ltd)\.$/i;
const MAX_JOINED = 18;

export function normalizeText(text) {
  return String(text)
    .replace(/[­​-‍⁠﻿]/g, '')
    .replace(/\.\s\.\s\./g, '…')
    .replace(/\s+/g, ' ')
    .trim();
}

// Returns [{w, g}] where g=1 means no space follows the word in the scrolling view.
export function tokenize(text) {
  const out = [];
  let prefix = '';
  for (const raw of normalizeText(text).split(' ')) {
    if (!raw) continue;
    if (!HAS_ALNUM.test(raw)) {
      if (OPENERS.test(raw)) prefix += raw;
      else if (out.length) out[out.length - 1].w += raw;
      else prefix += raw;
      continue;
    }
    const parts = raw.split(DASH_SPLIT).flatMap(p => p.split(ELLIPSIS_SPLIT));
    parts.forEach((part, i) => {
      const pieces = part.length > MAX_JOINED
        ? part.split(/(?<=[-/])(?=[\p{L}\p{N}])/u)
        : [part];
      pieces.forEach((piece, j) => {
        const last = i === parts.length - 1 && j === pieces.length - 1;
        out.push({ w: prefix + piece, g: last ? 0 : 1 });
        prefix = '';
      });
    });
  }
  if (prefix && out.length) out[out.length - 1].w += prefix;
  return out;
}

// Turns stored blocks into the flat arrays the reader uses.
export function buildIndex(blocks) {
  const words = [];
  const glue = [];
  const wordBlock = [];
  const blockStart = new Array(blocks.length);
  blocks.forEach((block, b) => {
    blockStart[b] = words.length;
    for (const t of tokenize(block.t)) {
      words.push(t.w);
      glue.push(t.g);
      wordBlock.push(b);
    }
  });
  return { words, glue, wordBlock, blockStart };
}

// Index of the letter to highlight. "orp" sits slightly left of center;
// "middle" is the true middle of the word. Surrounding punctuation is ignored.
export function pivotIndex(word, mode = 'orp') {
  const chars = Array.from(word);
  let start = 0;
  let end = chars.length - 1;
  while (start < end && !HAS_ALNUM.test(chars[start])) start++;
  while (end > start && !HAS_ALNUM.test(chars[end])) end--;
  const len = end - start + 1;
  let offset;
  if (mode === 'middle') offset = Math.floor((len - 1) / 2);
  else if (len <= 1) offset = 0;
  else if (len <= 5) offset = 1;
  else if (len <= 9) offset = 2;
  else if (len <= 13) offset = 3;
  else offset = 4;
  return start + offset;
}

export function splitAtPivot(text, mode) {
  const chars = Array.from(text);
  const p = pivotIndex(text, mode);
  return {
    left: chars.slice(0, p).join(''),
    pivot: chars[p] ?? '',
    right: chars.slice(p + 1).join(''),
  };
}

export function isSentenceEnd(word) {
  const core = word.replace(/[”’)"'\]}»*_]+$/u, '');
  if (ABBREVIATIONS.test(core.replace(/^[^\p{L}]+/u, ''))) return false;
  if (/^\p{Lu}\.$/u.test(core)) return false;
  return /[.!?…]$/.test(core);
}

export function isClauseEnd(word) {
  const core = word.replace(/[”’)"'\]}»*_]+$/u, '');
  return /[,;:—–―-]$/.test(core);
}

// Words to show at once. A group never crosses a sentence or paragraph end.
export function chunkAt(index, words, wordBlock, count, glue = []) {
  const parts = [words[index]];
  let text = words[index];
  let i = index + 1;
  while (parts.length < count && i < words.length
    && wordBlock[i] === wordBlock[index] && !isSentenceEnd(words[i - 1])) {
    text += (glue[i - 1] ? '' : ' ') + words[i];
    parts.push(words[i]);
    i++;
  }
  return { text, count: parts.length };
}

export function wordDelay(text, count, settings, endOfParagraph = false) {
  const base = (60000 / settings.wpm) * count;
  if (!settings.smartPacing) return base;
  let m = 1;
  const last = text.split(' ').pop();
  if (isSentenceEnd(last)) m = Math.max(m, settings.sentencePause);
  else if (isClauseEnd(last)) m = Math.max(m, settings.commaPause);
  if (endOfParagraph) m = Math.max(m, settings.paragraphPause);
  const letters = (text.match(/[\p{L}\p{N}]/gu) || []).length / count;
  if (letters > 8) m += Math.min(1.2, (letters - 8) * 0.07) * settings.longWordPause;
  if (/\d/.test(text)) m += 0.3 * settings.longWordPause;
  return base * m;
}

// Delay multiplier for the first words after pressing play.
export function rampFactor(wordsSincePlay, rampWords) {
  if (!rampWords || wordsSincePlay >= rampWords) return 1;
  return 1 + 0.8 * (1 - wordsSincePlay / rampWords);
}

export function estimateMs(wordCount, wpm, smart = true) {
  return (wordCount / wpm) * 60000 * (smart ? 1.25 : 1);
}

export function formatDuration(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

export function lowerBound(sorted, value) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

// Groups blocks into sections so long books only keep a small part in the page.
export function buildSegments(blocks, blockStart, chapterBlocks, target = 2000) {
  const chapters = new Set(chapterBlocks);
  const segs = [];
  let first = 0;
  const count = blocks.length;
  for (let b = 1; b <= count; b++) {
    const size = (b < count ? blockStart[b] : Infinity) - blockStart[first];
    if (b === count || chapters.has(b) || size >= target) {
      segs.push({ first, last: b - 1, start: blockStart[first] });
      first = b;
    }
  }
  return segs;
}
