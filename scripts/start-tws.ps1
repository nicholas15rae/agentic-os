<#
.SYNOPSIS
 start-tws.ps1 - open IBKR Trader Workstation (TWS) for the paper trading desk

.DESCRIPTION
 Called by the logon task (G:\ai-startup\start-ai-stack.ps1) and by
 start-command-center.ps1. Safe to run any number of times:

   API port 7497 listening -> nothing to do: TWS is up and logged in
   tws.exe already running -> NEVER started twice: it is waiting for your login
                              (also when it runs elevated or from another folder)
   opened < 3 min ago      -> not started twice either (two launchers at once)
   otherwise               -> opens TWS with its login window visible

 You log in yourself (choose Paper Trading). No credentials are stored here,
 and IBKR offers no supported unattended login, so after a reboot or the
 weekly re-login someone types the password. The trading bridge
 (127.0.0.1:8091) retries on its own (2-60 s backoff) and connects within
 about a minute of the API port opening. Turn on TWS's own "Auto restart"
 (Global Configuration -> Lock and Exit) so the nightly restart keeps you
 logged in.

 TWS API settings the bridge needs (Global Configuration -> API -> Settings):
   * Enable ActiveX and Socket Clients: ticked
   * Socket port: 7497 (paper; the live port 7496 is never dialled)
   * Allow connections from localhost only: ticked; Trusted IPs: 127.0.0.1
   * Read-Only API: fine for the read-only bridge, but paper ORDERS need it
     unticked (TWS rejects them with error 321 "API is in Read-Only mode")

.PARAMETER WaitForLoginSec
 After opening, wait up to N seconds for the API port.

.PARAMETER DryRun
 Only report the state; open nothing.

.NOTES
 Exit codes: 0 API up, 2 TWS open and waiting for login (or just opened),
             1 TWS not installed / failed to open.
 Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less files as ANSI.
#>
param(
    [int]$WaitForLoginSec = 0,
    [switch]$DryRun
)
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'cc-common.ps1')

$TWS_LOG  = Join-Path $CC_LOG_DIR 'tws-start.log'
$TWS_MARK = Join-Path $CC_LOG_DIR 'tws-start.opened'   # stamp of the last launch: guards two launchers racing
$TWS_MARK_FRESH_SEC = 180
$TWS_SETTINGS_HINT = "TWS API settings: Enable ActiveX and Socket Clients, socket port $TWS_API_PORT, localhost only + Trusted IP 127.0.0.1 (Read-Only API blocks paper orders)"
function Out-Tws([string]$msg) { Write-CcLog $TWS_LOG $msg; Write-Output $msg }

if (Test-Listening $TWS_API_PORT) {
    $inst = @(Get-TwsProcess | Where-Object { $_.Name -eq 'tws.exe' })
    $extra = if ($inst.Count -gt 1) { "; NOTE $($inst.Count) TWS windows are open (pids $(($inst | ForEach-Object ProcessId) -join ', ')): close the one still at its login screen" } else { '' }
    Out-Tws "TWS API is listening on 127.0.0.1:$TWS_API_PORT (logged in); nothing to do$extra"
    exit 0
}
$running = @(Get-TwsProcess)
$inst = @($running | Where-Object { $_.Name -eq 'tws.exe' })
if (-not $inst.Count) { $inst = $running }
$markAge = if (Test-Path $TWS_MARK) { ((Get-Date) - (Get-Item $TWS_MARK).LastWriteTime).TotalSeconds } else { [double]::MaxValue }
if ($inst.Count) {
    $pids = ($inst | ForEach-Object { $_.ProcessId }) -join ', '
    $many = if ($inst.Count -gt 1) { " ($($inst.Count) instances: close all but one)" } else { '' }
    Out-Tws "TWS is open (pid $pids)$many but its API port $TWS_API_PORT is closed: waiting for login to the PAPER account. If you are logged in, check $TWS_SETTINGS_HINT"
    $code = 2
} elseif ($markAge -lt $TWS_MARK_FRESH_SEC) {
    Out-Tws "TWS was opened $([int]$markAge)s ago and is still starting: waiting for login (not opened twice)"
    $code = 2
} elseif ($DryRun) {
    Out-Tws "TWS is not running; it would be opened from $TWS_EXE (dry run)"
    exit 2
} elseif (-not (Test-Path $TWS_EXE)) {
    Out-Tws "TWS NOT opened: $TWS_EXE is missing (set `$TWS_EXE in G:\ai-startup\ai-stack.config.ps1)"
    exit 1
} else {
    try {
        Set-Content -Path $TWS_MARK -Value (Get-Date -Format o) -Encoding ASCII
        Start-Process -FilePath $TWS_EXE -WorkingDirectory (Split-Path $TWS_EXE -Parent) -ErrorAction Stop | Out-Null
        Out-Tws "TWS opened from ${TWS_EXE}: log in to the PAPER account (the trading bridge connects by itself)"
        $code = 2
    } catch {
        Remove-Item $TWS_MARK -ErrorAction SilentlyContinue
        Out-Tws "TWS failed to open: $($_.Exception.Message)"
        exit 1
    }
}

if ($WaitForLoginSec -gt 0 -and -not $DryRun) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt $WaitForLoginSec) {
        if (Test-Listening $TWS_API_PORT) { Out-Tws "TWS API port $TWS_API_PORT open after $([int]$sw.Elapsed.TotalSeconds)s"; exit 0 }
        Start-Sleep -Seconds 3
    }
    Out-Tws "TWS still waiting for login after ${WaitForLoginSec}s ($TWS_SETTINGS_HINT)"
}
exit $code
