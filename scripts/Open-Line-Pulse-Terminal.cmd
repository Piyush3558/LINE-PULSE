@echo off
setlocal
pushd "%~dp0"
if errorlevel 1 exit /b 1
set "PATH=%~dp0runtime;%PATH%"
echo Type npm run dev to start Line Pulse, then open http://127.0.0.1:5173.
"%ComSpec%" /d /k
popd
