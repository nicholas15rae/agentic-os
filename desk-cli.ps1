# desk-cli launcher for PowerShell: .\desk-cli.ps1 status --json
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$py = Join-Path $here "trading\.venv\Scripts\python.exe"
if (-not (Test-Path $py)) { $py = "python" }
& $py (Join-Path $here "trading\desk_cli.py") @args
exit $LASTEXITCODE
