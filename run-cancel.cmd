@echo off
REM ============================================================
REM  yt-automation — wrapper that runs cancel-addons.mjs
REM  Used directly and by Windows Task Scheduler.
REM  Everything is relative to this file's folder, so this
REM  project folder can live anywhere on disk.
REM ============================================================
set "SCRIPT_DIR=%~dp0"
"%SystemRoot%\System32\where.exe" node >nul 2>nul
if errorlevel 1 (
  echo [yt-automation] node.exe not found on PATH. Install Node.js first.
  exit /b 1
)
node "%SCRIPT_DIR%cancel-addons.mjs" %*
exit /b %errorlevel%
