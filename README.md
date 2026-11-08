# Stillpoint

A private reader for iPhone with RSVP, reflowable pages, continuous scrolling, and synchronized local audiobooks. Books stay on your device.

Use the **Read / Listen / RSVP** button at the top to choose a mode. Changes preserve your word and stay paused. Read supports pages and continuous scrolling. Listen supports synchronized text following or a dedicated listening screen. RSVP supports independent WPM pacing or audiobook word timings. Only pressing Play in RSVP starts a session. Native text selection, highlights, and notes remain disabled.

Reader 24 uses a quiet, book-first interface. The library emphasizes covers and a Continue card with your saved chapter, mode, progress, and remaining time. Search, sorting, and All / Unfinished / Finished filters help browse larger libraries. Activity remains available from the library, and a direct backup link leads to Library and data. Opening a book never autoplays.

The listening footer keeps Contents, Back 15 seconds, a centered Play button, Forward 15 seconds, playback speed, and **⋯ Reader tools** visible. Speed also opens Sleep: 5–60 minutes or the end of the chapter. A small dot indicates an active timer; its current state is announced in the button's accessible label. Duration timers include paused time and stop narration plus ambience. Actual iPhone locked-screen scheduling remains device-dependent. Read mode shows page controls or reading progress instead of an audio-looking player. Select RSVP and press Play when you want one-word reading.

**⋯ Reader tools** holds Story help, bookmarks, fullscreen, background sound, reading modes, and all settings. Fullscreen hides app controls; a center tap or Escape restores them. Top and bottom Screen clearance support −80–160 px and update the actual reader live. Existing preferences and book positions are retained.

**Aa** opens a compact panel with the actual book visible above it. Font, size, weight, margins, spacing, alignment, layout, themes, dimming, and progress controls update live; range controls show numeric values. Custom colors remain available from Themes. Normal scrolling and page swipes remain available, while page zoom gestures and native scrollbar indicators are disabled. Text size is adjusted through Appearance. Native iPhone gesture/compositor behavior still requires a physical-device check.

For Story help, choose **⋯ → Story help**, select **Explain this scene** or **Summarize the book so far**, then copy the short prompt. It identifies title, author, current chapter, chapter percentage, book percentage, and a past-only excerpt of up to 50 words / approximately 600 characters ending at your cutoff. Hold a word → **Explain up to this word** for a precise point. Story Help pauses playback; closing it stays paused. No AI service is called automatically. An external AI can still make mistakes or spoil despite the request.

Settings retain five groups: Appearance, RSVP, Audio, Reading goal, and Library and data. Detailed word/focus/timing options are expandable. Library and data separates app/display controls, backups, storage, and reset/maintenance. Backup inclusion switches and destructive maintenance actions start collapsed. RSVP surrounding words remain optional and off by default.

Choose background sound under **⋯ → Background sound** or Settings → Audio. Narration and ambience start together on Play. Native narration retains lock-screen playback and Media Session controls. Actual iPhone screen-off mixing still needs device acceptance; desktop tests simulate visibility changes. Listen browsing preserves the audio position and offers **Back to my place** to resume following. The text advances gently by groups of lines; explicit seeks remain intentional jumps.

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

One listening-options button controls speed and sleep; Reader tools opens background sound. **Aa** opens a compact transparent-backed panel with the actual book visible above it for live font, margin, spacing, and theme changes. Appearance editing pauses playback and preserves its word. Reader tools → Fullscreen reading enters app fullscreen; center tap or Escape restores the controls without starting playback. iOS status and home gesture areas remain visible.

Story Help produces simple scene or book-so-far requests identifying title, author, current chapter, approximate percentage, and a short past-only excerpt ending at the cutoff. No fixed bullet-count instructions or long rules are included. External AI output remains outside Stillpoint’s control.

Reader 20 uses the smaller usable layout/visual viewport and never expands to physical screen height. Controls retain the home-gesture inset plus twelve pixels of clearance; visible controls take priority over filling an OS-reserved empty area. Tests use an explicit Home Screen viewport, a masked unusable bottom region, and a narrow phone layout. Desktop WebKit still cannot validate the native iOS compositor.

Older Listen/Read books using the original renderer are normalized to the current book view at open, preserving text, narration, bookmarks, and word position. This also gives existing books the actual-book live appearance preview and fullscreen controls. Margin changes respond to input and change events and flush the new page-column width immediately.

Listening options share the bottom transport row. Story Help uses two explicit buttons instead of a native select; its scrolling content cannot shrink controls below their readable height. Prompts include the current chapter title and word-based chapter percentage as well as book progress. App updates show the installed reader version.

Screen clearance stores device-local `clearanceTop` and `clearanceBottom` preferences (−80–160 CSS px, default 0). **Aa → Layout → Screen clearance** and **Settings → Library and data → Screen clearance** open a centered panel with the actual header and player visible for live adjustment. Positive Top moves the header down; negative Top raises it. Positive Bottom lifts the player; negative Bottom lowers it. Safe-area backing shrinks with negative adjustments so it does not cover the controls. Fullscreen offsets honor the same preferences. Reset affects only clearance, and settings backups include both values.

The footer layout measures the footer’s occupied space from the reader bottom to the footer’s actual top edge, rather than reserving its element height. Clearance updates refresh these measurements immediately, including position-only moves below zero padding. The book viewport, follow text, and Back to my place anchor therefore follow the lowered controls without an unused strip. The reader root is observed for viewport changes too.

Reader 24 adds persistent negative top clearance, application zoom guards, hidden native scrollbars, a quiet reader tool menu, mode-specific footers, a clearer library with completion filters, a simplified import sheet, appearance value feedback, and grouped settings. The page keeps all user-selected fonts, themes, reviewed text, audio, and positions. Native system accessibility zoom is outside the app's gesture controls.
