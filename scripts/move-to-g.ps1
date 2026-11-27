<#
 move-to-g.ps1 - finish moving the Agentic OS resources onto G: (planned 2026-11-23).

 Close the Command Center and the Claude app first, then run (in PowerShell):
     powershell -ExecutionPolicy Bypass -File "G:\agentic os\scripts\move-to-g.ps1"

 What it does, in order (it stops at the first problem; nothing is ever deleted):
   1. Checks nothing still has the old folders open.
   2. Copies anything that changed since the first copy:  C:\ai-hub -> G:\ai-hub,
      D:\ai-hub-memory -> G:\ai-hub-memory, C:\whisper -> G:\whisper, D:\ai-startup -> G:\ai-startup.
      Then checks every old file has a copy on G:.
   3. Renames each old folder to <name>.pre-move-2026-11-23 and leaves a junction (a folder
      link) at the old path pointing to G:, so anything still using an old path keeps working.
   4. Repoints the app's settings (os.json, providers.json) and Claude's tools
      (claude_desktop_config.json) to G:, with a backup of each file.
   5. Updates the ai-hub docs that name the old path, and re-registers the logon task
      "AI Stack Startup" to run from G:\ai-startup.

 Undo: delete a junction (Remove-Item C:\ai-hub - removes only the link), rename the
 .pre-move folder back, and restore the .bak-*-move-to-g config backups.
#>
$ErrorActionPreference = 'Stop'
$Suffix = '.pre-move-2026-11-23'
$Moves = @(
    @{ Old = 'C:\ai-hub';        New = 'G:\ai-hub' },
    @{ Old = 'D:\ai-hub-memory'; New = 'G:\ai-hub-memory' },
    @{ Old = 'C:\whisper';       New = 'G:\whisper' },
    @{ Old = 'D:\ai-startup';    New = 'G:\ai-startup' }
)
function Say([string]$m, [string]$c = 'Gray') { Write-Host $m -ForegroundColor $c }
function Stop-Here([string]$m) { Say "`nSTOPPED: $m" Red; Say 'Nothing after this point was changed. Fix it and run the script again (it is safe to re-run).' Yellow; exit 1 }
function Is-Junction([string]$p) { $i = Get-Item $p -Force -ErrorAction SilentlyContinue; $i -and ($i.Attributes -band [IO.FileAttributes]::ReparsePoint) }

Say '== 1. Checking nothing is using the old folders' Cyan
if (-not (Test-Path 'G:\')) { Stop-Here 'G: is not mounted.' }
foreach ($n in 'command-center', 'Claude') {
    if (Get-Process -Name $n -ErrorAction SilentlyContinue) { Stop-Here "$n is still running. Close it (also from the system tray) and run again." }
}
# Whisper is the app's own child; it can outlive the app.
Get-Process -Name whisper-server -ErrorAction SilentlyContinue | Stop-Process -Force
$pending = $Moves | Where-Object { -not (Is-Junction $_.Old) }
$pat = ($pending | ForEach-Object { [regex]::Escape($_.Old) + '(\\|"|\s|$)' }) -join '|'
if ($pat) {
    $users = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.ProcessId -ne $PID -and $_.CommandLine -match $pat }
    if ($users) {
        $users | ForEach-Object { Say ("   PID {0} {1}: {2}" -f $_.ProcessId, $_.Name, $_.CommandLine.Substring(0, [Math]::Min(140, $_.CommandLine.Length))) Yellow }
        Stop-Here 'these programs still use an old folder (above). Close them first.'
    }
}
Say '   ok'

Say '== 2. Copying what changed since the first copy, then checking' Cyan
foreach ($m in $pending) {
    if (-not (Test-Path $m.Old)) { Say "   $($m.Old) does not exist - skipped" Yellow; continue }
    robocopy $m.Old $m.New /E /XO /COPY:DAT /DCOPY:DAT /R:2 /W:2 /NFL /NDL /NP /NJH /NJS | Out-Null
    if ($LASTEXITCODE -ge 8) { Stop-Here "copying $($m.Old) to $($m.New) failed (robocopy code $LASTEXITCODE)." }
    $missing = Get-ChildItem $m.Old -Recurse -File -Force | Where-Object { -not (Test-Path -LiteralPath ($m.New + $_.FullName.Substring($m.Old.Length))) }
    if ($missing) { $missing | Select-Object -First 10 | ForEach-Object { Say "   missing on G: $($_.FullName)" Yellow }; Stop-Here "$(@($missing).Count) file(s) from $($m.Old) are not on G:." }
    Say ("   {0} -> {1}: {2} files, all present" -f $m.Old, $m.New, (Get-ChildItem $m.Old -Recurse -File -Force).Count)
}

Say '== 3. Parking the old folders and linking the old paths to G:' Cyan
foreach ($m in $Moves) {
    if (Is-Junction $m.Old) { Say "   $($m.Old) is already a link to G: - skipped"; continue }
    if (-not (Test-Path $m.Old)) { New-Item -ItemType Junction -Path $m.Old -Target $m.New | Out-Null; Say "   linked $($m.Old) -> $($m.New)"; continue }
    $parked = $m.Old + $Suffix
    if (Test-Path $parked) { Stop-Here "$parked already exists; move it aside first." }
    try { Rename-Item -LiteralPath $m.Old -NewName (Split-Path $parked -Leaf) }
    catch { Stop-Here "could not rename $($m.Old) - something still has it open (an Explorer window, terminal or editor?). $($_.Exception.Message)" }
    New-Item -ItemType Junction -Path $m.Old -Target $m.New | Out-Null
    Say "   $($m.Old) -> parked as $parked, linked to $($m.New)"
}

Say '== 4. Pointing the app and Claude at G:' Cyan
$py = "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe"; if (-not (Test-Path $py)) { $py = 'python' }
& $py -I (Join-Path $PSScriptRoot 'update-configs-for-g.py')
if ($LASTEXITCODE -ne 0) { Stop-Here 'a config file still names an old path (see above).' }

Say '== 5. ai-hub docs and the logon task' Cyan
$docs = Get-ChildItem 'G:\ai-hub\master', 'G:\ai-hub\media' -Recurse -File -Include *.md, *.json -ErrorAction SilentlyContinue
foreach ($f in $docs) {
    $t = [IO.File]::ReadAllText($f.FullName)
    $n = $t -replace '(?i)\bC:(\\\\|\\|/)ai-hub(?![\w-])', 'G:$1ai-hub'
    if ($n -ne $t) { [IO.File]::WriteAllText($f.FullName, $n, (New-Object Text.UTF8Encoding $false)); Say "   updated $($f.FullName)" }
}
git -C G:\ai-hub add -- master | Out-Null
git -C G:\ai-hub diff --cached --quiet -- master
if ($LASTEXITCODE -ne 0) { git -C G:\ai-hub commit -q -m 'docs: ai-hub lives at G:\ai-hub now' -- master; Say '   committed the doc changes in G:\ai-hub' }
& 'G:\ai-startup\register-startup-task.ps1' | Out-Host

Say "`nDone. Open the Command Center and the Claude app again." Green
Say 'The old copies are parked as *.pre-move-2026-11-23; delete them once everything has run fine for a few days.' Green
