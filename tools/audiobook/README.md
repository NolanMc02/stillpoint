# Local audiobooks for Stillpoint

This prototype generates English narration on your computer and imports it into Stillpoint for synchronized listening, scrolling text, and RSVP. It uses the exact reviewed text and tokenizer from the reader. Generation can run on a different computer from playback.

## Audiobook Studio

Studio is the desktop generation interface. Once the Kokoro environment below is installed, double-click **Open Audiobook Studio.command** (Mac) or **Open Audiobook Studio.cmd** (Windows) in the repository root. It opens `http://localhost:8765/studio/`. The local Python engine must stay running during generation. The launchers use `.venv-kokoro`; the configured development Mac can also use its existing sibling `audio-venv` environment.

1. Choose a DRM-free, reflowable EPUB.
2. Review reading text and optionally choose chapters. Include or omit passages before generating.
3. Choose a narrator and preview the voice. The first use may download weights.
4. Generate the audiobook. Progress is saved per passage; Pause finishes the current passage before stopping. Resume reuses verified completed passages.
5. Download the result, transfer it to your phone, and import it through Stillpoint's **Add a book → Choose files**. One ZIP supplies both reading text and audio. Existing books are not replaced automatically.

Closing the browser window does not stop the engine. Use **Close local engine** when finished; active generation pauses after its current passage. Reopening Studio restores job history. Source text, jobs, PCM caches, and output remain in `.studio-jobs/`; model downloads use `.studio-models/`. These directories are ignored by Git. Pause active jobs and close the engine before manually removing their saved files to recover disk space.

Studio currently exposes Kokoro English voices. It automatically selects CUDA when available, otherwise CPU. The M1 Mac workflow has been exercised with real generation; the Windows launcher and CUDA path need testing on the actual PC. Qwen remains CLI-only and experimental. Studio binds to loopback, requires same-origin authenticated writes, and does not send book text to a cloud speech API. It is not a hosted generation service: the public GitHub Pages site runs the reader, while Studio needs the local Python engine.

The reader's book icon opens the traditional Book view. **Aa → Layout** selects Pages or Continuous scroll. Font, size, boldness, spacing, margins, alignment, themes, page dimming, and progress display are configurable. Page counts refer to the current reflowed section, not a publisher's print edition. These are Kindle-style core reading controls; Amazon store/sync, dictionary, translation, and X-Ray integrations are not implemented. Highlights and notes remain disabled.

## Try the reader

Serve the repository over localhost; opening `index.html` as a file will not work:

```sh
python3 -m http.server 8123 --bind 127.0.0.1
```

Open `http://localhost:8123`. Import an EPUB and finish **Review reading text**. From the book's menu or the speaker button in the reader, open **Audiobook → Export narration job**. Transfer that JSON file to the generation computer.

After generation, open the same book and choose **Audiobook → Import audiobook**. Select the generated ZIP. Choose **Book · pages or scrolling** with **Listen along in book mode**, **Listen and follow text**, **Listen and follow RSVP**, or **Read without narration**. Press play in the reader. In narration modes the speed controls adjust audio playback speed; the settings sheet also offers exact rates.

The existing word menu's **Read from here**, chapter navigation, search, bookmarks, rewind, and position slider use the shared reading position. Narration follows those jumps. Normal RSVP keeps its independent WPM pacing when narration is off.

## Kokoro: tested path

Use Python 3.12 and a separate environment. The Kokoro requirements pin Transformers 4.51.3 and, on macOS, PyTorch 2.6.0 for a reproducible local engine. The newer PyTorch 2.15 / Transformers dependency chain stalled during local startup on this Mac. The Windows CUDA path still needs separate device testing. The first run downloads model weights and an English language-processing model. Once those are cached, generation runs offline.

macOS or Linux, from the repository root:

```sh
python3.12 -m venv .venv-kokoro
.venv-kokoro/bin/python -m pip install -r tools/audiobook/requirements-kokoro.txt
.venv-kokoro/bin/python tools/audiobook/generate.py /path/to/book-narration.json --output audiobook.zip --voice af_heart --device cpu
```

Windows PowerShell:

```powershell
py -3.12 -m venv .venv-kokoro
.venv-kokoro\Scripts\python.exe -m pip install -r tools/audiobook/requirements-kokoro.txt
.venv-kokoro\Scripts\python.exe tools/audiobook/generate.py C:\path\book-narration.json --output audiobook.zip --voice af_heart --device cpu
```

For CUDA generation on the 3060 Ti, install the CUDA-enabled PyTorch build into that environment using the [official installation selector](https://pytorch.org/get-started/locally/), then use `--device cuda`. Check the environment with:

```powershell
.venv-kokoro\Scripts\python.exe -c "import torch; print(torch.cuda.is_available())"
```

American English voices use `a` prefixes, such as `af_heart`. British English voices use `b` prefixes, such as `bm_george`. This prototype's native-timing adapter only accepts these English families. `--speed 1.0` controls synthesis speed; playback speed is independent.

Default export is one continuous AAC/M4A track at 64 kbps, using the FFmpeg binary bundled with `imageio-ffmpeg`. `--audio-format wav` preserves PCM clips for inspecting timing. Cached synthesis chunks and assembled PCM are retained in the adjacent `.work` directory and use substantially more disk space than the exported package. Synthesis is still resumable; assembly shifts every word timestamp using exact sample counts. The continuous PCM assembly currently has a 4 GB size limit.

## Qwen: experimental PC adapter

The Qwen adapter is implemented against upstream APIs but has **not been exercised on the Windows PC or with real Qwen weights**. Start with the tested Kokoro path, then audition this on the 3060 Ti. GPU memory fit and generation speed remain to be measured. The default speech model is `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice` with speaker `Ryan`.

Qwen's speech and alignment packages pin different Transformers versions, so create two environments. The aligner runs as a separate process after synthesis releases the speech model. Do not install both requirements files into one environment.

Windows PowerShell:

```powershell
py -3.12 -m venv .venv-qwen
py -3.12 -m venv .venv-aligner
.venv-qwen\Scripts\python.exe -m pip install -r tools/audiobook/requirements-qwen.txt
.venv-aligner\Scripts\python.exe -m pip install -r tools/audiobook/requirements-aligner.txt
```

Install CUDA-enabled PyTorch in **both** environments using the official selector. Then:

```powershell
.venv-qwen\Scripts\python.exe tools/audiobook/generate.py C:\path\book-narration.json --engine qwen --voice Ryan --device cuda --align-python .venv-aligner\Scripts\python.exe --output qwen-audiobook.zip
```

The current Qwen adapter targets CUDA or CPU, not the Mac's MPS backend. It uses explicit English number/currency expansions to preserve display-to-spoken mappings. Those rules are intentionally limited; unusual dates, abbreviations, currencies, and technical notation need auditioning. Voice cloning and pronunciation dictionaries are future work.

## Resume, inspect, and compare

Run the same command after interruption to resume completed clips. Clip cache keys include their source words and synthesis settings; audio checksums are checked before reuse. Press Ctrl+C to stop. The final ZIP replaces its output only after packaging succeeds. Keep different voices in separate output paths to compare them.

Validate a narration job without installing models:

```sh
python3 tools/audiobook/generate.py book-narration.json --validate-only
```

Each generation writes an adjacent `.report.json` with word count, audio duration, elapsed wall time, and generation seconds per audio second. The elapsed time includes model loading, processing, encoding, and any initial downloads. Cached runs are not model-speed benchmarks. It does not measure peak RAM or GPU memory.

## Synchronization contract

`stillpoint-v1` identifies the current tokenizer. The SHA-256 text fingerprint covers a compact UTF-8 JSON array of `[passageId, [[word, glue], ...]]` records. JavaScript exports these tokens; Python never independently tokenizes the EPUB. The fingerprint includes passage order and identities. A one-word text change invalidates the package.

Every displayed token must have exactly one timing record, in reading order. Records carry `sid`, zero-based token `offset`, `startMs`, and `endMs` relative to their clip. The generator keeps times in the original audio timeline; changing playback rate does not rewrite them. One displayed token can cover several spoken words, such as `$12` spoken as “twelve dollars.”

Kokoro timings come from model-predicted phoneme durations. Qwen uses a forced aligner. Both are estimates; syntactic validation does not prove acoustic accuracy or prove the model pronounced every word correctly. The generator stops on mismatched alignment text or missing/invalid timing rather than distributing duration uniformly. Human auditioning is still needed.

ZIP contents:

```text
audiobook.json       # versioned manifest, source fingerprint, ordered clips and word times
narration-job.json   # original reviewed text and tokens
audio/clip-00000.m4a
reading-book.json   # Studio book exports also contain reviewed text and cleanup choices
```

Stillpoint validates the full word sequence before replacing a saved audiobook. Replacement uses one IndexedDB transaction. A changed cleanup selection currently disables the old narration and asks for a new export. Automatic passage skipping/reuse after cleanup is not implemented yet.

## Storage and current limits

- The reader retains metadata separately from audio and loads one audio clip at a time during playback. Package import still decompresses the whole ZIP; very large books need available memory and browser storage. Full-novel and iPhone Safari stress tests remain outstanding.
- Audiobooks are included in normal backups by default. **Settings → Library and data** can omit them to reduce backup size. Removing a book removes its audio.
- Narration now continues when the page is hidden, releases the screen wake lock, and exposes Media Session play/pause and seeking controls where supported. Visual updates stop in the background and the reader resynchronizes on return. Independent RSVP still pauses when hidden. Begin playback with a user gesture before locking the phone. The user has confirmed working playback on their installed iPhone app after the Safari MIME fix. Interruption and long-book acceptance checks still need wider device testing.
- AAC priming behavior, long-book voice consistency, large imports, and manual acoustic timing accuracy still need broader testing. Automated browser coverage includes Chrome and a WebKit media regression. The page must remain open: closing its tab or shutting down the phone ends playback.
- New packages join source PCM before encoding, so there are no JavaScript-driven clip transitions during playback. Older packages with multiple clips still import, but should be regenerated for screen-off use.
- No cloud speech API is used. Initial dependency/model downloads require internet access. Keep backups of locally stored books and generated packages.

## Validation

The first real Mac test generated 39 displayed words, including `$12`, into 13.6 seconds of audio. CPU generation on the M1 Mac took about 8.85 seconds with weights already downloaded, including model loading (before M4A encoding was added). This tiny sample is not a full-book throughput estimate.

Pure Python tests need no ML dependencies:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tools/audiobook -p 'test_*.py'
```

Browser tests need Node, Playwright, JSZip, and an installed Chromium browser:

```sh
npm install --no-save playwright jszip
npx playwright install chromium
node tests/narration.cjs
node tests/cleanup.cjs
node tests/book-reader.cjs
node tests/updates.cjs
```

Optional `CHROME_PATH` chooses an existing Chrome executable. `REAL_AUDIO` points to an audiobook ZIP generated from the exact test passage; `SAMPLE_JOB` exports that passage's job for a real generation test. `SHOTS` points to an existing screenshot directory. Tests use local request routing and do not need a server.

Upstream references: [Kokoro](https://github.com/hexgrad/kokoro), [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS), [Qwen3-ASR / ForcedAligner](https://github.com/QwenLM/Qwen3-ASR).

## Phone acceptance check

Use a phone-accessible HTTPS deployment, not the Mac-only localhost demo. Test both Safari and the installed Home Screen app if you use both. Import a newly generated continuous audiobook and start playback. Lock the screen for several minutes, cross paragraph/chapter boundaries, test lock-screen play/pause and seek, and reopen the reader. Confirm audio continued and the highlighted word matches the current audio position. Repeat after an interruption such as a call or another audio app. Native background behavior is not guaranteed until these checks pass on the target device.

For a real Studio integration test, start Studio on port 8765 and run `SAMPLE_EPUB=/path/to/sample-book.epub node tests/studio.cjs` with the supplied original sample EPUB. This test loads real model weights, generates audio, downloads the combined ZIP, and imports/plays it in the reader.
