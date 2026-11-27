import type { SpotifyNowPlaying, SpotifyStatus } from "@/lib/platform";

/** Which quick-select list the widget shows. */
export type QuickList = "recent" | "playlists";

export const POLL_MS = 4000;
/** The volume slider sends once the drag pauses this long. */
export const VOLUME_DEBOUNCE_MS = 300;
/** After a local volume edit, polls don't overwrite the slider for this long (Spotify reports the old value briefly). */
export const VOLUME_HOLD_MS = 2500;

/** "3:07" (or "1:02:09" past an hour). */
export function fmtTime(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** Playback position now, advanced locally from the last poll while playing; clamped to the track length. */
export function progressAt(np: Pick<SpotifyNowPlaying, "isPlaying" | "progressMs" | "durationMs">, polledAt: number, now: number): number {
  const p = np.progressMs + (np.isPlaying ? Math.max(0, now - polledAt) : 0);
  return np.durationMs > 0 ? Math.min(p, np.durationMs) : p;
}

/** Fill fraction 0–1 for the progress bar. */
export const progressFraction = (pos: number, duration: number) => (duration > 0 ? Math.max(0, Math.min(1, pos / duration)) : 0);

/** The slider's value: a recent local edit wins over what the last poll reported. */
export function shownVolume(polled: number | null, local: { value: number; at: number } | null, now: number): number | null {
  if (local && now - local.at < VOLUME_HOLD_MS) return local.value;
  return polled;
}

/** After a seek, polls don't move the scrubber for this long (Spotify reports the old position briefly). */
export const SEEK_HOLD_MS = 2000;
/** Unmute target when no earlier non-zero volume is known. */
export const UNMUTE_FALLBACK = 50;

/** The `seek` action's value: whole SECONDS (Rust's position_sec), floored and kept below the last
 * second so a seek never skips the track (Rust clamps to duration − 1 s too). */
export function seekSeconds(ms: number, durationMs: number): number {
  const s = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  return durationMs > 0 ? Math.min(s, Math.max(0, Math.floor(durationMs / 1000) - 1)) : s;
}

/** The scrubber's position: a recent local seek (advanced while playing) wins over the polled one. */
export function shownPosition(polled: number, local: { value: number; at: number } | null, now: number, playing: boolean, durationMs: number): number {
  if (!local || now - local.at >= SEEK_HOLD_MS) return polled;
  const p = local.value + (playing ? Math.max(0, now - local.at) : 0);
  return durationMs > 0 ? Math.min(p, durationMs) : p;
}

/** The mute button's volume: 0 when audible, else the last non-zero level (or 50); null when the device has no volume. */
export function muteTarget(current: number | null, last: number | null): number | null {
  if (current == null) return null;
  if (current > 0) return 0;
  return last != null && last > 0 ? Math.min(100, Math.round(last)) : UNMUTE_FALLBACK;
}

/** Which speaker icon a volume shows. */
export const volumeLevel = (v: number): "mute" | "low" | "high" => (v <= 0 ? "mute" : v < 50 ? "low" : "high");

/** Rust's soft NO_VOLUME reply (an Ok string, not an error): the device refused a volume change. */
export const isNoVolumeReply = (reply: string) => /doesn't let me change its volume/i.test(reply);

/** The NO_VOLUME line to keep showing: only while the device that refused is still the one playing. */
export const noVolumeNote = (noVol: { device: string; reply: string } | null, device: string | null | undefined) =>
  noVol && noVol.device === (device ?? "") ? noVol.reply : null;

/** Error replies the widget's player treats as "the sign-in may be dead": it stops polling and
 * re-reads its status, whose `problemKind` then decides what to show. A plain 401 ("Spotify
 * refused the request") is not one of them: a fresh sign-in rarely fixes it. */
const RECHECK_ERROR = /isn't connected|revoked|needs new permissions|needs one more permission|owner of it in the developer dashboard|blocking this app|isn't on the app's user list/i;

/** Does this status need a new Spotify sign-in? Decided by `problemKind` / `reauthPending`, never
 * by the problem text. (A string is the widget's error reply: it only asks for a status re-read.) */
export function needsReconnect(s: string | Pick<SpotifyStatus, "problemKind" | "reauthPending">): boolean {
  if (typeof s === "string") return RECHECK_ERROR.test(s);
  return s.problemKind === "reauth" || s.reauthPending;
}

type FixStatus = Pick<SpotifyStatus, "connected" | "problem" | "problemKind"> & Partial<Pick<SpotifyStatus, "reauthPending">>;

/** What a Spotify status calls for: "connect" (never signed in), "reauth" (only a new sign-in
 * helps), "recheck" (the app owner needs Premium — signing in again won't help), "allowlist"
 * (this account isn't on the app's Users Management list — no sign-in helps), or null (show the
 * player / "Connected"; premium and transient problems recover or explain themselves). */
export type SpotifyFix = "connect" | "reauth" | "recheck" | "allowlist";
export function spotifyFix(s: FixStatus): SpotifyFix | null {
  if (!s.connected) return "connect";
  // An account-rule block outranks a pending re-consent: signing in again can't clear it.
  if (s.problem && s.problemKind === "owner_premium") return "recheck";
  if (s.problem && s.problemKind === "allowlist") return "allowlist";
  if (s.reauthPending) return "reauth";
  if (!s.problem) return null;
  if (s.problemKind === "reauth") return "reauth";
  if (s.problemKind === "owner_premium") return "recheck";
  if (s.problemKind === "allowlist") return "allowlist";
  return null;
}

export const ALLOWLIST_FIX_TEXT = "Add this Spotify account under Users Management in the Spotify Developer Dashboard (development mode, 5 users max).";

/** The line to show for a fix that no button solves (allowlist), else null. */
export function spotifyFixText(fix: SpotifyFix | null): string | null {
  return fix === "allowlist" ? ALLOWLIST_FIX_TEXT : null;
}

/** "Spotify sign-in expires in N days — Reconnect to renew it." when ≤ 7 days remain, else null. */
export function expiryHint(s: Pick<SpotifyStatus, "expiresInDays">): string | null {
  const d = s.expiresInDays;
  if (d === null || d === undefined || d > 7) return null;
  return `Spotify sign-in expires in ${d === 1 ? "1 day" : `${Math.max(0, d)} days`} — Reconnect to renew it.`;
}

/** "Spotify needs N new permissions" while a re-consent is pending (null otherwise / when unknown). */
export function missingScopesLine(s: Pick<SpotifyStatus, "reauthPending" | "missingScopes">): string | null {
  const n = s.reauthPending ? (s.missingScopes?.length ?? 0) : 0;
  if (!n) return null;
  return `Spotify needs ${n === 1 ? "1 new permission" : `${n} new permissions`}`;
}

/** The Settings card's main button for a connected account. The allowlist block has no Connect
 * button — only a re-check once the account was added in the Developer Dashboard. */
export function cardButton(s: FixStatus): { label: "Connect" | "Re-authenticate" | "Check again" | "Reconnect"; recheck: boolean } {
  const fix = spotifyFix(s);
  if (fix === "connect") return { label: "Connect", recheck: false };
  if (fix === "reauth") return { label: "Re-authenticate", recheck: false };
  if (fix === "recheck" || fix === "allowlist") return { label: "Check again", recheck: true };
  return { label: "Reconnect", recheck: false };
}
