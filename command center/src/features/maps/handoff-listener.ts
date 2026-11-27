// Contract: ./contract.ts (DRAFT). The phone side of "Send to phone" (Maps step 11, PURE part):
// parse, dedupe by id, enforce the 30-min TTL, remember what was shown. In memory only.
//
// NOT wired: nothing here opens the maps WebSocket or polls the gateway, and nothing mounts it in
// App.tsx (parked for Nic). The wiring step feeds `receiveWs` with frames from WS /api/maps/ws
// (never the comms socket) and `receiveList` with GET /api/maps/handoff at app open, then shows
// `pendingHandoffs()[0]` as a toast with Navigate and calls `ackHandoff` + `markSeen`.
import { create } from "zustand";
import { gateway } from "@/lib/gateway";
import type { HandoffAckStatus, HandoffItem, HandoffListenerState } from "./contract";
import { parseHandoff } from "./nav";

/** At most this many waiting hand-offs are held (maps_api.py HANDOFF_MAX_PENDING). */
export const HANDOFF_HOLD_MAX = 20;
/** Seen ids remembered (oldest forgotten first). */
export const SEEN_MAX = 200;

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function capSeen(seen: Record<string, true>): Record<string, true> {
  const keys = Object.keys(seen);
  if (keys.length <= SEEN_MAX) return seen;
  return Object.fromEntries(keys.slice(keys.length - SEEN_MAX).map((k) => [k, true as const]));
}

function liveOnly(items: Record<string, HandoffItem>, nowMs: number): Record<string, HandoffItem> {
  return Object.fromEntries(Object.entries(items).filter(([, it]) => it.expiresMs > nowMs));
}

export const useHandoffs = create<HandoffListenerState>((set, get) => ({
  items: {},
  seen: {},
  receive: (raw, nowMs = Date.now()) => {
    const p = parseHandoff(raw, nowMs);
    if (!p.ok) return null;
    const it = p.item;
    const { items, seen } = get();
    // Only pending ones are shown; a duplicate (same id) or a seen one is ignored.
    if (it.status !== "pending" || seen[it.id] || items[it.id]) return null;
    let next = { ...liveOnly(items, nowMs), [it.id]: it };
    const ids = Object.values(next).sort((a, b) => b.createdMs - a.createdMs);
    if (ids.length > HANDOFF_HOLD_MAX) next = Object.fromEntries(ids.slice(0, HANDOFF_HOLD_MAX).map((x) => [x.id, x]));
    set({ items: next });
    return next[it.id] ?? null;
  },
  receiveWs: (text, nowMs = Date.now()) => {
    if (typeof text !== "string" || text.length > 16 * 1024) return null;
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      return null;
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return null;
    const m = msg as Record<string, unknown>;
    if (m.type === "nav-handoff") {
      const { type: _type, ...rest } = m;
      return get().receive(rest, nowMs);
    }
    if (m.type === "nav-handoff-ack" && typeof m.id === "string" && ID_RE.test(m.id)) {
      // Opened / dismissed / expired somewhere: never show it again.
      get().markSeen(m.id);
      return null;
    }
    // "trips", "trips-refresh" and anything unknown are not hand-offs.
    return null;
  },
  receiveList: (raw, nowMs = Date.now()) => {
    const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
    // The gateway hands out nothing pending while the kill switch is on; honour the flag too.
    if (!r || r.killSwitch !== false || !Array.isArray(r.items)) return [];
    const out: HandoffItem[] = [];
    for (const raw of r.items.slice(0, 50)) {
      const it = get().receive(raw, nowMs);
      if (it) out.push(it);
    }
    return out;
  },
  markSeen: (id) => {
    if (typeof id !== "string" || !ID_RE.test(id)) return;
    const { items, seen } = get();
    const { [id]: _gone, ...rest } = items;
    set({ items: rest, seen: capSeen({ ...seen, [id]: true }) });
  },
  prune: (nowMs = Date.now()) => set({ items: liveOnly(get().items, nowMs) }),
  reset: () => set({ items: {}, seen: {} }),
}));

/** Waiting, unexpired hand-offs, newest first. Pure. */
export function pendingHandoffs(state: Pick<HandoffListenerState, "items" | "seen">, nowMs: number = Date.now()): HandoffItem[] {
  return Object.values(state.items)
    .filter((it) => it.expiresMs > nowMs && !state.seen[it.id])
    .sort((a, b) => b.createdMs - a.createdMs);
}

/** "Expires in 12 min" for the toast. */
export function expiresText(item: Pick<HandoffItem, "expiresMs">, nowMs: number = Date.now()): string {
  const m = Math.ceil((item.expiresMs - nowMs) / 60_000);
  return m <= 0 ? "Expired" : m === 1 ? "Expires in 1 min" : `Expires in ${m} min`;
}

/** GET /api/maps/handoff (pending). Never throws: [] on any failure. Not called anywhere yet. */
export async function fetchPendingHandoffs(nowMs: number = Date.now()): Promise<HandoffItem[]> {
  try {
    return useHandoffs.getState().receiveList(await gateway<unknown>("/api/maps/handoff?status=pending", { timeoutMs: 8000 }), nowMs);
  } catch {
    return [];
  }
}

/** POST /api/maps/handoff/{id}/ack, then mark it seen locally whatever the answer. Never throws. */
export async function ackHandoff(id: string, status: HandoffAckStatus): Promise<boolean> {
  if (!ID_RE.test(id) || (status !== "opened" && status !== "dismissed")) return false;
  useHandoffs.getState().markSeen(id);
  try {
    await gateway(`/api/maps/handoff/${encodeURIComponent(id)}/ack`, { method: "POST", body: JSON.stringify({ status }), timeoutMs: 8000 });
    return true;
  } catch {
    return false;
  }
}
