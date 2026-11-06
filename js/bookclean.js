import { tokenize } from './engine.js';

export const CLEAN_ROLES = {
  figure: 'Figures and captions', note: 'Footnotes and endnotes',
  frontmatter: 'Front matter', backmatter: 'Back matter', boilerplate: 'Publisher and distribution notices',
  header: 'Running headers and footers', number: 'Page numbers',
  page: 'Pages selected to skip',
};

export const defaultBookOptions = () => ({
  figure: false, note: false, frontmatter: false, backmatter: false, boilerplate: false,
  header: false, number: false, page: false, announcements: 'chapters', overrides: {},
});

export function blockChoice(block, options) {
  const override = options.overrides?.[block.sid];
  if (override === 'exclude') return false;
  if (override === 'keep' || override === 'body') return true;
  const roles = block.roles || [];
  if (roles.includes('page') && options.page === false) return false;
  // A specific choice (e.g. notes) also applies inside front/back matter.
  const specific = ['figure', 'note', 'boilerplate', 'header', 'number'].find(role => roles.includes(role));
  return specific ? options[specific] !== false : roles.every(role => options[role] !== false);
}

// Chapter navigation remains complete; only announcements are restricted.
export function cleanBook(source, choices = defaultBookOptions()) {
  const options = { ...defaultBookOptions(), ...choices };
  const blocks = [], map = new Map();
  source.blocks.forEach((block, i) => {
    if (!block.t.trim() || !blockChoice(block, options)) return;
    map.set(i, blocks.length);
    blocks.push({ ...block, k: options.overrides?.[block.sid] === 'body' ? 'p' : block.k });
  });
  const depths = source.chapters.filter(c => map.has(c.block)).map(c => c.depth || 0);
  const minDepth = depths.length ? Math.min(...depths) : 0;
  let chapters = source.chapters.flatMap(c => {
    const block = map.get(c.block);
    if (block === undefined || options.overrides?.[blocks[block].sid] === 'body') return [];
    const explicit = blocks[block].section;
    const major = c.major ?? (explicit ? /^(chapter|part|volume|book)$/.test(explicit)
      : /^(?:chapter|part|book)\s+(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i.test(c.title)
        || (c.depth || 0) === minDepth);
    return [{ ...c, block, announce: options.announcements === 'all'
      || options.announcements !== 'none' && major }];
  });
  // EPUBs often link a chapter number and its immediately adjacent subtitle separately.
  chapters = chapters.filter((c, i, all) => {
    const prior = all[i - 1];
    if (!prior || c.block <= prior.block || c.block > prior.block + 3) return true;
    const between = blocks.slice(prior.block, c.block + 1);
    if (!between.every(b => b.k === 'h') || between.some(b => b.document !== between[0].document)) return true;
    if (!/^(?:chapter|part|book)\s+(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)[.:]?$/i.test(prior.title.trim())) return true;
    prior.title = `${prior.title}: ${c.title}`;
    return false;
  });
  const seen = new Set(), announced = new Set();
  chapters = chapters.filter(c => {
    const key = `${c.block}|${c.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    if (announced.has(c.block)) c.announce = false;
    if (c.announce) announced.add(c.block);
    return true;
  });
  return {
    title: source.title, author: source.author, format: source.format, blocks, chapters,
    cleanup: { version: 1, source, options },
  };
}

// Use source block identities rather than percentage to preserve a place after editing.
export function positionAnchor(blocks, position) {
  let start = 0;
  for (const block of blocks) {
    const length = tokenize(block.t).length;
    if (position < start + length) return { sid: block.sid, offset: position - start };
    start += length;
  }
  return { sid: blocks.at(-1)?.sid, offset: 0 };
}

export function anchorPosition(source, blocks, anchor) {
  const original = source.blocks.findIndex(b => b.sid === anchor?.sid);
  let start = 0;
  for (const block of blocks) {
    const length = tokenize(block.t).length;
    if (block.sid === anchor?.sid) return start + Math.min(anchor.offset || 0, Math.max(0, length - 1));
    if (original >= 0 && block.order > original) return start;
    start += length;
  }
  return Math.max(0, start - 1);
}
