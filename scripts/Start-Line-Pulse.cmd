@echo off
setlocal
pushd "%~dp0"
if errorlevel 1 exit /b 1
echo Starting Line Pulse. Open http://127.0.0.1:5173 after the frontend is ready.
call "%~dp0npm.cmd" run dev
set "LP_EXIT=%ERRORLEVEL%"
popd
if not "%LP_EXIT%"=="0" pause
exit /b %LP_EXIT%
