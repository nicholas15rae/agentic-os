<#
=============================================================================
 start-command-center.ps1 - one-click launcher for every Command Center backend

     Start Command Center.lnk  ->  scripts\start-command-center.bat  ->  this file

 Starts (only what isn't already running - safe to run any number of times):
   Quantgress :8000 -> Gateway server.py :8080 + HTTPS :8443 (phone, NetBird)
   -> trading bridge :8091 (the gateway spawns it) -> TWS paper API :7497 (opened by
   start-tws.ps1; you log in) -> Whisper STT :8178
   -> Docker Desktop + Kokoro TTS :8880 + n8n :5678 -> Bionic / LM Studio :1235
   (also the verifier model) -> AnythingLLM :3001 -> Ollama :11434
   -> llama-server :1236 (only when MODEL_PATH is set in ai-stack.config.ps1)

 Output of everything it starts goes to logs\<service>.out.log / .err.log
 (rolled to .1-.3 at 5 MB). PIDs it starts go to logs\command-center.pids.json
 for stop-command-center.ps1. The backend runs headless: closing this window
 (or the desktop app) does not stop it, so the phone keeps working.

 Switches:
   -WithDesktopApp   also open the Command Center desktop app once the backend is up
   -RestartGateway   stop and start the gateway (use when it started before NetBird
                     was up and so isn't listening on the mesh address)
   -SkipModels       don't launch Bionic / AnythingLLM / Ollama / llama-server
   -DryRun           only check and report; start nothing
=============================================================================
#>
param(
    [switch]$WithDesktopApp,
    [switch]$RestartGateway,
    [switch]$SkipModels,
    [switch]$DryRun
)
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'      # keeps Invoke-WebRequest from drawing progress bars
. (Join-Path $PSScriptRoot 'cc-common.ps1')

$LAUNCH_LOG = Join-Path $CC_LOG_DIR 'launcher.log'
Invoke-LogRotate $LAUNCH_LOG
function Say([string]$msg, [string]$color = 'Gray') { Write-Host $msg -ForegroundColor $color; Write-CcLog $LAUNCH_LOG $msg }

$pidEntries = [System.Collections.ArrayList]@(Read-PidFile | Where-Object { Test-PidEntryAlive $_ })
function Add-PidEntry([string]$name, $proc, [string]$kind) {
    if (-not $proc) { return }
    $started = try { $proc.StartTime.ToString('o') } catch { '' }
    [void]$pidEntries.Add([pscustomobject]@{ name = $name; pid = $proc.Id; started = $started; kind = $kind; exe = $proc.Path })
    Write-PidFile $pidEntries
}

# Background service: hidden, detached, stdout/stderr appended to logs\<name>.out/.err.log.
# It runs under a hidden cmd.exe that sets the env vars and does the redirection; the recorded
# PID is that cmd.exe, and the stop script kills its whole tree.
# Python services write UTF-8 even when stdout is a file (avoids cp1252 crashes on emoji).
$CC_SERVICE_ENV = @{ PYTHONUNBUFFERED = '1'; PYTHONIOENCODING = 'utf-8' }
function Start-CcService([string]$name, [string]$exe, [string]$arguments, [string]$workdir, [hashtable]$extraEnv = @{}) {
    $out = Join-Path $CC_LOG_DIR "$name.out.log"
    $err = Join-Path $CC_LOG_DIR "$name.err.log"
    Invoke-LogRotate $out; Invoke-LogRotate $err
    $envs = @{} + $CC_SERVICE_ENV + $extraEnv
    $sets = ($envs.Keys | ForEach-Object { 'set "{0}={1}"' -f $_, $envs[$_] }) -join ' & '
    $cmd  = 'cmd.exe /d /s /c "{0} & "{1}" {2} 1>>"{3}" 2>>"{4}""' -f $sets, $exe, $arguments, $out, $err
    $procId = New-DetachedProcess $cmd $workdir 0
    Add-PidEntry $name (Get-Process -Id $procId -ErrorAction SilentlyContinue) 'service'
}
# Desktop apps that run their own server (Bionic, AnythingLLM, Docker Desktop): minimized.
function Start-CcGui([string]$name, [string]$exe) {
    $procId = New-DetachedProcess "`"$exe`"" (Split-Path $exe) 7
    Add-PidEntry $name (Get-Process -Id $procId -ErrorAction SilentlyContinue) 'gui'
}

# Run docker.exe with a time limit (it can hang while Docker Desktop is starting).
$DOCKER_CLI = (Get-Command docker -ErrorAction SilentlyContinue).Source
function Invoke-Docker([string]$arguments, [int]$timeoutMs = 8000) {
    if (-not $DOCKER_CLI) { return @{ code = -2; out = '' } }
    $psi = New-Object Diagnostics.ProcessStartInfo $DOCKER_CLI, $arguments
    $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
    $p = [Diagnostics.Process]::Start($psi)
    $o = $p.StandardOutput.ReadToEndAsync(); $e = $p.StandardError.ReadToEndAsync()
    if (-not $p.WaitForExit($timeoutMs)) { try { $p.Kill() } catch { }; return @{ code = -1; out = '' } }
    return @{ code = $p.ExitCode; out = ($o.Result + $e.Result).Trim() }
}

# ----------------------------------------------------------- service table ---
$meshIp = Get-MeshIp
$svcs = [System.Collections.ArrayList]@()
function New-Svc([string]$key, [string]$name, [string]$endpoint, [int]$timeout, [string]$log, [scriptblock]$probe, [scriptblock]$launch) {
    $s = [pscustomobject]@{ Key = $key; Name = $name; Endpoint = $endpoint; Timeout = $timeout; Log = $log
        Probe = $probe; Launch = $launch; State = 'pending'; Note = ''; Detail = ''; LaunchedAt = $null }
    [void]$svcs.Add($s); return $s
}
function Get-Svc([string]$key) { $svcs | Where-Object Key -eq $key | Select-Object -First 1 }
$L = { param($n) Join-Path $CC_LOG_DIR "$n.err.log" }

# Quantgress: every data route needs an API key, so 401/403 means "up".
New-Svc 'quantgress' 'Quantgress API' "127.0.0.1:$QUANTGRESS_PORT" 60 (& $L 'quantgress') `
    { $c = Get-HttpCode "http://127.0.0.1:$QUANTGRESS_PORT/trades?limit=1"; if ($c -in 200, 401, 403) { "HTTP $c" } } `
    {
        if (-not (Test-Path $QUANTGRESS_PYTHON)) { throw "SKIP:no venv at $QUANTGRESS_PYTHON" }
        Start-CcService 'quantgress' $QUANTGRESS_PYTHON "-m uvicorn api:app --host 127.0.0.1 --port $QUANTGRESS_PORT" $QUANTGRESS_DIR | Out-Null
    } | Out-Null

New-Svc 'gateway' 'Gateway (server.py)' "127.0.0.1:$GATEWAY_PORT" 90 (& $L 'gateway') `
    {
        if ((Get-HttpCode "http://127.0.0.1:$GATEWAY_PORT/api/status") -eq 200) {
            'binds ' + ((Get-ListenAddrs $GATEWAY_PORT) -join ', ')
        }
    } `
    {
        $owner = Get-ListenPids $GATEWAY_PORT | Select-Object -First 1
        if ($owner) {
            $pn = (Get-Process -Id $owner -ErrorAction SilentlyContinue).ProcessName
            if ($pn -notmatch '^python') { throw "port $GATEWAY_PORT is held by '$pn' (MiniTool's agent has done this) - stop it and re-run" }
            return   # a python server.py is starting up; just wait for it
        }
        if (-not (Test-Path (Join-Path $GATEWAY_WORKDIR 'server.py'))) { throw "no server.py in $GATEWAY_WORKDIR" }
        $py = if (Test-Path $GATEWAY_PYTHON) { $GATEWAY_PYTHON } else { (Get-Command python -ErrorAction Stop).Source }
        # server.py binds loopback + the NetBird IP itself, and adds HTTPS :8443 when data\certs\gateway.{crt,key} exist.
        Start-CcService 'gateway' $py "server.py --port $GATEWAY_PORT" $GATEWAY_WORKDIR | Out-Null
    } | Out-Null

# Phone path: HTTPS on the NetBird address, cert must match the IP. /mobile-hud needs no token.
$phoneHost = if ($meshIp) { $meshIp } else { '127.0.0.1' }
New-Svc 'phone' 'Phone HTTPS (NetBird)' "https://${phoneHost}:$CC_HTTPS_PORT" 90 (& $L 'gateway') `
    {
        if (-not $meshIp) { return }
        $c = Get-HttpCode "https://${meshIp}:$CC_HTTPS_PORT/mobile-hud" 5
        if ($c -eq 200) {
            $days = [int]([CcTls]::LastNotAfter - (Get-Date)).TotalDays
            "TLS ok, cert expires $([CcTls]::LastNotAfter.ToString('yyyy-MM-dd')) ($days days)"
        }
    } `
    {
        if (-not $meshIp) { throw 'NetBird is not connected (no 100.x address) - run "netbird up", then re-run' }
        if (-not (Test-Path (Join-Path $CC_ROOT 'data\certs\gateway.crt'))) { throw 'no data\certs\gateway.crt - HTTPS is off' }
        # The gateway row starts the process; this row only waits for its HTTPS listener.
    } | Out-Null

New-Svc 'bridge' 'Trading bridge' "127.0.0.1:$CC_BRIDGE_PORT" 60 (Join-Path $CC_ROOT 'data\trading\bridge.log') `
    { if ((Get-HttpCode "http://127.0.0.1:$CC_BRIDGE_PORT/health") -in 200..499) { 'started by the gateway' } } `
    { } | Out-Null   # the gateway spawns it on start-up (TRADING_BRIDGE_AUTOSTART)

# TWS (IBKR paper): opened here, logged in by you; the bridge connects once the API port opens. Deliberately NOT in
# the PID file, so stop-command-center.ps1 never closes TWS (or throws away its login).
New-Svc 'tws' 'TWS (IBKR paper API)' "127.0.0.1:$TWS_API_PORT" 90 (Join-Path $CC_LOG_DIR 'tws-start.log') `
    { if (Test-Listening $TWS_API_PORT) { 'logged in; the trading bridge connects by itself' } } `
    {
        if (-not $TWS_AUTOSTART) { throw 'SKIP:TWS_AUTOSTART is off in G:\ai-startup\ai-stack.config.ps1' }
        $out = & (Join-Path $PSScriptRoot 'start-tws.ps1')
        if ($LASTEXITCODE -eq 1) { throw [string]($out | Select-Object -Last 1) }
    } | Out-Null

# Whisper STT: same model choice as services.rs whisper_ensure (providers.json -> policy.stt).
New-Svc 'whisper' 'Whisper STT' '127.0.0.1:8178' 45 (& $L 'whisper') `
    { if ((Get-HttpCode "http://127.0.0.1:$($script:WhisperPort)/" 3) -gt 0) { "model $($script:WhisperModel)" } } `
    {
        if (-not (Test-Path $WHISPER_EXE)) { throw "SKIP:whisper not installed ($WHISPER_EXE missing)" }
        if (-not $script:WhisperModelPath) { throw "no ggml-*.bin model in $script:WhisperModelsDir" }
        $threads = [Math]::Min(8, [Math]::Max(2, [int]([Environment]::ProcessorCount / 2)))
        Start-CcService 'whisper' $WHISPER_EXE ("-m `"$script:WhisperModelPath`" --host 127.0.0.1 --port $script:WhisperPort " +
            "--inference-path /v1/audio/transcriptions -t $threads") $WHISPER_DIR | Out-Null
    } | Out-Null

New-Svc 'kokoro' 'Kokoro TTS (Docker)' '127.0.0.1:8880' 240 'docker logs kokoro' `
    { if ((Get-HttpCode $KOKORO_HEALTH_URL) -eq 200) { 'container kokoro' } } `
    { Start-DockerEngine } | Out-Null
New-Svc 'n8n' 'n8n (Docker)' '127.0.0.1:5678' 240 'docker logs n8n' `
    { if ((Get-HttpCode $N8N_HEALTH_URL) -eq 200) { 'container n8n' } } `
    { Start-DockerEngine } | Out-Null

New-Svc 'bionic' 'Bionic / LM Studio (+verifier)' "127.0.0.1:$BIONIC_PORT" 180 'Bionic app (Developer -> Logs)' `
    {
        if ((Get-HttpCode "http://127.0.0.1:$BIONIC_PORT/v1/models") -eq 200) {
            try {
                $loaded = @((Invoke-RestMethod "http://127.0.0.1:$BIONIC_PORT/api/v1/models" -TimeoutSec 4).models |
                    Where-Object { $_.loaded_instances.Count } | ForEach-Object { $_.loaded_instances.id })
                if ($loaded.Count) { 'loaded: ' + ($loaded -join ', ') } else { 'up; models load on first request' }
            } catch { 'up' }
        }
    } `
    {
        if ($SkipModels) { throw 'SKIP:-SkipModels' }
        if (Get-Process -Name Bionic -ErrorAction SilentlyContinue) { return }   # running, server still coming up
        if (-not (Test-Path $BIONIC_EXE)) { throw "SKIP:Bionic.exe not found at $BIONIC_EXE" }
        Start-CcGui 'bionic' $BIONIC_EXE | Out-Null
    } | Out-Null

New-Svc 'anythingllm' 'AnythingLLM RAG' "127.0.0.1:$ANYTHINGLLM_PORT" 120 "$env:APPDATA\anythingllm-desktop\storage\logs" `
    { if ((Get-HttpCode "http://127.0.0.1:$ANYTHINGLLM_PORT/api/ping") -eq 200) { 'online' } } `
    {
        if ($SkipModels) { throw 'SKIP:-SkipModels' }
        if (Get-Process -Name AnythingLLM -ErrorAction SilentlyContinue) { return }
        if (-not (Test-Path $ANYTHINGLLM_EXE)) { throw "SKIP:AnythingLLM.exe not found at $ANYTHINGLLM_EXE" }
        Start-CcGui 'anythingllm' $ANYTHINGLLM_EXE | Out-Null
    } | Out-Null

New-Svc 'ollama' 'Ollama' "127.0.0.1:$OLLAMA_PORT" 180 (& $L 'ollama') `
    { $c = Get-HttpCode "http://127.0.0.1:$OLLAMA_PORT/api/version"; if ($c -eq 200) { 'idle server; models load on demand' } } `
    {
        if ($SkipModels) { throw 'SKIP:-SkipModels' }
        if (-not (Test-Path $OLLAMA_EXE)) { throw "SKIP:ollama.exe not found at $OLLAMA_EXE" }
        Start-CcService 'ollama' $OLLAMA_EXE 'serve' (Split-Path $OLLAMA_EXE) $OLLAMA_ENV | Out-Null
    } | Out-Null

New-Svc 'instance2' 'llama-server (Tony)' "127.0.0.1:$INSTANCE2_PORT" 180 (& $L 'instance2') `
    { if ((Get-HttpCode "http://127.0.0.1:$INSTANCE2_PORT/health") -eq 200) { 'model loaded' } } `
    {
        if ($SkipModels) { throw 'SKIP:-SkipModels' }
        if ([string]::IsNullOrWhiteSpace($MODEL_PATH)) { throw 'SKIP:MODEL_PATH is empty in G:\ai-startup\ai-stack.config.ps1' }
        throw 'SKIP:started by G:\ai-startup\start-ai-stack.ps1 (picks the llama.cpp build) - run that for :1236'
    } | Out-Null

# Whisper model from the app's providers.json (falls back to any ggml-*.bin).
$script:WhisperPort = 8178; $script:WhisperModelsDir = 'G:\whisper\models'; $wModel = 'base.en'
try {
    $pj = Get-Content $CC_PROVIDERS_JSON -Raw | ConvertFrom-Json
    $wp = $pj.providers | Where-Object { $_.id -eq $pj.policy.stt -and $_.engine -eq 'whispercpp' } | Select-Object -First 1
    if ($wp) {
        $u = [uri]$wp.baseUrl; $script:WhisperPort = $u.Port
        if ($wp.modelsDir) { $script:WhisperModelsDir = $wp.modelsDir }
        if ($wp.model) { $wModel = $wp.model }
    }
} catch { }
$script:WhisperModelPath = Join-Path $script:WhisperModelsDir "ggml-$wModel.bin"
if (-not (Test-Path $script:WhisperModelPath)) {
    $script:WhisperModelPath = (Get-ChildItem $script:WhisperModelsDir -Filter 'ggml-*.bin' -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
}
$script:WhisperModel = if ($script:WhisperModelPath) { Split-Path $script:WhisperModelPath -Leaf } else { '(none)' }
(Get-Svc 'whisper').Endpoint = "127.0.0.1:$script:WhisperPort"

# Docker: launch Desktop if the engine is down; containers are started once it answers.
$script:dockerLaunched = $false; $script:containersStarted = $false
function Start-DockerEngine {
    if (-not $DOCKER_CLI) { throw 'SKIP:docker CLI not installed' }
    if ($script:dockerLaunched) { return }
    $script:dockerLaunched = $true
    if ((Invoke-Docker 'info --format {{.ServerVersion}}' 6000).code -eq 0) { return }
    if (Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue) { return }
    if (-not (Test-Path $DOCKER_DESKTOP_EXE)) { throw "Docker Desktop not found at $DOCKER_DESKTOP_EXE" }
    Start-CcGui 'docker-desktop' $DOCKER_DESKTOP_EXE | Out-Null
}
function Step-Docker {
    if (-not $script:dockerLaunched -or $script:containersStarted) { return }
    if ((Invoke-Docker 'info --format {{.ServerVersion}}' 5000).code -ne 0) { return }
    foreach ($c in 'kokoro', 'n8n') {
        $st = (Invoke-Docker "inspect -f {{.State.Running}} $c" 5000).out
        if ($st -eq 'false') { $r = Invoke-Docker "start $c" 30000; Say "  docker start $c -> exit $($r.code)" 'DarkGray' }
    }
    $script:containersStarted = $true
}

# ------------------------------------------------------------------ run ---
Say ''
Say ('=' * 78) 'Cyan'
Say ("  COMMAND CENTER LAUNCHER   {0}{1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $(if ($DryRun) { '   (dry run: nothing is started)' })) 'Cyan'
Say ('=' * 78) 'Cyan'
Say ("  NetBird mesh: {0}" -f $(if ($meshIp) { "$meshIp (phone: https://${meshIp}:$CC_HTTPS_PORT/mobile-hud)" } else { 'NOT connected - the phone cannot reach this PC' })) $(if ($meshIp) { 'Gray' } else { 'Yellow' })

if ($RestartGateway -and -not $DryRun) {
    foreach ($port in $GATEWAY_PORT, $CC_HTTPS_PORT) {
        foreach ($gp in Get-ListenPids $port) {
            $ci = Get-ProcInfo $gp
            if ($ci.CommandLine -match 'server\.py') { [void](Stop-CcTree $gp 'restart'); Say "  stopped gateway pid $gp for restart" 'Yellow' }
        }
    }
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ((Test-Listening $GATEWAY_PORT) -and $sw.Elapsed.TotalSeconds -lt 10) { Start-Sleep -Milliseconds 300 }
}

function Invoke-Launch($s) {
    $up = & $s.Probe
    if ($up) { $s.State = 'up'; $s.Note = 'already running'; $s.Detail = $up; return }
    if ($DryRun) { $s.State = 'down'; $s.Note = 'not running'; return }
    try {
        & $s.Launch
        $s.State = 'waiting'; $s.Note = 'started'; $s.LaunchedAt = Get-Date
    } catch {
        $m = $_.Exception.Message
        if ($m -like 'SKIP:*') { $s.State = 'skipped'; $s.Note = $m.Substring(5) }
        else { $s.State = 'failed'; $s.Note = $m }
    }
}
function Wait-Svcs([object[]]$list) {
    while ($true) {
        Step-Docker
        $pending = @($list | Where-Object State -eq 'waiting')
        if ($pending.Count -eq 0) { break }
        foreach ($s in $pending) {
            $r = & $s.Probe
            $age = ((Get-Date) - $s.LaunchedAt).TotalSeconds
            if ($r) { $s.State = 'up'; $s.Detail = $r; $s.Note = "started, healthy after $([int]$age)s"; Say "  [ UP ] $($s.Name)" 'Green' }
            elseif ($age -ge $s.Timeout) { $s.State = 'failed'; $s.Note = "no healthy answer within $($s.Timeout)s"; Say "  [FAIL] $($s.Name)" 'Red' }
        }
        Start-Sleep -Seconds 2
    }
}

# Quantgress first, so the trading bridge the gateway spawns finds it on its first poll.
$q = Get-Svc 'quantgress'; Invoke-Launch $q
if ($q.State -eq 'waiting') { Say '  starting Quantgress before the gateway...'; $q.Timeout = 45; Wait-Svcs @($q) }

foreach ($s in $svcs) { if ($s.State -eq 'pending') { Invoke-Launch $s; if ($s.Note -eq 'started') { Say "  launching $($s.Name)..." } } }
# The phone and bridge rows follow the gateway: they only "start" when the gateway does.
$gwState = (Get-Svc 'gateway').State
foreach ($k in 'phone', 'bridge') {
    $s = Get-Svc $k
    if ($s.State -ne 'waiting') { continue }
    if ($gwState -eq 'failed') { $s.State = 'failed'; $s.Note = 'gateway did not start' }
    elseif ($gwState -eq 'up') {
        # The gateway was already running, so it won't open these now - waiting is pointless.
        $s.State = 'failed'
        $s.Note = if ($k -eq 'bridge') { 'not running; the gateway spawns it only at its own start-up - run with -RestartGateway' }
                  else { 'gateway has no HTTPS listener on the mesh - run with -RestartGateway' }
    }
}
if (-not $DryRun) { Wait-Svcs $svcs }

# Gateway up but started before NetBird -> no mesh listener -> phone can't connect.
$gw = Get-Svc 'gateway'; $ph = Get-Svc 'phone'
if ($gw.State -eq 'up' -and $meshIp -and -not ((Get-ListenAddrs $GATEWAY_PORT) -contains $meshIp)) {
    $ph.State = 'failed'; $ph.Note = 'gateway is not listening on the NetBird IP (it started before NetBird) - run with -RestartGateway'
}

# TWS open but not logged in yet isn't a failure: it is waiting for you (the bridge connects once you log in).
$tw = Get-Svc 'tws'
if ($tw.State -in 'failed', 'down' -and @(Get-TwsProcess).Count) {
    $tw.State = 'down'; $tw.Note = 'TWS is open - log in to the PAPER account (the trading bridge connects by itself)'
}

# ---------------------------------------------------------------- summary ---
Say ''
$fmt = '  {0,-31} {1,-28} {2,-8} {3}'
Say ($fmt -f 'SERVICE', 'ENDPOINT', 'STATUS', 'DETAIL') 'White'
Say ($fmt -f ('-' * 31), ('-' * 28), ('-' * 8), ('-' * 40)) 'DarkGray'
$failed = 0
foreach ($s in $svcs) {
    switch ($s.State) {
        'up'      { $st = 'UP';      $col = 'Green' }
        'skipped' { $st = 'SKIPPED'; $col = 'DarkGray' }
        'down'    { $st = 'DOWN';    $col = 'Yellow' }
        default   { $st = 'FAILED';  $col = 'Red'; $failed++ }
    }
    $detail = (@($s.Note, $s.Detail) | Where-Object { $_ }) -join ' - '
    Say ($fmt -f $s.Name, $s.Endpoint, $st, $detail) $col
    if ($st -eq 'FAILED' -and $s.Log) { Say ("  {0,-31} {1,-28} {2,-8} log: {3}" -f '', '', '', $s.Log) 'DarkYellow' }
}
Say ''
if ($pidEntries.Count) { Say "  PIDs started by this launcher: $CC_PID_FILE" 'DarkGray' }
Say "  Logs: $CC_LOG_DIR" 'DarkGray'

# --------------------------------------------------------------- desktop app ---
if ($WithDesktopApp -and -not $DryRun) {
    if (Get-Process -Name 'command-center' -ErrorAction SilentlyContinue) { Say '  Desktop app is already open.' }
    elseif (Test-Path $CC_APP_EXE) { Start-Process -FilePath $CC_APP_EXE -WorkingDirectory (Split-Path $CC_APP_EXE); Say "  Opened the desktop app ($CC_APP_EXE)" 'Green' }
    else { Say "  Desktop app not built: $CC_APP_EXE is missing" 'Yellow'; $failed++ }
}

if ($DryRun) { $down = @($svcs | Where-Object State -eq 'down').Count; Say "  Dry run: $down service(s) would be started." 'Cyan'; exit 0 }
if ($failed) { Say "  $failed service(s) FAILED - see the log paths above." 'Red'; exit 1 }
Say '  All required services are up. The backend keeps running after this window closes.' 'Green'
exit 0
