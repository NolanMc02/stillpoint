# Stillpoint

A private reader for iPhone with RSVP, reflowable pages, continuous scrolling, and synchronized local audiobooks. Books stay on your device.

Use the **book icon** in the reader to switch between Book and RSVP views. In Book view, **Aa** offers pages or continuous scrolling, fonts, text size, boldness, spacing, margins, alignment, themes, page dimming, and progress display. Swipe or tap page edges to turn; tap the center to show or hide controls. Reading position is shared with RSVP and narration. Native text selection, highlights, and notes are disabled. Only Play starts an RSVP session.

**Audiobook Studio** is a local desktop interface: choose an EPUB, review its text and chapters, preview a narrator, generate with progress and pause/resume, and download one ZIP containing the book, audio, and word timings. On the phone, use **Add a book → Choose files** to import that ZIP. Open `Open Audiobook Studio.command` on a configured Mac or `Open Audiobook Studio.cmd` on a configured Windows PC. For an NVIDIA Windows PC, run `Setup Audiobook Studio (Windows).cmd` once first. A prominent generation card shows narration progress, elapsed time, an estimated remaining narration time, and the actual device. One-time setup, the CLI alternative, and current limits are documented in [tools/audiobook/README.md](tools/audiobook/README.md).

Open the site in Safari, tap Share, then Add to Home Screen.

Ambient sound can use your own audio files (MP3, M4A, WAV, or AAC). Add or remove tracks under Settings, Ambient sound. Each file loops over and over and is kept on the device.

No build step is needed. To run the tests, serve this folder on port 8123, then run `python3 tests/make_samples.py` and `node tests/run.cjs` with Playwright installed.

EPUB and PDF imports include a reading-text review. You can include or omit captions, notes, front/back matter, and distribution notices; search the extracted text (or a PDF page number); and keep, exclude, or treat an individual passage as body text. Major chapters, all sections, and no chapter announcements are separate choices from chapter navigation. Reflowable EPUB is the preferred source; fixed-layout EPUBs give a clear error.

Open **Review reading text** from a book's library menu or its chapter list to change cleanup later. Source passages and choices stay in IndexedDB and are included in backups. Reading position and bookmarks are remapped using source passage identities. Books imported before this feature need to be reimported to retain their source passages; existing books are not rewritten automatically.

PDF cleanup uses conservative text/layout heuristics. Explicit numbered captions, margin repetition, and heading evidence are supported, but complex diagrams and unlabelled captions may require individual exclusions. The review shows extracted source text, not rendered PDF pages. Scanned PDFs still require external OCR. PDF notes are included by default because detection is approximate. Introductions, epigraphs, and narrative letters are preserved when marked as such.

Additional browser regression checks (install `playwright` and `jszip`):

```sh
node tests/cleanup.cjs
node tests/examples.cjs /path/to/folder-containing-example-epubs-and-example-pdfs
```

The cleanup suite creates its own small EPUB in memory and checks import/review, restoration, chapter announcements, PDF classification, cancellation, persistence, reading position, and bookmarks on a phone viewport. The optional examples suite reads the local example books without copying them into this repository. Set `CHROME_PATH` to an installed Chrome executable when Playwright's browser is unavailable. The original sample generator also requires Pandoc and ReportLab.
