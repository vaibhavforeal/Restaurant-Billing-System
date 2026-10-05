@echo off
setlocal
set "ELECTRON_RUN_AS_NODE="
if not exist "%~dp0node_modules\electron\dist\electron.exe" (
  echo Electron is missing. Run npm ci, then node node_modules/electron/install.js.
  pause
  exit /b 1
)
if not exist "%~dp0build\desktop\commercial\main.js" (
  echo Customer build missing. Configure FORKFLOW_LICENSE_PUBLIC_KEY and run npm run build:commercial.
  pause
  exit /b 1
)
start "" /D "%~dp0" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0build\desktop\commercial"
