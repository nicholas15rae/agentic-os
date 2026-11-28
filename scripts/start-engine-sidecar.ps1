<#
 start-engine-sidecar.ps1 - Section 26: start the built-in engine's control routes (/api/engine/*)
 from the section-26-engine worktree on 127.0.0.1:8081, hidden, if nothing answers there yet.

   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-engine-sidecar.ps1

 Needed only while the real gateway (:8080) runs code without the engine routes. It never touches
 the gateway or its data. The desktop's Engine / Models screen finds it on its own.
 Keep this file ASCII-only.
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
try {
    $r = Invoke-RestMethod -Uri 'http://127.0.0.1:8081/api/engine/sidecar' -TimeoutSec 3
    Write-Host "engine sidecar already running ($($r.root))" -ForegroundColor Green
    exit 0
} catch {}
$py = (Get-Command python -ErrorAction Stop).Source
$logs = Join-Path $root 'logs'
New-Item -ItemType Directory -Force $logs | Out-Null
$p = Start-Process -FilePath $py -ArgumentList '-m', 'engine.serve', '--port', '8081' -WorkingDirectory $root -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logs 'engine-sidecar.out.log') -RedirectStandardError (Join-Path $logs 'engine-sidecar.err.log') -PassThru
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    try { Invoke-RestMethod -Uri 'http://127.0.0.1:8081/api/engine/sidecar' -TimeoutSec 2 | Out-Null; Write-Host "engine sidecar up (pid $($p.Id))" -ForegroundColor Green; exit 0 } catch {}
}
Write-Host "engine sidecar did not answer; see $logs\engine-sidecar.err.log" -ForegroundColor Red
exit 1
