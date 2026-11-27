<#
=============================================================================
 start-tws.ps1 - open IBKR Trader Workstation (TWS) for the paper trading desk

 Called by the logon task (G:\ai-startup\start-ai-stack.ps1) and by
 start-command-center.ps1. Safe to run any number of times:

   API port 7497 listening -> nothing to do: TWS is up and logged in
   TWS already open        -> not started twice: it is waiting for your login
   otherwise               -> opens TWS with its login window visible

 You log in yourself (choose Paper Trading). No credentials are stored here.
 The trading bridge (127.0.0.1:8091) retries on its own and connects within
 about a minute of the API port opening. Turn on TWS's own "Auto restart"
 (Global Configuration -> Lock and Exit) so the nightly restart keeps you
 logged in; IBKR still asks for a full login about once a week and after a reboot.

 Switches:
   -WaitForLoginSec N   after opening, wait up to N seconds for the API port
   -DryRun              only report the state; open nothing

 Exit codes: 0 API up, 2 TWS open and waiting for login (or just opened),
             1 TWS not installed / failed to open.
 Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less files as ANSI.
=============================================================================
#>
param(
    [int]$WaitForLoginSec = 0,
    [switch]$DryRun
)
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'cc-common.ps1')

$TWS_LOG = Join-Path $CC_LOG_DIR 'tws-start.log'
function Out-Tws([string]$msg) { Write-CcLog $TWS_LOG $msg; Write-Output $msg }

if (Test-Listening $TWS_API_PORT) {
    Out-Tws "TWS API is listening on 127.0.0.1:$TWS_API_PORT (logged in); nothing to do"
    exit 0
}
$running = Get-TwsProcess
if ($running.Count) {
    Out-Tws "TWS is open (pid $($running[0].ProcessId)) but its API port $TWS_API_PORT is closed: log in to the PAPER account"
    $code = 2
} elseif ($DryRun) {
    Out-Tws "TWS is not running; it would be opened from $TWS_EXE (dry run)"
    exit 2
} elseif (-not (Test-Path $TWS_EXE)) {
    Out-Tws "TWS NOT opened: $TWS_EXE is missing (set `$TWS_EXE in G:\ai-startup\ai-stack.config.ps1)"
    exit 1
} else {
    try {
        Start-Process -FilePath $TWS_EXE -WorkingDirectory (Split-Path $TWS_EXE -Parent) -ErrorAction Stop | Out-Null
        Out-Tws "TWS opened from ${TWS_EXE}: log in to the PAPER account (the trading bridge connects by itself)"
        $code = 2
    } catch {
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
    Out-Tws "TWS still waiting for login after ${WaitForLoginSec}s"
}
exit $code
