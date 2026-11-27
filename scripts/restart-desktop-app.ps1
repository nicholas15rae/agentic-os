<#
=============================================================================
 restart-desktop-app.ps1 - restart the Command Center desktop app safely

   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\restart-desktop-app.ps1 [-Hide] [-Exe <path>]

 1. Stops every running command-center.exe (the process only, never its tree: servers the app
    started itself, such as a gateway or STT it re-spawned, keep running) and its WebView2
    processes, found by the app's own WebView2 folder.
 2. Waits until the app and all of its WebView2 processes are gone (Wait-CcAppGone in
    cc-common.ps1). A start while the last instance's WebView2 is still exiting can abort
    at start-up (0xc0000409, seen 2026-11-26 20:42).
 3. Starts the exe detached (WMI), like the launcher, and waits for a NEW app_start line in
    data\security\security_audit.jsonl (the app writes it once its window and webview exist).
 4. If the new process dies first: prints what it added to panic.log, waits again and
    retries once. A launch handed to an instance that is still running counts as up.
 5. -Hide closes the window to the tray once the app is up (the engine keeps running).

 Run from inside the app (a Claude fix run is in the app's job and dies with it), it first
 re-launches itself detached and exits.
 Leaves the gateway, Bionic, STT and every other service alone.
 Exit 0 = the app is up; 1 = it would not start (see panic.log and logs\launcher.log).
 Keep this file ASCII-only (Windows PowerShell 5.1 reads BOM-less files as ANSI).
=============================================================================
#>
param([switch]$Hide, [string]$Exe = '', [int]$StartTimeoutSec = 30, [switch]$Detached)
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'cc-common.ps1')
$LAUNCH_LOG = Join-Path $CC_LOG_DIR 'launcher.log'
function Say([string]$msg, [string]$color = 'Gray') { Write-Host $msg -ForegroundColor $color; Write-CcLog $LAUNCH_LOG "[restart-app] $msg" }

# Is a command-center.exe among this process's ancestors? (Then killing the app kills this script.)
function Test-UnderApp([int]$procId = $PID) {
    $seen = @{}
    $cur = Get-ProcInfo $procId
    while ($cur -and -not $seen.ContainsKey([int]$cur.ProcessId)) {
        $seen[[int]$cur.ProcessId] = $true
        $parent = Get-ProcInfo $cur.ParentProcessId
        if (-not $parent) { return $false }
        if ($parent.Name -eq 'command-center.exe') { return $true }
        $cur = $parent
    }
    return $false
}

# 1. Stop every instance: the app process itself, then its WebView2 by folder. Not taskkill /T: the
#    app's tree also holds servers it spawned (gateway_ensure, the STT keep-alive), which must stay up.
function Stop-AppOnly {
    foreach ($p in @(Get-Process -Name 'command-center' -ErrorAction SilentlyContinue)) {
        $path = $p.Path
        Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
        Say "stopped pid $($p.Id) ($path)" 'Yellow'
    }
    foreach ($w in @(Get-CcWebViewPids)) { Stop-Process -Id $w -Force -ErrorAction SilentlyContinue }
}

function Get-PanicLength { if (Test-Path -LiteralPath $CC_PANIC_LOG) { (Get-Item -LiteralPath $CC_PANIC_LOG).Length } else { 0 } }

# 2-3. Wait until gone, start, wait for a new app_start. Returns 'up', 'up-unconfirmed',
# 'handed-off' (another instance took the launch), 'died' or 'blocked'. Sets $script:appPid.
function Start-AppOnce {
    if (-not (Wait-CcAppGone)) { Say 'the app or its WebView2 is still running after the wait - not starting' 'Red'; return 'blocked' }
    $before = Get-CcLastAppStart
    $script:panicFrom = Get-PanicLength
    try { $script:appPid = New-DetachedProcess "`"$Exe`"" (Split-Path $Exe) 1 }
    catch { Say "start failed: $($_.Exception.Message)" 'Red'; return 'blocked' }
    Say "started pid $($script:appPid)"
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt $StartTimeoutSec) {
        Start-Sleep -Milliseconds 500
        if (-not (Get-Process -Id $script:appPid -ErrorAction SilentlyContinue)) {
            # The single-instance plugin hands a second launch to a running instance and exits.
            $other = @(Get-Process -Name 'command-center' -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne $script:appPid })
            if ($other.Count) { $script:appPid = $other[0].Id; return 'handed-off' }
            return 'died'
        }
        if ((Get-CcLastAppStart) -gt $before) { return 'up' }
    }
    return 'up-unconfirmed'   # running, but no app_start yet (a slow start, or the audit log is off)
}

function Show-NewPanics {
    if ((Get-PanicLength) -le $script:panicFrom) { Say 'nothing new in panic.log (the exit was not a Rust panic, or the app is older than the panic log)' 'Yellow'; return }
    $fs = [IO.File]::Open($CC_PANIC_LOG, 'Open', 'Read', 'ReadWrite')
    try { [void]$fs.Seek($script:panicFrom, 'Begin'); $text = (New-Object IO.StreamReader($fs)).ReadToEnd() } finally { $fs.Dispose() }
    foreach ($l in ($text -split "`r?`n" | Where-Object { $_ })) { Say "panic.log: $l" 'Red' }
}

# The whole restart; returns the exit code.
function Invoke-Restart {
    if (-not $Exe) { $script:Exe = $CC_APP_EXE }
    try { $script:Exe = (Resolve-Path -LiteralPath $Exe -ErrorAction Stop).ProviderPath }
    catch { Say "no app exe at $Exe" 'Red'; return 1 }
    if (-not $Detached -and (Test-UnderApp)) {
        $argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Detached', '-Exe', "`"$Exe`"", '-StartTimeoutSec', $StartTimeoutSec)
        if ($Hide) { $argv += '-Hide' }
        $ps = Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell\v1.0\powershell.exe'
        $id = New-DetachedProcess ("`"$ps`" " + ($argv -join ' ')) (Split-Path $PSCommandPath) 0
        Say "running inside the app's process tree: continuing detached as pid $id (see logs\launcher.log)" 'Yellow'
        return 0
    }
    Stop-AppOnly
    $state = Start-AppOnce
    if ($state -eq 'died') {
        Say "pid $($script:appPid) exited during start-up" 'Red'
        Show-NewPanics
        Say 'retrying once after the wait' 'Yellow'
        $state = Start-AppOnce
        if ($state -eq 'died') { Say "pid $($script:appPid) exited during start-up again" 'Red'; Show-NewPanics }
    }
    switch ($state) {
        'up'             { Say "app is up: pid $($script:appPid) (app_start logged)" 'Green' }
        'handed-off'     { Say "the launch was handed to running instance pid $($script:appPid)" 'Yellow' }
        'up-unconfirmed' { Say "app is running (pid $($script:appPid)) but wrote no app_start within ${StartTimeoutSec}s" 'Yellow' }
        default          { Say 'the app did not start - see panic.log and logs\launcher.log' 'Red'; return 1 }
    }
    # 5. Close the window to the tray once it has one (the engine keeps running).
    if ($Hide) {
        $sw = [Diagnostics.Stopwatch]::StartNew()
        while ($sw.Elapsed.TotalSeconds -lt 15) {
            $p = Get-Process -Id $script:appPid -ErrorAction SilentlyContinue
            if (-not $p) { break }
            if ($p.MainWindowHandle -ne [IntPtr]::Zero) { [void]$p.CloseMainWindow(); Say 'window closed to the tray'; break }
            Start-Sleep -Milliseconds 500
        }
    }
    return 0
}

exit (Invoke-Restart)
