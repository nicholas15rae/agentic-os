<#
 netbird-firewall.ps1 - let NetBird's WireGuard port in through Windows Firewall, so the phone on
 5G can reach this PC directly (P2P) instead of through a NetBird relay.

 Adds ONE inbound rule: Allow UDP 51820 for C:\Program Files\Netbird\netbird.exe on the Public
 and Private profiles (this PC's Ethernet is on the Public profile). Idempotent: when the rule is
 already right it changes nothing; when it has drifted it is put back. It asks for admin (UAC)
 itself, only when something has to change. It never touches NetBird's settings, the router, or
 any other firewall rule (NetBird's own "Netbird" / "Netbird-v6" rules stay as they are).

     powershell -NoProfile -ExecutionPolicy Bypass -File "G:\agentic os\scripts\netbird-firewall.ps1"
     ... -Check     read-only: show this rule and every other inbound UDP 51820 / NetBird rule
     ... -WhatIf    say what it would do and change nothing (no admin needed)
     ... -Remove    delete the rule again

 The router side (port-forward UDP 51820 to this PC) is in docs/netbird-direct-path.md.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [switch]$Remove,
    [switch]$Check,
    [ValidateRange(1, 65535)][int]$Port = 51820,
    [string]$Program = 'C:\Program Files\Netbird\netbird.exe',
    [switch]$Elevated   # internal: set on the elevated re-launch, which keeps its window open at the end
)

$ErrorActionPreference = 'Stop'
$RuleName    = 'AgenticOS-NetBird-WireGuard-In'
$DisplayName = "NetBird WireGuard (inbound UDP $Port)"
$Group       = 'Agentic OS'
$Description = "Lets NetBird peers outside the LAN (the phone on 5G) reach this PC's WireGuard port directly instead of via a relay. Added by scripts\netbird-firewall.ps1 (remove with -Remove)."

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-RuleState {
    $r = Get-NetFirewallRule -Name $RuleName -ErrorAction SilentlyContinue
    if (-not $r) { return $null }
    $pf = $r | Get-NetFirewallPortFilter
    $af = $r | Get-NetFirewallApplicationFilter
    return [pscustomobject]@{
        Enabled   = [string]$r.Enabled
        Direction = [string]$r.Direction
        Action    = [string]$r.Action
        Profile   = [string]$r.Profile
        Protocol  = [string]$pf.Protocol
        Port      = (@($pf.LocalPort) -join ',')
        Program   = [string]$af.Program
    }
}

function Test-RuleMatches($s) {
    if (-not $s) { return $false }
    $profiles = (($s.Profile -split ',\s*') | Sort-Object) -join ','
    return ($s.Enabled -eq 'True') -and ($s.Direction -eq 'Inbound') -and ($s.Action -eq 'Allow') -and
        ($s.Protocol -eq 'UDP') -and ($s.Port -eq "$Port") -and ($s.Program -ieq $Program) -and
        ($profiles -eq 'Private,Public')
}

function Format-Rule($s) {
    return "enabled=$($s.Enabled) $($s.Direction) $($s.Action) $($s.Protocol) port $($s.Port) program '$($s.Program)' profiles $($s.Profile)"
}

# Read-only: this script's rule, then any other inbound rule that mentions UDP $Port or NetBird.
function Show-Status {
    $s = Get-RuleState
    Write-Host ''
    if (-not $s) {
        Write-Host "Rule '$RuleName': not present."
    } elseif (Test-RuleMatches $s) {
        Write-Host "Rule '$RuleName': in place ($(Format-Rule $s))."
    } else {
        Write-Host "Rule '$RuleName': present but NOT as intended ($(Format-Rule $s)). Re-run without -Check to fix it."
    }
    $byPort = @(Get-NetFirewallPortFilter -Protocol UDP -ErrorAction SilentlyContinue | Where-Object { @($_.LocalPort) -contains "$Port" } | Get-NetFirewallRule -ErrorAction SilentlyContinue)
    $byProg = @(Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue | Where-Object { $_.Program -like '*netbird*' } | Get-NetFirewallRule -ErrorAction SilentlyContinue)
    $byName = @(Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'netbird' })
    $others = @($byPort + $byProg + $byName | Where-Object { $_ -and $_.Name -ne $RuleName -and [string]$_.Direction -eq 'Inbound' } | Sort-Object Name -Unique)
    if (-not $others) {
        Write-Host "Other inbound rules for UDP $Port or NetBird: none."
        return
    }
    Write-Host "Other inbound rules for UDP $Port or NetBird (left untouched):"
    foreach ($r in $others) {
        $pf = $r | Get-NetFirewallPortFilter
        $ad = $r | Get-NetFirewallAddressFilter
        $local = @($ad.LocalAddress) -join ','
        $scope = if ($local -and $local -ne 'Any') { " (only to local address $local, so not the LAN/internet port)" } else { '' }
        Write-Host ("  - {0}: enabled={1} {2} {3} port {4} profiles {5}{6}" -f $r.DisplayName, $r.Enabled, $r.Action, $pf.Protocol, (@($pf.LocalPort) -join ','), $r.Profile, $scope)
    }
}

function Show-LanHint {
    try {
        $cfg = Get-NetIPConfiguration -ErrorAction Stop | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } | Select-Object -First 1
        if ($cfg) {
            $ip = @($cfg.IPv4Address)[0].IPAddress
            Write-Host "Router side: forward UDP $Port to this PC's LAN address $ip ($($cfg.InterfaceAlias)), with a DHCP reservation for it."
            return
        }
    } catch { }
    Write-Host "Router side: forward UDP $Port to this PC's LAN address, with a DHCP reservation for it."
}

function Exit-Script([int]$code) {
    if ($Elevated) { [void](Read-Host 'Press Enter to close this window') }
    exit $code
}

# ---- read-only modes ------------------------------------------------------------------------
if ($Check) {
    Show-Status
    exit 0
}

if (-not $Remove -and -not (Test-Path -LiteralPath $Program)) {
    Write-Host "netbird.exe not found at '$Program'. Install NetBird or pass -Program <path>. Nothing changed."
    Exit-Script 2
}

$state = Get-RuleState
if ($Remove -and -not $state) {
    Write-Host "No rule named '$RuleName'. Nothing to remove."
    Exit-Script 0
}
if (-not $Remove -and (Test-RuleMatches $state)) {
    Write-Host "Already in place: $DisplayName for '$Program' on Public+Private. Nothing changed."
    Show-Status
    Show-LanHint
    Exit-Script 0
}

$plan = if ($Remove) { "remove rule '$RuleName'" }
        elseif ($state) { "replace rule '$RuleName' (now: $(Format-Rule $state)) with: inbound Allow UDP $Port for '$Program' on Public+Private" }
        else { "add rule '$RuleName': inbound Allow UDP $Port for '$Program' on Public+Private" }

if ($WhatIfPreference) {
    Write-Host "What if: would $plan. Nothing changed."
    exit 0
}

# ---- changes: need admin ------------------------------------------------------------------
if (-not (Test-Admin)) {
    Write-Host "To $plan, Windows Firewall needs administrator rights. Asking (UAC)..."
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Elevated', '-Port', "$Port", '-Program', "`"$Program`"")
    if ($Remove) { $argList += '-Remove' }
    try {
        $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $argList -Wait -PassThru
    } catch {
        Write-Host 'UAC was declined or failed. Nothing changed.'
        exit 1
    }
    Show-Status
    exit $p.ExitCode
}

try {
    if ($Remove) {
        if ($PSCmdlet.ShouldProcess($RuleName, 'Remove firewall rule')) {
            Remove-NetFirewallRule -Name $RuleName
            Write-Host "Removed '$RuleName' ($DisplayName)."
        }
    } else {
        if ($state -and $PSCmdlet.ShouldProcess($RuleName, 'Replace drifted firewall rule')) {
            Remove-NetFirewallRule -Name $RuleName
            Write-Host "Removed the drifted '$RuleName' (was: $(Format-Rule $state))."
        }
        if ($PSCmdlet.ShouldProcess($RuleName, "Add inbound Allow UDP $Port for $Program")) {
            New-NetFirewallRule -Name $RuleName -DisplayName $DisplayName -Group $Group -Description $Description `
                -Direction Inbound -Action Allow -Protocol UDP -LocalPort $Port -Program $Program `
                -Profile Public, Private -Enabled True | Out-Null
            Write-Host "Added '$RuleName': inbound Allow UDP $Port for '$Program' on Public+Private."
        }
    }
} catch {
    Write-Host "Failed: $($_.Exception.Message)"
    Exit-Script 1
}
Show-Status
if (-not $Remove) { Show-LanHint }
Exit-Script 0
