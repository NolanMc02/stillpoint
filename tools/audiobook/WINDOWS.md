# Audiobook Studio on your Windows PC

The same application runs on Windows. No rewrite is needed. The reader on your iPhone stays the same; generate on the PC and transfer the finished ZIP.

## First-time setup for the RTX 3060 Ti

1. Extract the Windows source bundle. Put the `stillpoint` folder in a local folder outside OneDrive, such as a `Stillpoint` folder directly inside your Windows user folder. Run the files from the extracted folder, not from inside the ZIP.
2. Install **64-bit Python 3.12** from [Python's official Windows downloads](https://www.python.org/downloads/windows/). If using the official Python install manager, install the 3.12 runtime with `py install 3.12` once. Keep your NVIDIA graphics driver updated.
3. Double-click **Setup Audiobook Studio (Windows).cmd**. It creates `.venv-kokoro`, installs the [official PyTorch 2.6 CUDA 12.4 build](https://docs.pytorch.org/get-started/previous-versions/), installs the voice dependencies, downloads the English language model, and checks your actual GPU.
4. Setup must report **cudaAvailable: true**, your NVIDIA GPU name, and a passing real narration/word-timing/M4A check. If CUDA is unavailable, setup stops with an explanation rather than calling a CPU run a GPU success. Keep any error text so it can be diagnosed.
5. Double-click **Open Audiobook Studio.cmd**. Leave its command window open while generating. Studio opens in your browser at `http://localhost:8765/studio/`.

The first setup downloads several gigabytes of dependencies plus the voice model. It needs internet access and can take time. After the required voice files are cached, synthesis is local. Do not copy the Mac Python environment to the PC; Windows needs its own environment. The setup script installs packages into the app environment and does not install or change your NVIDIA driver.

## Daily use

Choose an EPUB → review text/chapters → preview a voice → Generate audiobook. The large progress card shows the stage, percentage of text narrated, passages/words completed, elapsed processing time, current chapter/passage, audio created, and GPU name once the voice engine has loaded. The estimated time remaining appears after at least two newly synthesized passages; it estimates narration, with packaging shown separately. Model loading/downloads do not have a made-up percentage.

Pause stops after the current passage. Resume verifies and reuses completed passage audio. Closing the browser does not stop the engine. Use Close local engine when finished. Keep the PC awake while generating.

When ready, download the ZIP and transfer it to your iPhone with your preferred file-transfer method. In Stillpoint, choose Add a book → Choose files to import the book and audio together. If the matching book already exists on the phone, its speaker menu → Import audiobook can attach the audio to that book when the reviewed text matches exactly.

## Verification status

The Mac CPU workflow, GPU/CPU selection logic, progress reporting, and a real setup warm-up have been exercised here. The Windows setup script and RTX 3060 Ti have **not** been run on your physical PC yet. Its first successful CUDA check and voice preview are the remaining platform acceptance test. Performance gains need measurement on your machine; no speedup is promised. Qwen remains an experimental CLI option and is not required for Studio.

## Repair an existing contraction-alignment failure

If a job failed with `Missing or invalid alignment for "n't"`, the speech model may have given the contraction's internal suffix no separate duration. The updated generator groups that fragment with its own displayed word's valid model timing. Missing whole-word timings still fail validation. Narration reaching 100% means the text has been spoken; the file still needs validated timestamps and packaging.

Download the [small Windows repair ZIP](https://github.com/NolanMc02/stillpoint/raw/refs/heads/main/tools/audiobook/repairs/alignment-repair-windows.zip). Pause other generation and wait for Paused, then Close local engine. Extract the repair ZIP into your **existing** Stillpoint folder beside `Open Audiobook Studio.cmd`. Run `Apply Alignment Fix.cmd`, reopen Studio, and Resume the failed job in Your narration. Keep the existing `.studio-jobs` folder: completed audio is verified and reused. No Setup or model reinstallation is required.

The repair copies only the updated generator and backs up the previous file. The Windows batch wrapper has not been exercised on the physical PC; its Python timing repair, early failure, and reuse of cached audio have automated coverage. A real Mac narration test covering several contractions also passes. If the updated job still fails, retain the exact message including its new Passage number so a different case can be diagnosed.
