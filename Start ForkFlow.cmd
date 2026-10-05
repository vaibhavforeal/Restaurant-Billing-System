@echo off
setlocal
rem Always launch the built app with Electron, not Windows Script Host.
set "ELECTRON_RUN_AS_NODE="
if not exist "%~dp0node_modules\electron\dist\electron.exe" (
  echo Electron is missing. Run npm ci, then node node_modules/electron/install.js.
  pause
  exit /b 1
)
rem Internal development stage. Use Start ForkFlow Customer.cmd for licensing.
set "FORKFLOW_DESKTOP_APP=%~dp0build\desktop\app"
if not exist "%FORKFLOW_DESKTOP_APP%\main.js" (
  echo The desktop build is missing. Run npm run build:desktop first.
  pause
  exit /b 1
)
start "" /D "%~dp0" "%~dp0node_modules\electron\dist\electron.exe" "%FORKFLOW_DESKTOP_APP%"
exit /b %errorlevel%
