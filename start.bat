@echo off
cd /d "%~dp0"
call "..\Node_js\npm.cmd" run dev
pause
