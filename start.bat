@echo off
cd /d "%~dp0"
call "..\Node_js\npm.cmd" run dev -- --host 0.0.0.0
pause