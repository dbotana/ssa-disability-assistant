@echo off
REM Double-click this file to run the assistant on this PC.
cd /d "%~dp0"

REM The py launcher is tried first on purpose. Windows ships a fake "python"
REM that only opens the Microsoft Store, so asking each candidate for its
REM version is the only reliable way to tell a real interpreter from the stub.
REM
REM A server that stops by itself (a changed model file, no free port)
REM has printed why; pause so the window stays open long enough to read it.
py -3 --version >nul 2>&1 && (
  py -3 tools\serve.py
  if errorlevel 1 pause
  goto :eof
)

python3 --version >nul 2>&1 && (
  python3 tools\serve.py
  if errorlevel 1 pause
  goto :eof
)

python --version >nul 2>&1 && (
  python tools\serve.py
  if errorlevel 1 pause
  goto :eof
)

node --version >nul 2>&1 && (
  node tools\serve.mjs
  if errorlevel 1 pause
  goto :eof
)

echo.
echo   This PC does not have Python or Node installed, so the assistant
echo   cannot start.
echo.
echo   Install Python from https://www.python.org/downloads/ and
echo   double-click this file again. Tick "Add python.exe to PATH"
echo   in the installer.
echo.
echo   (This version runs only on your own computer, so that what you say
echo   never leaves it. There is no web address to use instead.)
echo.
pause
