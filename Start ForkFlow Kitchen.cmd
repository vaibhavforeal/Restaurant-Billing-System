@echo off
setlocal
set "ELECTRON_RUN_AS_NODE="
if not exist "%~dp0build\desktop\kitchen\main.js" (
  echo Kitchen build missing. Run npm run build:kitchen first.
  pause
  exit /b 1
)
start "" /D "%~dp0" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0build\desktop\kitchen"
