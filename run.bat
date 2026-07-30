@echo off
REM Starts the dashboard server in its own window, then opens it in your browser.

cd /d "%~dp0"

start "NFL Fantasy Dashboard" cmd /k python src\dashboard_server.py

timeout /t 2 /nobreak >nul
start "" http://localhost:8000
