@echo off
chcp 65001 >nul 2>&1
node "%~dp0build-portable.js"
pause
