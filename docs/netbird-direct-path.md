# NetBird: a direct path from the phone to this PC

Written 2026-11-26. Goal: when the phone is on 5G, its NetBird link to this PC (`mortadella`,
100.84.91.149) should be **direct (P2P)**, not carried through NetBird's relay in Chicago. A
relayed link adds round-trip time to every phone turn and stalls on a lossy connection. Lazy
connections add a tunnel setup (an estimated 1-3 s) to the first turn after the link has gone
idle, and that lands on Tony's time to first word.

## Where things stand

| What | Reading (2026-11-26, `netbird status`) |
|---|---|
| This PC | NetBird 0.83.1 (0.83.2 available), userspace interface, WireGuard **UDP 51820**, **lazy connections on** |
| LAN | Ethernet `10.0.0.174`, router `10.0.0.1`. The Ethernet network is on the **Public** firewall profile |
| Droplet `ubuntu-s-1vcpu-2gb-70gb-intel-tor1` (100.84.235.228) | **P2P**, ICE `srflx`/`host`, 26-31 ms |
| Phone `r0qcsx` (100.84.84.190) | **Idle**: no WireGuard handshake on record, so there's no P2P/relay reading yet. It can only be read while the phone is actively talking to the PC: that's what the new HUD chip is for |
| Windows Firewall | Only NetBird's own `Netbird` / `Netbird-v6` rules, scoped to the mesh addresses. **Nothing lets unsolicited UDP 51820 in on Ethernet**, so a router port-forward on its own would be dropped by Windows |

Why the phone is probably relayed on 5G: carriers put phones behind CGNAT, usually with
symmetric mapping. Without an open, forwarded port at home, the PC's router drops the phone's
connection attempts and NetBird falls back to the relay. The home router already does
port-preserving NAT (the PC shows up on the internet with source port 51820), so a forward of
that one port is usually all it takes.

## Do it (in this order)

### 1. Give the PC a fixed LAN address

In the router's admin page (normally `http://10.0.0.1`), add a **DHCP reservation** for this PC
at `10.0.0.174`. `ipconfig /all` shows the Ethernet adapter's physical (MAC) address if the
router asks for it. Without it, the forward breaks the day the PC gets a different address.

### 2. Forward UDP 51820 to the PC

Same admin page, port forwarding:

| Field | Value |
|---|---|
| Protocol | **UDP** (not TCP) |
| External port | **51820** |
| Internal IP | **10.0.0.174** |
| Internal port | **51820** |

Keep the external port the same as the internal one. NetBird advertises 51820, and the router
keeps that port as it is.

### 3. Open the port in Windows Firewall

In a normal PowerShell window (it asks for admin through UAC by itself):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "G:\agentic os\scripts\netbird-firewall.ps1"
```

It adds one inbound rule, `AgenticOS-NetBird-WireGuard-In`: Allow **UDP 51820** for
`C:\Program Files\Netbird\netbird.exe`, on the **Public + Private** profiles. It prints what it
did. Re-running it is safe, because it changes nothing when the rule is already right. It never
touches NetBird's settings, the router or any other rule.

| Switch | What it does |
|---|---|
| `-Check` | Read-only: shows the rule, plus every other inbound rule for UDP 51820 or NetBird |
| `-WhatIf` | Says what it would do and changes nothing (no admin needed) |
| `-Remove` | Deletes the rule again |

### 4. Turn lazy connections off

With lazy connections on, NetBird lets idle tunnels go to sleep and only wakes them on the first
packet, so the first phone turn after a quiet spell pays the whole setup.

- **NetBird dashboard** (app.netbird.io): *Settings → Networks → Lazy connections* → **off**.
  If it has moved, search the Settings pages for "lazy". On NetBird 0.83 this toggle is the fix:
  lazy connections are controlled by the management server, not by a client flag.
- Then on the PC, `netbird status -d` should say `Lazy connection: false` (give it a minute).
- If it still says `true`, the only local switch left is the `NB_LAZY_CONN` environment
  variable. It wasn't set anywhere on 2026-11-26; check it hasn't appeared since. Each of these
  prints nothing when it isn't set:
  - System environment variables: `[Environment]::GetEnvironmentVariable('NB_LAZY_CONN','Machine')`
    (or *System Properties → Environment Variables → System variables*).
  - The NetBird service's own environment:
    `(Get-ItemProperty HKLM:\SYSTEM\CurrentControlSet\Services\NetBird).Environment | Select-String NB_LAZY_CONN`

  If either one sets it, delete it there, then in an **admin** PowerShell run
  `netbird service restart`. That drops the mesh for a few seconds, so the phone loses the
  gateway briefly, and so does the desktop's link to the droplet.
- The old `--enable-lazy-connection` client flag is deprecated and ignored in 0.83, so don't use
  it: taking the mesh down and up with it changes nothing.
- If the Android app has its own lazy-connection toggle (in its settings / advanced section),
  turn that off too.

### 5. Stop Android putting NetBird to sleep

On the phone (Galaxy S22): *Settings → Apps → NetBird → Battery* → **Unrestricted**. Also
*Settings → Battery → Background usage limits → Never sleeping apps* → add **NetBird**. Without
this, Android parks the tunnel and the first turn after the phone wakes has to rebuild it.

## Read the result: the MESH chip

The phone HUD (`https://100.84.91.149:8443/mobile-hud`) now adds the path to the **MESH** chip
at the top:

| Chip | Meaning |
|---|---|
| `MESH LOCKED · P2P 31 ms` (teal) | Direct: WireGuard goes straight between the phone and the PC. This is the goal |
| `MESH LOCKED · RELAY chi1 92 ms` (amber) | Relayed through NetBird's relay (here `streamline-us-chi1-…`, Chicago). The forward or the firewall rule isn't working (yet) |
| `MESH LOCKED` with no path | No reading: the tunnel is idle, the gateway is older than this change, or the call failed. It stays quiet on purpose |

- It refreshes every 45 s and again when you come back to the app. The reading is always live,
  because the request that asks for it travels through the same tunnel.
- **Tap the MESH chip** for the details line (tap again to hide it): the ICE candidate **types** on each side.
  `host` means same LAN. `srflx` means a public address learned via STUN (the forward or NAT
  mapping works). `prflx` means one found during the checks (typical for the phone's CGNAT side).
  `relay` means TURN.
- Right after the tunnel wakes, the first reading can say RELAY for a few seconds while NetBird
  tries to upgrade the link to P2P. Trust the next refresh.
- From the desktop, the same data for every peer:
  `curl.exe -s http://127.0.0.1:8080/api/net/path` (loopback lists all peers), or
  `netbird status -d` and look at the `r0qcsx` block (`Connection type`, `ICE candidate`).

What you want to see on 5G: `P2P`, with this PC's side `srflx` (or `host`) and the phone's side
`prflx` or `srflx`.

The endpoint (`GET /api/net/path`, `net_api.py`) never returns public keys, ICE candidate
endpoints or public IPs. It uses the same gateway token as every other `/api` route.

## If it still says RELAY after steps 1-5

1. Check the firewall rule: `...\netbird-firewall.ps1 -Check` should report it `in place`.
2. Check the forward exists for **UDP** (a TCP-only forward is the classic mistake) and points
   at the current LAN address (`ipconfig`).
3. **Advertise the forwarded address yourself** (`--external-ip-map`). Some routers rewrite the
   port, or STUN reports something other than what's forwarded. Tell NetBird the public address
   to hand out. In an **admin** PowerShell (look up the home public IPv4 first, for example on
   the router's status page):

   ```powershell
   netbird down
   netbird up --external-ip-map <home-public-IPv4>
   ```

   The mesh drops for a few seconds. Variant: `--external-ip-map <public-IP>/10.0.0.174` maps
   only that LAN address. Keep `--wireguard-port 51820` unless the router can't forward that
   port. If your public IPv4 changes (dynamic), this needs redoing, so prefer the plain forward
   when it works.
4. IPv6: this PC has global IPv6 addresses and 5G phones usually have native IPv6. If the router
   firewalls inbound IPv6, open a pinhole for UDP 51820 to this PC as well.
5. Update NetBird to 0.83.2 on both ends.

Leave Rosenpass (quantum resistance) off. It does nothing for NAT or latency and slows the
handshake.

## Undo

- Firewall: `...\netbird-firewall.ps1 -Remove`
- Router: delete the UDP 51820 forward (keep the reservation, it's harmless).
- Lazy connections: switch the dashboard toggle back on.
- `--external-ip-map`: in an **admin** PowerShell, `netbird down; netbird up --external-ip-map=""`
  (an empty value clears it). Keep the `=` with no space: Windows PowerShell 5.1 drops an empty
  `""` argument, so with a space NetBird gets the flag without a value and `netbird up` fails,
  leaving the mesh down. If `netbird up` ever errors, run `netbird up` on its own to bring the
  mesh back.

See also `command center/docs/netbird-least-privilege-acl.md`, which covers which mesh peer may
reach which port.
