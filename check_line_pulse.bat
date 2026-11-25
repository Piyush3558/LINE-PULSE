@echo off
setlocal
cd /d "%~dp0"

where py >nul 2>nul
if not errorlevel 1 (
  set "LP_PYTHON=py -3"
) else (
  where python >nul 2>nul
  if errorlevel 1 (
    echo Python was not found. Install Python 3.10 or newer.
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
%LP_PYTHON% -m unittest discover -s fx5-readonly-collector -p "test_*.py"
if errorlevel 1 (
  pause
  exit /b 1
)
%LP_PYTHON% -m unittest discover -s fx5-live-dashboard -p "test_*.py"
if errorlevel 1 (
  pause
  exit /b 1
)
echo.
echo Offline project checks passed. No PLC was contacted.
pause
endlocal
