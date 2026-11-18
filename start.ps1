<#
.SYNOPSIS
    Agentic OS launcher for Windows (mirrors install.sh + start.sh).

.DESCRIPTION
    First run: creates venv\, upgrades pip, installs requirements.txt,
    creates audit\ backups\ and a default data\settings.json.
    Every run: re-installs deps only when requirements.txt changed, frees the
    dashboard port if a stale Python server holds it, then starts server.py.

.EXAMPLE
    .\start.ps1            # set up if needed, then start the dashboard
    .\start.ps1 -Open      # ...and open it in the default browser
    .\start.ps1 -Install   # force a dependency reinstall
#>
[CmdletBinding()]
param(
    [switch]$Open,
    [switch]$Install
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$Utf8NoBom = New-Object System.Text.UTF8Encoding $false

Write-Host '=== Agentic OS (Windows) ===' -ForegroundColor Cyan

if (-not (Test-Path 'server.py')) {
    Write-Host 'ERROR: server.py not found next to start.ps1.' -ForegroundColor Red
    exit 1
}

# -- Virtual environment (venv\ preferred, .venv\ from install.sh accepted) --
$Python = $null
foreach ($dir in 'venv', '.venv') {
    $candidate = Join-Path $dir 'Scripts\python.exe'
    if (Test-Path $candidate) { $Python = (Resolve-Path $candidate).Path; break }
}

if (-not $Python) {
    $base = $null
    if (Get-Command py -ErrorAction SilentlyContinue) {
        & py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" 2>$null
        if ($LASTEXITCODE -eq 0) { $base = @('py', '-3') }
    }
    if (-not $base -and (Get-Command python -ErrorAction SilentlyContinue)) { $base = @('python') }
    if (-not $base) {
        Write-Host 'ERROR: Python 3.10+ not found. Install it from https://www.python.org/downloads/windows/' -ForegroundColor Red
        exit 1
    }
    Write-Host 'Creating virtual environment in venv\ ...'
    $baseArgs = @($base | Select-Object -Skip 1) + @('-m', 'venv', 'venv')
    & $base[0] @baseArgs
    if ($LASTEXITCODE -ne 0) { Write-Host 'ERROR: venv creation failed.' -ForegroundColor Red; exit 1 }
    $Python = (Resolve-Path 'venv\Scripts\python.exe').Path
    & $Python -m pip install --upgrade pip --quiet
    $Install = $true
}
Write-Host "Python: $(& $Python --version) ($Python)"

# -- Dependencies: reinstall only when requirements.txt changes -------------
$stamp = Join-Path (Split-Path (Split-Path $Python)) '.requirements.sha256'
$reqHash = (Get-FileHash 'requirements.txt' -Algorithm SHA256).Hash
$oldHash = if (Test-Path $stamp) { (Get-Content $stamp -Raw).Trim() } else { '' }
if ($Install -or $reqHash -ne $oldHash) {
    Write-Host 'Installing Python dependencies...'
    & $Python -m pip install -r requirements.txt --quiet --disable-pip-version-check
    if ($LASTEXITCODE -ne 0) { Write-Host 'ERROR: pip install failed.' -ForegroundColor Red; exit 1 }
    [System.IO.File]::WriteAllText($stamp, $reqHash, $Utf8NoBom)
}

# -- Runtime folders + default settings (what install.sh seeds) -------------
foreach ($d in 'audit', 'backups', 'data\kanban') {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d | Out-Null }
}
$settingsFile = Join-Path $PWD 'data\settings.json'
if (-not (Test-Path $settingsFile)) {
    Write-Host 'Creating default data\settings.json'
    $defaults = @'
{
  "theme": "dark",
  "agent_preferences": {
    "opencode": { "enabled": true, "binary": "opencode" },
    "hermes": { "enabled": true, "binary": "hermes" },
    "agy": { "enabled": true, "binary": "agy" }
  },
  "dashboard": { "port": 8080, "host": "127.0.0.1", "dark_mode": true },
  "api_keys": { "gemini": "", "openrouter": "" },
  "free_tier_limits": {
    "gemini_flash": { "requests_per_day": 1500, "tokens_per_day": 1000000 },
    "openrouter_free": { "requests_per_day": 100, "tokens_per_day": 200000 }
  }
}
'@
    # No BOM: Python's json module rejects a UTF-8 BOM.
    [System.IO.File]::WriteAllText($settingsFile, $defaults, $Utf8NoBom)
}

# -- Agent CLIs (optional, like install.sh) ---------------------------------
foreach ($tool in 'node', 'opencode', 'hermes', 'agy') {
    $cmd = Get-Command $tool -ErrorAction SilentlyContinue
    if ($cmd) { Write-Host ("  {0,-9} found  ({1})" -f $tool, $cmd.Source) -ForegroundColor DarkGreen }
    else      { Write-Host ("  {0,-9} not on PATH (agent shows offline)" -f $tool) -ForegroundColor DarkYellow }
}

# -- Port / host from settings (default 127.0.0.1:8080) ---------------------
$Port = 8080
$BindHost = '127.0.0.1'
try {
    $s = Get-Content $settingsFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($s.dashboard.port) { $Port = [int]$s.dashboard.port }
    if ($s.dashboard.host) { $BindHost = [string]$s.dashboard.host }
} catch {
    Write-Host "WARNING: could not parse data\settings.json, using $BindHost`:$Port" -ForegroundColor DarkYellow
}

# -- Free the port if a stale Python server holds it (start.sh uses lsof) ---
$listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique
foreach ($procId in $listeners) {
    $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if (-not $proc) { continue }
    if ($proc.ProcessName -match '^pythonw?$') {
        Write-Host "Port $Port held by stale $($proc.ProcessName) (PID $procId) - stopping it."
        Stop-Process -Id $procId -Force
        Start-Sleep -Seconds 1
    } else {
        Write-Host "ERROR: port $Port is used by $($proc.ProcessName) (PID $procId). Change dashboard.port in data\settings.json." -ForegroundColor Red
        exit 1
    }
}

# UTF-8 mode: brain/skill files and agent CLI output are UTF-8, and the
# Windows default codepage (cp1252) would garble or reject them.
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'

$Url = "http://127.0.0.1:$Port"
Write-Host ''
Write-Host "Dashboard: $Url" -ForegroundColor Green
Write-Host 'Press Ctrl+C to stop'
Write-Host ''

if ($Open) {
    Start-Job -ScriptBlock { param($u) Start-Sleep -Seconds 3; Start-Process $u } -ArgumentList $Url | Out-Null
}

& $Python server.py --port $Port --host $BindHost
exit $LASTEXITCODE
