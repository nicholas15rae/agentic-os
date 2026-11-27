import { useEffect, useMemo, useState } from "react";
import { Loader2, QrCode, RefreshCw, ScanLine, ShieldCheck, TimerReset } from "lucide-react";
import { Card, Input } from "@/components/ui";
import { isTauri } from "@/lib/platform";
import { describeSecurityError, parseSecurityError, securityApi, type AuditEntry, type SessionTimeouts } from "./api";
import { StepUpCancelled, useSecurity } from "./store";
import { useCompanionInbox } from "./SecurityGate";
import { DevicesCard } from "./Devices";
import { AUDIT_FILTERS, clampMinutes, filterAudit, IDLE_LOCK_LIMITS, REAUTH_LIMITS, type AuditFilter } from "./audit-filter";
import { encodeQr, qrSvgPath } from "./qr";
import { CameraCapture } from "@/features/finance/CameraCapture";

/** The desktop's pairing QR text (companion.rs `pair_payload`). */
const isPairingCode = (t: string) => t.trim().startsWith("gbgpair1|");

const TONE: Record<AuditEntry["severity"], string> = { info: "text-ink-3", warn: "text-amber-soft", critical: "text-alert" };

/** Security commands check their own step-up (the gate lets every `security_*` through), so a
 *  `STEP_UP_REQUIRED:settings` refusal opens the PIN modal here and the call is retried once. */
async function withStepUp<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    const p = parseSecurityError(e);
    if (p?.code !== "STEP_UP_REQUIRED" || !p.arg) throw e;
    await useSecurity.getState().requestStepUp(p.arg);
    return run();
  }
}

function errText(e: unknown): string {
  return e instanceof StepUpCancelled ? "Cancelled: nothing changed." : describeSecurityError(e);
}

/** Settings → Security: posture, lock timers, companion pairing (QR on the desktop, key / QR text
 *  on the phone) and the filterable audit trail. */
export function SecurityCard() {
  const status = useSecurity((s) => s.status);
  const setStatus = useSecurity((s) => s.setStatus);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [filter, setFilter] = useState<AuditFilter>("all");
  const [key, setKey] = useState("");
  const [scan, setScan] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const inbox = useCompanionInbox((s) => s.alerts);
  const load = () => void securityApi.auditRecent(200).then(setAudit).catch(() => undefined);
  useEffect(load, []);
  const shown = useMemo(() => filterAudit(audit, filter), [audit, filter]);
  if (!isTauri() || !status) return null;
  const phone = status.platform === "android" || status.platform === "ios";
  const pair = async (code = key) => {
    setBusy(true);
    setMsg(null);
    try {
      setStatus(await withStepUp(() => securityApi.companionStoreKey(code.trim())));
      setKey("");
      setMsg("Paired: this device can now approve desktop unlocks.");
    } catch (e) {
      setMsg(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card
      title="Security"
      hint={`App lock after ${status.idleLockMinutes} min without input (talking to Tony counts) and every ${status.reauthMinutes} min regardless; Trading, Finance and Settings are read-only until a PIN step-up, which stays open while you're active (${status.elevationIdleMinutes} min unused, ${status.elevationMaxMinutes} min max). Admin: gabagool-cli.`}
      action={
        <button className="pill-glass !h-8 text-[11px]" onClick={load} aria-label="Refresh audit">
          <RefreshCw size={12} />
        </button>
      }
    >
      <div className="grid grid-cols-2 gap-2 text-[11px] text-ink-2 md:grid-cols-4">
        <span>PIN: {status.pinSet ? "set (Argon2id)" : "NOT set"}</span>
        <span>Biometrics: {status.biometricAvailable ? "available" : "unavailable"}</span>
        <span>Companion: {status.companionPaired ? "paired" : status.companionDevice ? "this is the phone" : "not paired"}</span>
        <span className="font-mono text-ink-3">{status.deviceId}</span>
      </div>

      {!phone && !status.companionDevice && <DevicesCard />}

      <TimeoutEditor
        current={{ idleLockMinutes: status.idleLockMinutes, reauthMinutes: status.reauthMinutes, elevationIdleMinutes: status.elevationIdleMinutes, elevationMaxMinutes: status.elevationMaxMinutes, persistAcrossRestarts: status.persistAcrossRestarts ?? false }}
        onSaved={setStatus}
      />

      {!phone && <PairingQr paired={status.companionPaired} />}

      {(phone || status.companionDevice) && (
        <div className="mt-3 flex gap-2">
          <Input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="Pairing code from the desktop's QR, or a key from `gabagool-cli pair-companion`"
            className="font-mono"
            autoComplete="off"
            aria-label="Companion pairing key"
          />
          <button className="pill-glass" disabled={busy || key.trim().length < 32} onClick={() => void pair()}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} />} Pair
          </button>
          {phone && (
            <button className="pill-glass" disabled={busy} onClick={() => setScan((s) => !s)} aria-pressed={scan}>
              <ScanLine size={13} /> {scan ? "Stop" : "Scan QR"}
            </button>
          )}
        </div>
      )}
      {phone && scan && (
        <div className="mt-2">
          <CameraCapture
            mode="qr"
            onCapture={() => undefined}
            onQr={(t) => {
              if (!isPairingCode(t)) {
                if (t) setMsg("That QR isn't a Command Center pairing code. Show one on the desktop: Settings → Security → Pair phone with QR.");
                return;
              }
              setScan(false);
              void pair(t);
            }}
          />
        </div>
      )}
      {msg && <p className="mt-2 text-[11px] text-ink-2">{msg}</p>}

      {status.companionDevice && (
        <>
          <h3 className="label-caps mt-4 text-ink-3">Desktop alerts (this phone)</h3>
          <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto text-[11px]">
            {inbox.map((a) => (
              <li key={a.id} className={TONE[a.severity] ?? "text-ink-3"}>
                {new Date(a.ts * 1000).toLocaleString()} · {a.body}
                {a.verified ? "" : " · via gateway"}
              </li>
            ))}
            {!inbox.length && <li className="text-ink-3">None since the app opened. Test: `gabagool-cli test-alert` on the desktop.</li>}
          </ul>
        </>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-1.5">
        <h3 className="label-caps mr-1 text-ink-3">Audit trail (security_audit.jsonl)</h3>
        {AUDIT_FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={`rounded-full border px-2 py-0.5 text-[10.5px] ${filter === f.id ? "border-amber/50 bg-amber/15 text-amber-light" : "border-white/10 text-ink-3 hover:text-ink-2"}`}
          >
            {f.label}
          </button>
        ))}
      </div>
      <ul className="mt-2 max-h-72 space-y-1 overflow-y-auto font-mono text-[10.5px]" data-testid="audit-list">
        {shown.map((e) => (
          <li key={`${e.seq}-${e.ts}`} className={TONE[e.severity]}>
            {e.ts.slice(0, 19).replace("T", " ")} · {e.event}
            {e.module ? ` [${e.module}]` : ""} · {e.outcome} · {e.source}
          </li>
        ))}
        {!shown.length && <li className="text-ink-3">{audit.length ? "Nothing in the last 200 entries matches this filter." : "No entries yet."}</li>}
      </ul>
    </Card>
  );
}

const TIMEOUT_FIELDS: { key: Exclude<keyof SessionTimeouts, "persistAcrossRestarts">; label: string; min: number; max: number; hint: string }[] = [
  { key: "idleLockMinutes", label: "Lock after idle", min: IDLE_LOCK_LIMITS.min, max: IDLE_LOCK_LIMITS.max, hint: "No input (or talk with Tony) for this long locks the app" },
  { key: "reauthMinutes", label: "Re-verify every", min: REAUTH_LIMITS.min, max: REAUTH_LIMITS.max, hint: "Locks after this long since you last unlocked, even while active" },
  { key: "elevationIdleMinutes", label: "Step-up unused", min: 1, max: 30, hint: "Trading / Finance / Settings go back to read-only after this long without activity" },
  { key: "elevationMaxMinutes", label: "Step-up max", min: 1, max: 60, hint: "…and after this long in any case" },
];

/** The four timeouts plus restart persistence, editable (a Settings PIN step-up confirms the
 *  change; Rust clamps it). Idle lock 5–120 min and hard re-auth 30–720 min (Section 24). */
function TimeoutEditor({ current, onSaved }: { current: SessionTimeouts; onSaved: (s: Awaited<ReturnType<typeof securityApi.setTimeouts>>) => void }) {
  const [draft, setDraft] = useState<SessionTimeouts>(current);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => setDraft(current), [current.idleLockMinutes, current.reauthMinutes, current.elevationIdleMinutes, current.elevationMaxMinutes, current.persistAcrossRestarts]);
  // What will actually be saved: every field rounded and clamped to its range.
  const next: SessionTimeouts = { ...draft };
  for (const f of TIMEOUT_FIELDS) next[f.key] = clampMinutes(Number(draft[f.key]), f);
  const dirty = TIMEOUT_FIELDS.some((f) => next[f.key] !== current[f.key]) || draft.persistAcrossRestarts !== current.persistAcrossRestarts;
  const adjusted = TIMEOUT_FIELDS.some((f) => Number(draft[f.key]) !== next[f.key]);
  const save = async () => {
    setBusy(true);
    setNote(null);
    try {
      const s = await withStepUp(() => securityApi.setTimeouts(next));
      onSaved(s);
      setNote(`Saved: lock after ${s.idleLockMinutes} min idle, re-verify every ${s.reauthMinutes} min.`);
    } catch (e) {
      setNote(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-3 rounded-[12px] border border-white/[0.06] p-3" aria-label="Session timeouts">
      <p className="label-caps mb-2 text-ink-3">Timeouts (minutes)</p>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {TIMEOUT_FIELDS.map((f) => (
          <label key={f.key} className="text-[11px] text-ink-2" title={f.hint}>
            {f.label} ({f.min}–{f.max})
            <Input
              type="number"
              min={f.min}
              max={f.max}
              value={draft[f.key]}
              onChange={(e) => setDraft({ ...draft, [f.key]: Number(e.target.value) })}
              aria-label={f.label}
              className="mt-1 font-mono"
            />
          </label>
        ))}
      </div>
      <label className="mt-2 flex items-center gap-2 text-[11px] text-ink-2" title="An unlocked session comes back after the app restarts, if it is still inside the idle and re-verify windows and nothing locked it in between. Step-ups never carry over.">
        <input type="checkbox" checked={!!draft.persistAcrossRestarts} onChange={(e) => setDraft({ ...draft, persistAcrossRestarts: e.target.checked })} />
        Stay unlocked across app restarts
      </label>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button className="pill-glass !h-8 text-[11px]" disabled={busy || !dirty} onClick={() => void save()} title="Needs your PIN (Settings step-up)">
          {busy ? <Loader2 size={12} className="animate-spin" /> : <TimerReset size={12} />} Save timeouts
        </button>
        {dirty && adjusted && <span className="text-[11px] text-ink-3">Will save as {TIMEOUT_FIELDS.map((f) => next[f.key]).join(" / ")} min.</span>}
        {note && <span className="text-[11px] text-ink-3">{note}</span>}
      </div>
    </div>
  );
}

/** Desktop: show a one-time pairing QR for the phone (a NEW pairing key, pending on the desktop
 * until the phone's first approval within 2 minutes; companion.rs `pair_begin_qr`). */
function PairingQr({ paired }: { paired: boolean }) {
  const [qr, setQr] = useState<{ payload: string; expiresAt: number } | null>(null);
  const [left, setLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (!qr) return;
    const tick = () => {
      const s = Math.max(0, Math.round(qr.expiresAt - Date.now() / 1000));
      setLeft(s);
      if (s === 0) {
        setQr(null); // drop the key from memory once it's expired
        setNote("Pairing code expired. Show a new one if the phone didn't pair.");
      }
    };
    tick();
    const iv = setInterval(tick, 1000);
    return () => clearInterval(iv);
  }, [qr]);
  const svg = useMemo(() => (qr ? qrSvgPath(encodeQr(qr.payload)) : null), [qr]);
  const show = async () => {
    if (paired && !confirm("Pair a phone with a QR code?\n\nThis makes a NEW pairing key. It replaces the current pairing once the new phone approves its first request within 2 minutes; if no phone uses it in time, the current pairing stays.")) return;
    setBusy(true);
    setNote(null);
    try {
      setQr(await withStepUp(() => securityApi.companionPairQr()));
    } catch (e) {
      setNote(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-3 text-[11px] text-ink-2">
      <div className="flex flex-wrap items-center gap-2">
        <button className="pill-glass !h-8 text-[11px]" disabled={busy} onClick={() => void (qr ? (setQr(null), setNote(null)) : show())}>
          {busy ? <Loader2 size={12} className="animate-spin" /> : <QrCode size={12} />} {qr ? "Hide pairing code" : "Pair phone with QR"}
        </button>
        <span className="text-ink-3">Scan it in the phone app (Settings → Security), then approve one request on the phone within 2 minutes to finish pairing. The code works for one phone only; unused, it expires and nothing changes.</span>
      </div>
      {qr && svg && (
        <div className="mt-2 flex items-center gap-3">
          <svg viewBox={`0 0 ${svg.viewBox} ${svg.viewBox}`} className="size-48 rounded-md bg-white" role="img" aria-label="Companion pairing QR code" shapeRendering="crispEdges">
            <path d={svg.path} fill="#000" />
          </svg>
          <span className="font-mono text-ink-3" aria-live="polite">
            expires in {left}s
          </span>
        </div>
      )}
      {note && <p className="mt-1 text-ink-3">{note}</p>}
    </div>
  );
}
