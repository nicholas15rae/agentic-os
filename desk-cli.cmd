@echo off
rem desk-cli launcher (cmd / PowerShell). Uses the trading venv; no Tauri, no gateway needed.
setlocal
set "HERE=%~dp0"
set "PY=%HERE%trading\.venv\Scripts\python.exe"
if not exist "%PY%" set "PY=python"
"%PY%" "%HERE%trading\desk_cli.py" %*
exit /b %ERRORLEVEL%
