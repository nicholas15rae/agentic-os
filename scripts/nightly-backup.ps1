# Nightly backup of Agentic OS from the fast drives (G: repo, C: app data) to the D: hard drive.
#
# What it saves, under D:\Backups\agentic-os:
#   bundles\agentic-os-<date>.bundle   every branch, tag and the stash (git bundle --all); last 14 kept
#   worktree-mirror\                   the working tree as it is right now, so uncommitted work and
#                                      gitignored personal data (data/, training_logs/, .env, brain/)
#                                      survive; build output and junctions are skipped
#   appdata\<date>\                    %APPDATA%\os.agentic.commandcenter (settings JSON, voices) with each
#                                      SQLite database copied through SQLite's backup API, so a running
#                                      Command Center can't leave a half-written copy; last 14 kept
#   stack-mirror\{ai-hub,ai-hub-memory,ai-startup}\   exact mirrors of the rest of the stack on G:
#   backup.log                         one block per run
#
# Run by the "Agentic OS nightly backup" scheduled task. Safe to run by hand any time:
#   powershell -NoProfile -ExecutionPolicy Bypass -File "G:\agentic os\scripts\nightly-backup.ps1"

param(
    [string]$Repo = 'G:\agentic os',
    [string]$Dest = 'D:\Backups\agentic-os',
    [int]$Keep = 14
)

# 'Continue', not 'Stop': in Windows PowerShell 5.1 a native tool writing progress to stderr (git does)
# would otherwise throw. Every step checks its exit code instead.
$ErrorActionPreference = 'Continue'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$appData = Join-Path $env:APPDATA 'os.agentic.commandcenter'
$python = 'C:\Users\nicho\AppData\Local\Programs\Python\Python311\python.exe'
$git = 'C:\Program Files\Git\cmd\git.exe'
New-Item -ItemType Directory -Force $Dest | Out-Null
$log = Join-Path $Dest 'backup.log'
$failed = $false

function Write-Log([string]$msg) {
    $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Add-Content -Path $log -Value $line -Encoding utf8
    Write-Output $line
}

function Remove-OldItems([string]$dir, [string]$filter, [int]$keep) {
    Get-ChildItem $dir -Filter $filter -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending | Select-Object -Skip $keep |
        ForEach-Object { Remove-Item $_.FullName -Recurse -Force; Write-Log "  pruned $($_.Name)" }
}

Write-Log "=== backup start ($stamp)"
if (-not (Test-Path $Repo)) {
    Write-Log "FAILED: $Repo is missing. Is the G: Dev Drive attached?"
    exit 1
}

# 1. Git history: every ref, including the stash.
try {
    $bundles = Join-Path $Dest 'bundles'
    New-Item -ItemType Directory -Force $bundles | Out-Null
    $bundle = Join-Path $bundles "agentic-os-$stamp.bundle"
    & $git -C $Repo bundle create $bundle --all 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "git bundle exit $LASTEXITCODE" }
    # verify needs a repository to check against; the scheduler starts in System32, not the repo.
    & $git -C $Repo bundle verify $bundle 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "git bundle verify exit $LASTEXITCODE" }
    Write-Log ("ok  git bundle {0:N1} MB" -f ((Get-Item $bundle).Length / 1MB))
    Remove-OldItems $bundles 'agentic-os-*.bundle' $Keep
} catch { $failed = $true; Write-Log "FAILED git bundle: $_" }

# 2. Working tree mirror (uncommitted + gitignored files). /XJ skips the node_modules junctions
#    in live-run worktrees; /MIR keeps the mirror an exact copy of today's tree.
try {
    $mirror = Join-Path $Dest 'worktree-mirror'
    robocopy $Repo $mirror /MIR /XJ /MT:8 /R:1 /W:1 /NFL /NDL /NP /NJH /NJS `
        /XD node_modules target __pycache__ .pytest_cache .git | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy exit $LASTEXITCODE" }
    Write-Log "ok  worktree mirror (robocopy $LASTEXITCODE)"
} catch { $failed = $true; Write-Log "FAILED worktree mirror: $_" }

# 3. Command Center app data, with consistent SQLite copies.
try {
    $snap = Join-Path (Join-Path $Dest 'appdata') $stamp
    robocopy $appData $snap /E /R:1 /W:1 /NFL /NDL /NP /NJH /NJS `
        /XF *.db *.db-wal *.db-shm /XD pre-move-backup-* | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy exit $LASTEXITCODE" }
    $dbs = Get-ChildItem $appData -Filter *.db -File
    foreach ($db in $dbs) {
        $out = Join-Path $snap $db.Name
        & $python -I -c "import sqlite3,sys; s=sqlite3.connect(sys.argv[1]); d=sqlite3.connect(sys.argv[2]); s.backup(d); d.close(); s.close()" $db.FullName $out
        if ($LASTEXITCODE -ne 0) { throw "sqlite backup of $($db.Name) exit $LASTEXITCODE" }
    }
    Write-Log "ok  app data snapshot ($($dbs.Count) databases)"
    Remove-OldItems (Join-Path $Dest 'appdata') '2*' $Keep
} catch { $failed = $true; Write-Log "FAILED app data: $_" }

# 4. The rest of the stack that lives on G: next to the repo (G: is a VHDX on C:, so without this
#    it would all sit on one physical disk). ai-hub keeps its own .git, so the mirror carries its
#    history too; the live memory is tiny; Whisper is reinstallable and is left out.
foreach ($src in 'G:\ai-hub', 'G:\ai-hub-memory', 'G:\ai-startup') {
    try {
        if (-not (Test-Path $src)) { Write-Log "skip $src (not there)"; continue }
        $to = Join-Path (Join-Path $Dest 'stack-mirror') (Split-Path $src -Leaf)
        robocopy $src $to /MIR /XJ /MT:8 /R:1 /W:1 /NFL /NDL /NP /NJH /NJS `
            /XD node_modules .venv __pycache__ .pytest_cache | Out-Null
        if ($LASTEXITCODE -ge 8) { throw "robocopy exit $LASTEXITCODE" }
        Write-Log "ok  mirror $src (robocopy $LASTEXITCODE)"
    } catch { $failed = $true; Write-Log "FAILED mirror $src : $_" }
}

if ($failed) { Write-Log '=== backup finished WITH ERRORS'; exit 1 }
Write-Log '=== backup ok'
exit 0
