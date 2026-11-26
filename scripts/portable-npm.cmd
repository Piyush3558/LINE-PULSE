@echo off
setlocal
set "NODE_HOME=%~dp0runtime"
if not exist "%NODE_HOME%\node.exe" (
    echo The portable Node.js runtime is missing. Extract all files from the Line Pulse ZIP first.
    exit /b 1
)
set "PATH=%NODE_HOME%;%PATH%"
"%NODE_HOME%\node.exe" "%NODE_HOME%\node_modules\npm\bin\npm-cli.js" %*
exit /b %ERRORLEVEL%
