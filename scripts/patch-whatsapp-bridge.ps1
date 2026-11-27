<#
=============================================================================
 patch-whatsapp-bridge.ps1 - move the WhatsApp bridge off :8080 and onto loopback

 The lharries whatsapp-mcp checkout (G:\ai-hub\whatsapp-mcp, outside this repo) has its
 Go bridge's REST API hard-coded to :8080, which the gateway owns, and bound to EVERY
 interface. That API has no authentication (/api/send sends a WhatsApp message), so
 on all interfaces any NetBird peer could send as you. This script changes three lines:

   whatsapp-bridge\main.go               startRESTServer(..., 8080)  -> the new port
   whatsapp-bridge\main.go               fmt.Sprintf(":%d", port)    -> "127.0.0.1:%d"
   whatsapp-mcp-server\whatsapp.py       http://localhost:8080/api   -> http://127.0.0.1:<port>/api

 It shows the diff and writes NOTHING until you type yes. It refuses when the port is
 in use (netstat) or is one the Command Center already uses, and when a line it expects
 is missing or appears twice (upstream changed: patch by hand). Each file it changes is
 copied to <file>.cc-backup-<time> first; encoding, BOM and line endings are kept.
 Already patched -> it says so and changes nothing.

 Usage:
   powershell -ExecutionPolicy Bypass -File scripts\patch-whatsapp-bridge.ps1            # diff, then asks
   powershell -ExecutionPolicy Bypass -File scripts\patch-whatsapp-bridge.ps1 -DiffOnly  # diff only
   ... -Port 8097 -BridgeRoot G:\ai-hub\whatsapp-mcp

 After it: rebuild the bridge (CGO is required by go-sqlite3: a C compiler such as
 MSYS2 ucrt64 gcc on PATH), run it once in a console to scan the QR if the session
 expired, then let start-command-center.ps1 start it (-WithWhatsApp, or
 $WA_AUTOSTART = $true in G:\ai-startup\ai-stack.config.ps1).
 Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less files as ANSI.
 Exit codes: 0 written / already patched / -DiffOnly, 1 declined, 2 refused.
=============================================================================
#>
param(
    [string]$BridgeRoot = 'G:\ai-hub\whatsapp-mcp',
    [int]$Port = 0,
    [switch]$DiffOnly
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'cc-common.ps1')
if ($Port -eq 0) { $Port = $WA_BRIDGE_PORT }

function Stop-Refused([string]$why) { Write-Host "REFUSED: $why" -ForegroundColor Red; Write-Host 'Nothing was written.'; exit 2 }

# ---------------------------------------------------------------- the port ---
if ($Port -lt 1024 -or $Port -gt 65535) { Stop-Refused "port $Port is outside 1024-65535" }
$reserved = [ordered]@{
    'gateway' = $GATEWAY_PORT; 'gateway HTTPS' = $CC_HTTPS_PORT; 'trading bridge' = $CC_BRIDGE_PORT
    'Quantgress' = $QUANTGRESS_PORT; 'Bionic / LM Studio' = $BIONIC_PORT; 'Ollama' = $OLLAMA_PORT
    'llama-server' = $INSTANCE2_PORT; 'AnythingLLM' = $ANYTHINGLLM_PORT; 'TWS paper API' = $TWS_API_PORT
    'Whisper' = 8178; 'Whisper (2nd)' = 8179; 'Kokoro' = 8880; 'n8n' = 5678
}
foreach ($k in $reserved.Keys) { if ([int]$reserved[$k] -eq $Port) { Stop-Refused "port $Port belongs to the $k" } }

# Listeners on the port, from netstat (a listening TCP row has the foreign address 0.0.0.0:0 or
# [::]:0, whatever language the state column is in), plus Get-NetTCPConnection.
# Returns 'address pid name' strings.
function Get-PortListeners([int]$p) {
    $found = @{}
    foreach ($line in @(& netstat.exe -ano -p TCP 2>$null) + @(& netstat.exe -ano -p TCPv6 2>$null)) {
        if ($line -match '^\s*TCP\s+(\S+):(\d+)\s+(0\.0\.0\.0|\[::\]):0\s+\S+\s+(\d+)\s*$' -and [int]$Matches[2] -eq $p) {
            $found["$($Matches[1]) $($Matches[4])"] = [int]$Matches[4]
        }
    }
    foreach ($c in @(Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue)) {
        $found["$($c.LocalAddress) $($c.OwningProcess)"] = [int]$c.OwningProcess
    }
    foreach ($k in $found.Keys) {
        $pn = (Get-Process -Id $found[$k] -ErrorAction SilentlyContinue).ProcessName
        "$k $pn"
    }
}

# ------------------------------------------------------------------ files ---
$mainGo = Join-Path $BridgeRoot 'whatsapp-bridge\main.go'
$mcpPy  = Join-Path $BridgeRoot 'whatsapp-mcp-server\whatsapp.py'
foreach ($f in $mainGo, $mcpPy) { if (-not (Test-Path -LiteralPath $f)) { Stop-Refused "missing $f (is -BridgeRoot right?)" } }

$utf8 = New-Object System.Text.UTF8Encoding($false, $true)   # strict: a non-UTF-8 file is refused
function Read-Src([string]$path) {
    $bytes = [IO.File]::ReadAllBytes($path)
    $bom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
    $start = if ($bom) { 3 } else { 0 }
    try { $text = $utf8.GetString($bytes, $start, $bytes.Length - $start) } catch { Stop-Refused "$path is not UTF-8" }
    [pscustomobject]@{ Path = $path; Bom = $bom; Text = $text; New = $text; Changes = [System.Collections.ArrayList]@() }
}

# One edit: the pattern must match exactly once (a single line); the match is replaced by $replacement.
function Set-Edit($src, [string]$label, [string]$pattern, [string]$replacement, [string]$donePattern) {
    $rx = New-Object Text.RegularExpressions.Regex($pattern, [Text.RegularExpressions.RegexOptions]::Multiline)
    $ms = $rx.Matches($src.New)
    if ($ms.Count -ne 1) {
        if ($ms.Count -eq 0 -and [regex]::IsMatch($src.New, $donePattern, 'Multiline')) { return }   # already patched
        Stop-Refused "$label`: expected exactly one match in $($src.Path), found $($ms.Count) (upstream changed? patch by hand)"
    }
    $m = $ms[0]
    $lineNo = ([regex]::Matches($src.New.Substring(0, $m.Index), "`n")).Count + 1
    $lineStart = $src.New.LastIndexOf("`n", [Math]::Max(0, $m.Index - 1)) + 1
    if ($m.Index -eq 0) { $lineStart = 0 }
    $lineEnd = $src.New.IndexOf("`n", $m.Index); if ($lineEnd -lt 0) { $lineEnd = $src.New.Length }
    $oldLine = $src.New.Substring($lineStart, $lineEnd - $lineStart).TrimEnd("`r")
    $newText = $src.New.Substring(0, $m.Index) + $replacement + $src.New.Substring($m.Index + $m.Length)
    $newEnd = $newText.IndexOf("`n", $lineStart); if ($newEnd -lt 0) { $newEnd = $newText.Length }
    $newLine = $newText.Substring($lineStart, $newEnd - $lineStart).TrimEnd("`r")
    if ($oldLine -eq $newLine) { return }
    $src.New = $newText
    [void]$src.Changes.Add([pscustomobject]@{ Label = $label; Line = $lineNo; Old = $oldLine; New = $newLine })
}

$go = Read-Src $mainGo
Set-Edit $go 'REST port' 'startRESTServer\(client, messageStore, \d+\)' "startRESTServer(client, messageStore, $Port)" "startRESTServer\(client, messageStore, $Port\)"
Set-Edit $go 'bind address' 'serverAddr := fmt\.Sprintf\("[0-9.]*:%d", port\)' 'serverAddr := fmt.Sprintf("127.0.0.1:%d", port)' 'serverAddr := fmt\.Sprintf\("127\.0\.0\.1:%d", port\)'
$py = Read-Src $mcpPy
Set-Edit $py 'MCP server URL' '^WHATSAPP_API_BASE_URL = "http://[^"/\s]+/api"' "WHATSAPP_API_BASE_URL = `"http://127.0.0.1:$Port/api`"" ('^WHATSAPP_API_BASE_URL = "http://127\.0\.0\.1:' + $Port + '/api"')

# The patched source must now say what we want, whatever was there before.
if ($go.New -notmatch [regex]::Escape("startRESTServer(client, messageStore, $Port)") -or $go.New -notmatch [regex]::Escape('fmt.Sprintf("127.0.0.1:%d", port)')) { Stop-Refused "could not place the edits in $mainGo" }

$files = @($go, $py) | Where-Object { $_.Changes.Count }
Write-Host ''
Write-Host "WhatsApp bridge patch: REST API -> 127.0.0.1:$Port   ($BridgeRoot)" -ForegroundColor Cyan
if (-not $files) {
    Write-Host "Already patched: the bridge listens on 127.0.0.1:$Port and the MCP server calls it there. Nothing to do." -ForegroundColor Green
    exit 0
}
foreach ($f in $files) {
    Write-Host ''
    Write-Host "--- $($f.Path)" -ForegroundColor White
    Write-Host "+++ $($f.Path) (patched)" -ForegroundColor White
    foreach ($c in $f.Changes) {
        Write-Host ("@@ line {0}: {1}" -f $c.Line, $c.Label) -ForegroundColor DarkCyan
        Write-Host ("-{0}" -f $c.Old) -ForegroundColor Red
        Write-Host ("+{0}" -f $c.New) -ForegroundColor Green
    }
}
Write-Host ''

# Port check (netstat): nothing may already listen on the new port.
$busy = @(Get-PortListeners $Port)
if ($busy.Count) { Stop-Refused ("port $Port is in use: " + ($busy -join '; ') + ' - pick another with -Port') }
Write-Host "Port $Port is free (netstat)." -ForegroundColor Gray

$running = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.StartsWith($BridgeRoot, [StringComparison]::OrdinalIgnoreCase) })
if ($running.Count) {
    Write-Host ("Note: a bridge process is running from $BridgeRoot (pid " + (($running | ForEach-Object ProcessId) -join ', ') + '). It keeps the old port until you rebuild and restart it.') -ForegroundColor Yellow
}
if ($DiffOnly) { Write-Host '-DiffOnly: nothing was written.'; exit 0 }

$answer = ''
try { $answer = Read-Host 'Write these changes? Type yes to apply' } catch { $answer = '' }
if ($answer -ne 'yes') { Write-Host 'Not applied. Nothing was written.' -ForegroundColor Yellow; exit 1 }

# Re-check right before writing.
$busy = @(Get-PortListeners $Port)
if ($busy.Count) { Stop-Refused ("port $Port became busy: " + ($busy -join '; ')) }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$enc = New-Object System.Text.UTF8Encoding($false)
foreach ($f in $files) {
    $backup = "$($f.Path).cc-backup-$stamp"
    Copy-Item -LiteralPath $f.Path -Destination $backup
    $body = $enc.GetBytes($f.New)
    if ($f.Bom) { $body = [byte[]](0xEF, 0xBB, 0xBF) + $body }
    [IO.File]::WriteAllBytes($f.Path, $body)
    $check = Read-Src $f.Path
    if ($check.Text -ne $f.New) { Write-Host "WRITE CHECK FAILED for $($f.Path) - restore $backup" -ForegroundColor Red; exit 2 }
    Write-Host "  wrote $($f.Path)   (backup: $backup)" -ForegroundColor Green
}

Write-Host ''
Write-Host 'Next:' -ForegroundColor Cyan
Write-Host "  1. Rebuild (CGO on, a C compiler on PATH):"
Write-Host "       cd `"$(Join-Path $BridgeRoot 'whatsapp-bridge')`"; go env -w CGO_ENABLED=1; go build -o whatsapp-bridge.exe ."
Write-Host '  2. Run whatsapp-bridge.exe once in a console; scan the QR (WhatsApp > Linked devices) if it asks.'
Write-Host "  3. Check it is loopback only:  netstat -ano | findstr :$Port   (127.0.0.1 only, never the NetBird IP)"
Write-Host '  4. Restart whatever runs the WhatsApp MCP server (the desktop app) so it calls the new port.'
Write-Host '  5. start-command-center.ps1 -WithWhatsApp starts the bridge and the inbox ingester; once proven, set'
Write-Host '     $WA_AUTOSTART = $true in G:\ai-startup\ai-stack.config.ps1 to start them every launch.'
exit 0
