@echo off
setlocal
set "STUDIO_ROOT=%~dp0"
set "STUDIO_PYTHON=%STUDIO_ROOT%.venv-kokoro\Scripts\python.exe"
if not exist "%STUDIO_PYTHON%" (
  echo Double-click Setup Audiobook Studio ^(Windows^).cmd first.
  pause
  exit /b 1
)
"%STUDIO_PYTHON%" -c "import urllib.request; urllib.request.urlopen('http://localhost:8765/api/status', timeout=2).close()" >nul 2>&1
if not errorlevel 1 (
  start "" "http://localhost:8765/studio/"
  exit /b 0
)
"%STUDIO_PYTHON%" "%STUDIO_ROOT%tools\audiobook\studio.py" --model-cache "%STUDIO_ROOT%.studio-models"
if errorlevel 1 (
  echo Studio could not start. Keep the error above for troubleshooting.
  pause
)
