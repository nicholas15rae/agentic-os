# =============================================================================
#  cc-common.ps1 - shared settings and helpers for start/stop-command-center.ps1
#
#  Paths come from G:\ai-startup\ai-stack.config.ps1 (the logon orchestrator's
#  config) when it exists, so both launchers start services the same way.
#  The defaults below are only used if that file is missing.
#  Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less files as ANSI.
# =============================================================================

$CC_ROOT     = Split-Path $PSScriptRoot -Parent                 # G:\agentic os
$CC_LOG_DIR  = Join-Path $CC_ROOT 'logs'
$CC_PID_FILE = Join-Path $CC_LOG_DIR 'command-center.pids.json'
$CC_LOG_MAX_BYTES = 5MB    # a service log is rolled to .1 when it passes this at launch
$CC_LOG_KEEP      = 3      # keep .1 .. .3

# ---- defaults (overridden by ai-stack.config.ps1 when present) ----
$GATEWAY_PORT       = 8080
$GATEWAY_WORKDIR    = $CC_ROOT
$GATEWAY_PYTHON     = "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe"
$QUANTGRESS_DIR     = 'G:\quantgress'
$QUANTGRESS_PYTHON  = 'G:\quantgress\.venv\Scripts\python.exe'
$QUANTGRESS_PORT    = 8000
$BIONIC_EXE         = "$env:LOCALAPPDATA\Programs\Bionic\Bionic.exe"
$BIONIC_PORT        = 1235
$OLLAMA_EXE         = 'D:\Ollama\ollama.exe'
$OLLAMA_PORT        = 11434
$OLLAMA_ENV         = @{ OLLAMA_HOST = '127.0.0.1:11434' }
$MODEL_PATH         = ''
$INSTANCE2_PORT     = 1236
$DOCKER_DESKTOP_EXE = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
$KOKORO_HEALTH_URL  = 'http://127.0.0.1:8880/health'
$N8N_HEALTH_URL     = 'http://127.0.0.1:5678/healthz'
$TWS_EXE            = 'C:\Jts\tws.exe'      # IBKR Trader Workstation; you log in to the PAPER account yourself
$TWS_API_PORT       = 7497                  # paper API port the trading bridge dials (live 7496 is never used)
$TWS_AUTOSTART      = $true                 # the logon task and the launcher open TWS when it isn't running

$AI_STACK_CONFIG = 'G:\ai-startup\ai-stack.config.ps1'
if (Test-Path $AI_STACK_CONFIG) { . $AI_STACK_CONFIG }

# ---- Command Center specific ----
$CC_HTTPS_PORT     = 8443                                        # server.py serves this when data\certs\gateway.{crt,key} exist
$CC_BRIDGE_PORT    = 8091                                        # trading bridge, spawned by the gateway
$WHISPER_EXE       = 'G:\whisper\bin\whisper-server.exe'         # same constant as services.rs
$WHISPER_DIR       = 'G:\whisper'
$ANYTHINGLLM_EXE   = "$env:LOCALAPPDATA\Programs\AnythingLLM\AnythingLLM.exe"
$ANYTHINGLLM_PORT  = 3001
$CC_APP_EXE        = Join-Path $CC_ROOT 'command center\src-tauri\target\release\command-center.exe'
$CC_PROVIDERS_JSON = "$env:APPDATA\os.agentic.commandcenter\providers.json"

New-Item -ItemType Directory -Force $CC_LOG_DIR | Out-Null

# ------------------------------------------------------------------ helpers ---
function Get-ListenPids([int]$port) {
    @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique | Where-Object { $_ -gt 0 })
}
function Get-ListenAddrs([int]$port) {
    @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalAddress -Unique)
}
function Test-Listening([int]$port) { (Get-ListenPids $port).Count -gt 0 }

function Get-ProcInfo([int]$procId) {
    Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue
}

# The NetBird address (100.64.0.0/10) of this PC, or $null when the mesh is down.
function Get-MeshIp {
    $nb = Get-Command netbird -ErrorAction SilentlyContinue
    if (-not $nb) { return $null }
    try {
        $line = (& netbird status 2>$null) | Select-String 'NetBird IP:' | Select-Object -First 1
        if ($line -and $line.ToString() -match '(100\.\d+\.\d+\.\d+)') { return $Matches[1] }
    } catch { }
    return $null
}

# Roll name.log -> name.log.1 -> ... once it passes the size cap. Called before a launch,
# while nothing holds the file. A locked file is left alone (the old process is still writing).
function Invoke-LogRotate([string]$path) {
    if (-not (Test-Path $path)) { return }
    if ((Get-Item $path).Length -lt $CC_LOG_MAX_BYTES) { return }
    try {
        for ($i = $CC_LOG_KEEP; $i -ge 1; $i--) {
            $src = if ($i -eq 1) { $path } else { "$path.$($i - 1)" }
            if (Test-Path $src) { Move-Item $src "$path.$i" -Force -ErrorAction Stop }
        }
    } catch { }
}

function Read-PidFile {
    if (-not (Test-Path $CC_PID_FILE)) { return @() }
    # PowerShell 5.1's ConvertFrom-Json emits a JSON array as ONE object: enumerate it explicitly.
    try { $j = Get-Content $CC_PID_FILE -Raw | ConvertFrom-Json; foreach ($x in $j) { $x } } catch { }
}
function Write-PidFile($entries) {
    $arr = @($entries)
    if ($arr.Count -eq 0) { Remove-Item $CC_PID_FILE -Force -ErrorAction SilentlyContinue; return }
    ConvertTo-Json -InputObject $arr -Depth 4 | Set-Content $CC_PID_FILE -Encoding UTF8
}
# A recorded PID only counts if the same process (same start time) is still alive,
# so a reused PID is never killed.
function Test-PidEntryAlive($e) {
    $p = Get-Process -Id $e.pid -ErrorAction SilentlyContinue
    if (-not $p) { return $false }
    try { return $p.StartTime.ToString('o') -eq $e.started } catch { return $false }
}

# HTTP status code for a URL (0 = no answer). HTTPS certificates are checked against the
# hostname but the private "Agentic OS Local CA" root is accepted (it isn't in Windows' store).
if (-not ('CcTls' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Net.Security;
using System.Security.Cryptography.X509Certificates;
public static class CcTls {
    public static DateTime LastNotAfter = DateTime.MinValue;
    public static string LastErrors = "";
    public static bool Check(object s, X509Certificate c, X509Chain ch, SslPolicyErrors e) {
        if (c != null) { LastNotAfter = new X509Certificate2(c).NotAfter; }
        LastErrors = e.ToString();
        return (e & (SslPolicyErrors.RemoteCertificateNameMismatch | SslPolicyErrors.RemoteCertificateNotAvailable)) == 0;
    }
    public static void Install() {
        System.Net.ServicePointManager.ServerCertificateValidationCallback = new RemoteCertificateValidationCallback(Check);
        System.Net.ServicePointManager.SecurityProtocol = System.Net.SecurityProtocolType.Tls12;
    }
}
'@
}
[CcTls]::Install()

# Start a fully detached process through WMI (Win32_Process.Create). Unlike Start-Process it
# inherits no handles from this launcher, so a service never holds the launcher's stdout pipe
# open (which made "| Out-File" or a scheduled task capture hang), and it isn't tied to the
# launcher's console. ShowWindow: 0 = hidden, 7 = minimized without focus. Returns the PID.
function New-DetachedProcess([string]$commandLine, [string]$workdir, [int]$show = 0) {
    $si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]$show }
    $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine = $commandLine; CurrentDirectory = $workdir; ProcessStartupInformation = $si }
    if ($r.ReturnValue -ne 0) { throw "Win32_Process.Create failed (code $($r.ReturnValue)): $commandLine" }
    return [int]$r.ProcessId
}

function Get-HttpCode([string]$url, [int]$timeoutSec = 4) {
    try {
        $r = Invoke-WebRequest $url -UseBasicParsing -TimeoutSec $timeoutSec -ErrorAction Stop
        return [int]$r.StatusCode
    } catch {
        $resp = $_.Exception.Response
        if ($resp -and $resp.StatusCode) { return [int]$resp.StatusCode }
        return 0
    }
}

# TWS is an install4j launcher: its processes run from the install folder (tws.exe, or its bundled JRE).
function Get-TwsProcess {
    $dir = Split-Path $TWS_EXE -Parent
    @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.ExecutablePath -and $_.ExecutablePath.StartsWith($dir, [StringComparison]::OrdinalIgnoreCase) -and
        $_.Name -notmatch '^(uninstall|i4jdel|updater|restarter)'
    })
}

# Kill a process and its children. If its parent is a launcher for the same command line
# (a Windows venv python.exe re-spawns the base interpreter as a child), kill the parent too.
function Stop-CcTree([int]$procId, [string]$why) {
    $info = Get-ProcInfo $procId
    if (-not $info) { return $false }
    $target = $procId
    $parent = Get-ProcInfo $info.ParentProcessId
    if ($parent -and $parent.Name -eq $info.Name -and $parent.CommandLine -and $info.CommandLine) {
        $a = ($parent.CommandLine -replace '^"[^"]+"\s*|^\S+\s*', '').Trim()
        $b = ($info.CommandLine   -replace '^"[^"]+"\s*|^\S+\s*', '').Trim()
        if ($a -eq $b) { $target = $parent.ProcessId }
    }
    & taskkill.exe /PID $target /T /F 2>&1 | Out-Null
    Start-Sleep -Milliseconds 300
    return -not (Get-Process -Id $procId -ErrorAction SilentlyContinue)
}

# ---- desktop app restarts -------------------------------------------------------------
# The app's WebView2 runs as msedgewebview2.exe processes (browser, gpu, renderer, utility,
# crashpad) on its own user-data folder. They can outlive command-center.exe by a few seconds.
# A new instance started meanwhile can fail to create its webview (WebView2 refuses different
# browser args on a folder that still has live processes), and the release build aborts at
# start-up (0xc0000409; 2026-11-26 20:42). So never start the app until Wait-CcAppGone is true.
# Known-folder lookups (the same the app uses), not $env:LOCALAPPDATA / $env:APPDATA, which a
# stripped environment can lack.
$CC_WEBVIEW_DIR = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'os.agentic.commandcenter\EBWebView'
$CC_PANIC_LOG   = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'os.agentic.commandcenter\logs\panic.log'   # written by the app (lib.rs)
$CC_AUDIT_LOG   = Join-Path $CC_ROOT 'data\security\security_audit.jsonl'          # the app writes app_start here

# PIDs of WebView2 processes on the app's own folder (pure: $procs are Win32_Process-like objects).
# Other apps' WebView2 (Widgets, Search, Python tools) use other folders and never match. An empty
# or relative folder matches nothing (fails closed: '' would otherwise match every command line).
function Select-CcWebViewPids($procs, [string]$dir = $CC_WEBVIEW_DIR) {
    if (-not $dir -or -not [IO.Path]::IsPathRooted($dir)) { return @() }
    @($procs | Where-Object { $_.Name -eq 'msedgewebview2.exe' -and $_.CommandLine -and
        $_.CommandLine.IndexOf($dir, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | ForEach-Object { [int]$_.ProcessId })
}
function Get-CcWebViewPids {
    Select-CcWebViewPids @(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue)
}

# Wait until the desktop app is fully gone: no command-center.exe and none of its WebView2
# processes. WebView2 processes still there after $capSec (the app itself already gone) are
# killed, then waited for $killWaitSec more. $true = gone; $false = the app is still running, or
# its WebView2 would not go. The three scriptblocks are only replaced by tests.
function Wait-CcAppGone([int]$capSec = 15, [int]$killWaitSec = 5,
        [scriptblock]$AppPids = { @(Get-Process -Name 'command-center' -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }) },
        [scriptblock]$WebViewPids = { Get-CcWebViewPids },
        [scriptblock]$Kill = { param($ids) foreach ($i in $ids) { Stop-Process -Id $i -Force -ErrorAction SilentlyContinue } },
        [int]$pollMs = 250) {
    $sw = [Diagnostics.Stopwatch]::StartNew(); $limit = $capSec; $killed = $false
    while ($true) {
        $app = @(& $AppPids); $wv = @(& $WebViewPids)
        if ($app.Count -eq 0 -and $wv.Count -eq 0) { return $true }
        if ($sw.Elapsed.TotalSeconds -ge $limit) {
            if ($killed -or $app.Count) { return $false }
            & $Kill $wv
            $killed = $true; $limit = $sw.Elapsed.TotalSeconds + $killWaitSec
        }
        Start-Sleep -Milliseconds $pollMs
    }
}

# The last app_start the app wrote to the audit log (its unix time, 0 = none). The app writes it in
# its own setup, after Tauri created the window, so a new one means this start got past WebView2.
function Get-CcLastAppStart([string]$auditLog = $CC_AUDIT_LOG) {
    if (-not (Test-Path $auditLog)) { return 0 }
    $line = Get-Content $auditLog -Tail 400 -ErrorAction SilentlyContinue | Where-Object { $_ -match '"event":"app_start"' } | Select-Object -Last 1
    if ($line -and $line -match '"unix":([0-9.]+)') { return [double]$Matches[1] }
    return 0
}

function Write-CcLog([string]$file, [string]$msg) {
    $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Add-Content -Path $file -Value $line -Encoding UTF8
}
