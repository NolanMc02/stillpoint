// Converts documents into {title, author, format, blocks, chapters}.
// Blocks are {k:'p'|'h'|'q', t:text}. Chapters are {title, block, depth}.
import { normalizeText } from './engine.js';
import { analyzePages, buildBlocks } from './pdfclean.js';
import { cleanBook, defaultBookOptions } from './bookclean.js';

export class ImportError extends Error {}

const BLOCK_TAGS = new Set(`address article aside blockquote body center dd details dialog div dl dt fieldset
figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr html li main menu nav ol p pre section summary
table tbody td tfoot th thead tr ul`.split(/\s+/));
const SKIP_TAGS = new Set('script style head template svg math object noscript iframe rt rp audio video canvas'.split(' '));
const NOTE_TYPES = /\b(footnote|endnote|rearnote|footnotes|endnotes|rearnotes)\b/;

const extension = name => (name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
const baseTitle = name => name.replace(/\.[a-z0-9]+$/i, '').replace(/[_]+/g, ' ').trim() || 'Untitled';
const tagOf = el => (el.localName || el.nodeName || '').toLowerCase().replace(/^.*:/, '');

function epubType(el) {
  return `${el.getAttribute('epub:type') || el.getAttributeNS?.('http://www.idpf.org/2007/ops', 'type') || ''} ${el.getAttribute('role') || ''}`.trim();
}

function parseMarkup(text, preferXml = false) {
  if (preferXml) {
    const doc = new DOMParser().parseFromString(text.replace(/^﻿/, ''), 'application/xhtml+xml');
    if (!doc.querySelector('parsererror')) return doc;
  }
  return new DOMParser().parseFromString(text, 'text/html');
}

// Walks a document and adds readable blocks. Records where each element id starts.
export function appendDocument(doc, blocks, anchors = null, context = null) {
  let buffer = '';
  let quoteDepth = 0;
  let roles = context?.roles || [];
  let section = '';
  const classify = node => {
    const type = epubType(node);
    const cls = node.getAttribute('class') || '';
    const id = node.getAttribute('id') || '';
    if (/\bpg-boilerplate\b/.test(cls) || /^pg-(header|footer)$/.test(id)) return 'boilerplate';
    if (NOTE_TYPES.test(type) || /doc-(footnote|endnote)/.test(type) || /\b(?:footnote|footnotes|endnotes|rearnotes)\b/.test(cls)) return 'note';
    if (['figure', 'figcaption'].includes(tagOf(node)) || /\bfigure\b/.test(type) || /\b(?:caption|figcaption|figcenter)\b/.test(cls)) return 'figure';
    if (/\b(?:cover|titlepage|copyright-page|dedication|frontmatter|toc)\b/.test(type)) return 'frontmatter';
    if (/\b(?:backmatter|bibliography|index|advertisements|colophon)\b/.test(type)) return 'backmatter';
    return null;
  };
  const flush = (kind = quoteDepth ? 'q' : 'p') => {
    const text = normalizeText(buffer);
    buffer = '';
    if (text && /[\p{L}\p{N}]/u.test(text)) blocks.push({ k: kind, t: text,
      ...(context ? { roles: [...roles], section, document: context.document, location: context.location || context.document } : {}) });
  };
  const visit = node => {
    if (node.nodeType === 3) { buffer += node.nodeValue; return; }
    if (node.nodeType !== 1) return;
    const tag = tagOf(node);
    if (SKIP_TAGS.has(tag)) return;
    const type = epubType(node);
    if (/\b(?:noteref|doc-noteref|doc-backlink|pagebreak|doc-pagebreak)\b/.test(type)) return;
    if (!context && (NOTE_TYPES.test(type) || /doc-(footnote|endnote)/.test(type))) return;
    if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true' || /display\s*:\s*none\b/i.test(node.getAttribute('style') || '')) return;
    if (tag === 'a' && /\b(?:fnanchor|footnote-ref)\b/.test(node.getAttribute('class') || '')) return;
    if (tag === 'sup' && (node.querySelector?.('a') || !context && /^\s*[\d*†‡]+\s*$/.test(node.textContent))) return;
    if (tag === 'nav' && /\b(toc|landmarks|page-list)\b/.test(type)) return;
    const role = context && classify(node);
    const oldRoles = roles, oldSection = section;
    const structural = type.split(/\s+/).find(t => /^(chapter|subchapter|part|volume|book|preface|introduction|epigraph)$/.test(t));
    const boundary = role && !roles.includes(role) || structural;
    if (boundary) flush();
    if (role && !roles.includes(role)) roles = [...roles, role];
    if (structural) section = structural;
    const id = node.getAttribute('id') || (tag === 'a' ? node.getAttribute('name') : null);
    if (anchors && id) anchors.set(id, blocks.length + (normalizeText(buffer) ? 1 : 0));
    if (tag === 'br') { buffer += ' '; return; }
    if (tag === 'img') {
      const alt = node.getAttribute('alt');
      if (context) {
        // Prefer the actual caption over a duplicate image description.
        const figure = node.closest('figure, [role="figure"], .figcenter');
        if (alt && (!roles.includes('figure') || !figure?.textContent.trim())) {
          flush(); const prior = roles; roles = [...new Set([...roles, 'figure'])]; buffer = alt; flush(); roles = prior;
        }
      } else if (alt && alt.length > 40) buffer += ` ${alt} `;
      roles = oldRoles; section = oldSection;
      return;
    }
    if (/^h[1-6]$/.test(tag)) {
      flush();
      for (const child of node.childNodes) visit(child);
      flush('h');
      roles = oldRoles; section = oldSection;
      return;
    }
    if (BLOCK_TAGS.has(tag)) {
      flush();
      const quote = tag === 'blockquote';
      if (quote) quoteDepth++;
      for (const child of node.childNodes) visit(child);
      flush();
      if (quote) quoteDepth--;
      roles = oldRoles; section = oldSection;
      return;
    }
    for (const child of node.childNodes) visit(child);
    if (boundary) flush();
    roles = oldRoles; section = oldSection;
  };
  visit(doc.body || doc.documentElement);
  flush();
}

function chaptersFromHeadings(blocks) {
  return blocks.flatMap((b, i) => (b.k === 'h' ? [{ title: b.t.slice(0, 120), block: i, depth: 0 }] : []));
}

function decodeText(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xFF && bytes[1] === 0xFE) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xFE && bytes[1] === 0xFF) return new TextDecoder('utf-16be').decode(bytes);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return new TextDecoder('windows-1252').decode(bytes); }
}

const CHAPTER_LINE = /^\s*(chapter|part|book|act|prologue|epilogue|introduction|preface|foreword|afterword|appendix)\b[^.!?]{0,70}$/i;

export function textToBook(text, title, format = 'txt') {
  const clean = text.replace(/\r\n?/g, '\n');
  const paragraphs = /\n\s*\n/.test(clean) ? clean.split(/\n\s*\n+/) : clean.split('\n');
  const blocks = [];
  for (const paragraph of paragraphs) {
    const lines = paragraph.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    if (CHAPTER_LINE.test(lines[0]) && lines[0].length < 80) {
      blocks.push({ k: 'h', t: normalizeText(lines[0]) });
      if (lines.length > 1) blocks.push({ k: 'p', t: normalizeText(lines.slice(1).join(' ')) });
    } else {
      const joined = normalizeText(lines.join(' '));
      if (joined) blocks.push({ k: 'p', t: joined });
    }
  }
  return { title, author: '', format, blocks, chapters: chaptersFromHeadings(blocks) };
}

function markdownToBook(text, title) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let buffer = [];
  let fence = false;
  const inline = s => s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|`|~~)/g, '')
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/g, '$1$2');
  const flush = () => {
    const joined = normalizeText(inline(buffer.join(' ')));
    if (joined) blocks.push({ k: 'p', t: joined });
    buffer = [];
  };
  let start = 0;
  if (lines[0]?.trim() === '---') {
    const close = lines.indexOf('---', 1);
    if (close > 0) start = close + 1;
  }
  for (const line of lines.slice(start)) {
    if (/^\s*(```|~~~)/.test(line)) { flush(); fence = !fence; continue; }
    if (fence) { buffer.push(line); continue; }
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/);
    if (heading) { flush(); blocks.push({ k: 'h', t: normalizeText(inline(heading[1])) }); continue; }
    if (!line.trim() || /^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); continue; }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) { flush(); buffer.push(line.replace(/^\s*([-*+]|\d+\.)\s+/, '')); flush(); continue; }
    if (/^\s*>/.test(line)) { const q = normalizeText(inline(line.replace(/^\s*>+\s?/, ''))); if (q) blocks.push({ k: 'q', t: q }); continue; }
    buffer.push(line);
  }
  flush();
  return { title: blocks[0]?.k === 'h' ? blocks[0].t.slice(0, 120) : title, author: '', format: 'md', blocks, chapters: chaptersFromHeadings(blocks) };
}

function markupToBook(text, title, format, xml = false) {
  const doc = parseMarkup(text, xml);
  const blocks = [];
  appendDocument(doc, blocks);
  const docTitle = doc.querySelector('title')?.textContent?.trim();
  return { title: docTitle || title, author: '', format, blocks, chapters: chaptersFromHeadings(blocks) };
}

function fb2ToBook(text, title) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new ImportError('This FB2 file could not be read because its XML is damaged.');
  const blocks = [];
  const chapters = [];
  const walk = node => {
    for (const child of node.children) {
      const tag = tagOf(child);
      if (tag === 'title') {
        const t = normalizeText(child.textContent);
        if (t) { chapters.push({ title: t.slice(0, 120), block: blocks.length, depth: 0 }); blocks.push({ k: 'h', t }); }
      } else if (tag === 'p' || tag === 'v' || tag === 'subtitle') {
        const t = normalizeText(child.textContent);
        if (t) blocks.push({ k: tag === 'subtitle' ? 'h' : 'p', t });
      } else if (tag !== 'binary' && tag !== 'description') walk(child);
    }
  };
  const bodies = [...doc.getElementsByTagName('body')].filter(b => b.getAttribute('name') !== 'notes');
  bodies.forEach(walk);
  const bookTitle = doc.getElementsByTagName('book-title')[0]?.textContent?.trim();
  const first = doc.getElementsByTagName('first-name')[0]?.textContent?.trim() || '';
  const last = doc.getElementsByTagName('last-name')[0]?.textContent?.trim() || '';
  return { title: bookTitle || title, author: `${first} ${last}`.trim(), format: 'fb2', blocks, chapters };
}

export function rtfToText(rtf) {
  const skip = /^(fonttbl|colortbl|stylesheet|info|pict|object|header|footer|headerl|headerr|footerl|footerr|footnote|themedata|datastore|latentstyles|listtable|listoverridetable|rsidtbl|generator|\*)$/;
  let out = '';
  const stack = [];
  let state = { skip: false, uc: 1 };
  let pendingSkip = 0;
  let i = 0;
  let codepage = 1252;
  let decoder = new TextDecoder('windows-1252');
  const hexBytes = [];
  const flushHex = () => {
    if (hexBytes.length) { if (!state.skip) out += decoder.decode(new Uint8Array(hexBytes)); hexBytes.length = 0; }
  };
  while (i < rtf.length) {
    const c = rtf[i];
    if (c === '\\') {
      const next = rtf[i + 1];
      if (next === "'") {
        const value = parseInt(rtf.substr(i + 2, 2), 16);
        i += 4;
        if (pendingSkip > 0) { pendingSkip--; continue; }
        if (!Number.isNaN(value)) hexBytes.push(value);
        continue;
      }
      flushHex();
      if (next === '\\' || next === '{' || next === '}') { if (!state.skip) out += next; i += 2; continue; }
      if (next === '~') { if (!state.skip) out += ' '; i += 2; continue; }
      if (next === '-' ) { i += 2; continue; }
      if (next === '_') { if (!state.skip) out += '-'; i += 2; continue; }
      if (next === '*') { state.skip = state.skip || state.destination; i += 2; state.star = true; continue; }
      const m = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(rtf.slice(i, i + 40));
      if (!m) { i += 2; continue; }
      i += m[0].length;
      const word = m[1];
      const arg = m[2] === undefined ? null : Number(m[2]);
      if (state.destination && (skip.test(word) || state.star)) state.skip = true;
      state.destination = false;
      state.star = false;
      if (state.skip) continue;
      if (word === 'par' || word === 'sect' || word === 'page') out += '\n\n';
      else if (word === 'line') out += ' ';
      else if (word === 'tab' || word === 'cell') out += ' ';
      else if (word === 'row') out += '\n\n';
      else if (word === 'emdash') out += '—';
      else if (word === 'endash') out += '–';
      else if (word === 'lquote') out += '‘';
      else if (word === 'rquote') out += '’';
      else if (word === 'ldblquote') out += '“';
      else if (word === 'rdblquote') out += '”';
      else if (word === 'bullet') out += '•';
      else if (word === 'uc' && arg !== null) state.uc = arg;
      else if (word === 'ansicpg' && arg) {
        try { decoder = new TextDecoder(`windows-${arg}`); codepage = arg; } catch { codepage = 1252; }
      } else if (word === 'u' && arg !== null) {
        out += String.fromCharCode(arg < 0 ? arg + 65536 : arg);
        pendingSkip = state.uc;
      }
      continue;
    }
    flushHex();
    if (c === '{') { stack.push(state); state = { ...state, destination: true, star: false }; i++; continue; }
    if (c === '}') { state = stack.pop() || state; i++; continue; }
    if (c === '\r' || c === '\n') { i++; continue; }
    state.destination = false;
    if (pendingSkip > 0) { pendingSkip--; i++; continue; }
    if (!state.skip) out += c;
    i++;
  }
  flushHex();
  return out;
}

async function loadZip(buffer) {
  if (!window.JSZip) throw new ImportError('The ZIP reader did not load. Reopen the app and try again.');
  try { return await window.JSZip.loadAsync(buffer); }
  catch { throw new ImportError('This file could not be opened because it looks damaged.'); }
}

function zipFile(zip, path) {
  return zip.file(path) || zip.file(decodeURIComponent(path))
    || zip.file(Object.keys(zip.files).find(k => k.toLowerCase() === path.toLowerCase()) || '\0');
}

const resolvePath = (base, rel) => {
  const path = new URL(rel, `http://book/${base}`).pathname.slice(1);
  try { return decodeURIComponent(path); } catch { return path; }
};

async function epubToBook(buffer, fallback) {
  const zip = await loadZip(buffer);
  const encryption = zip.file('META-INF/encryption.xml');
  if (encryption) {
    const xml = new DOMParser().parseFromString(await encryption.async('string'), 'application/xml');
    const algorithms = [...xml.getElementsByTagNameNS('*', 'EncryptionMethod')].map(e => e.getAttribute('Algorithm') || '');
    if (algorithms.some(a => !/idpf\.org\/2008\/embedding|ns\.adobe\.com\/pdf\/enc/.test(a))) {
      throw new ImportError('This EPUB is protected by DRM, so its text cannot be read. Use a DRM-free copy.');
    }
  }
  const container = zip.file('META-INF/container.xml');
  if (!container) throw new ImportError('This EPUB is missing its table of files, so it cannot be opened.');
  const containerDoc = new DOMParser().parseFromString(await container.async('string'), 'application/xml');
  const opfPath = containerDoc.getElementsByTagNameNS('*', 'rootfile')[0]?.getAttribute('full-path');
  if (!opfPath || !zipFile(zip, opfPath)) throw new ImportError('This EPUB is missing its book description, so it cannot be opened.');
  const opf = new DOMParser().parseFromString(await zipFile(zip, opfPath).async('string'), 'application/xml');
  if ([...opf.getElementsByTagNameNS('*', 'meta')].some(m => m.getAttribute('property') === 'rendition:layout' && m.textContent.trim() === 'pre-paginated')) {
    throw new ImportError('This is a fixed-layout EPUB. Use a reflowable EPUB or a text PDF for RSVP reading.');
  }

  const manifest = new Map();
  let navHref = null;
  for (const item of opf.getElementsByTagNameNS('*', 'item')) {
    const href = resolvePath(opfPath, item.getAttribute('href'));
    manifest.set(item.getAttribute('id'), { href, type: item.getAttribute('media-type') || '' });
    if (/\bnav\b/.test(item.getAttribute('properties') || '')) navHref = href;
  }
  const spineEl = opf.getElementsByTagNameNS('*', 'spine')[0];
  const ncxHref = manifest.get(spineEl?.getAttribute('toc'))?.href
    || [...manifest.values()].find(m => m.type.includes('dtbncx'))?.href;
  const spine = [...opf.getElementsByTagNameNS('*', 'itemref')]
    .map(r => ({ ...manifest.get(r.getAttribute('idref')), auxiliary: r.getAttribute('linear') === 'no' })).filter(e => e.href);

  const blocks = [];
  const fileStart = new Map();
  const anchors = new Map();
  for (const entry of spine) {
    const file = zipFile(zip, entry.href);
    if (!file) continue;
    if (entry.href === navHref) continue;
    fileStart.set(entry.href, blocks.length);
    const local = new Map();
    const doc = parseMarkup(await file.async('string'), true);
    appendDocument(doc, blocks, local, { document: entry.href,
      location: doc.querySelector('title')?.textContent?.trim() || `Section ${fileStart.size}`,
      roles: entry.auxiliary || /(?:^|\/)(?:cover|titlepage|copyright)(?:\.|\/)/i.test(entry.href) ? ['frontmatter'] : [] });
    local.forEach((block, id) => anchors.set(`${entry.href}#${id}`, block));
  }

  const toc = [];
  const addEntry = (href, title, depth, base) => {
    const clean = normalizeText(title);
    if (!href || !clean) return;
    const [path, frag] = href.split('#');
    const target = resolvePath(base, path || base.split('/').pop());
    const block = frag !== undefined && anchors.has(`${target}#${frag}`)
      ? anchors.get(`${target}#${frag}`)
      : (frag !== undefined && anchors.has(`${target}#${decodeURIComponent(frag)}`)
        ? anchors.get(`${target}#${decodeURIComponent(frag)}`)
        : fileStart.get(target));
    if (block !== undefined && block < blocks.length) toc.push({ title: clean.slice(0, 120), block, depth });
  };
  if (navHref && zipFile(zip, navHref)) {
    const nav = parseMarkup(await zipFile(zip, navHref).async('string'), true);
    const navs = [...nav.getElementsByTagName('nav')];
    const main = navs.find(n => /\btoc\b/.test(epubType(n))) || navs[0];
    const walkList = (list, depth) => {
      for (const li of list.children) {
        if (tagOf(li) !== 'li') continue;
        const link = [...li.children].find(c => tagOf(c) === 'a');
        if (link) addEntry(link.getAttribute('href'), link.textContent, depth, navHref);
        const sub = [...li.children].find(c => tagOf(c) === 'ol' || tagOf(c) === 'ul');
        if (sub) walkList(sub, depth + 1);
      }
    };
    const list = main && [...main.children].find(c => tagOf(c) === 'ol' || tagOf(c) === 'ul');
    if (list) walkList(list, 0);
  }
  if (!toc.length && ncxHref && zipFile(zip, ncxHref)) {
    const ncx = new DOMParser().parseFromString(await zipFile(zip, ncxHref).async('string'), 'application/xml');
    const walkNav = (node, depth) => {
      for (const point of node.children) {
        if (tagOf(point) !== 'navpoint') continue;
        const label = [...point.children].find(c => tagOf(c) === 'navlabel')?.textContent || '';
        const src = [...point.children].find(c => tagOf(c) === 'content')?.getAttribute('src');
        addEntry(src, label, depth, ncxHref);
        walkNav(point, depth + 1);
      }
    };
    const map = ncx.getElementsByTagNameNS('*', 'navMap')[0];
    if (map) walkNav(map, 0);
  }
  toc.sort((a, b) => a.block - b.block);
  const seen = new Set();
  let chapters = toc.filter(c => { const key = `${c.block}|${c.title}`; if (seen.has(key)) return false; seen.add(key); return true; });
  if (!chapters.length) chapters = chaptersFromHeadings(blocks);

  const meta = name => opf.getElementsByTagNameNS('*', name)[0]?.textContent?.trim() || '';
  const firstChapter = chapters.find(c => blocks[c.block]?.section === 'chapter' || /^chapter\s+/i.test(c.title)) || chapters[0];
  let advertising = false;
  blocks.forEach((b, i) => {
    if (i < (firstChapter?.block || 0) && !/^(preface|introduction|epigraph|part|volume|book)$/.test(b.section)) b.roles = [...new Set([...b.roles, 'frontmatter'])];
    if (b.k === 'h' && /books you like to read|^advertisements$/i.test(b.t)) advertising = true;
    if (advertising && !b.roles.includes('note')) b.roles = [...new Set([...b.roles, 'backmatter'])];
    if (/^\*\*\*\s*(?:START|END) OF (?:THE|THIS) PROJECT GUTENBERG EBOOK/i.test(b.t)) b.roles = [...new Set([...b.roles, 'boilerplate'])];
    b.sid = `epub:${i}`; b.order = i;
  });
  return cleanBook({ title: meta('title') || fallback, author: meta('creator'), format: 'epub', blocks, chapters }, defaultBookOptions());
}

async function docxToBook(buffer, fallback) {
  const zip = await loadZip(buffer);
  const main = zip.file('word/document.xml');
  if (!main) throw new ImportError('This DOCX is missing its main text, so it cannot be opened.');
  const doc = new DOMParser().parseFromString(await main.async('string'), 'application/xml');
  const blocks = [];
  for (const p of doc.getElementsByTagNameNS('*', 'p')) {
    let text = '';
    const walk = node => {
      for (const child of node.children) {
        const tag = tagOf(child);
        if (tag === 't') text += child.textContent;
        else if (tag === 'tab' || tag === 'br' || tag === 'cr') text += ' ';
        else if (tag === 'nobreakhyphen') text += '-';
        else if (tag !== 'ppr' && tag !== 'rpr' && tag !== 'instrtext' && tag !== 'del' && tag !== 'drawing' && tag !== 'pict' && tag !== 'txbxcontent') walk(child);
      }
    };
    walk(p);
    const t = normalizeText(text);
    if (!t) continue;
    const style = [...p.getElementsByTagNameNS('*', 'pStyle')][0];
    const value = style ? (style.getAttributeNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'val') || style.getAttribute('w:val') || '') : '';
    const heading = /^(heading|title)/i.test(value);
    blocks.push({ k: heading ? 'h' : /quote/i.test(value) ? 'q' : 'p', t });
  }
  let title = fallback;
  let author = '';
  const core = zip.file('docProps/core.xml');
  if (core) {
    const coreDoc = new DOMParser().parseFromString(await core.async('string'), 'application/xml');
    title = coreDoc.getElementsByTagNameNS('*', 'title')[0]?.textContent?.trim() || title;
    author = coreDoc.getElementsByTagNameNS('*', 'creator')[0]?.textContent?.trim() || '';
  }
  return { title, author, format: 'docx', blocks, chapters: chaptersFromHeadings(blocks) };
}

export function palmDecompress(data) {
  const out = [];
  let i = 0;
  while (i < data.length) {
    const c = data[i++];
    if (c >= 1 && c <= 8) { for (let k = 0; k < c && i < data.length; k++) out.push(data[i++]); }
    else if (c < 0x80) out.push(c);
    else if (c >= 0xC0) out.push(0x20, c ^ 0x80);
    else {
      const pair = (c << 8) | data[i++];
      const distance = (pair >> 3) & 0x7FF;
      const length = (pair & 7) + 3;
      for (let k = 0; k < length; k++) out.push(out[out.length - distance]);
    }
  }
  return out;
}

function trailingSize(record, flags) {
  let size = 0;
  for (let bit = 15; bit >= 1; bit--) {
    if (!(flags & (1 << bit))) continue;
    let value = 0;
    let shift = 0;
    let pos = record.length - size - 1;
    for (let n = 0; n < 4 && pos >= 0; n++, pos--) {
      const b = record[pos];
      value |= (b & 0x7F) << shift;
      shift += 7;
      if (b & 0x80) break;
    }
    size += value;
  }
  if (flags & 1) size += (record[record.length - size - 1] & 3) + 1;
  return size;
}

function mobiToBook(buffer, fallback) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  if (buffer.byteLength < 100) throw new ImportError('This MOBI file looks damaged.');
  const signature = String.fromCharCode(...bytes.slice(60, 68));
  if (signature !== 'BOOKMOBI' && signature !== 'TEXtREAd') throw new ImportError('This does not look like a MOBI book.');
  const count = view.getUint16(76);
  const offsets = [];
  for (let n = 0; n < count; n++) offsets.push(view.getUint32(78 + n * 8));
  offsets.push(buffer.byteLength);
  const r0 = offsets[0];
  const compression = view.getUint16(r0);
  const recordCount = view.getUint16(r0 + 8);
  const encryption = view.getUint16(r0 + 12);
  if (encryption !== 0) throw new ImportError('This book is protected by DRM, so its text cannot be read. Use a DRM-free copy.');
  if (compression !== 1 && compression !== 2) throw new ImportError('This MOBI uses a compression format the app cannot read. Convert it to EPUB and try again.');
  let encoding = 1252;
  let extraFlags = 0;
  let title = fallback;
  let author = '';
  if (signature === 'BOOKMOBI' && String.fromCharCode(...bytes.slice(r0 + 16, r0 + 20)) === 'MOBI') {
    const headerLength = view.getUint32(r0 + 20);
    encoding = view.getUint32(r0 + 28);
    const nameOffset = view.getUint32(r0 + 84);
    const nameLength = view.getUint32(r0 + 88);
    const decode = b => new TextDecoder(encoding === 65001 ? 'utf-8' : 'windows-1252').decode(b);
    title = decode(bytes.slice(r0 + nameOffset, r0 + nameOffset + nameLength)) || title;
    if (headerLength >= 228) extraFlags = view.getUint16(r0 + 242);
    if (view.getUint32(r0 + 128) & 0x40) {
      const ex = r0 + 16 + headerLength;
      if (String.fromCharCode(...bytes.slice(ex, ex + 4)) === 'EXTH') {
        const n = view.getUint32(ex + 8);
        let p = ex + 12;
        for (let k = 0; k < n; k++) {
          const type = view.getUint32(p);
          const len = view.getUint32(p + 4);
          if (type === 100) author = decode(bytes.slice(p + 8, p + len));
          if (type === 503) title = decode(bytes.slice(p + 8, p + len)) || title;
          p += len;
        }
      }
    }
  }
  const chunks = [];
  for (let n = 1; n <= recordCount && n < offsets.length - 1; n++) {
    let record = bytes.subarray(offsets[n], offsets[n + 1]);
    if (extraFlags) record = record.subarray(0, Math.max(0, record.length - trailingSize(record, extraFlags)));
    chunks.push(compression === 2 ? Uint8Array.from(palmDecompress(record)) : record);
  }
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const merged = new Uint8Array(total);
  let at = 0;
  chunks.forEach(c => { merged.set(c, at); at += c.length; });
  const text = new TextDecoder(encoding === 65001 ? 'utf-8' : 'windows-1252').decode(merged);
  const markup = /<(html|body|p|div)\b/i.test(text);
  const book = markup ? markupToBook(text, title, 'mobi') : textToBook(text, title, 'mobi');
  return { ...book, title, author, format: 'mobi' };
}

async function extractPdf(buffer, fallback, onProgress) {
  const pdfjs = await import('../vendor/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
  let pdf;
  let task;
  try {
    task = pdfjs.getDocument({
      data: new Uint8Array(buffer), isEvalSupported: false, disableFontFace: true, useSystemFonts: false,
      standardFontDataUrl: new URL('../vendor/standard_fonts/', import.meta.url).href,
      cMapUrl: new URL('../vendor/cmaps/', import.meta.url).href, cMapPacked: true,
    });
    pdf = await task.promise;
  } catch (error) {
    if (error?.name === 'PasswordException') throw new ImportError('This PDF is password protected. Remove the password and import it again.');
    throw new ImportError('This PDF could not be opened because it looks damaged.');
  }
  const pages = [];
  let characters = 0;
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    const lines = [];
    let current = null;
    for (const item of content.items) {
      if (item.str === undefined) continue;
      const x = item.transform[4];
      const y = item.transform[5];
      const h = Math.abs(item.height) || Math.hypot(item.transform[2], item.transform[3]);
      if (current && Math.abs(current.y - y) <= Math.max(Math.min(current.h, h), 1) * 0.55) {
        const gap = x - current.endX;
        const needsSpace = gap > Math.max(h, 1) * 0.12 && !/\s$/.test(current.text) && !/^\s/.test(item.str);
        current.text += (needsSpace ? ' ' : '') + item.str;
        current.endX = x + item.width;
        current.h = Math.max(current.h, h);
        current.sizes.push([h, item.str.length]);
      } else if (item.str.trim()) {
        current = { text: item.str, x, y, h, endX: x + item.width, sizes: [[h, item.str.length]] };
        lines.push(current);
      }
    }
    lines.forEach(l => {
      // A single large initial must not set the height of a whole prose line.
      const sizes = l.sizes.sort((a, b) => a[0] - b[0]);
      let weight = sizes.reduce((sum, s) => sum + s[1], 0) / 2;
      for (const [size, count] of sizes) { weight -= count; if (weight <= 0) { l.h = size; break; } }
      l.text = l.text.replace(/\s+/g, ' ').trim(); characters += l.text.length;
    });
    const viewport = page.getViewport({ scale: 1 });
    pages.push({ n, height: viewport.height, width: viewport.width,
      lines: lines.filter(l => l.text).map(({ text, x, y, h, endX }) => ({ text, x, y, h, endX })) });
    page.cleanup();
    onProgress?.(`Reading page ${n} of ${pdf.numPages}`);
  }
  if (characters / Math.max(pdf.numPages, 1) < 25) {
    throw new ImportError('This PDF looks scanned, so it has no text to read. Scanned PDFs are not supported yet.');
  }
  let outline = [];
  try {
    const flatten = async (items, depth) => {
      for (const item of items || []) {
        let dest = item.dest;
        if (typeof dest === 'string') dest = await pdf.getDestination(dest);
        let page = null;
        if (Array.isArray(dest) && dest[0] != null) {
          page = typeof dest[0] === 'object' ? (await pdf.getPageIndex(dest[0])) + 1 : dest[0] + 1;
        }
        if (page) outline.push({ title: normalizeText(item.title), page, depth });
        await flatten(item.items, depth + 1);
      }
    };
    await flatten(await pdf.getOutline(), 0);
  } catch { outline = []; }
  let title = fallback;
  let author = '';
  try {
    const meta = await pdf.getMetadata();
    const infoTitle = meta.info?.Title?.trim();
    if (infoTitle && !/^(untitled|microsoft word|document\d*)/i.test(infoTitle) && !/\.(docx?|indd|pdf|tex)$/i.test(infoTitle)) title = infoTitle;
    author = meta.info?.Author?.trim() || '';
  } catch {}
  await task.destroy();
  return { title, author, outline, pages: pages.length, analysis: analyzePages(pages) };
}

// Builds the final PDF book from the choices made on the review screen.
export function finishPdf(extracted, options) {
  const { blocks, pageBlock, headingBlocks } = buildBlocks(extracted.analysis, {
    ...options, headers: false, numbers: false, footnotes: false, skip: new Set(),
  });
  blocks.forEach((b, i) => {
    b.sid = `pdf:${i}`; b.order = i;
    if (options.skip.has(b.page)) b.roles.push('page');
    let priorIndex = i - 1;
    while (priorIndex >= 0 && blocks[priorIndex].roles.some(r => r !== 'page')) priorIndex--;
    const prior = blocks[priorIndex];
    if (options.hyphens && b.continues && prior && !options.skip.has(b.page) && !options.skip.has(prior.page)
      && /\p{L}-$/u.test(prior.t) && /^\p{Ll}/u.test(b.t)) {
      const word = b.t.match(/^\S+/)[0];
      prior.t = prior.t.slice(0, -1) + word;
      b.t = b.t.slice(word.length).trim();
    }
  });
  const contentsPages = new Set();
  let lastContents = -10;
  extracted.analysis.pages.filter(p => p.n <= 12).forEach(p => {
    const heading = p.lines.some(l => /^contents$/i.test(l.text.replace(/\s/g, '')));
    const entries = p.lines.filter(l => /^\d+\s+[A-Z]|^step\s+[ivxlcdm]+:/i.test(l.text)).length;
    if (heading || p.n === lastContents + 1 && entries >= 4) { contentsPages.add(p.n); lastContents = p.n; }
  });
  blocks.forEach(b => { if (contentsPages.has(b.page)) b.roles.push('frontmatter'); });
  const titleKey = t => normalizeText(t.replace(/\0/g, '')).toLowerCase()
    .replace(/^(?:chapter\s+)?\d+\s*[:.]\s*/i, '').replace(/[^\p{L}\p{N}]/gu, '');
  let chapters;
  if (extracted.outline.length) {
    const seen = new Set();
    chapters = extracted.outline.flatMap(entry => {
      const title = entry.title.replace(/\0/g, '').trim();
      const keys = [titleKey(title), titleKey(title.split(':')[0])].filter(k => k.length > 5);
      const matches = blocks.map((b, i) => ({ b, i })).filter(({ b }) => b.k === 'h' && keys.includes(titleKey(b.t)));
      const nearby = matches.filter(({ b }) => Math.abs(b.page - entry.page) <= 8)
        .sort((a, b) => Math.abs(a.b.page - entry.page) - Math.abs(b.b.page - entry.page));
      let block = nearby[0]?.i ?? (matches.length === 1 ? matches[0].i : undefined);
      if (block === undefined) {
        const first = pageBlock.get(entry.page);
        if (first !== undefined) {
          block = blocks.findIndex((b, i) => i >= first && b.page === entry.page && !b.roles.length);
          if (block < 0) block = undefined;
        }
      }
      const key = `${block}|${entry.title}`;
      if (block === undefined || seen.has(key) || !entry.title) return [];
      seen.add(key);
      return [{ title: title.slice(0, 120), block, depth: entry.depth,
        major: blocks[block].section === 'chapter' || /^(?:chapter|part|book)\b|^\d+\s*:/i.test(title) || entry.depth === 0 }];
    });
  } else {
    const contentsTitles = new Set(extracted.analysis.pages.filter(p => contentsPages.has(p.n))
      .flatMap(p => p.lines.filter(l => /^\d+\s+[A-Z]/.test(l.text)).map(l => titleKey(l.text.replace(/^\d+\s+/, '').split(':')[0]))));
    chapters = headingBlocks.map(block => ({ title: blocks[block].t.slice(0, 120), block, depth: 0,
      major: blocks[block].section === 'chapter' || contentsTitles.has(titleKey(blocks[block].t)) }));
  }
  chapters.sort((a, b) => a.block - b.block);
  return cleanBook({ title: extracted.title, author: extracted.author, format: 'pdf', blocks, chapters }, {
    ...defaultBookOptions(), header: !options.headers, number: !options.numbers, note: !options.footnotes,
  });
}

// Returns a book, or {review: extracted} when a PDF needs the review screen.
export async function importFile(file, onProgress) {
  const name = file.name || 'Untitled';
  const title = baseTitle(name);
  const ext = extension(name);
  const buffer = await file.arrayBuffer();
  if (!buffer.byteLength) throw new ImportError('This file is empty.');
  const head = new Uint8Array(buffer.slice(0, 5));
  const isPdf = String.fromCharCode(...head) === '%PDF-';
  const isZip = head[0] === 0x50 && head[1] === 0x4B;
  if (ext === 'pdf' || isPdf) return { review: await extractPdf(buffer, title, onProgress) };
  if (['mobi', 'prc', 'azw', 'azw3', 'pdb'].includes(ext)) return mobiToBook(buffer, title);
  if (ext === 'doc' && !isZip) throw new ImportError('Older .doc files are not supported. Save it as .docx and import it again.');
  if (ext === 'docx') return docxToBook(buffer, title);
  if (ext === 'epub' || (isZip && ext !== 'docx')) {
    if (!isZip) throw new ImportError('This EPUB could not be opened because it looks damaged.');
    const zip = await loadZip(buffer);
    if (zip.file('word/document.xml')) return docxToBook(buffer, title);
    if (zip.file('META-INF/container.xml')) return epubToBook(buffer, title);
    throw new ImportError('This ZIP file does not contain a book. Import an EPUB, PDF, or text document.');
  }
  const text = decodeText(buffer);
  if (ext === 'rtf' || text.startsWith('{\\rtf')) return textToBook(rtfToText(text), title, 'rtf');
  if (ext === 'fb2') return fb2ToBook(text, title);
  if (ext === 'md' || ext === 'markdown' || ext === 'mdown') return markdownToBook(text, title);
  if (['html', 'htm', 'xhtml', 'xml'].includes(ext)) return markupToBook(text, title, 'html', ext !== 'html' && ext !== 'htm');
  if (/\u0000/.test(text.slice(0, 4000))) throw new ImportError(`.${ext || 'This'} files are not supported. Try EPUB, PDF, DOCX, or plain text.`);
  return textToBook(text, title, ext || 'txt');
}
