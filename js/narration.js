// Versioned interchange shared with tools/audiobook. Timings refer to the saved audio timeline.
import { tokenize } from './engine.js';

export const TOKENIZER = 'stillpoint-v1';
export const canonicalText = blocks => JSON.stringify(blocks.map(b => [b.sid, b.tokens.map(t => [t.w, t.g])]));
export async function textHash(blocks) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalText(blocks)));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function createNarrationJob(book, content) {
  const blocks = content.blocks.map((b, i) => ({ sid: b.sid || `legacy:${i}`, text: b.t, tokens: tokenize(b.t) }))
    .filter(b => b.tokens.length);
  if (!blocks.length) throw new Error('This book has no words to narrate.');
  if (new Set(blocks.map(b => b.sid)).size !== blocks.length) throw new Error('This book has duplicate passage identities. Reimport it before exporting narration.');
  return { format: 'stillpoint-narration-job', version: 1, tokenizer: TOKENIZER,
    book: { id: book.id, title: book.title, author: book.author || '' },
    textHash: await textHash(blocks), blocks,
    chapters: (book.chapters || []).map(c => ({ title: c.title, sid: content.blocks[c.block]?.sid || `legacy:${c.block}` })),
  };
}

const fail = message => { throw new Error(message); };
export function validateManifest(manifest, job) {
  if (manifest?.format !== 'stillpoint-audiobook' || manifest.version !== 1 || manifest.tokenizer !== TOKENIZER) fail('This audiobook format is not supported.');
  if (manifest.textHash !== job.textHash) fail('The audiobook does not match this reading text. Export a new narration job after reviewing the text.');
  if (!Array.isArray(manifest.clips) || !manifest.clips.length) fail('This audiobook has no audio clips.');
  const expected = job.blocks.flatMap(b => b.tokens.map((_, offset) => ({ sid: b.sid, offset })));
  const files = new Set();
  let cursor = 0;
  for (const clip of manifest.clips) {
    if (!/^audio\/clip-\d+\.(wav|m4a|mp3|flac)$/.test(clip.file) || files.has(clip.file)) fail('This audiobook has an invalid audio filename.');
    files.add(clip.file);
    if (!Number.isFinite(clip.durationMs) || clip.durationMs <= 0 || !Array.isArray(clip.words) || !clip.words.length) fail('This audiobook has invalid audio timing data.');
    let previous = -1;
    for (const word of clip.words) {
      const target = expected[cursor++];
      if (!target || word.sid !== target.sid || word.offset !== target.offset) fail('The audiobook word sequence does not match this book.');
      if (!Number.isFinite(word.startMs) || !Number.isFinite(word.endMs) || word.startMs < 0 || word.startMs < previous
        || word.endMs <= word.startMs || word.endMs > clip.durationMs + 1) fail('This audiobook has invalid word timestamps.');
      previous = word.startMs;
    }
  }
  if (cursor !== expected.length) fail('This audiobook is missing words.');
  return manifest;
}

export async function readNarrationPackage(file, job) {
  const zip = await window.JSZip.loadAsync(await file.arrayBuffer());
  const entry = zip.file('audiobook.json');
  if (!entry) fail('Choose an audiobook package generated from a Stillpoint narration job.');
  const manifest = validateManifest(JSON.parse(await entry.async('string')), job);
  const audio = [];
  for (const clip of manifest.clips) {
    const entry = zip.file(clip.file);
    if (!entry) fail(`This audiobook is missing ${clip.file}.`);
    const data = await entry.async('blob');
    if (!data.size) fail('This audiobook contains an empty audio clip.');
    audio.push({ file: clip.file, data });
  }
  return { manifest, audio };
}

let mediaOwner = null;
const MEDIA_ACTIONS = ['play', 'pause', 'stop', 'seekto', 'seekbackward', 'seekforward'];

// Native media playback continues independently of animation frames or JS timers.
export class NarrationPlayer {
  constructor(manifest, readAudio, callbacks = {}) {
    this.manifest = manifest;
    this.readAudio = readAudio;
    this.callbacks = callbacks;
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.audio.playsInline = true;
    this.rate = 1;
    this.clipIndex = -1;
    this.revision = 0;
    this.playing = false;
    this.words = [];
    manifest.clips.forEach((clip, clipIndex) => clip.words.forEach(word => this.words.push({ ...word, clipIndex })));
    this.starts = [];
    let count = 0;
    for (const clip of manifest.clips) { this.starts.push(count); count += clip.words.length; }
    this.audio.ontimeupdate = () => this.update();
    this.audio.onended = () => this.next();
    this.audio.onerror = () => this.error(new Error('The audio could not be played. Try importing the audiobook again.'));
    this.audio.onpause = () => {
      // Ignore our own pause/load operations and stale events after a new play.
      if (!this.playing || !this.audio.paused || this.audio.ended) return;
      this.update(true);
      this.pause();
      this.callbacks.onPause?.();
    };
    this.audio.onplaying = () => {
      this.playing = true;
      this.callbacks.onResume?.();
      this.updateMediaState('playing');
      this.frame();
    };
    this.audio.onloadedmetadata = () => this.updateMediaPosition();
  }
  error(error) { this.pause(); this.callbacks.onError?.(error); }
  update(force = false) {
    if (this.clipIndex < 0 || (!this.playing && !force)) return;
    const words = this.manifest.clips[this.clipIndex].words;
    const ms = this.audio.currentTime * 1000;
    let low = 0, high = words.length;
    while (low < high) { const mid = (low + high) >>> 1; if (words[mid].startMs <= ms) low = mid + 1; else high = mid; }
    const pos = this.starts[this.clipIndex] + Math.max(0, low - 1);
    if (pos !== this.pos) { this.pos = pos; this.callbacks.onWord?.(pos); }
    this.updateMediaPosition();
  }
  frame() {
    cancelAnimationFrame(this.raf);
    if (!this.playing || this.background) return;
    this.update();
    this.raf = requestAnimationFrame(() => this.frame());
  }
  async prepare(pos) {
    const word = this.words[pos];
    if (!word || this.clipIndex === word.clipIndex) return;
    const revision = ++this.revision;
    const data = await this.readAudio(this.manifest.clips[word.clipIndex].file);
    if (revision !== this.revision) return;
    if (!data) throw new Error('This audio clip is missing. Import the audiobook again.');
    URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(data);
    this.audio.src = this.url;
    this.clipIndex = word.clipIndex;
    this.audio.load();
  }
  async playAt(pos, { paused = false, resume = true } = {}) {
    const revision = ++this.revision;
    const samePosition = resume && pos === this.pos && this.clipIndex >= 0;
    const resumeTime = this.audio.currentTime;
    this.playing = false;
    this.audio.pause();
    cancelAnimationFrame(this.raf);
    const word = this.words[pos];
    if (!word) throw new Error('There is no narration at this position.');
    if (this.clipIndex !== word.clipIndex) {
      const clip = this.manifest.clips[word.clipIndex];
      const data = await this.readAudio(clip.file);
      if (revision !== this.revision) return false;
      if (!data) throw new Error('This audio clip is missing. Import the audiobook again.');
      URL.revokeObjectURL(this.url);
      this.url = URL.createObjectURL(data);
      this.audio.src = this.url;
      this.clipIndex = word.clipIndex;
    }
    this.audio.playbackRate = this.rate;
    this.audio.currentTime = samePosition ? resumeTime : word.startMs / 1000;
    this.pos = pos;
    this.callbacks.onWord?.(pos);
    this.updateMediaPosition();
    if (paused) { this.updateMediaState('paused'); return true; }
    await this.audio.play();
    if (revision !== this.revision) return false;
    this.playing = true;
    this.updateMediaState('playing');
    this.frame();
    return true;
  }
  async next() {
    if (!this.playing) return;
    const next = this.clipIndex + 1;
    if (next >= this.manifest.clips.length) { this.pause(); this.callbacks.onEnd?.(); return; }
    try { await this.playAt(this.starts[next]); } catch (error) { this.error(error); }
  }
  pause() { this.revision++; this.playing = false; this.audio.pause(); cancelAnimationFrame(this.raf); this.updateMediaState('paused'); }
  setRate(rate) { this.rate = rate; this.audio.playbackRate = rate; this.updateMediaPosition(); }
  setBackground(hidden) {
    this.background = hidden;
    if (hidden) cancelAnimationFrame(this.raf);
    else { this.update(true); this.frame(); }
  }
  claimMediaSession(book, actions) {
    // Safari exposes AudioSession on supporting versions. The fallback is ordinary HTML audio.
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
    if (!navigator.mediaSession) return;
    mediaOwner = this;
    const session = navigator.mediaSession;
    if (typeof MediaMetadata !== 'undefined') session.metadata = new MediaMetadata({ title: book.title, artist: book.author || '', album: 'Stillpoint' });
    const seek = seconds => {
      let offset = 0;
      let pos = this.words.length - 1;
      for (let c = 0; c < this.manifest.clips.length; c++) {
        const clip = this.manifest.clips[c];
        if (seconds * 1000 < offset + clip.durationMs) {
          let low = 0, high = clip.words.length;
          while (low < high) { const mid = (low + high) >>> 1; if (clip.words[mid].startMs <= seconds * 1000 - offset) low = mid + 1; else high = mid; }
          pos = this.starts[c] + Math.max(0, low - 1); break;
        }
        offset += clip.durationMs;
      }
      actions.seek(pos);
    };
    const handlers = {
      play: () => actions.play(), pause: () => actions.pause(), stop: () => actions.pause(),
      seekto: data => { if (Number.isFinite(data.seekTime)) seek(Math.max(0, data.seekTime)); },
      seekbackward: data => seek(Math.max(0, this.positionSeconds() - (data.seekOffset || 15))),
      seekforward: data => seek(this.positionSeconds() + (data.seekOffset || 15)),
    };
    for (const action of MEDIA_ACTIONS) { try { session.setActionHandler(action, handlers[action]); } catch {} }
    this.updateMediaState(this.playing ? 'playing' : 'paused');
  }
  positionSeconds() {
    if (this.clipIndex < 0) return 0;
    return this.manifest.clips.slice(0, this.clipIndex).reduce((n, c) => n + c.durationMs / 1000, 0) + this.audio.currentTime;
  }
  updateMediaState(state) {
    if (mediaOwner !== this) return;
    navigator.mediaSession.playbackState = state;
    this.updateMediaPosition();
  }
  updateMediaPosition() {
    if (mediaOwner !== this || !navigator.mediaSession?.setPositionState) return;
    const duration = this.manifest.clips.reduce((n, c) => n + c.durationMs / 1000, 0);
    try { navigator.mediaSession.setPositionState({ duration, playbackRate: this.rate, position: Math.min(duration, Math.max(0, this.positionSeconds())) }); } catch {}
  }
  releaseMediaSession() {
    if (mediaOwner !== this) return;
    for (const action of MEDIA_ACTIONS) { try { navigator.mediaSession.setActionHandler(action, null); } catch {} }
    navigator.mediaSession.playbackState = 'none';
    navigator.mediaSession.metadata = null;
    mediaOwner = null;
    try { if (navigator.audioSession) navigator.audioSession.type = 'auto'; } catch {}
  }
  remainingMs(pos) {
    const word = this.words[pos];
    if (!word) return 0;
    return (this.manifest.clips[word.clipIndex].durationMs - word.startMs
      + this.manifest.clips.slice(word.clipIndex + 1).reduce((n, c) => n + c.durationMs, 0)) / this.rate;
  }
  dispose() { this.pause(); this.releaseMediaSession(); this.audio.onerror = null; this.audio.onpause = null; this.audio.onplaying = null; this.audio.removeAttribute('src'); this.audio.load(); URL.revokeObjectURL(this.url); }
}
