@echo off
rem One-click launcher: runs start-command-center.ps1 without changing the execution policy.
rem Extra arguments pass through, e.g.  start-command-center.bat -WithDesktopApp
title Command Center launcher
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-command-center.ps1" %*
echo.
timeout /t 300
