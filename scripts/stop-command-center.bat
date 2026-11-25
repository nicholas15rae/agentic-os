@echo off
rem Stops the Command Center backend. Extra arguments pass through, e.g.  -Everything
title Command Center shutdown
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-command-center.ps1" %*
echo.
timeout /t 60
