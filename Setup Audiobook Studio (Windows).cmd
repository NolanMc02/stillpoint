@echo off
setlocal
cd /d "%~dp0"
py -3.12 -c "import sys; assert sys.version_info[:2] == (3, 12)" >nul 2>&1
if errorlevel 1 (
  echo Python 3.12 is required. Install it from python.org first.
  echo With the Python install manager, run: py install 3.12
  echo Then double-click this setup file again.
  pause
  exit /b 1
)
py -3.12 tools\audiobook\setup_windows.py
if errorlevel 1 (
  echo.
  echo Setup did not finish. Keep the error above for troubleshooting.
  pause
  exit /b 1
)
echo.
echo Setup finished. Double-click Open Audiobook Studio.cmd to start.
pause
