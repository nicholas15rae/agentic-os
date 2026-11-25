<#
=============================================================================
 stop-command-center.ps1 - stop the Command Center backend cleanly

     Stop Command Center.lnk  ->  scripts\stop-command-center.bat  ->  this file

 Default: closes the desktop app (its keep-alive would restart the gateway and
 Whisper), then stops every process recorded in logs\command-center.pids.json
 plus the Command Center's own servers, found by port and checked by command
 line so nothing else is touched:
   gateway server.py :8080/:8443, trading bridge :8091, Whisper :8178/:8179,
   Quantgress :8000
 Shared tools (Bionic / LM Studio, AnythingLLM, Ollama, Docker) keep running
 unless they were started by start-command-center.ps1 or -Everything is given.

 Switches:
   -Everything       also stop Bionic, AnythingLLM, Ollama, llama-server :1236
                     and Docker Desktop (Kokoro + n8n come back when Docker starts)
   -KeepDesktopApp   leave the desktop app open
   -DryRun           only list what would be stopped
=============================================================================
#>
param([switch]$Everything, [switch]$KeepDesktopApp, [switch]$DryRun)
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'cc-common.ps1')
function Stop-Target([int]$procId, [string]$why) { if ($DryRun) { return $true }; Stop-CcTree $procId $why }
$LAUNCH_LOG = Join-Path $CC_LOG_DIR 'launcher.log'
function Say([string]$msg, [string]$color = 'Gray') { Write-Host $msg -ForegroundColor $color; Write-CcLog $LAUNCH_LOG "[stop] $msg" }

Say ''
Say ('=' * 78) 'Cyan'
Say ("  STOPPING COMMAND CENTER   {0}{1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $(if ($Everything) { '   (-Everything)' })) 'Cyan'
Say ('=' * 78) 'Cyan'
$rows = [System.Collections.ArrayList]@()
function Add-Row([string]$name, [string]$result, [string]$color) { [void]$rows.Add([pscustomobject]@{ Name = $name; Result = $result; Color = $color }) }

# 1. Desktop app first, or it restarts the gateway / Whisper within minutes.
if (-not $KeepDesktopApp) {
    $app = @(Get-Process -Name 'command-center' -ErrorAction SilentlyContinue)
    if ($app.Count) {
        if (-not $DryRun) { foreach ($p in $app) { [void]$p.CloseMainWindow() } }
        Start-Sleep -Seconds 3
        $app = @(Get-Process -Name 'command-center' -ErrorAction SilentlyContinue)
        foreach ($p in $app) { [void](Stop-Target $p.Id 'app') }
        Add-Row 'Desktop app' 'closed' 'Green'
    } else { Add-Row 'Desktop app' 'not running' 'DarkGray' }
}

# 2. Core servers, by port, verified by command line / executable.
$core = @(
    @{ Name = 'Gateway (server.py)';  Ports = @($GATEWAY_PORT, $CC_HTTPS_PORT); Match = 'server\.py' }
    @{ Name = 'Trading bridge';       Ports = @($CC_BRIDGE_PORT);                Match = 'ibkr_bridge\.py' }
    @{ Name = 'Whisper STT';          Ports = @(8178, 8179);                     Match = 'whisper-server' }
    @{ Name = 'Quantgress API';       Ports = @($QUANTGRESS_PORT);               Match = 'uvicorn\s+api:app' }
)
if ($Everything) {
    $core += @{ Name = 'Ollama';              Ports = @($OLLAMA_PORT);    Match = 'ollama' }
    $core += @{ Name = 'llama-server (Tony)'; Ports = @($INSTANCE2_PORT); Match = 'llama-server' }
}
foreach ($c in $core) {
    $stopped = @(); $foreign = @()
    foreach ($port in $c.Ports) {
        foreach ($procId in Get-ListenPids $port) {
            $ci = Get-ProcInfo $procId
            $id = "$($ci.Name) $($ci.CommandLine)"
            if ($id -match $c.Match) { if (Stop-Target $procId $c.Name) { $stopped += $procId } }
            else { $foreign += "$port held by $($ci.Name) (left alone)" }
        }
    }
    if ($stopped.Count) { Add-Row $c.Name ("stopped pid " + (($stopped | Select-Object -Unique) -join ', ')) 'Green' }
    elseif ($foreign.Count) { Add-Row $c.Name ($foreign -join '; ') 'Yellow' }
    else { Add-Row $c.Name 'not running' 'DarkGray' }
}
if ($Everything -and -not $DryRun) {
    # Ollama's tray app respawns the server; stop both.
    Get-Process -Name 'ollama app' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}

# 3. Anything else this launcher started (GUI apps, Docker Desktop), by recorded PID.
$entries = @(Read-PidFile)
foreach ($e in $entries) {
    if (-not (Test-PidEntryAlive $e)) { continue }
    $ok = Stop-Target $e.pid "launcher:$($e.name)"
    Add-Row "$($e.name) (launcher pid $($e.pid))" $(if ($ok) { 'stopped' } else { 'could not stop' }) $(if ($ok) { 'Green' } else { 'Red' })
}
if (-not $DryRun) { Write-PidFile @() }

# 4. -Everything: shared GUI tools even if something else started them.
if ($Everything -and $DryRun) { Add-Row 'Bionic, AnythingLLM, Docker Desktop' 'would be stopped' 'Yellow' }
elseif ($Everything) {
    foreach ($g in @(@{ N = 'Bionic / LM Studio'; P = 'Bionic' }, @{ N = 'AnythingLLM'; P = 'AnythingLLM' })) {
        $ps = @(Get-Process -Name $g.P -ErrorAction SilentlyContinue)
        if ($ps.Count) {
            if ($g.P -eq 'Bionic') {
                # Unload models first so VRAM is released cleanly.
                try {
                    $ids = (Invoke-RestMethod "http://127.0.0.1:$BIONIC_PORT/api/v1/models" -TimeoutSec 4).models |
                        Where-Object { $_.loaded_instances.Count } | ForEach-Object { $_.loaded_instances.id }
                    foreach ($i in $ids) { Invoke-RestMethod "http://127.0.0.1:$BIONIC_PORT/api/v1/models/unload" -Method Post -ContentType 'application/json' -Body (@{ instance_id = $i } | ConvertTo-Json) -TimeoutSec 30 | Out-Null }
                } catch { }
            }
            $ps | Stop-Process -Force -ErrorAction SilentlyContinue
            Add-Row $g.N 'stopped' 'Green'
        } else { Add-Row $g.N 'not running' 'DarkGray' }
    }
    # Quit Docker Desktop rather than "docker stop": stopped containers would not come back at
    # the next logon (restart=unless-stopped), while quitting the engine keeps them set to restart.
    $dd = Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue
    if ($dd -and (Get-Command docker -ErrorAction SilentlyContinue)) {
        & docker desktop stop 2>&1 | Out-Null
        Add-Row 'Docker Desktop (Kokoro, n8n)' $(if ($LASTEXITCODE -eq 0) { 'stopped' } else { "docker desktop stop exit $LASTEXITCODE" }) $(if ($LASTEXITCODE -eq 0) { 'Green' } else { 'Yellow' })
    } else { Add-Row 'Docker Desktop (Kokoro, n8n)' 'not running' 'DarkGray' }
}

if ($DryRun) {
    Say ''
    foreach ($r in $rows) { Say ('  {0,-40} {1}' -f $r.Name, ($r.Result -replace '^stopped', 'would stop' -replace '^closed$', 'would close')) $r.Color }
    Say ''; Say '  Dry run: nothing was stopped.' 'Cyan'; exit 0
}
# 5. Verify the ports are free.
Start-Sleep -Seconds 1
$ports = @($GATEWAY_PORT, $CC_HTTPS_PORT, $CC_BRIDGE_PORT, 8178, 8179, $QUANTGRESS_PORT)
if ($Everything) { $ports += @($BIONIC_PORT, $ANYTHINGLLM_PORT, $OLLAMA_PORT, $INSTANCE2_PORT, 8880, 5678) }
$open = @($ports | Where-Object { Test-Listening $_ })

Say ''
foreach ($r in $rows) { Say ('  {0,-40} {1}' -f $r.Name, $r.Result) $r.Color }
Say ''
if ($open.Count) {
    foreach ($p in $open) {
        $o = Get-ListenPids $p | ForEach-Object { (Get-Process -Id $_ -ErrorAction SilentlyContinue).ProcessName }
        Say ("  port {0} still open ({1})" -f $p, ($o -join ', ')) 'Yellow'
    }
    if (-not $Everything) { Say '  (Bionic, AnythingLLM, Ollama and Docker are left running unless -Everything is used.)' 'DarkGray' }
} else { Say '  All Command Center ports are closed.' 'Green' }
if (-not $Everything) {
    $shared = @(@{ N = 'Bionic'; P = $BIONIC_PORT }, @{ N = 'AnythingLLM'; P = $ANYTHINGLLM_PORT }, @{ N = 'Ollama'; P = $OLLAMA_PORT }, @{ N = 'Kokoro'; P = 8880 }, @{ N = 'n8n'; P = 5678 }) |
        Where-Object { Test-Listening $_.P } | ForEach-Object { $_.N }
    if ($shared) { Say ("  Still running (shared tools): {0}. Use -Everything to stop them too." -f ($shared -join ', ')) 'DarkGray' }
}
exit 0
