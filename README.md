# Stillpoint

A private RSVP speed reader for iPhone. Books stay on your device.

Open the site in Safari, tap Share, then Add to Home Screen.

Ambient sound can use your own audio files (MP3, M4A, WAV, or AAC). Add or remove tracks under Settings, Ambient sound. Each file loops over and over and is kept on the device.

No build step is needed. To run the tests, serve this folder on port 8123, then run `python3 tests/make_samples.py` and `node tests/run.cjs` with Playwright installed.
