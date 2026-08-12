@echo off
REM Starts the dashboard server in its own window, then opens it in your browser.
REM python -u keeps logs unbuffered so they show immediately in that console.

cd /d "%~dp0"

start "NFL Fantasy Dashboard" cmd /k python -u src\dashboard_server.py

timeout /t 2 /nobreak >nul
start "" http://localhost:8000
