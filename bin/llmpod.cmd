@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0llmpod.ps1" %*
exit /b %ERRORLEVEL%
