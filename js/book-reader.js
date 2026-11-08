// Reflowable pages and continuous scrolling over the same word IDs as RSVP/audio.
import { FollowScroll } from './follow-scroll.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

export class BookReader {
  constructor(root, data, callbacks = {}) {
    this.root = root; this.data = data; this.callbacks = callbacks;
    this.follower = new FollowScroll();
    this.layout = data.book.bookLayout || 'pages'; this.pos = data.pos;
    this.sections = []; this.page = 0; this.pageCount = 1; this.suppressUntil = 0;
    const chapters = new Map(data.book.chapters.map(c => [c.block, c.title]));
    let first = 0;
    for (let b = 1; b <= data.blocks.length; b++) {
      if (b === data.blocks.length || chapters.has(b) || data.blockStart[b] - data.blockStart[first] > 6000) {
        this.sections.push({ first, last: b - 1, start: data.blockStart[first], end: data.blockStart[b] ?? data.words.length,
          title: chapters.get(first) || data.book.title });
        first = b;
      }
    }
    root.innerHTML = '<div class="book-viewport" tabindex="0" aria-label="Book text"><div class="book-text"></div></div><div class="book-folio"><span class="book-section-title"></span><span class="book-page-count"></span></div>';
    this.viewport = root.querySelector('.book-viewport'); this.text = root.querySelector('.book-text');
    root.dataset.layout = this.layout;
    this.onScroll = () => this.scrolled();
    this.viewport.addEventListener('scroll', this.onScroll, { passive: true });
    this.bindGestures();
    this.resize = new ResizeObserver(() => {
      clearTimeout(this.resizeTimer); this.resizeTimer = setTimeout(() => this.reflow(this.pos), 80);
    });
    this.resize.observe(this.viewport);
    this.showWord(this.pos, true);
    document.fonts.ready.then(() => { if (this.root.isConnected) this.reflow(this.pos); });
  }
  sectionFor(pos) {
    let low = 0, high = this.sections.length;
    while (low < high) { const mid = (low + high) >>> 1; if (this.sections[mid].start <= pos) low = mid + 1; else high = mid; }
    return Math.max(0, low - 1);
  }
  sectionHTML(index) {
    const section = this.sections[index], output = [];
    for (let b = section.first; b <= section.last; b++) {
      const block = this.data.blocks[b];
      let inner = '';
      for (let i = this.data.blockStart[b]; i < (this.data.blockStart[b + 1] ?? this.data.words.length); i++) {
        inner += `<span class="bw" data-i="${i}">${esc(this.data.words[i])}</span>${this.data.glue[i] ? '' : ' '}`;
      }
      const tag = block.k === 'h' ? 'h2' : block.k === 'q' ? 'blockquote' : 'p';
      output.push(`<${tag}>${inner}</${tag}>`);
    }
    return `<section class="book-section" data-section="${index}">${output.join('')}</section>`;
  }
  load(section) {
    this.section = section;
    this.first = this.layout === 'scroll' ? Math.max(0, section - 1) : section;
    this.last = this.layout === 'scroll' ? Math.min(this.sections.length - 1, section + 1) : section;
    this.text.innerHTML = Array.from({ length: this.last - this.first + 1 }, (_, i) => this.sectionHTML(this.first + i)).join('');
    this.refreshWords();
  }
  refreshWords() { this.wordNodes = [...this.text.querySelectorAll('.bw')]; }
  wordEl(pos) { return this.text.querySelector(`[data-i="${pos}"]`); }
  reflow(pos = this.pos) {
    if (!this.root.isConnected || !this.viewport.clientWidth || !this.sections.length) return;
    this.suppressUntil = performance.now() + 250;
    this.width = this.viewport.clientWidth;
    this.gap = 32;
    if (this.layout === 'pages') {
      Object.assign(this.text.style, { width: `${this.width}px`, height: `${this.viewport.clientHeight}px`, columnWidth: `${this.width}px`, columnGap: `${this.gap}px`, columnFill: 'auto' });
      this.step = this.width + this.gap;
      this.pageCount = Math.max(1, Math.ceil((this.text.scrollWidth + this.gap - 1) / this.step));
      this.alignPage(pos);
      this.viewport.scrollTop = 0;
      // WebKit can return the previous column's word rect until a paint after
      // font changes. Verify the anchor again once fragmentation has settled.
      cancelAnimationFrame(this.settleFrame);
      this.settleFrame = requestAnimationFrame(() => {
        this.settleFrame = requestAnimationFrame(() => {
          if (this.root.isConnected && this.layout === 'pages' && this.pos === pos) {
            this.alignPage(pos); this.folio();
          }
        });
      });
    } else {
      Object.assign(this.text.style, { width: '', height: '', columnWidth: '', columnGap: '', columnFill: '' });
      this.viewport.scrollLeft = 0;
    }
    this.setCurrent(pos, this.following);
    this.folio();
  }
  alignPage(pos) {
    const word = this.wordEl(pos);
    if (word) {
      const rect = word.getClientRects()[0] || word.getBoundingClientRect();
      this.page = clamp(Math.floor((rect.left - this.viewport.getBoundingClientRect().left + this.viewport.scrollLeft + 1) / this.step), 0, this.pageCount - 1);
    }
    this.viewport.scrollLeft = this.page * this.step;
  }
  showWord(pos, initial = false) {
    this.follower.cancel();
    this.pos = clamp(pos, 0, Math.max(0, this.data.words.length - 1));
    const section = this.sectionFor(this.pos);
    const load = this.section === undefined || (this.layout === 'pages' ? section !== this.section : section < this.first || section > this.last);
    if (load) this.load(section);
    this.suppressUntil = performance.now() + 250;
    if (this.layout === 'pages') this.reflow(this.pos);
    else {
      this.reflow(this.pos);
      const word = this.wordEl(this.pos);
      if (word) {
        const frame = this.viewport.getBoundingClientRect(), rect = word.getBoundingClientRect();
        if (initial || rect.top < frame.top + 20 || rect.bottom > frame.bottom - 30) this.viewport.scrollTop += rect.top - frame.top - frame.height * .2;
      }
    }
    this.setCurrent(this.pos, this.following);
    this.folio();
  }
  followWord(pos) {
    if (this.browsing) { this.setCurrent(pos, true); return; }
    this.pos = clamp(pos, 0, Math.max(0, this.data.words.length - 1));
    const section = this.sectionFor(this.pos);
    if (this.section === undefined || (this.layout === 'pages' ? section !== this.section : section < this.first || section > this.last)) {
      this.showWord(this.pos, true); return;
    }
    this.suppressUntil = performance.now() + 1200;
    if (this.layout === 'pages') {
      const previous = this.page;
      this.alignPage(this.pos);
      if (previous !== this.page && this.data.animate !== false && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
        this.text.animate([{ opacity: .35 }, { opacity: 1 }], { duration: 220 });
      }
    } else this.follower.follow(this.viewport, this.wordEl(this.pos));
    this.setCurrent(this.pos, true); this.folio();
  }
  setCurrent(pos, following = false) {
    this.following = following;
    this.text.querySelector('.bw.current')?.classList.remove('current');
    if (following) this.wordEl(pos)?.classList.add('current');
  }
  browse() {
    if (!this.callbacks.isListening?.()) return;
    this.follower.cancel(); this.suppressUntil = 0;
    if (!this.browsing) { this.browsing = true; this.callbacks.onBrowse?.(true); }
  }
  returnTo(pos) {
    clearTimeout(this.scrollTimer);
    this.browsing = false; this.callbacks.onBrowse?.(false);
    this.showWord(pos, true);
  }
  firstVisible() {
    const frame = this.viewport.getBoundingClientRect();
    let low = 0, high = this.wordNodes.length;
    while (low < high) {
      const mid = (low + high) >>> 1, rect = this.wordNodes[mid].getBoundingClientRect();
      const before = this.layout === 'pages' ? rect.right <= frame.left + 1 : rect.bottom < frame.top + 2;
      if (before) low = mid + 1; else high = mid;
    }
    return Number(this.wordNodes[Math.min(low, this.wordNodes.length - 1)]?.dataset.i || 0);
  }
  turn(direction) {
    this.browse();
    if (this.layout === 'scroll') {
      this.viewport.scrollBy({ top: direction * this.viewport.clientHeight * .85, behavior: 'smooth' }); return;
    }
    let page = this.page + direction;
    if (page < 0 || page >= this.pageCount) {
      const next = this.section + direction;
      if (next < 0 || next >= this.sections.length) return;
      this.load(next); this.reflow(this.sections[next].start);
      page = direction > 0 ? 0 : this.pageCount - 1;
    }
    this.suppressUntil = performance.now() + 300;
    this.page = page; this.viewport.scrollLeft = page * this.step;
    this.pos = this.firstVisible();
    if (this.data.animate !== false && !matchMedia('(prefers-reduced-motion: reduce)').matches) this.text.animate([{ opacity: .5, transform: `translateX(${direction * 12}px)` }, { opacity: 1, transform: 'none' }], { duration: 160 });
    this.manualPosition = true; this.callbacks.onPosition?.(this.pos); this.manualPosition = false;
    this.folio();
  }
  scrolled() {
    if (this.layout !== 'scroll' || this.follower.active || performance.now() < this.suppressUntil) return;
    this.browse();
    const viewport = this.viewport;
    if (viewport.scrollTop + viewport.clientHeight > viewport.scrollHeight - 600 && this.last < this.sections.length - 1) {
      this.text.insertAdjacentHTML('beforeend', this.sectionHTML(++this.last));
      if (this.last - this.first > 2) {
        const oldHeight = viewport.scrollHeight;
        this.text.firstElementChild.remove(); this.first++;
        viewport.scrollTop -= oldHeight - viewport.scrollHeight;
      }
      this.refreshWords();
    } else if (viewport.scrollTop < 500 && this.first > 0) {
      const oldHeight = viewport.scrollHeight;
      this.text.insertAdjacentHTML('afterbegin', this.sectionHTML(--this.first));
      viewport.scrollTop += viewport.scrollHeight - oldHeight;
      if (this.last - this.first > 2) { this.text.lastElementChild.remove(); this.last--; }
      this.refreshWords();
    }
    clearTimeout(this.scrollTimer);
    this.scrollTimer = setTimeout(() => {
      if (!this.root.isConnected || performance.now() < this.suppressUntil) return;
      this.pos = this.firstVisible(); this.section = this.sectionFor(this.pos);
      this.manualPosition = true; this.callbacks.onPosition?.(this.pos); this.manualPosition = false; this.folio();
    }, 140);
  }
  folio() {
    const section = this.sections[this.sectionFor(this.pos)];
    this.root.querySelector('.book-section-title').textContent = section?.title || '';
    const label = this.layout === 'pages' ? `Page ${this.page + 1} of ${this.pageCount} in section` : `${Math.round(this.pos / Math.max(1, this.data.words.length - 1) * 100)}%`;
    this.root.querySelector('.book-page-count').textContent = label;
    this.callbacks.onPage?.({ label, page: this.page, count: this.pageCount, layout: this.layout });
  }
  bindGestures() {
    let gesture;
    this.viewport.addEventListener('wheel', () => this.browse(), { passive: true });
    this.viewport.addEventListener('pointerdown', event => {
      this.follower.cancel(); this.suppressUntil = 0;
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      gesture = { id: event.pointerId, x: event.clientX, y: event.clientY };
      const word = event.target.closest('.bw');
      if (word) gesture.timer = this.gestureTimer = setTimeout(() => {
        if (!gesture) return;
        gesture.menu = true; this.callbacks.onWordMenu?.(Number(word.dataset.i));
      }, 480);
    });
    this.viewport.addEventListener('pointermove', event => {
      if (!gesture || event.pointerId !== gesture.id) return;
      if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 10) { clearTimeout(gesture.timer); this.browse(); }
    });
    const finish = event => {
      if (!gesture || event.pointerId !== gesture.id) return;
      const current = gesture; gesture = null; clearTimeout(current.timer);
      if (current.menu || event.type === 'pointercancel') return;
      const dx = event.clientX - current.x, dy = event.clientY - current.y;
      if (this.layout === 'pages' && Math.abs(dx) > 35 && Math.abs(dx) > Math.abs(dy) * 1.2) { this.turn(dx < 0 ? 1 : -1); return; }
      if (Math.hypot(dx, dy) > 12) return;
      const frame = this.viewport.getBoundingClientRect(), x = (event.clientX - frame.left) / frame.width;
      if (this.layout === 'pages' && x < .22) this.turn(-1);
      else if (this.layout === 'pages' && x > .68) this.turn(1);
      else this.callbacks.onToggleChrome?.();
    };
    this.viewport.addEventListener('pointerup', finish);
    this.viewport.addEventListener('pointercancel', finish);
  }
  destroy() { this.follower.cancel(); this.resize.disconnect(); cancelAnimationFrame(this.settleFrame); clearTimeout(this.resizeTimer); clearTimeout(this.scrollTimer); clearTimeout(this.gestureTimer); }
}
