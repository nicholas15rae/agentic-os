<#
 Tests for the desktop-app restart rule in scripts\cc-common.ps1 (Select-CcWebViewPids, Wait-CcAppGone,
 Get-CcLastAppStart) and its use in start-, stop- and restart-desktop-app.ps1. 2026-11-26.
   powershell -NoProfile -ExecutionPolicy Bypass -File "G:\agentic os\scripts\tests\cc-app-restart.tests.ps1"
 Starts and stops nothing: every process list is a fake, the audit log is a temp file.
 Plain asserts (Windows PowerShell only ships Pester 3.4). Exit code 1 = a test failed.
#>
$ErrorActionPreference = 'Stop'
$scripts = Split-Path $PSScriptRoot
. (Join-Path $scripts 'cc-common.ps1')

$script:failed = 0; $script:passed = 0
function Test-Case([string]$name, [scriptblock]$body) {
    try { & $body; $script:passed++; Write-Host "PASS  $name" }
    catch { $script:failed++; Write-Host "FAIL  $name :: $($_.Exception.Message)" -ForegroundColor Red }
}
function Assert-Equal($expected, $actual, [string]$what) {
    if ("$expected" -cne "$actual") { throw "$what expected '$expected', got '$actual'" }
}
function Assert-True($cond, [string]$what) { if (-not $cond) { throw $what } }
function P([int]$id, [string]$name, [string]$cmd) { [pscustomobject]@{ ProcessId = $id; Name = $name; CommandLine = $cmd } }
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("cc-app-restart-tests-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $tmp | Out-Null

try {
    Test-Case "only the app's own WebView2 processes are picked (any case), never other apps'" {
        $dir = 'C:\Users\nic\AppData\Local\os.agentic.commandcenter\EBWebView'
        $procs = @(
            (P 10 'msedgewebview2.exe' '"C:\...\msedgewebview2.exe" --embedded-browser-webview=1 --webview-exe-name=command-center.exe --user-data-dir="C:\Users\nic\AppData\Local\os.agentic.commandcenter\EBWebView"'),
            (P 11 'msedgewebview2.exe' '"C:\...\msedgewebview2.exe" --type=gpu-process --user-data-dir="c:\users\nic\appdata\local\OS.AGENTIC.COMMANDCENTER\EBWebView"'),
            (P 12 'msedgewebview2.exe' '"C:\...\msedgewebview2.exe" --type=crashpad-handler --database=C:\Users\nic\AppData\Local\os.agentic.commandcenter\EBWebView\Crashpad'),
            (P 20 'msedgewebview2.exe' '"C:\...\msedgewebview2.exe" --webview-exe-name=WidgetBoard.exe --user-data-dir="C:\Users\nic\AppData\Local\Microsoft\Windows\SharedWebView\EBWebView"'),
            (P 21 'msedgewebview2.exe' '"C:\...\msedgewebview2.exe" --webview-exe-name=python.exe --user-data-dir="C:\Users\nic\AppData\Local\Temp\tmpab\EBWebView"'),
            (P 22 'msedgewebview2.exe' $null),
            (P 30 'command-center.exe' '"G:\agentic os\...\command-center.exe" C:\Users\nic\AppData\Local\os.agentic.commandcenter\EBWebView')
        )
        Assert-Equal '10 11 12' ((Select-CcWebViewPids $procs $dir) -join ' ') 'picked'
        Assert-Equal '' ((Select-CcWebViewPids @() $dir) -join ' ') 'none'
        Assert-True ($CC_WEBVIEW_DIR -like '*\os.agentic.commandcenter\EBWebView') "default dir is the app's EBWebView folder: $CC_WEBVIEW_DIR"
    }

    Test-Case 'nothing left: true at once, nothing killed' {
        $script:kills = @()
        $r = Wait-CcAppGone 5 5 { @() } { @() } { param($ids) $script:kills += $ids } 10
        Assert-Equal 'True' $r 'result'; Assert-Equal '' ($script:kills -join ' ') 'kills'
    }

    Test-Case 'WebView2 that exits by itself inside the cap is waited for, not killed' {
        $script:n = 0; $script:kills = @()
        $r = Wait-CcAppGone 5 5 { @() } { $script:n++; if ($script:n -le 3) { @(10, 11) } else { @() } } { param($ids) $script:kills += $ids } 10
        Assert-Equal 'True' $r 'result'; Assert-Equal '' ($script:kills -join ' ') 'kills'; Assert-True ($script:n -ge 4) "polled $($script:n) times"
    }

    Test-Case 'WebView2 still there after the cap (app gone): killed once, then gone = true' {
        $script:kills = @(); $script:dead = $false
        $r = Wait-CcAppGone 0 2 { @() } { if ($script:dead) { @() } else { @(10, 12) } } { param($ids) $script:kills += $ids; $script:dead = $true } 10
        Assert-Equal 'True' $r 'result'; Assert-Equal '10 12' ($script:kills -join ' ') 'kills'
    }

    Test-Case 'WebView2 that survives the kill: false after the extra wait, killed only once' {
        $script:kills = 0
        $sw = [Diagnostics.Stopwatch]::StartNew()
        $r = Wait-CcAppGone 0 1 { @() } { @(10) } { param($ids) $script:kills++ } 10
        Assert-Equal 'False' $r 'result'; Assert-Equal '1' $script:kills 'kill calls'
        Assert-True ($sw.Elapsed.TotalSeconds -lt 5) "returned after $($sw.Elapsed.TotalSeconds) s"
    }

    Test-Case 'the app itself still running after the cap: false, its WebView2 left alone' {
        $script:kills = 0
        $r = Wait-CcAppGone 0 1 { @(4242) } { @(10) } { param($ids) $script:kills++ } 10
        Assert-Equal 'False' $r 'result'; Assert-Equal '0' $script:kills 'kill calls'
    }

    Test-Case 'the last app_start in the audit log (0 when there is none)' {
        $log = Join-Path $tmp 'security_audit.jsonl'
        Assert-Equal '0' (Get-CcLastAppStart $log) 'missing file'
        [IO.File]::WriteAllText($log, (@(
            '{"ts":"2026-11-27T01:44:44.536Z","unix":1795743884.5364518,"seq":60,"event":"app_start","severity":"info"}',
            '{"ts":"2026-11-27T01:50:00.000Z","unix":1795744200.25,"seq":61,"event":"unlock","severity":"info"}',
            '{"ts":"2026-11-27T02:20:30.724Z","unix":1795746030.724214,"seq":62,"event":"app_start","severity":"info"}',
            '{"ts":"2026-11-27T02:21:00.000Z","unix":1795746060.5,"seq":63,"event":"lock","severity":"info"}'
        ) -join "`n") + "`n")
        $last = Get-CcLastAppStart $log
        Assert-True ([Math]::Abs($last - 1795746030.724214) -lt 0.001) "last app_start: $last"
        Assert-True ($last -gt 1795743884.5364518) 'a newer start compares greater'
        $none = Join-Path $tmp 'none.jsonl'; [IO.File]::WriteAllText($none, '{"unix":1,"event":"lock"}' + "`n")
        Assert-Equal '0' (Get-CcLastAppStart $none) 'no app_start'
    }

    Test-Case 'every launcher that starts the app waits for the last one to be gone first' {
        $start = Get-Content (Join-Path $scripts 'start-command-center.ps1') -Raw
        $w = $start.IndexOf('elseif (-not (Wait-CcAppGone))'); $s = $start.IndexOf('Start-Process -FilePath $CC_APP_EXE')
        Assert-True ($w -gt 0 -and $s -gt $w) 'start-command-center.ps1 waits before Start-Process'
        $restart = Get-Content (Join-Path $scripts 'restart-desktop-app.ps1') -Raw
        $w = $restart.IndexOf('if (-not (Wait-CcAppGone))'); $s = $restart.IndexOf('New-DetachedProcess')
        Assert-True ($w -gt 0 -and $s -gt $w) 'restart-desktop-app.ps1 waits before New-DetachedProcess'
        $stop = Get-Content (Join-Path $scripts 'stop-command-center.ps1') -Raw
        Assert-True ($stop.IndexOf('Wait-CcAppGone') -gt $stop.IndexOf("Stop-Target `$p.Id 'app'")) 'stop-command-center.ps1 waits after stopping the app'
    }

    Test-Case 'an empty or relative WebView2 folder matches nothing (never every WebView2 on the machine)' {
        $procs = @((P 20 'msedgewebview2.exe' '--user-data-dir="C:\Users\nic\AppData\Local\Microsoft\Windows\SharedWebView\EBWebView"'))
        Assert-Equal '' ((Select-CcWebViewPids $procs '') -join ' ') 'empty dir'
        Assert-Equal '' ((Select-CcWebViewPids $procs 'EBWebView') -join ' ') 'relative dir'
    }

    # ---- restart-desktop-app.ps1's own logic, with every process call faked ----
    $rtokens = $null; $rerrors = $null
    $rast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $scripts 'restart-desktop-app.ps1'), [ref]$rtokens, [ref]$rerrors)
    if ($rerrors.Count) { throw "restart-desktop-app.ps1 does not parse: $($rerrors[0].Message)" }
    foreach ($name in 'Test-UnderApp', 'Stop-AppOnly', 'Get-PanicLength', 'Start-AppOnce') {
        $f = $rast.Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true)
        if (-not $f) { throw "function $name not found in restart-desktop-app.ps1" }
        . ([scriptblock]::Create($f.Extent.Text))
    }
    function Say([string]$msg, [string]$color) { $script:said += $msg }
    $CC_PANIC_LOG = Join-Path $tmp 'panic.log'

    # Fakes for one Start-AppOnce run: $alive = pids Get-Process -Id finds, $others = pids Get-Process -Name finds,
    # $starts = what Get-CcLastAppStart returns, call by call (the last value repeats).
    function Use-Fakes([bool]$gone = $true, [int[]]$alive = @(777), [int[]]$others = @(), [double[]]$starts = @(100, 200), [switch]$createFails) {
        $script:fk = @{ gone = $gone; alive = $alive; others = $others; starts = $starts; n = 0; createFails = [bool]$createFails; created = 0 }
        $script:said = @()
    }
    function Wait-CcAppGone { $script:fk.gone }
    function Get-CcLastAppStart { $i = [Math]::Min($script:fk.n, $script:fk.starts.Count - 1); $script:fk.n++; $script:fk.starts[$i] }
    function New-DetachedProcess($cmd, $dir, $show) { if ($script:fk.createFails) { throw 'Win32_Process.Create failed (code 9)' }; $script:fk.created++; 777 }
    function Get-Process { [CmdletBinding()] param([int]$Id, [string]$Name)
        if ($Name) { $script:fk.others | ForEach-Object { [pscustomobject]@{ Id = $_; Path = "C:\fake\$_.exe" } } }
        elseif ($script:fk.alive -contains $Id) { [pscustomobject]@{ Id = $Id } }
    }
    $Exe = 'C:\fake\command-center.exe'; $StartTimeoutSec = 2

    Test-Case 'a new app_start = up' {
        Use-Fakes -starts @(100, 100, 200)
        Assert-Equal 'up' (Start-AppOnce) 'state'; Assert-Equal '777' $script:appPid 'pid'
    }
    Test-Case 'the new process gone with no other instance = died' {
        Use-Fakes -alive @() -others @()
        Assert-Equal 'died' (Start-AppOnce) 'state'
    }
    Test-Case 'the new process gone but another instance running = handed-off to that pid' {
        Use-Fakes -alive @() -others @(555)
        Assert-Equal 'handed-off' (Start-AppOnce) 'state'; Assert-Equal '555' $script:appPid 'pid'
    }
    Test-Case 'the last instance not gone = blocked, nothing started' {
        Use-Fakes -gone $false
        Assert-Equal 'blocked' (Start-AppOnce) 'state'; Assert-Equal '0' $script:fk.created 'starts'
    }
    Test-Case 'a failed WMI start = blocked with the reason said (never an uncaught throw)' {
        Use-Fakes -createFails
        Assert-Equal 'blocked' (Start-AppOnce) 'state'
        Assert-True (($script:said -join ' ') -match 'start failed: Win32_Process.Create failed') "said: $($script:said -join ' | ')"
    }
    Test-Case 'alive but no app_start before the timeout = up-unconfirmed' {
        Use-Fakes -starts @(100)
        $StartTimeoutSec = 1
        Assert-Equal 'up-unconfirmed' (Start-AppOnce) 'state'
    }
    Test-Case 'step 1 stops only the app processes and their WebView2, never a tree' {
        Use-Fakes -others @(1, 2)
        $script:stopped = @()
        function Stop-Process { [CmdletBinding()] param([int]$Id, [switch]$Force) $script:stopped += $Id }
        function Get-CcWebViewPids { @(10, 11) }
        Stop-AppOnly
        Assert-Equal '1 2 10 11' ($script:stopped -join ' ') 'stopped'
        $body = ($rast.Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Stop-AppOnly' }, $true)).Extent.Text
        Assert-True ($body -notmatch 'Stop-CcTree|taskkill') 'no tree kill in Stop-AppOnly'
    }
    Test-Case 'run from inside the app (any ancestor is command-center.exe) is detected; a cycle ends' {
        $script:tree = @{
            100 = [pscustomobject]@{ ProcessId = 100; ParentProcessId = 50; Name = 'powershell.exe' }
            50  = [pscustomobject]@{ ProcessId = 50;  ParentProcessId = 40; Name = 'claude.exe' }
            40  = [pscustomobject]@{ ProcessId = 40;  ParentProcessId = 4;  Name = 'command-center.exe' }
            200 = [pscustomobject]@{ ProcessId = 200; ParentProcessId = 60; Name = 'powershell.exe' }
            60  = [pscustomobject]@{ ProcessId = 60;  ParentProcessId = 9;  Name = 'explorer.exe' }
            300 = [pscustomobject]@{ ProcessId = 300; ParentProcessId = 301; Name = 'a.exe' }
            301 = [pscustomobject]@{ ProcessId = 301; ParentProcessId = 300; Name = 'b.exe' }
        }
        function Get-ProcInfo([int]$procId) { $script:tree[$procId] }
        Assert-Equal 'True' (Test-UnderApp 100) 'under the app'
        Assert-Equal 'False' (Test-UnderApp 200) 'not under the app'
        Assert-Equal 'False' (Test-UnderApp 300) 'cycle'
    }

    Test-Case 'the edited scripts parse and stay ASCII-only' {
        foreach ($f in 'cc-common.ps1', 'start-command-center.ps1', 'stop-command-center.ps1', 'restart-desktop-app.ps1', 'tests\cc-app-restart.tests.ps1') {
            $path = Join-Path $scripts $f
            $t = $null; $e = $null
            [void][Management.Automation.Language.Parser]::ParseFile($path, [ref]$t, [ref]$e)
            Assert-Equal 0 $e.Count "$f parse errors"
            $bad = @([IO.File]::ReadAllBytes($path) | Where-Object { $_ -gt 127 }).Count
            Assert-Equal 0 $bad "$f non-ASCII bytes"
        }
    }
} finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host ""
Write-Host "$($script:passed) passed, $($script:failed) failed"
if ($script:failed) { exit 1 }
exit 0
