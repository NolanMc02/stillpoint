import { importFile } from '../js/importers.js';
import { cleanBook, CLEAN_ROLES, defaultBookOptions } from '../js/bookclean.js';
import { createNarrationJob } from '../js/narration.js';
import { tokenize } from '../js/engine.js';

const $ = s => document.querySelector(s);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let connection = null, parsed = null, source = null, options = null, selectedChapters = new Set(), passagePage = 0;
let chapterSelectionChanged = false;
let activePreview = null, busy = false;
let pollTimer;
const notify = message => { $('#notice').hidden = !message; $('#notice').textContent = message || ''; };

async function api(path, payload) {
  const response = await fetch(path, payload ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Stillpoint-Token': connection.token }, body: JSON.stringify(payload) } : { cache: 'no-store' });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'The local engine could not complete this action.');
  return result;
}

function reviewed() {
  const all = source ? cleanBook(source, options) : parsed;
  if (!all) return null;
  if (!all.chapters?.length || !chapterSelectionChanged || all.chapters.every(c => selectedChapters.has(c.title + '|' + (all.blocks[c.block]?.sid || c.block)))) return all;
  const keep = new Set();
  all.chapters.forEach((chapter, i) => {
    if (!selectedChapters.has(chapter.title + '|' + (all.blocks[chapter.block]?.sid || chapter.block))) return;
    const end = all.chapters[i + 1]?.block ?? all.blocks.length;
    for (let b = chapter.block; b < end; b++) keep.add(b);
  });
  const map = new Map(), blocks = [];
  all.blocks.forEach((block, index) => { if (keep.has(index)) { map.set(index, blocks.length); blocks.push(block); } });
  const cleanup = all.cleanup ? { ...all.cleanup, options: { ...all.cleanup.options, overrides: { ...all.cleanup.options.overrides } } } : undefined;
  if (cleanup) all.blocks.forEach((block, index) => { if (!keep.has(index)) cleanup.options.overrides[block.sid] = 'exclude'; });
  return { ...all, ...(cleanup ? { cleanup } : {}), blocks, chapters: all.chapters.filter(c => map.has(c.block)).map(c => ({ ...c, block: map.get(c.block) })) };
}

function refreshBook(renderReview = true) {
  const book = reviewed();
  if (!book) return;
  const count = book.blocks.reduce((n, b) => n + tokenize(b.t).length, 0);
  $('#word-count').textContent = `${count.toLocaleString()} words`;
  const seconds = count / (155 * Number($('#speed').value)) * 60;
  $('#duration-estimate').textContent = seconds < 60 ? `About ${Math.round(seconds)} seconds of audio` : `About ${Math.round(seconds / 60)} minutes of audio`;
  $('#excerpt').textContent = book.blocks.filter(b => b.k !== 'h').slice(0, 2).map(b => b.t).join(' ').slice(0, 650) || book.blocks[0]?.t || 'Choose at least one passage or chapter.';
  $('#generate').disabled = !connection?.ready || !count || busy;
  $('#preview-voice').disabled = !connection?.ready || !count || busy;
  if (renderReview) renderPassages();
}

function renderPassages() {
  if (!source) return;
  const query = $('#review-search').value.toLowerCase().trim();
  const blocks = source.blocks.filter(b => !query || b.t.toLowerCase().includes(query));
  const maxPage = Math.max(0, Math.ceil(blocks.length / 8) - 1);
  passagePage = Math.min(passagePage, maxPage);
  const included = new Set(reviewed().blocks.map(b => b.sid));
  $('#passages').innerHTML = blocks.slice(passagePage * 8, passagePage * 8 + 8).map(block => `<div class="passage ${included.has(block.sid) ? '' : 'omitted'}"><p>${esc(block.t)}</p><select aria-label="Include passage" data-passage="${esc(block.sid)}">${[['auto', 'Use cleanup choice'], ['keep', 'Include this passage'], ['exclude', 'Omit this passage'], ['body', 'Include as body text']].map(([value, label]) => `<option value="${value}" ${value === (options.overrides[block.sid] || 'auto') ? 'selected' : ''}>${label}</option>`).join('')}</select></div>`).join('');
  $('#passages-count').textContent = `${blocks.length ? passagePage + 1 : 0} of ${blocks.length ? maxPage + 1 : 0}`;
  $('#passages-prev').disabled = passagePage === 0;
  $('#passages-next').disabled = passagePage >= maxPage;
}

function renderChapters() {
  const book = source ? cleanBook(source, options) : parsed;
  if (!chapterSelectionChanged) selectedChapters = new Set((book.chapters || []).map(c => c.title + '|' + (book.blocks[c.block]?.sid || c.block)));
  $('#chapter-options').innerHTML = book.chapters?.length ? book.chapters.map(c => {
    const key = c.title + '|' + (book.blocks[c.block]?.sid || c.block);
    return `<label><input type="checkbox" data-chapter="${esc(key)}" ${selectedChapters.has(key) ? 'checked' : ''}>${esc(c.title)}</label>`;
  }).join('') : '<p class="hint">This book has no chapter markers. Its full reading text will be narrated.</p>';
}

async function openBook(file) {
  if (busy) return notify('Pause the current generation before choosing another book.');
  notify('Opening your book…');
  try {
    parsed = await importFile(file);
    source = parsed.cleanup?.source || null;
    options = structuredClone(parsed.cleanup?.options || defaultBookOptions());
    chapterSelectionChanged = false;
    selectedChapters = new Set((parsed.chapters || []).map(c => c.title + '|' + (parsed.blocks[c.block]?.sid || c.block)));
    $('#book-title').textContent = parsed.title;
    $('#book-author').textContent = parsed.author || 'Author not specified';
    $('#drop-zone').hidden = true; $('#book-details').hidden = false;
    $('#cleanup-options').innerHTML = Object.entries(CLEAN_ROLES).filter(([key]) => !['page', 'header', 'number'].includes(key)).map(([key, label]) => `<label><input type="checkbox" data-role="${key}" ${options[key] ? 'checked' : ''}>${esc(label)}</label>`).join('');
    passagePage = 0; $('#review-search').value = '';
    renderChapters(); refreshBook(); notify('');
  } catch (error) { notify(error.message || 'This EPUB could not be opened.'); }
}

async function requestGeneration(kind) {
  const book = reviewed();
  if (!book?.blocks.length) return;
  let selected = book;
  if (kind === 'preview') {
    const body = book.blocks.find(b => b.k !== 'h') || book.blocks[0];
    const tokens = tokenize(body.t).slice(0, 45);
    selected = { ...book, blocks: [{ ...body, t: tokens.map(t => t.w + (t.g ? '' : ' ')).join('').trim() }], chapters: [], cleanup: undefined };
  }
  const id = 'studio-' + crypto.randomUUID();
  const metadata = { id, title: selected.title, author: selected.author || '', format: selected.format,
    chapters: selected.chapters || [], bookmarks: [] };
  const content = { id, blocks: selected.blocks, ...(selected.cleanup ? { cleanup: selected.cleanup } : {}) };
  const job = await createNarrationJob(metadata, content);
  const result = await api('/api/jobs', { kind, job, readingBook: kind === 'book' ? { format: 'stillpoint-reading-book', version: 1, book: metadata, content } : null,
    voice: $('#voice').value, speed: Number($('#speed').value) });
  if (kind === 'preview') activePreview = result.id;
  busy = true; refreshBook(); await poll();
}

const phaseLabels = { starting: 'Starting the local engine', loading: 'Loading the local voice engine · first use may take a few minutes', synthesis: 'Narrating passages', alignment: 'Aligning words', assembly: 'Joining the narration', encoding: 'Preparing the audiobook', finishing: 'Finishing the local voice session', complete: 'Ready to listen', paused: 'Paused · completed passages are saved', error: 'Generation needs attention' };
async function poll() {
  try {
    const state = await api('/api/status');
    const wasBusy = busy;
    connection = state;
    busy = state.jobs.some(j => j.status === 'running');
    $('#engine-state').textContent = state.ready ? 'Local engine ready' : 'Voice engine needs setup';
    $('#engine-state').classList.toggle('ready', state.ready);
    if (!state.ready) notify('Open Studio with its launcher to use the installed voice engine.');
    if (!$('#voice').options.length) $('#voice').innerHTML = state.voices.map(v => `<option value="${v.id}">${esc(v.name)}</option>`).join('');
    $('#voice-description').textContent = state.voices.find(v => v.id === $('#voice').value)?.description || '';
    $('#jobs').innerHTML = state.jobs.length ? state.jobs.map(job => {
      const percent = job.total ? Math.min(100, Math.round((job.completed || 0) / job.total * 100)) : 0;
      const progress = job.total ? `${job.completed || 0} of ${job.total} passages` : '';
      return `<article class="job"><div class="job-top"><h3>${esc(job.title)}${job.kind === 'preview' ? ' · voice preview' : ''}</h3><span class="hint">${job.status === 'ready' ? 'Complete' : `${percent}%`}</span></div><p class="hint">${esc(job.error || phaseLabels[job.phase] || job.status)}${progress ? ` · ${progress}` : ''}</p><div class="progress"><i style="width:${job.status === 'ready' ? 100 : percent}%"></i></div><div class="job-actions">${job.status === 'running' ? `<button class="quiet" data-pause="${job.id}">Pause after this passage</button>` : ''}${['paused', 'error', 'queued'].includes(job.status) ? `<button class="secondary" data-resume="${job.id}" ${busy ? 'disabled' : ''}>Resume generation</button>` : ''}${job.status === 'ready' && job.kind !== 'preview' ? `<a href="/api/jobs/${job.id}/download">Download for Stillpoint ↗</a>` : ''}${job.status === 'ready' ? `<button class="quiet" data-listen="${job.id}">Listen</button>` : ''}</div></article>`;
    }).join('') : '<p class="empty">Your generated books will appear here.</p>';
    const preview = state.jobs.find(j => j.id === activePreview && j.status === 'ready');
    if (preview) {
      $('#voice-player').src = `/api/jobs/${preview.id}/audio`;
      $('#voice-player').hidden = false;
      activePreview = null;
    }
    if (parsed && wasBusy !== busy) refreshBook(false);
  } catch (error) {
    $('#engine-state').textContent = 'Local engine offline';
    notify('Start Audiobook Studio on your computer to generate narration. Your reader and downloaded audiobooks work independently.');
  }
}

$('#epub-file').onchange = e => e.target.files[0] && openBook(e.target.files[0]);
$('#change-book').onclick = () => $('#epub-file').click();
$('#drop-zone').ondragover = e => { e.preventDefault(); $('#drop-zone').classList.add('dragging'); };
$('#drop-zone').ondragleave = () => $('#drop-zone').classList.remove('dragging');
$('#drop-zone').ondrop = e => { e.preventDefault(); $('#drop-zone').classList.remove('dragging'); if (e.dataTransfer.files[0]) openBook(e.dataTransfer.files[0]); };
for (const [button, panel] of [['review-toggle', 'review'], ['chapters-toggle', 'chapter-options']]) $(`#${button}`).onclick = () => { const open = $(`#${panel}`).hidden; $(`#${panel}`).hidden = !open; $(`#${button}`).setAttribute('aria-expanded', open); };
$('#cleanup-options').onchange = e => { if (e.target.dataset.role) { options[e.target.dataset.role] = e.target.checked; passagePage = 0; renderChapters(); refreshBook(); } };
$('#chapter-options').onchange = e => { if (e.target.dataset.chapter) { chapterSelectionChanged = true; if (e.target.checked) selectedChapters.add(e.target.dataset.chapter); else selectedChapters.delete(e.target.dataset.chapter); refreshBook(); } };
$('#review-search').oninput = () => { passagePage = 0; renderPassages(); };
$('#passages').onchange = e => { const sid = e.target.dataset.passage; if (!sid) return; if (e.target.value === 'auto') delete options.overrides[sid]; else options.overrides[sid] = e.target.value; renderChapters(); refreshBook(); };
$('#passages-prev').onclick = () => { passagePage--; renderPassages(); };
$('#passages-next').onclick = () => { passagePage++; renderPassages(); };
$('#voice').onchange = () => { $('#voice-description').textContent = connection.voices.find(v => v.id === $('#voice').value)?.description || ''; };
$('#speed').oninput = () => { $('#speed-label').textContent = Number($('#speed').value).toFixed(2).replace(/0$/, '') + '×'; refreshBook(); };
$('#generate').onclick = () => requestGeneration('book').catch(error => notify(error.message));
$('#preview-voice').onclick = () => requestGeneration('preview').catch(error => notify(error.message));
$('#jobs').onclick = async e => {
  const pause = e.target.closest('[data-pause]'), resume = e.target.closest('[data-resume]'), listen = e.target.closest('[data-listen]');
  try {
    if (pause) { await api(`/api/jobs/${pause.dataset.pause}/pause`, {}); notify('Pausing after the current passage finishes.'); }
    if (resume) { await api(`/api/jobs/${resume.dataset.resume}/resume`, {}); notify(''); }
    if (listen) { $('#voice-player').src = `/api/jobs/${listen.dataset.listen}/audio`; $('#voice-player').hidden = false; $('#voice-player').scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    if (pause || resume) await poll();
  } catch (error) { notify(error.message); }
};
$('#stop-engine').onclick = async () => {
  try {
    await api('/api/shutdown', {}); clearInterval(pollTimer);
    $('#engine-state').textContent = 'Local engine closed'; $('#engine-state').classList.remove('ready');
    $('#generate').disabled = true; $('#preview-voice').disabled = true;
    notify('The local engine is closing. Active narration will pause after its current passage. Open Audiobook Studio to return.');
  } catch (error) { notify(error.message); }
};
await poll();
pollTimer = setInterval(poll, 1500);
