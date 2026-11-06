// PDF cleanup: pure functions over extracted page lines.
// A page is {n, lines:[{text, y, h, x, end}]}, with lines in reading order.

const PAGE_NUMBER = /^[\s\W]*(?:(?:page|p\.?)\s*)?(?:\d{1,5}|[ivxlcdm]{1,7})(?:\s*(?:of|\/)\s*\d{1,5})?[\s\W]*$/i;

const CHAPTER_TITLE = /^(?:(?:chapter|part|section|book)\s+(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)\b|step\s+[ivxlcdm]+\b)/i;
const NAMED_TITLE = /^(?:(?:chapter|part|book|step)\s+(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)\b[^.!?]{0,65}|prologue|epilogue|introduction|preface|appendix(?:\s+[A-Z])?)[:.]?$/i;
const fingerprint = text => text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
const median = values => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
};

export function analyzePages(pages) {
  const edgeCount = new Map();
  const edges = page => {
    const l = page.lines;
    const picks = new Set();
    [0, 1, l.length - 2, l.length - 1].forEach(i => { if (l[i]) picks.add(l[i]); });
    return picks;
  };
  pages.forEach(page => {
    const seen = new Set();
    edges(page).forEach(line => {
      const fp = fingerprint(line.text);
      if (fp.length < 2 || seen.has(fp)) return;
      seen.add(fp);
      edgeCount.set(fp, (edgeCount.get(fp) || 0) + 1);
    });
  });
  const threshold = 3;
  const bodyH = median(pages.flatMap(p => p.lines.map(l => l.h)).filter(Boolean)) || 10;
  const repeated = new Set([...edgeCount].filter(([fp, n]) => n >= threshold && fp.length <= 120).map(([fp]) => fp));

  const found = { headers: 0, numbers: 0, footnotes: 0, hyphens: 0, figures: 0 };
  const analyzed = pages.map(page => {
    const lines = page.lines.map(l => ({ ...l, role: 'body' }));
    const edgeSet = new Set();
    [0, 1, lines.length - 2, lines.length - 1].forEach(i => { if (lines[i]) edgeSet.add(i); });
    lines.forEach((line, i) => {
      if (!edgeSet.has(i)) return;
      const margin = page.height ? line.y > page.height * 0.92 || line.y < page.height * 0.12 : edgeSet.has(i);
      if (margin && line.h <= bodyH * 1.15 && PAGE_NUMBER.test(line.text)) { line.role = 'number'; found.numbers++; }
      else if (margin && line.h <= bodyH * 1.15 && repeated.has(fingerprint(line.text))) { line.role = 'header'; found.headers++; }
    });
    // A footnote block is a run of small lines at the bottom that starts with a marker.
    let i = lines.length - 1;
    while (i >= 0 && lines[i].role !== 'body') i--;
    let start = -1;
    while (i >= 0 && lines[i].role === 'body' && lines[i].h >= bodyH * 0.6 && lines[i].h < bodyH * 0.88
      && (!page.height || lines[i].y < page.height * 0.18)) {
      if (/^\s*(?:\d{1,3}[.)]?|[*†‡])\s/.test(lines[i].text)) start = i;
      i--;
    }
    if (start > 0) {
      for (let k = start; k < lines.length; k++) {
        if (lines[k].role === 'body') { lines[k].role = 'footnote'; found.footnotes++; }
      }
    }
    // Explicit captions are strong evidence; small text alone is not.
    lines.forEach((line, index) => {
      if (!/^(?:FIGURE|FIG\.|PLATE)\s+\d+[.:]/i.test(line.text)) return;
      line.role = 'figure';
      for (let k = index + 1; k < lines.length; k++) {
        if (lines[k].role !== 'body' || lines[k].h > line.h * 1.15 || lines[k - 1].y - lines[k].y > Math.max(line.h * 2.8, 12)) break;
        lines[k].role = 'figure';
      }
      for (let k = index - 1; k >= 0; k--) {
        const candidate = lines[k];
        if (/^\d+(?:\.\d+)*[.):]\s/.test(candidate.text)) break;
        const label = candidate.text.length < 55 && /[A-Z]/.test(candidate.text) && candidate.text === candidate.text.toUpperCase();
        if (candidate.role !== 'body' || !(candidate.h < bodyH * 0.8 || label)) break;
        candidate.role = 'figure';
      }
    });
    found.figures += lines.filter(l => l.role === 'figure').length;
    lines.forEach((line, k) => {
      const next = lines[k + 1];
      if (next && /\p{L}-$/u.test(line.text) && /^\p{Ll}/u.test(next.text)) found.hyphens++;
    });
    return { n: page.n, height: page.height, width: page.width, lines };
  });
  return { pages: analyzed, bodyH, found };
}

export const defaultCleanOptions = () => ({
  headers: true, numbers: true, footnotes: false, hyphens: true, skip: new Set(),
});

// Turns analyzed pages into blocks. Returns the first block of each page for chapter lookups.
export function buildBlocks(analysis, options) {
  const { bodyH } = analysis;
  const blocks = [];
  const pageBlock = new Map();
  const headingBlocks = [];
  let buffer = '';
  let previous = null;
  let gaps = [];
  let metadata = {};

  analysis.pages.forEach(page => {
    const ys = page.lines.map(l => l.y);
    for (let i = 1; i < ys.length; i++) {
      const gap = ys[i - 1] - ys[i];
      if (gap > 0) gaps.push(gap);
    }
  });
  const lineGap = median(gaps) || bodyH * 1.2;

  const flush = () => {
    const text = buffer.trim();
    if (text) blocks.push({ k: 'p', t: text, ...metadata });
    buffer = '';
  };

  analysis.pages.forEach(page => {
    if (options.skip.has(page.n)) { flush(); previous = null; return; }
    // Keep page locations, while continuation flags avoid an extra playback pause.
    flush();
    let markedPage = false;
    const leftEdge = median(page.lines.map(l => l.x));
    page.lines.forEach(line => {
      if (line.role === 'header' && options.headers) return;
      if (line.role === 'number' && options.numbers) return;
      if (line.role === 'footnote' && options.footnotes) return;
      const text = line.text.trim();
      if (!text) return;

      if (line.role !== 'body') {
        flush();
        if (!markedPage) { pageBlock.set(page.n, blocks.length); markedPage = true; }
        blocks.push({ k: 'p', t: text, page: page.n, location: `Page ${page.n}`,
          document: `page:${page.n}`, roles: [line.role === 'footnote' ? 'note' : line.role] });
        return;
      }

      const samePage = previous && previous.page === page.n;
      const above = samePage ? previous.line.y - line.y : lineGap * 2;
      const adjoiningTitle = previous?.heading && samePage && line.h === previous.line.h && above < lineGap * 1.8;
      const heading = line.h > bodyH * 1.22 && text.length < 90 && text.split(/\s+/).length <= 12
        && !/^[\s•\uF000-\uF8FF“"—–]/u.test(text) && !/[.!?,;]$/.test(text)
        && (adjoiningTitle || above > Math.max(lineGap * 1.5, line.h * 1.4));
      const named = NAMED_TITLE.test(text.trim()) && text.length < 80;

      if (heading || named) {
        flush();
        if (!markedPage) { pageBlock.set(page.n, blocks.length); markedPage = true; }
        const prior = blocks[blocks.length - 1];
        if (prior && prior.k === 'h' && heading && previous && previous.heading && samePage
          && above < lineGap * 1.8 && line.h === previous.line.h && prior.t.length + text.length < 120) {
          prior.t += ` ${text}`;
        } else {
          headingBlocks.push(blocks.length);
          blocks.push({ k: 'h', t: text, page: page.n, location: `Page ${page.n}`, document: `page:${page.n}`,
            roles: [], section: named && CHAPTER_TITLE.test(text) || /^\d+$/.test(text) && heading ? 'chapter' : 'subchapter' });
        }
        previous = { page: page.n, line, heading: true, text };
        return;
      }

      const gap = samePage ? previous.line.y - line.y : lineGap;
      const bigGap = samePage && gap > lineGap * 1.5;
      const indented = line.x > leftEdge + bodyH * 0.9 && line.x < leftEdge + bodyH * 5
        && (!samePage || line.x - previous.line.x > bodyH * 0.7);
      const shortEnd = previous && !previous.heading && previous.short && /[.!?:"”]$/.test(previous.text);
      const newParagraph = !previous || previous.heading || bigGap || indented || (shortEnd && samePage);

      if (newParagraph) flush();
      if (!buffer) metadata = { page: page.n, location: `Page ${page.n}`, document: `page:${page.n}`, roles: [],
        continues: !!previous && !newParagraph && !samePage };
      if (!markedPage) { pageBlock.set(page.n, blocks.length + (buffer ? 0 : 0)); markedPage = true; }

      if (buffer && options.hyphens && /\p{L}-$/u.test(buffer) && /^\p{Ll}/u.test(text)) {
        buffer = buffer.slice(0, -1) + text;
      } else {
        buffer += (buffer ? ' ' : '') + text;
      }
      previous = {
        page: page.n, line, heading: false, text,
        short: text.length < 55,
      };
    });
  });
  flush();
  return { blocks, pageBlock, headingBlocks };
}

// "1-4, 210" becomes a set of page numbers.
export function parsePageList(input, total) {
  const pages = new Set();
  for (const part of String(input).split(/[,\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let n = Math.max(1, Math.min(a, b)); n <= Math.min(total, Math.max(a, b)); n++) pages.add(n);
  }
  return pages;
}
