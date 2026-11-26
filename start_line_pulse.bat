@echo off
setlocal
cd /d "%~dp0"
if not exist ".env" (
  echo Run setup_windows.bat first. See README.md.
  pause
  exit /b 1
)
if not exist "frontend\dist\index.html" (
  call npm run build
  if errorlevel 1 exit /b 1
)
call npm run line-pulse -- preflight
if errorlevel 1 exit /b 1
call npm run line-pulse -- db-check
if errorlevel 1 exit /b 1
echo Open http://127.0.0.1:8765 in your browser.
call npm run start:local
