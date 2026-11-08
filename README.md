# Stillpoint

A private reader for iPhone with RSVP, reflowable pages, continuous scrolling, and synchronized local audiobooks. Books stay on your device.

Use the labeled **Read / Listen / RSVP** button at the top of the reader to choose a mode. Mode changes preserve the current word and pause playback. Read offers pages or scrolling; Listen offers optional text following; RSVP can use independent WPM pacing or audiobook voice and timing. In Read and text-following Listen views, **Aa** offers pages or continuous scrolling, fonts, text size, boldness, spacing, margins, alignment, themes, page dimming, and progress display. Swipe or tap page edges to turn; tap the center to show or hide controls. Reading position is shared with RSVP and narration. Native text selection, highlights, and notes are disabled. Only Play (or the explicitly labeled Start RSVP shortcut in Read) starts an RSVP session.

The library has a prominent Continue card with the last-used mode, chapter, cover, and mode-specific remaining time. Opening it stays paused. Audio availability is shown on each book; lightweight audio summaries keep library browsing separate from audio loading.

Listen and narrated RSVP provide **Back 15 seconds**, **Forward 15 seconds**, playback speed, and chapter/book time remaining. The **Sleep** button offers 5–60 minutes or the end of the current chapter. Duration timers count wall-clock time, including pauses. Timers stop narration and background sound, reset when leaving the book, and are checked through native media events as well as a clock. Actual iPhone locked-screen timing still needs device acceptance testing. Playback failures offer Reload audio, Audiobook options, and Read instead; reloading stays paused.

The reader footer shows one progress percentage, a compact chapter/book clock, and transport controls. Scrolling views omit page-navigation buttons, and the separate chapter/progress folio appears only while controls are hidden. Installed iPhone apps use a fixed opaque header with extra clearance below the status-bar area; actual iOS scroll-edge rendering still needs an on-device check.

Use the **question-mark speech bubble** to open Story help. Choose **Explain this scene** or **Summarize the book so far**, then **Copy prompt**. The recap asks for the main events from the beginning to the same exact cutoff in 5–7 short bullets (at most 250 words); it uses the recent excerpt to mark your location and asks AI to request earlier text if it cannot confidently recap the book. The prompt identifies the book, chapter, word cutoff and edition progress, and includes up to 400 preceding words. It never includes later words in the same paragraph or future chapter titles. For a precise cutoff, hold a word and choose **Explain up to this word**. Playback pauses, and the prompt remains fixed while open. Paste it into your AI chat; no AI service is called automatically. The prompt asks for 3–5 short bullets without future events, sentence completion or foreshadowing, but an external AI's response cannot be guaranteed spoiler-free. If clipboard access is blocked, the prompt can be selected and copied manually.

Settings are grouped into **Appearance**, **RSVP**, **Audio**, **Reading goal**, and **Library and data**. Detailed word, focus, timing, and gesture controls live in expandable sections. **RSVP → Surrounding words** optionally shows one to three faint words on each side of the current flash without moving its focus point; it is off by default.

Choose background sound under **Settings → Audio** or the reader's ambient-sound button, then press Play. Narration and background sound start together, and hiding the page no longer explicitly stops the background sound. Narration keeps its native media element and lock-screen controls. Actual iPhone screen-off mixing still needs a physical-device check; desktop tests simulate visibility changes. Pausing stops background sound when it is set to play only while reading.

Listen-and-follow keeps the highlighted word in a comfortable vertical band, gently advancing a few lines when needed rather than recentering every word. Book pages keep their position until the next page is needed. Explicit seeks still jump to the selected place, and reduced-motion preferences are respected.

New EPUB imports include a small local cover thumbnail (EPUB 3 cover-image, EPUB 2 cover metadata, and guide cover pages are supported). Updated Studio exports carry that cover in the combined book ZIP. For a book already in the library, choose **⋯ → Add cover** and select the original EPUB or an image; this preserves its text, audio, and reading position. Old imports cannot recover artwork that was never stored. Covers are included in ordinary book backups.

**Audiobook Studio** is a local desktop interface: choose an EPUB, review its text and chapters, preview a narrator, generate with progress and pause/resume, and download one ZIP containing the book, audio, and word timings. On the phone, use **Add a book → Choose files** to import that ZIP. Open `Open Audiobook Studio.command` on a configured Mac or `Open Audiobook Studio.cmd` on a configured Windows PC. For an NVIDIA Windows PC, run `Setup Audiobook Studio (Windows).cmd` once first. A prominent generation card shows narration progress, elapsed time, an estimated remaining narration time, and the actual device. One-time setup, the CLI alternative, and current limits are documented in [tools/audiobook/README.md](tools/audiobook/README.md).

Open the site in Safari, tap Share, then Add to Home Screen.

Keep Stillpoint open while importing an audiobook. The import shows its stage and audio-saving percentage. Studio's stored M4A ZIP is read in ranges and saved as small audio parts, avoiding whole-archive memory copies. If the app stops during import, reopening shows recovery guidance. Existing audio imports remain compatible. Update an installed copy through **Settings → Library and data → Check for app updates**.

Ambient sound can use your own audio files (MP3, M4A, WAV, or AAC). Add or remove tracks under Settings, Ambient sound. Each file loops over and over and is kept on the device.

No build step is needed. To run the tests, serve this folder on port 8123, then run `python3 tests/make_samples.py` and `node tests/run.cjs` with Playwright installed.

EPUB and PDF imports include a reading-text review. You can include or omit captions, notes, front/back matter, and distribution notices; search the extracted text (or a PDF page number); and keep, exclude, or treat an individual passage as body text. Major chapters, all sections, and no chapter announcements are separate choices from chapter navigation. Reflowable EPUB is the preferred source; fixed-layout EPUBs give a clear error.

Open **Review reading text** from a book's library menu or its chapter list to change cleanup later. Source passages and choices stay in IndexedDB and are included in backups. Reading position and bookmarks are remapped using source passage identities. Books imported before this feature need to be reimported to retain their source passages; existing books are not rewritten automatically.

PDF cleanup uses conservative text/layout heuristics. Explicit numbered captions, margin repetition, and heading evidence are supported, but complex diagrams and unlabelled captions may require individual exclusions. The review shows extracted source text, not rendered PDF pages. Scanned PDFs still require external OCR. PDF notes are included by default because detection is approximate. Introductions, epigraphs, and narrative letters are preserved when marked as such.

Additional browser regression checks (install `playwright` and `jszip`):

```sh
node tests/cleanup.cjs
node tests/reader-upgrades.cjs
node tests/reading-iteration.cjs
node tests/reader-polish.cjs
node tests/audiobook-zip.cjs
node tests/large-audiobook.cjs
node tests/examples.cjs /path/to/folder-containing-example-epubs-and-example-pdfs
```

The cleanup suite creates its own small EPUB in memory and checks import/review, restoration, chapter announcements, PDF classification, cancellation, persistence, reading position, and bookmarks on a phone viewport. The optional examples suite reads the local example books without copying them into this repository. Set `CHROME_PATH` to an installed Chrome executable when Playwright's browser is unavailable. The original sample generator also requires Pandoc and ReportLab.

The large-audiobook suite requires Node 22.15+ for `zlib.crc32` and creates a sparse 416 MiB ZIP in the system temporary folder. It exercises import, reopening, native reader playback, failed-write rollback, interrupted-import cleanup, and damaged ZIP errors. WebKit uses disk-backed storage. The ZIP suite checks stored/deflated entries, streaming descriptors, ZIP64, and corrupt archives. Set `BOOK_BROWSER=webkit` to run either suite with an installed Playwright WebKit engine. These desktop tests do not replace a physical iPhone check.

## Backups and restore

Settings → Library and data → Save a backup prepares a ZIP with progress, then **Save backup file** opens file sharing or downloads it. Keep a copy outside Stillpoint. Audiobooks and background audio can be excluded with the settings switches. The ZIP writer retains file-backed Blobs and computes CRCs in 8 MiB chunks; it stores audio without recompression and supports ZIP64 offsets. Multi-gigabyte output has not been physically tested on an iPhone.

Restore previews the backup before writing. Existing books and settings stay intact by default; replacement of existing books and restoration of settings are separate choices. Replacing a book uses the backup’s text, place, bookmarks, and audio; if audio was omitted, its replacement is text-only. History is merged without duplicates. Each book’s text and complete audio are committed together after validation. Closing the panel cancels; completed books remain and the current failed replacement keeps its previous copy. Older v1 compressed archives are supported, with incremental raw-DEFLATE for large audio where the browser supports it. Free space is needed for staged replacements. Native iPhone Save to Files and memory-pressure acceptance remain necessary.

`tests/backups.cjs` exercises a 416 MiB archive, canceled restores, CRC failures, missing audio, compressed legacy backups, share/download paths, and safe restore defaults in Chrome and WebKit.

## Reader browsing and appearance

Listen keeps a separate browsing view from the audio word. Manual scrolling/page turns never seek narration, including while paused. **Back to my place** returns to the current spoken word and re-enables following. Explicit word, chapter, search, and scrubber jumps remain intentional seeks. Reading visibility saves the listening position rather than the top browsed word.

One listening-options button controls speed, sleep, and background sound. **Aa** opens a compact transparent-backed panel with the actual book visible above it for live font, margin, spacing, and theme changes. Appearance editing pauses playback and preserves its word. The four-corner button enters app fullscreen; center tap or Escape restores the controls without starting playback. iOS status and home gesture areas remain visible.

Story Help produces simple scene or book-so-far requests identifying title, author, current chapter, approximate percentage, and a short past-only excerpt ending at the cutoff. No fixed bullet-count instructions or long rules are included. External AI output remains outside Stillpoint’s control.

Reader 20 uses the smaller usable layout/visual viewport and never expands to physical screen height. Controls retain the home-gesture inset plus twelve pixels of clearance; visible controls take priority over filling an OS-reserved empty area. Tests use an explicit Home Screen viewport, a masked unusable bottom region, and a narrow phone layout. Desktop WebKit still cannot validate the native iOS compositor.

Older Listen/Read books using the original renderer are normalized to the current book view at open, preserving text, narration, bookmarks, and word position. This also gives existing books the actual-book live appearance preview and fullscreen controls. Margin changes respond to input and change events and flush the new page-column width immediately.

Listening options share the bottom transport row. Story Help uses two explicit buttons instead of a native select; its scrolling content cannot shrink controls below their readable height. Prompts include the current chapter title and word-based chapter percentage as well as book progress. App updates are labeled Reader 20.

Reader 21 adds persistent device-local `clearanceTop` and `clearanceBottom` preferences (0–160 CSS px, default 0). **Aa → Layout → Screen clearance** and **Settings → Library and data → Screen clearance** open a centered panel, keeping the actual header and player visible for live adjustment. Top adds header spacing; bottom raises the player. Fullscreen text/folio and appearance-preview top offsets honor the corresponding preferences. Reset affects only clearance. Ordinary settings backup/restore includes both preferences.
