@echo off
rem Agentic OS launcher for Windows - double-click or run from cmd.
rem All logic lives in start.ps1; flags pass through (e.g. start.bat -Open).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
exit /b %ERRORLEVEL%
