import type { InstagramStatus, MapsStatus } from "@/lib/platform";

export type Tone = "ok" | "warn" | "down" | "idle";

/** Settings badge for the Instagram card, from the live `instagram_status` (never a cached guess). */
export function instagramBadge(s: InstagramStatus | null): { label: string; tone: Tone } {
  if (!s) return { label: "CHECKING…", tone: "idle" };
  switch (s.status) {
    case "ok":
      return { label: s.username ? `CONNECTED · @${s.username}` : "CONNECTED", tone: "ok" };
    case "missing":
      return { label: "NO TOKEN", tone: "idle" };
    case "off":
      return { label: "TOOLS OFF", tone: "idle" };
    case "blocked":
      return { label: "KILL SWITCH", tone: "warn" };
    default:
      return { label: "ERROR", tone: "down" };
  }
}

export function mapsBadge(s: MapsStatus | null): { label: string; tone: Tone } {
  if (!s) return { label: "CHECKING…", tone: "idle" };
  switch (s.status) {
    case "ok":
      return { label: s.latencyMs != null ? `ONLINE · ${s.latencyMs} ms` : "ONLINE", tone: "ok" };
    case "off":
      return { label: "TOOLS OFF", tone: "idle" };
    case "blocked":
      return { label: "KILL SWITCH", tone: "warn" };
    default:
      return { label: "UNREACHABLE", tone: "down" };
  }
}

/** "Renews automatically · expires in 52 days" / "expiry unknown until the first renewal". */
export function tokenExpiryLine(s: Pick<InstagramStatus, "tokenExpiresAt">, nowSec = Date.now() / 1000): string {
  if (s.tokenExpiresAt == null) return "Expiry unknown until the app's first renewal (tokens must be ≥ 24 h old to renew).";
  const days = Math.floor((s.tokenExpiresAt - nowSec) / 86_400);
  if (days < 0) return "Token expired — paste a new INSTAGRAM_ACCESS_TOKEN.";
  return `Renews automatically · expires in ${days} day${days === 1 ? "" : "s"}.`;
}
