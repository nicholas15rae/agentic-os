<#
=============================================================================
 comms-bridge-smoke.ps1 - prove the phone bridge's transport works, end to end

 Run on this PC. For each transport it:
   1. opens the live socket (WS /api/comms/ws),
   2. posts a fake text (POST /api/comms/sms) and a fake missed call
      (POST /api/comms/call-log), both with ids that start with "selftest:",
   3. checks the text's thread (GET /threads, /threads/selftest/messages),
      the call (GET /calls) and the socket's "sms" event,
   4. deletes its rows again (DELETE /api/comms/selftest?run=...), which also
      removes their vault copies, and checks they are gone.

 Transports:
   http   http://127.0.0.1:8080          (the desktop's own path, loopback)
   https  https://<NetBird IP>:8443      (the phone's path: token + local CA)

 The https leg checks the server certificate against the Agentic OS Local CA
 (data\certs\agentic-os-ca.crt) and the host name. Nothing else is trusted.
 The gateway token is read from the same file the gateway uses
 (data\command-center\gateway.token) and is
 only ever sent in the Authorization header. It is never printed or logged.

 Nothing is sent to a phone and no real thread or contact is touched: the fake
 rows use the address "selftest" and no contact name.

 Usage:
   powershell -NoProfile -ExecutionPolicy Bypass -File "G:\agentic os\scripts\comms-bridge-smoke.ps1"
   ... -SkipHttps                 loopback only (NetBird down / no certificate)
   ... -HttpsUrl https://100.84.91.149:8443
   ... -HttpUrl / -CaFile / -TokenFile / -TimeoutSec to point it elsewhere

 Exit codes: 0 every check passed, 1 at least one check failed.
 Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less files as ANSI.
=============================================================================
#>
param(
    [string]$HttpUrl = 'http://127.0.0.1:8080',
    [string]$HttpsUrl = '',
    [string]$CaFile = '',
    [string]$TokenFile = '',
    [int]$TimeoutSec = 8,
    [switch]$SkipHttp,
    [switch]$SkipHttps
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

$Root = Split-Path $PSScriptRoot -Parent
if (-not $CaFile) { $CaFile = Join-Path $Root 'data\certs\agentic-os-ca.crt' }
# The file server.py's ZeroTrustMiddleware reads (the desktop app's network lock writes it).
if (-not $TokenFile) { $TokenFile = Join-Path $Root 'data\command-center\gateway.token' }
$TimeoutMs = [Math]::Max(1, $TimeoutSec) * 1000

# ---- TLS pinned to the local CA, HTTP and WebSocket helpers (C#: callbacks run off the PS thread) ----
if (-not ('CommsSmoke' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Security;
using System.Net.WebSockets;
using System.Reflection;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Threading;

public class CommsSmokeResponse {
    public int Status;
    public string Body = "";
    public string Error = "";
}

public static class CommsSmoke {
    public static X509Certificate2 Ca;
    public static string LastTlsError = "";

    // Accept the server certificate only when it matches the host name and chains to Ca.
    public static bool Validate(object sender, X509Certificate cert, X509Chain chain, SslPolicyErrors errors) {
        if (cert == null) { LastTlsError = "the server sent no certificate"; return false; }
        if ((errors & SslPolicyErrors.RemoteCertificateNameMismatch) != 0) { LastTlsError = "the certificate does not match the host name"; return false; }
        if (Ca == null) { LastTlsError = "no local CA certificate loaded"; return false; }
        using (X509Chain ch = new X509Chain()) {
            ch.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
            ch.ChainPolicy.VerificationFlags = X509VerificationFlags.AllowUnknownCertificateAuthority;
            ch.ChainPolicy.ExtraStore.Add(Ca);
            if (!ch.Build(new X509Certificate2(cert))) {
                StringBuilder sb = new StringBuilder();
                foreach (X509ChainStatus s in ch.ChainStatus) { sb.Append(s.Status).Append(' '); }
                LastTlsError = "certificate chain invalid: " + sb.ToString().Trim();
                return false;
            }
            X509Certificate2 root = ch.ChainElements[ch.ChainElements.Count - 1].Certificate;
            if (!string.Equals(root.Thumbprint, Ca.Thumbprint, StringComparison.OrdinalIgnoreCase)) {
                LastTlsError = "the certificate is not issued by the Agentic OS Local CA";
                return false;
            }
        }
        LastTlsError = "";
        return true;
    }

    public static void Init() {
        ServicePointManager.SecurityProtocol = ServicePointManager.SecurityProtocol | SecurityProtocolType.Tls12;
    }

    static CommsSmokeResponse Read(HttpWebResponse r) {
        CommsSmokeResponse o = new CommsSmokeResponse();
        o.Status = (int)r.StatusCode;
        using (StreamReader sr = new StreamReader(r.GetResponseStream(), Encoding.UTF8)) { o.Body = sr.ReadToEnd(); }
        return o;
    }

    public static CommsSmokeResponse Http(string method, string url, string token, string json, int timeoutMs) {
        LastTlsError = "";
        try {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
            req.Method = method;
            req.Timeout = timeoutMs;
            req.ReadWriteTimeout = timeoutMs;
            req.Accept = "application/json";
            req.KeepAlive = false;
            req.Proxy = null;   // the gateway is always a direct connection (loopback or NetBird)
            if (url.StartsWith("https:", StringComparison.OrdinalIgnoreCase)) { req.ServerCertificateValidationCallback = Validate; }
            if (!string.IsNullOrEmpty(token)) { req.Headers["Authorization"] = "Bearer " + token; }
            if (!string.IsNullOrEmpty(json)) {   // PowerShell passes $null to a string parameter as ""
                byte[] b = Encoding.UTF8.GetBytes(json);
                req.ContentType = "application/json";
                req.ContentLength = b.Length;
                using (Stream s = req.GetRequestStream()) { s.Write(b, 0, b.Length); }
            }
            using (HttpWebResponse r = (HttpWebResponse)req.GetResponse()) { return Read(r); }
        } catch (WebException e) {
            HttpWebResponse r = e.Response as HttpWebResponse;
            if (r != null) { using (r) { return Read(r); } }
            CommsSmokeResponse o = new CommsSmokeResponse();
            o.Error = e.Message + (LastTlsError.Length > 0 ? " (" + LastTlsError + ")" : "");
            return o;
        } catch (Exception e) {
            CommsSmokeResponse o = new CommsSmokeResponse();
            o.Error = e.Message;
            return o;
        }
    }

    // Connect the socket. Returns null and sets error on failure.
    public static ClientWebSocket WsOpen(string url, string token, int timeoutMs, out string error) {
        error = "";
        LastTlsError = "";
        ClientWebSocket ws = new ClientWebSocket();
        ws.Options.Proxy = null;
        if (!string.IsNullOrEmpty(token)) { ws.Options.SetRequestHeader("Authorization", "Bearer " + token); }
        if (url.StartsWith("wss:", StringComparison.OrdinalIgnoreCase)) {
            // .NET Core / PowerShell 7 has a per-socket callback; .NET Framework's ClientWebSocket only
            // consults the process-wide one (this script is its own process).
            PropertyInfo p = typeof(ClientWebSocketOptions).GetProperty("RemoteCertificateValidationCallback");
            if (p != null) { p.SetValue(ws.Options, new RemoteCertificateValidationCallback(Validate), null); }
            else { ServicePointManager.ServerCertificateValidationCallback = Validate; }
        }
        try {
            using (CancellationTokenSource cts = new CancellationTokenSource(timeoutMs)) {
                ws.ConnectAsync(new Uri(url), cts.Token).Wait();
            }
            return ws;
        } catch (Exception e) {
            Exception inner = e is AggregateException && e.InnerException != null ? e.InnerException : e;
            error = inner.Message;
            if (inner.InnerException != null) { error += ": " + inner.InnerException.Message; }
            if (LastTlsError.Length > 0) { error += " (" + LastTlsError + ")"; }
            ws.Dispose();
            return null;
        }
    }

    // Read text frames until one contains `needle` or the time is up. Returns that frame, or null.
    public static string WsWait(ClientWebSocket ws, string needle, int timeoutMs) {
        DateTime end = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        byte[] buf = new byte[65536];
        try {
            while (ws.State == WebSocketState.Open) {
                int left = (int)(end - DateTime.UtcNow).TotalMilliseconds;
                if (left <= 0) { return null; }
                MemoryStream msg = new MemoryStream();
                WebSocketReceiveResult r;
                using (CancellationTokenSource cts = new CancellationTokenSource(left)) {
                    do {
                        r = ws.ReceiveAsync(new ArraySegment<byte>(buf), cts.Token).Result;
                        if (r.MessageType == WebSocketMessageType.Close) { return null; }
                        msg.Write(buf, 0, r.Count);
                    } while (!r.EndOfMessage);
                }
                string text = Encoding.UTF8.GetString(msg.ToArray());
                if (text.Contains(needle)) { return text; }
            }
        } catch (Exception) { }
        return null;
    }

    public static void WsClose(ClientWebSocket ws) {
        if (ws == null) { return; }
        try {
            if (ws.State == WebSocketState.Open) {
                using (CancellationTokenSource cts = new CancellationTokenSource(2000)) {
                    ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "smoke done", cts.Token).Wait();
                }
            }
        } catch (Exception) { }
        ws.Dispose();
    }
}
'@
}
[CommsSmoke]::Init()

# ---- results ----
$script:Failed = 0
$script:Passed = 0
function Out-Check([string]$leg, [bool]$ok, [string]$what, [string]$detail = '') {
    if ($ok) { $script:Passed++; $tag = 'PASS' } else { $script:Failed++; $tag = 'FAIL' }
    $line = '[{0}] {1,-5} {2}' -f $tag, $leg, $what
    if ($detail) { $line += " - $detail" }
    Write-Output $line
}
function Out-Info([string]$msg) { Write-Output "       $msg" }

# One HTTP call; returns @{ ok; status; json; why } (why: a short reason when not ok).
function Invoke-Gw([string]$method, [string]$url, $body = $null) {
    $json = if ($null -ne $body) { ConvertTo-Json -InputObject $body -Depth 6 -Compress } else { $null }
    $r = [CommsSmoke]::Http($method, $url, $script:Token, $json, $TimeoutMs)
    $parsed = $null
    if ($r.Body) { try { $parsed = $r.Body | ConvertFrom-Json } catch { $parsed = $null } }
    $why = ''
    if ($r.Status -eq 0) { $why = "no answer: $($r.Error)" }
    elseif ($r.Status -eq 401) { $why = 'HTTP 401: the gateway token was refused (wrong or missing token file)' }
    elseif ($r.Status -ge 300) { $why = "HTTP $($r.Status)" + $(if ($parsed -and ($parsed.PSObject.Properties.Name -contains 'detail')) { ": $($parsed.detail)" } else { '' }) }
    return @{ ok = ($r.Status -ge 200 -and $r.Status -lt 300); status = $r.Status; json = $parsed; why = $why }
}

function Get-Prop($obj, [string]$name) {
    if ($null -eq $obj) { return $null }
    if ($obj.PSObject.Properties.Name -contains $name) { return $obj.$name }
    return $null
}

# The NetBird address (100.64.0.0/10) of this PC, or $null (same parse as cc-common.ps1's Get-MeshIp).
function Get-SmokeMeshIp {
    if (-not (Get-Command netbird -ErrorAction SilentlyContinue)) { return $null }
    $ErrorActionPreference = 'Continue'   # netbird's stderr must not stop the script
    try {
        $line = (& netbird status 2>$null) | Select-String 'NetBird IP:' | Select-Object -First 1
        if ($line -and $line.ToString() -match '(100\.\d+\.\d+\.\d+)') { return $Matches[1] }
    } catch { }
    return $null
}

# ---- token (never printed) and CA ----
$script:Token = ''
if (Test-Path -LiteralPath $TokenFile) {
    try { $script:Token = ([IO.File]::ReadAllText($TokenFile)).Trim() } catch { $script:Token = '' }
}
if ($script:Token) { Write-Output "Gateway token: found (sent in the Authorization header only)" }
else { Write-Output "Gateway token: none at the token file (the network lock is off, or the file is elsewhere: -TokenFile)" }

$legs = @()
if (-not $SkipHttp) { $legs += , @('http', $HttpUrl.TrimEnd('/')) }
if (-not $SkipHttps) {
    if (-not $HttpsUrl) {
        $mesh = Get-SmokeMeshIp
        if ($mesh) { $HttpsUrl = "https://${mesh}:8443" }
    }
    if (-not $HttpsUrl) {
        Out-Check 'https' $false 'find the phone path' 'NetBird is not connected (no 100.x address). Run "netbird up", pass -HttpsUrl, or use -SkipHttps'
    } elseif (-not (Test-Path -LiteralPath $CaFile)) {
        Out-Check 'https' $false 'load the local CA' "no CA certificate at $CaFile (pass -CaFile)"
    } else {
        try {
            [CommsSmoke]::Ca = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList $CaFile
            $legs += , @('https', $HttpsUrl.TrimEnd('/'))
        } catch {
            Out-Check 'https' $false 'load the local CA' "could not read $CaFile"
        }
    }
}

$run = 'smoke{0}-{1}' -f (Get-Date -Format 'yyyyMMddHHmmss'), ([guid]::NewGuid().ToString('N').Substring(0, 6))
$cleanupBase = $null   # a base URL that worked, for the final safety sweep
$pendingRuns = New-Object System.Collections.Generic.List[string]

foreach ($leg in $legs) {
    $name = $leg[0]; $base = $leg[1]
    $legRun = "$run-$name"
    $smsId = "selftest:${legRun}:sms"
    $callId = "selftest:${legRun}:call"
    Write-Output ''
    Write-Output "== $name  $base  (run $legRun)"

    # 1. live socket first, so the event can't be missed
    $wsUrl = ($base -replace '^http', 'ws') + '/api/comms/ws'
    $wsErr = ''
    $ws = [CommsSmoke]::WsOpen($wsUrl, $script:Token, $TimeoutMs, [ref]$wsErr)
    Out-Check $name ($null -ne $ws) 'open the live socket (WS /api/comms/ws)' $wsErr
    if ($ws) { Start-Sleep -Milliseconds 300 }   # let the gateway register the client before the post

    try {
        # 2. fake text + fake call
        $nowMs = [long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
        $sms = Invoke-Gw 'POST' "$base/api/comms/sms" @{ messages = @(@{ id = $smsId; address = 'selftest'; body = "Agentic OS bridge self-test $legRun"; ts = $nowMs; direction = 'in'; channel = 'sms' }) }
        $added = Get-Prop $sms.json 'added'
        Out-Check $name ($sms.ok -and $added -eq 1) 'post a test text (POST /api/comms/sms)' $(if (-not $sms.ok) { $sms.why } elseif ($added -ne 1) { "added=$added" } else { '' })
        if (-not $sms.ok) {
            if ($ws) { [CommsSmoke]::WsClose($ws); $ws = $null }
            Out-Info 'the gateway did not take the text; the rest of this transport is skipped'
            continue
        }
        if ($null -eq $cleanupBase) { $cleanupBase = $base }
        $pendingRuns.Add($legRun)

        $call = Invoke-Gw 'POST' "$base/api/comms/call-log" @{ calls = @(@{ id = $callId; address = 'selftest'; direction = 'missed'; ts = $nowMs; duration = 0 }) }
        $cadded = Get-Prop $call.json 'added'
        Out-Check $name ($call.ok -and $cadded -eq 1) 'post a test call (POST /api/comms/call-log)' $(if (-not $call.ok) { $call.why } elseif ($cadded -ne 1) { "added=$cadded" } else { '' })

        # 3. the socket event
        if ($ws) {
            $frame = [CommsSmoke]::WsWait($ws, $smsId, $TimeoutMs)
            $evOk = $false
            if ($frame) {
                try { $ev = $frame | ConvertFrom-Json; $evOk = ((Get-Prop $ev 'type') -eq 'sms' -and (Get-Prop $ev 'id') -eq $smsId) } catch { $evOk = $false }
            }
            Out-Check $name $evOk 'the socket pushed the "sms" event' $(if (-not $frame) { "nothing within $TimeoutSec s" } elseif (-not $evOk) { 'a frame named the id but was not an sms event' } else { '' })
            [CommsSmoke]::WsClose($ws); $ws = $null
        }

        # 4. threads, messages, calls
        $th = Invoke-Gw 'GET' "$base/api/comms/threads?limit=500"
        $thHit = $th.ok -and @((Get-Prop $th.json 'threads') | Where-Object { $_ -and $_.thread -eq 'selftest' }).Count -ge 1
        Out-Check $name $thHit 'the "selftest" thread is listed (GET /api/comms/threads)' $(if (-not $th.ok) { $th.why } elseif (-not $thHit) { 'thread not in the list' } else { '' })

        $ms = Invoke-Gw 'GET' "$base/api/comms/threads/selftest/messages?limit=200"
        $msHit = $ms.ok -and @((Get-Prop $ms.json 'messages') | Where-Object { $_ -and $_.id -eq $smsId }).Count -eq 1
        Out-Check $name $msHit 'the test text is in its thread (GET /threads/selftest/messages)' $(if (-not $ms.ok) { $ms.why } elseif (-not $msHit) { 'message not found' } else { '' })

        $cl = Invoke-Gw 'GET' "$base/api/comms/calls?limit=1000"
        $clHit = $cl.ok -and @((Get-Prop $cl.json 'calls') | Where-Object { $_ -and $_.id -eq $callId }).Count -eq 1
        Out-Check $name $clHit 'the test call is listed (GET /api/comms/calls)' $(if (-not $cl.ok) { $cl.why } elseif (-not $clHit) { 'call not found' } else { '' })

        # 5. delete over the same transport (the phone deletes its own test rows too)
        $del = Invoke-Gw 'DELETE' "$base/api/comms/selftest?run=$legRun"
        $dm = Get-Prop $del.json 'messages'; $dc = Get-Prop $del.json 'calls'; $dv = Get-Prop $del.json 'vault'
        $delOk = $del.ok -and $dm -ge 1 -and $dc -ge 1 -and $dv -ge 1
        Out-Check $name $delOk 'delete the test rows and their vault copies (DELETE /api/comms/selftest)' $(if (-not $del.ok) { $del.why } else { "messages=$dm calls=$dc vault=$dv" })
        if ($del.ok) { [void]$pendingRuns.Remove($legRun) }

        $after = Invoke-Gw 'GET' "$base/api/comms/threads/selftest/messages?limit=200"
        $gone = $after.ok -and @((Get-Prop $after.json 'messages') | Where-Object { $_ -and $_.id -eq $smsId }).Count -eq 0
        Out-Check $name $gone 'the test text is gone afterwards' $(if (-not $after.ok) { $after.why } elseif (-not $gone) { 'still listed' } else { '' })
    } finally {
        if ($ws) { [CommsSmoke]::WsClose($ws) }
    }
}

# Safety sweep: a leg that stopped half-way still gets its rows removed.
if ($pendingRuns.Count -gt 0 -and $cleanupBase) {
    foreach ($r in @($pendingRuns)) {
        $d = Invoke-Gw 'DELETE' "$cleanupBase/api/comms/selftest?run=$r"
        if ($d.ok) { Out-Info "cleaned up the rows of $r" } else { Out-Info "could not clean up $r ($($d.why)); run DELETE /api/comms/selftest?run=$r later" }
    }
}

Write-Output ''
if ($legs.Count -eq 0 -and $script:Failed -eq 0) {
    Write-Output 'Nothing to test (both transports skipped).'
    exit 1
}
Write-Output ("Result: {0} passed, {1} failed" -f $script:Passed, $script:Failed)
if ($script:Failed -gt 0) { exit 1 }
exit 0
