@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
set RC=%ERRORLEVEL%
:: La finestra con l'URL non deve chiudersi subito, nemmeno in caso di successo.
pause
exit /b %RC%
