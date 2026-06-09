@echo off
title PhoneBridge - Build Distributable .exe (with embedded icon)
cd /d "%~dp0"

cls
echo.
echo  .----------------------------------------------------------.
echo  ^| [ PHONEBRIDGE.SYS ]                          [ BUILDING ] ^|
echo  '----------------------------------------------------------'
echo.
echo  This builds PhoneBridge.exe with the gradient PB icon
echo  embedded into the file so it shows in File Explorer for
echo  anyone you share the .exe with.
echo.
echo  First build: ~3-5 minutes (downloads Node 18 base binary, ~40 MB)
echo  Later builds: ~30 seconds
echo.
pause

where node >nul 2>nul
if errorlevel 1 (
  echo  [ FAIL ] Node.js is not installed. Get it from https://nodejs.org/
  pause
  exit /b 1
)

echo.
echo  ==========================================================
echo  [1/4] Installing dependencies...
echo  ==========================================================
echo.

if not exist node_modules\qrcode (
  call npm install --no-audit --no-fund --loglevel=error
  if errorlevel 1 (
    echo  [ FAIL ] npm install failed.
    pause
    exit /b 1
  )
)

if not exist node_modules\@yao-pkg (
  call npm install @yao-pkg/pkg --save-dev --no-audit --no-fund --loglevel=error
  if errorlevel 1 (
    echo  [ FAIL ] Could not install pkg.
    pause
    exit /b 1
  )
)

if not exist node_modules\rcedit (
  call npm install rcedit --save-dev --no-audit --no-fund --loglevel=error
  if errorlevel 1 (
    echo  [ FAIL ] Could not install rcedit.
    pause
    exit /b 1
  )
)

echo  [ ok ] Dependencies installed.
echo.

echo  ==========================================================
echo  [2/4] Inlining assets into embedded.js...
echo  ==========================================================
echo.
call node prepare.js
if errorlevel 1 (
  echo  [ FAIL ] prepare.js failed.
  pause
  exit /b 1
)
echo.

echo  ==========================================================
echo  [3/4] Compiling PhoneBridge.exe with the PB icon embedded...
echo  ==========================================================
echo.
echo  (The icon is embedded into the base Node binary BEFORE pkg
echo   appends its payload - the only way that keeps the .exe both
echo   runnable AND showing the PB icon.)
echo.
if exist dist\PhoneBridge.exe del /q dist\PhoneBridge.exe
call node build-with-icon.js
if errorlevel 1 (
  echo  [ FAIL ] build-with-icon.js failed.
  pause
  exit /b 1
)

if not exist dist\PhoneBridge.exe (
  echo  [ FAIL ] Build did not produce dist\PhoneBridge.exe
  pause
  exit /b 1
)
echo  [ ok ] Compiled successfully with embedded icon.
echo.

echo  ==========================================================
echo  [4/4] Verifying the build...
echo  ==========================================================
echo.
call node verify-build.js
if errorlevel 1 (
  echo  [ WARN ] Verification reported a problem - see above.
)
echo.

echo  +============================================================+
echo  ^|                  [ BUILD COMPLETE ]                         ^|
echo  +============================================================+
echo.
echo     dist\PhoneBridge.exe
echo.
for %%I in (dist\PhoneBridge.exe) do echo     Size:  %%~zI bytes
echo.
echo  Test it:
echo    1. Look at the .exe in File Explorer (should show PB icon)
echo    2. Double-click it - should launch normally
echo.
echo  Opening the dist folder...
explorer dist
echo.
pause
