#!/bin/bash
set -e
STUDIO_ROOT="$(cd "$(dirname "$0")" && pwd)"
if /usr/bin/curl --fail --silent --max-time 2 http://localhost:8765/api/status >/dev/null 2>&1; then
  /usr/bin/open http://localhost:8765/studio/
  exit 0
fi
STUDIO_PYTHON=""
for STUDIO_CANDIDATE in "$STUDIO_ROOT/.venv-kokoro/bin/python" "$STUDIO_ROOT/../audio-venv/bin/python"; do
  if [ -x "$STUDIO_CANDIDATE" ]; then STUDIO_PYTHON="$STUDIO_CANDIDATE"; break; fi
done
if [ -z "$STUDIO_PYTHON" ]; then
  /usr/bin/osascript -e 'display dialog "Install the local Kokoro environment using the Studio setup guide, then open this launcher again." buttons {"OK"} default button "OK"'
  exit 1
fi
STUDIO_MODELS="$STUDIO_ROOT/.studio-models"
if [ -d "$STUDIO_ROOT/../model-cache" ]; then STUDIO_MODELS="$STUDIO_ROOT/../model-cache"; fi
exec "$STUDIO_PYTHON" "$STUDIO_ROOT/tools/audiobook/studio.py" --model-cache "$STUDIO_MODELS"
