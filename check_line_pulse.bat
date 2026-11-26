@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 24 LTS first.
  exit /b 1
)
call npm ci
if errorlevel 1 exit /b 1
call npm run build
if errorlevel 1 exit /b 1
call npm run line-pulse -- preflight
if errorlevel 1 exit /b 1
call npm test
if errorlevel 1 exit /b 1
echo Offline checks passed. No PLC was contacted.
pause
