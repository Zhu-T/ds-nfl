@echo off
REM ===========================================================================
REM  ds-nfl launcher  -  starts the app and opens it at http://localhost:3000
REM
REM    run.bat           start the app
REM    run.bat build     production build, then serve it
REM ===========================================================================

cd /d "%~dp0"

if /i "%~1"=="build" goto :prod
if /i "%~1"=="--help" goto :help
if /i "%~1"=="-h" goto :help
if not "%~1"=="" goto :badarg

set "MODE=dev"
set "NPMCMD=dev"
goto :launch

:prod
set "MODE=production"
set "NPMCMD=start"

:launch

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is not on PATH. Install Node 20 or newer and run this again:
  echo     https://nodejs.org
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Installing dependencies. This only happens once.
  echo.
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo npm install failed - see the output above.
    pause
    exit /b 1
  )
  echo.
)

REM curl.exe ships with Windows 10 1803 and later.
where curl >nul 2>&1
if errorlevel 1 goto :nocurl

REM If something already answers on 3000, open that rather than starting a
REM second server. Next would silently fall back to port 3001 and the browser
REM would then be pointed at the wrong place.
curl -s -o nul -m 2 http://localhost:3000/ >nul 2>&1
if not errorlevel 1 (
  echo A server is already running on port 3000. Opening it.
  start "" http://localhost:3000
  exit /b 0
)

if /i "%MODE%"=="production" (
  echo Building for production...
  call npm run build
  if errorlevel 1 (
    echo.
    echo Build failed - see the output above.
    pause
    exit /b 1
  )
  echo.
)

echo Starting ds-nfl ^(%MODE%^)...
start "ds-nfl" cmd /k npm run %NPMCMD%

REM Poll until the server actually answers. A fixed wait is never right: a
REM first-run dev compile took 13 seconds on this machine.
set /a TRIES=0
:waitloop
set /a TRIES+=1
curl -s -o nul -m 2 http://localhost:3000/ >nul 2>&1
if not errorlevel 1 goto :ready
if %TRIES% geq 90 goto :timeout
ping -n 2 127.0.0.1 >nul
goto :waitloop

:ready
echo Ready. Opening http://localhost:3000
start "" http://localhost:3000
exit /b 0

:timeout
echo.
echo The server did not respond within 90 seconds.
echo Check the "ds-nfl" window for the actual error.
pause
exit /b 1

:nocurl
echo Starting ds-nfl ^(%MODE%^)...
start "ds-nfl" cmd /k npm run %NPMCMD%
echo Waiting for the first compile...
ping -n 21 127.0.0.1 >nul
start "" http://localhost:3000
exit /b 0

:badarg
echo Unknown option: %~1
echo.
call :printusage
exit /b 1

:help
call :printusage
exit /b 0

:printusage
echo Usage:
echo     run.bat           start the app         http://localhost:3000
echo     run.bat build     production build, then serve it
goto :eof
