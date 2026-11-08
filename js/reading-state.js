export const MODE_LABELS = { read: 'Read', listen: 'Listen', rsvp: 'RSVP' };
export function savedMode(book) {
  if (MODE_LABELS[book.readerMode]) return book.readerMode;
  if (book.audioMode === 'rsvp') return 'rsvp';
  if (book.audioMode === 'page') return 'listen';
  return book.readingView === 'book' ? 'read' : 'rsvp';
}
export function selectMode(book, mode) {
  if (!MODE_LABELS[mode]) throw new Error('Choose Read, Listen, or RSVP.');
  book.readerMode = mode;
  book.readingView = mode === 'rsvp' ? 'rsvp' : 'book';
  book.audioMode = mode === 'listen' ? 'page' : mode === 'rsvp' && book.rsvpAudio ? 'rsvp' : 'off';
  book.listenFollow ??= true;
  return book;
}
export function audioTimeAtWord(manifest, position) {
  let offset = 0, cursor = 0;
  for (const clip of manifest.clips) {
    if (position < cursor + clip.words.length) return (offset + clip.words[Math.max(0, position - cursor)].startMs) / 1000;
    cursor += clip.words.length; offset += clip.durationMs;
  }
  return offset / 1000;
}
export function summarizeAudio(book, manifest) {
  book.audioReady = true;
  book.audioDurationMs = manifest.clips.reduce((sum, clip) => sum + clip.durationMs, 0);
  book.audioRemainingMs = Math.max(0, book.audioDurationMs - audioTimeAtWord(manifest, book.pos || 0) * 1000);
  return book;
}
