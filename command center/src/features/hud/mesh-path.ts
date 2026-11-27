/**
 * The phone's NetBird path to the desktop, from `GET /api/net/path` (net_api.py): a direct
 * WireGuard link (P2P) or one carried by a NetBird relay. Pure: unit-tested without the HUD's
 * imports (MobileHud.tsx is a browser-only component).
 */
export interface NetPath {
  peer: string | null;
  ip?: string | null;
  /** NetBird's peer status: "Connected", "Idle", "Connecting", … or "unknown". */
  status: string;
  /** NetBird's connectionType: "P2P" or "Relayed"; null while the peer isn't connected. */
  path: string | null;
  /** ICE candidate TYPES only (host / srflx / prflx / relay), never the endpoints. */
  iceLocal: string | null;
  iceRemote: string | null;
  /** The relay's host name, only when relayed (net_api.py withholds a bare IP). */
  relayHost: string | null;
  latencyMs: number | null;
  lastHandshake: string | null;
  lazy: boolean | null;
}

export interface MeshPathChip {
  text: string;
  tone: "direct" | "relay";
  title: string;
}

/** Between 30 and 60 s: the reading is live (the request itself crosses the tunnel) and cheap. */
export const MESH_PATH_POLL_MS = 45_000;

/**
 * A short site code for the chip: "streamline-us-chi1-4.relay.netbird.io" → "chi1". Falls back
 * to the host's first label, trimmed, when there's no code in it.
 */
export function relayTag(host: string | null | undefined): string | null {
  const label = (host ?? "").trim().toLowerCase().split(".")[0];
  if (!label) return null;
  const code = label.split("-").find((t) => /^[a-z]{2,5}\d+$/.test(t));
  return code ?? (label.length > 12 ? `${label.slice(0, 11)}…` : label);
}

/**
 * The MESH chip's path segment: "P2P 31 ms" (direct, teal) or "RELAY chi1 92 ms" (relayed,
 * amber). Nothing (null) for anything else, including the desktop's all-peers shape, an idle or
 * unknown peer, and a failed call, so the chip stays quiet rather than guessing.
 */
export function meshPathChip(p: unknown): MeshPathChip | null {
  if (!p || typeof p !== "object") return null;
  const n = p as Partial<NetPath>;
  if (n.status !== "Connected" || (n.path !== "P2P" && n.path !== "Relayed")) return null;
  const ms = typeof n.latencyMs === "number" && Number.isFinite(n.latencyMs) && n.latencyMs > 0 ? ` ${Math.round(n.latencyMs)} ms` : "";
  const ice = n.iceLocal || n.iceRemote ? ` (ICE ${n.iceLocal ?? "?"}/${n.iceRemote ?? "?"})` : "";
  const lazy = n.lazy ? " · lazy connections on: the first turn after idle pays the setup" : "";
  if (n.path === "P2P") return { text: `P2P${ms}`, tone: "direct", title: `NetBird: direct to the desktop${ice}${lazy}` };
  const tag = relayTag(n.relayHost);
  return { text: `RELAY${tag ? ` ${tag}` : ""}${ms}`, tone: "relay", title: `NetBird: relayed${n.relayHost ? ` via ${n.relayHost}` : ""}${ice}${lazy}` };
}

/** One NetBird peer in the desktop's Gateway & Network panel. */
export interface MeshPeerRow {
  name: string;
  ip: string | null;
  /** "P2P 31 ms" / "RELAY chi1 92 ms" when connected, else NetBird's status ("Idle", "Connecting", …). */
  text: string;
  tone: "direct" | "relay" | "off";
  title: string;
}

/**
 * The desktop's view of `GET /api/net/path`: a loopback caller gets every peer
 * (`{lazy, peers: [...]}`), i.e. the phone(s) this PC knows. Connected peers first, then by name.
 * Null for any other shape (a failed call, the phone's single-peer answer), so the panel can
 * say "unavailable" instead of guessing.
 */
export function desktopMeshRows(resp: unknown, max = 6): MeshPeerRow[] | null {
  if (!resp || typeof resp !== "object" || !Array.isArray((resp as { peers?: unknown }).peers)) return null;
  const peers = (resp as { peers: unknown[] }).peers.filter((p): p is Partial<NetPath> => !!p && typeof p === "object");
  const rows = peers.map((p): MeshPeerRow => {
    const name = (typeof p.peer === "string" && p.peer) || (typeof p.ip === "string" && p.ip) || "peer";
    const chip = meshPathChip(p);
    if (chip) return { name, ip: p.ip ?? null, text: chip.text, tone: chip.tone, title: chip.title };
    const status = typeof p.status === "string" && p.status ? p.status : "unknown";
    return { name, ip: p.ip ?? null, text: status, tone: "off", title: `NetBird: ${status.toLowerCase()} (no live tunnel to this peer right now)` };
  });
  rows.sort((a, b) => Number(a.tone === "off") - Number(b.tone === "off") || a.name.localeCompare(b.name));
  return rows.slice(0, max);
}
