@echo off
cd /d "%~dp0"
start "Socials Organizer" /min cmd /c "node src\server.js"
timeout /t 1 /nobreak >nul
start "" http://localhost:3000
