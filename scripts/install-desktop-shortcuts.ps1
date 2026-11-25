<#
 install-desktop-shortcuts.ps1 - create "Start Command Center" and "Stop Command Center"
 shortcuts on the Desktop, using the app's icon. Safe to re-run (overwrites the two .lnk files).
     powershell -NoProfile -ExecutionPolicy Bypass -File "G:\agentic os\scripts\install-desktop-shortcuts.ps1"
     ... -WithDesktopApp   the Start shortcut also opens the desktop app
#>
param([switch]$WithDesktopApp)
$root    = Split-Path $PSScriptRoot -Parent
$icon    = Join-Path $root 'command center\src-tauri\icons\icon.ico'
$desktop = [Environment]::GetFolderPath('Desktop')        # follows OneDrive folder redirection
$shell   = New-Object -ComObject WScript.Shell

$links = @(
    @{ Name = 'Start Command Center'; Bat = 'start-command-center.bat'; Args = $(if ($WithDesktopApp) { '-WithDesktopApp' } else { '' })
       Desc = 'Start and health-check every Command Center backend service (gateway, phone HTTPS, Whisper, Kokoro, n8n, models)' }
    @{ Name = 'Stop Command Center';  Bat = 'stop-command-center.bat';  Args = ''
       Desc = 'Stop the Command Center backend and free its ports' }
)
foreach ($l in $links) {
    $path = Join-Path $desktop "$($l.Name).lnk"
    $s = $shell.CreateShortcut($path)
    $s.TargetPath       = Join-Path $PSScriptRoot $l.Bat
    $s.Arguments        = $l.Args
    $s.WorkingDirectory = $root
    $s.Description      = $l.Desc
    $s.WindowStyle      = 1
    if (Test-Path $icon) { $s.IconLocation = "$icon,0" }
    $s.Save()
    Write-Host "Created $path -> $($s.TargetPath) $($s.Arguments)"
}
