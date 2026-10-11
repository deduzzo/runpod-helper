@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1" %*
set RC=%ERRORLEVEL%
if not "%RC%"=="0" pause
exit /b %RC%
