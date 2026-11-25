@echo off
setlocal
cd /d "%~dp0"

if not exist "fx5-live-dashboard\server.py" (
  echo Line Pulse project files are incomplete. Keep both project folders together.
  pause
  exit /b 1
)

where py >nul 2>nul
if not errorlevel 1 (
  set "LP_PYTHON=py -3"
) else (
  where python >nul 2>nul
  if errorlevel 1 (
    echo Python was not found. Install Python 3.10 or newer, then run this file again.
    pause
    exit /b 1
  )
  set "LP_PYTHON=python"
)

%LP_PYTHON% windows_preflight.py
if errorlevel 1 (
  pause
  exit /b 1
)

echo.
echo Open http://127.0.0.1:8765 in a browser on this PC.
echo Use Check connection, then Start collection. Leave this window open.
echo Stop collection in the dashboard before pressing Ctrl+C here.
echo.
%LP_PYTHON% fx5-live-dashboard\server.py
if errorlevel 1 (
  echo.
  echo Line Pulse stopped with an error. Check the message above.
  pause
  exit /b 1
)
endlocal
