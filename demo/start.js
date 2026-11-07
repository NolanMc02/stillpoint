import * as db from '../js/db.js';
import { readNarrationPackage } from '../js/narration.js';
try {
  await db.openDB();
  const id = 'local-audiobook-demo';
  const job = await (await fetch('job.json')).json();
  if (!await db.get('books', id)) {
    const blocks = job.blocks.map(b => ({ sid: b.sid, k: 'p', t: b.text }));
    const book = { id, title: job.book.title, author: job.book.author, format: 'epub',
      pos: 0, wordCount: job.blocks.reduce((n, b) => n + b.tokens.length, 0),
      addedAt: Date.now(), chapters: [], bookmarks: [], audioMode: 'page', audioRate: 1 };
    await db.saveBook(book, { id, blocks });
  }
  const existing = await db.get('narrations', id);
  if (!existing || existing.manifest.playback !== 'continuous') {
    const data = await (await fetch('audiobook.zip')).blob();
    const { manifest, audio } = await readNarrationPackage(data, job);
    await db.saveNarration(id, manifest, audio);
  }
  await db.put('kv', id, 'lastBook');
  location.replace('../');
} catch (error) {
  document.querySelector('#status').textContent = `The sample could not open: ${error.message}`;
}
