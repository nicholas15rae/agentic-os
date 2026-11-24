# NetBird least-privilege ACL (mortadella)

Drafted 2026-11-24 from the live mesh (`netbird status --detail`, listening sockets, gateway
logs). It keeps the phone → gateway path and the PC → droplet paths, and closes everything else
on the mesh.

## The mesh today

| Peer | Mesh IP | Role |
|---|---|---|
| `mortadella` (this PC) | 100.84.91.149 | Gateway :8080 (phone PWA / HUD), Bionic, TWS |
| `gabagoul` | 100.84.66.145 | Your phone (confirm in Peers: it should say Android) |
| `ubuntu-s-1vcpu-512mb-10gb-tor1` | 100.84.1.36 | DigitalOcean droplet: SSH 22, model server 8000 |
| `r0qcsx` | 100.84.84.190 | **Unidentified.** Check it in Peers. If it isn't yours, delete it. With this ACL it can't reach anything anyway |

Reachable from the mesh **before** this ACL (NetBird's default policy is "All ↔ All"):
SMB 139/445, AnythingLLM 3001, n8n 5678, TWS 7497, LM Link 41408 and the gateway 8080 on this
PC, plus everything on the droplet.

## Target policy

| # | Name | Source group → Destination group | Protocol / ports | Direction |
|---|---|---|---|---|
| 1 | `phone-to-gateway` | `phone` → `pc-mortadella` | TCP **8080** | one-way ➜ |
| 2 | `pc-to-droplet` | `pc-mortadella` → `droplet` | TCP **22**, **8000** | one-way ➜ |
| — | `Default` (All ↔ All) | — | — | **disabled** |

NetBird has no explicit "deny" rule. Once no policy allows a flow it's dropped, so disabling
`Default` is the "deny all other mesh traffic" rule. That blocks SMB, AnythingLLM, n8n,
LM Studio / LM Link, TWS 7497 and the droplet's other ports (Qdrant 6333, n8n 5678, …). Policies
are stateful: replies to an allowed connection come back without a rule in the other direction.
"One-way" means the droplet can't open connections to the PC and the PC can't open them to the
phone.

## Apply it (app.netbird.io): do it in this order so you can't lock yourself out

1. **Groups.** Go to *Peers* and click each peer, then *Assigned groups*, then type a new group name:
   - `mortadella` → group `pc-mortadella`
   - `gabagoul` → group `phone` (first check it's the phone: OS should be Android)
   - `ubuntu-s-1vcpu-512mb-10gb-tor1` → group `droplet`
   - `r0qcsx` → no new group (leave it in "All" only)
2. **Policy 1.** Go to *Access Control → Policies → Add policy*:
   - Name `phone-to-gateway`. Source `phone`, Destination `pc-mortadella`.
   - Protocol **TCP**, Ports **8080**.
   - Turn **off** bidirectional, so the arrow points one way (phone ➜ PC). Enabled. Save.
3. **Policy 2.** *Add policy*:
   - Name `pc-to-droplet`. Source `pc-mortadella`, Destination `droplet`.
   - Protocol **TCP**, Ports **22** and **8000**.
   - One-way (PC ➜ droplet). Enabled. Save.
4. **Test the new paths before closing the old ones** (see *Verify*: the phone row and the PC rows).
5. **Close everything else.** In *Access Control → Policies*, toggle the `Default` policy (All ↔ All)
   **off**. Disable it rather than deleting it, so it's a one-click rollback.
6. **Verify again** (below). If the phone breaks, re-enable `Default` and check that `gabagoul`
   really is in `phone`.

Optional while you're in the dashboard:
- *Peers → mortadella*: turn off **login expiration** to stop the "extend session" prompts.
- Update the client to 0.83.2 (NetBird says it's available).

## Verify

| From | Test | Expected |
|---|---|---|
| Phone | open `http://100.84.91.149:8080/cc/` | the Command Center loads |
| PC (PowerShell) | `Test-NetConnection 100.84.1.36 -Port 22` | `TcpTestSucceeded : True` |
| PC | `Test-NetConnection 100.84.1.36 -Port 8000` | `True` (if the model server is running) |
| PC | `Test-NetConnection 100.84.1.36 -Port 6333` | `False` (not allowed) |
| Droplet (ssh in) | `nc -zv -w3 100.84.91.149 8080` | fails: the droplet may not open connections into the PC |
| Droplet | `nc -zv -w3 100.84.91.149 445` / `3001` / `5678` / `7497` | all fail |
| PC | Trading page → Pipeline health → **Run check** | `tws_exposure` PASS (once TWS's Trusted IP is removed) |

The health check probes from this PC, so it proves TWS only accepts localhost. It can't prove the
ACL, because traffic from a machine to its own mesh address never crosses the mesh. The droplet
rows above are what prove the ACL.

**Verified 2026-11-24** (TWS: "localhost only" on, Trusted IPs empty): from the droplet, an IB API
handshake to `100.84.91.149:7497` is **refused**. From this PC, TWS still answers its *own* mesh
address. That's a self-connection quirk, not exposure, and the health check reports it as PASS
with a note. TWS refuses the LAN address (`10.0.0.174`) outright. Even so, keep the ACL: it stops
port 7497 at the mesh whatever TWS does, and it also closes SMB, AnythingLLM, n8n and LM Link.
