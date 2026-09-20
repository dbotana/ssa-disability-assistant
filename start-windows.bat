@echo off
REM Double-click this file to run the assistant on this PC.
cd /d "%~dp0"

REM The py launcher is tried first on purpose. Windows ships a fake "python"
REM that only opens the Microsoft Store, so asking each candidate for its
REM version is the only reliable way to tell a real interpreter from the stub.
py -3 --version >nul 2>&1 && (
  py -3 tools\serve.py
  goto :eof
)

python3 --version >nul 2>&1 && (
  python3 tools\serve.py
  goto :eof
)

python --version >nul 2>&1 && (
  python tools\serve.py
  goto :eof
)

node --version >nul 2>&1 && (
  node tools\serve.mjs
  goto :eof
)

echo.
echo   This PC does not have Python or Node installed, so the assistant
echo   cannot run locally.
echo.
echo   You can use it in your browser instead, with nothing to install:
echo.
echo       https://dbotana.github.io/ssa-disability-assistant/
echo.
echo   Or install Python from https://www.python.org/downloads/ and
echo   double-click this file again. Tick "Add python.exe to PATH"
echo   in the installer.
echo.
pause
