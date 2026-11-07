Stillpoint contraction alignment repair

This fixes missing or zero-duration internal contraction fragments such as n't,
while preserving strict checks for missing spoken words. It also checks each
passage's timing before narrating the rest of the book.

1. In Studio, pause any running generation and wait for Paused, then Close local engine.
2. Extract this ZIP into your EXISTING Stillpoint folder (the one containing
   Open Audiobook Studio.cmd). The repair launcher and alignment-repair folder
   must sit beside that existing launcher. Do not start a new empty installation.
3. Double-click Apply Alignment Fix.cmd, then Open Audiobook Studio.cmd.
4. Under Your narration, Resume the original failed job. Completed cached
   passages are verified and reused; it does not start the book from scratch.

The repair replaces only tools/audiobook/generate.py and saves a copy of the old
file inside alignment-repair. It does not delete .studio-jobs, .studio-models,
.venv-kokoro, or any books/audio. No setup or model download is needed again.

If the error remains after applying this update, keep the exact new error,
including its Passage number. It may identify a different alignment issue.
