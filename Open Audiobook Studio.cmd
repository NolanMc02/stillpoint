@echo off
set "STUDIO_ROOT=%~dp0"
if exist "%STUDIO_ROOT%.venv-kokoro\Scripts\python.exe" (
  "%STUDIO_ROOT%.venv-kokoro\Scripts\python.exe" "%STUDIO_ROOT%tools\audiobook\studio.py" --model-cache "%STUDIO_ROOT%.studio-models"
) else (
  echo Set up the local Kokoro environment first using tools\audiobook\README.md.
  pause
)
