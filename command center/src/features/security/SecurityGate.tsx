import { useEffect, useState, type ReactNode } from "react";
import { create } from "zustand";
import { Check, Lock, Smartphone, X } from "lucide-react";
import { isTauri, onNativeEvent } from "@/lib/platform";
import { gateway } from "@/lib/gateway";
import { describePurpose, securityApi, type InboxAlert, type SecurityStatus } from "./api";
import { systemNotify } from "@/features/reminders/notify";
import { useSecurity } from "./store";
import { LockScreen } from "./LockScreen";
import { StepUpModal } from "./StepUpModal";

/** User input reports activity to Rust at most this often (the idle auto-lock lives in Rust). */
const TOUCH_EVERY_MS = 30_000;

/**
 * App entry gate (desktop / mobile app). The app only mounts while Rust says the session is
 * live; any lock (startup, idle, hourly re-verification, manual, remote hard lock) unmounts it
 * and shows the LockScreen. Enforcement is in Rust: every IPC call is gated there regardless of
 * what this component renders. The PWA (no Rust) passes straight through: there the gateway
 * keeps protected modules read-only.
 */
export function SecurityGate({ children }: { children: ReactNode }) {
  return isTauri() ? <DesktopGate>{children}</DesktopGate> : <>{children}</>;
}

function DesktopGate({ children }: { children: ReactNode }) {
  const status = useSecurity((s) => s.status);
  const setStatus = useSecurity((s) => s.setStatus);
  const refresh = useSecurity((s) => s.refresh);

  useEffect(() => {
    void refresh();
    let off: (() => void) | undefined;
    void onNativeEvent<SecurityStatus>("security-state", setStatus).then((u) => (off = u));
    // Backstop in case an event is missed (the Rust watcher locks within ~1 s either way).
    const t = window.setInterval(() => void refresh(), 15_000);
    return () => {
      off?.();
      window.clearInterval(t);
    };
  }, [refresh, setStatus]);

  const live = !!status && !status.hardLocked && !status.session.locked;
  useActivity(live);

  if (!status) return <div className="grid h-dvh place-items-center bg-[#0b0d11] font-mono text-xs text-ink-3">securing…</div>;
  if (!status.enabled && !status.hardLocked) return <>{children}</>;
  // The companion phone keeps receiving desktop alerts even while it is itself locked.
  const inbox = status.companionDevice ? <CompanionAlerts /> : null;
  if (!live)
    return (
      <>
        <LockScreen status={status} />
        {inbox}
      </>
    );
  return (
    <>
      {children}
      {inbox}
      <StepUpModal />
      {status.companionDevice && <CompanionApprovals />}
    </>
  );
}

/** Throttled `security_touch` on real input (pointer, keys, wheel, touch) while unlocked. */
function useActivity(live: boolean) {
  useEffect(() => {
    if (!live) return;
    let last = 0;
    const on = () => {
      const now = Date.now();
      if (now - last < TOUCH_EVERY_MS) return;
      last = now;
      void securityApi.touch().catch(() => undefined);
    };
    const evs = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
    for (const e of evs) window.addEventListener(e, on, { passive: true, capture: true });
    on();
    return () => {
      for (const e of evs) window.removeEventListener(e, on, { capture: true });
    };
  }, [live]);
}

/** Top-bar button: lock the app now. */
export function LockNowButton() {
  const status = useSecurity((s) => s.status);
  const setStatus = useSecurity((s) => s.setStatus);
  if (!isTauri() || !status?.enabled) return null;
  return (
    <button
      onClick={() => void securityApi.lock().then(setStatus)}
      title="Lock the Command Center now (resuming needs biometrics or your phone, plus the PIN)"
      aria-label="Lock now"
      className="glass-thin flex h-11 w-11 items-center justify-center rounded-full text-ink-2 transition-colors hover:text-ink"
    >
      <Lock size={15} />
    </button>
  );
}

interface CompanionRequest {
  id: string;
  nonce: string;
  device: string;
  purpose: string;
  expiresAt: number;
}

/**
 * Companion phone side: a desktop without biometrics asks this (paired) device to approve its
 * unlock. Approve = this device's own biometric check, then a Rust HMAC signature the desktop
 * verifies with its copy of the pairing key.
 */
function CompanionApprovals() {
  const [reqs, setReqs] = useState<CompanionRequest[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const notified = new Set<string>();
    const poll = async () => {
      try {
        const r = await gateway<{ requests: CompanionRequest[] }>("/api/security/companion/pending", { timeoutMs: 5000 });
        if (!alive) return;
        const fresh = r.requests.filter((q) => q.expiresAt > Date.now() / 1000);
        for (const q of fresh) {
          if (notified.has(q.id)) continue;
          notified.add(q.id);
          void systemNotify("Command Center approval", `${q.device} wants to ${describePurpose(q.purpose)}. Open the app to approve.`);
        }
        setReqs(fresh);
      } catch {
        /* gateway away: try again */
      }
    };
    void poll();
    const t = window.setInterval(() => void poll(), 3000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);
  const answer = async (q: CompanionRequest, approve: boolean) => {
    setBusy(q.id);
    setError(null);
    try {
      const body: Record<string, unknown> = { id: q.id, approve };
      if (approve) Object.assign(body, await securityApi.companionSign(q.id, q.nonce, q.device, q.purpose));
      await gateway("/api/security/companion/respond", { method: "POST", body: JSON.stringify(body) });
      setReqs((r) => r.filter((x) => x.id !== q.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  if (!reqs.length) return null;
  const q = reqs[0];
  return (
    <div className="glass fixed bottom-24 left-1/2 z-[70] w-[min(92vw,22rem)] -translate-x-1/2 rounded-[20px] p-4" role="alertdialog" aria-label="Approve desktop unlock">
      <div className="flex items-center gap-2 text-amber-soft">
        <Smartphone size={15} />
        <span className="label-caps">{q.purpose.startsWith("step_up:") ? "Step-up request" : "Unlock request"}</span>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-ink-2">
        <span className="font-mono">{q.device}</span> wants to {describePurpose(q.purpose)}. Approve only if that's you.
      </p>
      {error && <p className="mt-2 text-[11px] text-alert">{error}</p>}
      <div className="mt-3 flex justify-end gap-2">
        <button className="pill-glass" disabled={!!busy} onClick={() => void answer(q, false)}>
          <X size={13} /> Deny
        </button>
        <button className="pill-glass !text-teal" disabled={!!busy} onClick={() => void answer(q, true)}>
          <Check size={13} /> Approve
        </button>
      </div>
    </div>
  );
}

const ALERT_POLL_MS = 10_000;
const SINCE_KEY = "cc.security.alertsSince";

/** Newest alerts first, for Settings → Security on the phone. */
export const useCompanionInbox = create<{ alerts: (InboxAlert & { verified: boolean })[]; add: (a: (InboxAlert & { verified: boolean })[]) => void }>((set) => ({
  alerts: [],
  add: (a) => set((s) => ({ alerts: [...a.reverse(), ...s.alerts].slice(0, 100) })),
}));

/**
 * Companion phone: polls the gateway's alert inbox and raises an Android notification for each
 * new desktop alert. Signed alerts are checked in Rust against the pairing key; unsigned ones
 * (raised by the gateway itself, e.g. a webhook kill) are marked "via gateway".
 */
function CompanionAlerts() {
  useEffect(() => {
    let alive = true;
    let since = Number(safeGet(SINCE_KEY) ?? 0) || Date.now() / 1000 - 3600;
    const poll = async () => {
      try {
        const r = await gateway<{ alerts: InboxAlert[]; now: number }>(`/api/security/companion/alerts?since=${since}`, { timeoutMs: 5000 });
        if (!alive || !r.alerts.length) return;
        const ok = await securityApi.companionCheckAlerts(r.alerts).catch(() => r.alerts.map(() => false));
        const items = r.alerts.map((a, i) => ({ ...a, verified: !!ok[i] }));
        since = Math.max(since, ...items.map((a) => a.ts));
        safeSet(SINCE_KEY, String(since));
        useCompanionInbox.getState().add(items);
        for (const a of items.slice(-3)) void systemNotify(a.title, a.verified ? a.body : `${a.body} (via gateway)`);
      } catch {
        /* gateway away (off the mesh): try again */
      }
    };
    void poll();
    const t = window.setInterval(() => void poll(), ALERT_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);
  return null;
}

function safeGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function safeSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private mode: start from the last hour next time */
  }
}
