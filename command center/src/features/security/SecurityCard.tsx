import { useEffect, useState } from "react";
import { Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { Card, Input } from "@/components/ui";
import { isTauri } from "@/lib/platform";
import { describeSecurityError, securityApi, type AuditEntry, type SessionTimeouts } from "./api";
import { onSecurityRefusal } from "./store";
import { useSecurity } from "./store";
import { useCompanionInbox } from "./SecurityGate";
import { DevicesCard } from "./Devices";

const TONE: Record<AuditEntry["severity"], string> = { info: "text-ink-3", warn: "text-amber-soft", critical: "text-alert" };

/** Settings → Security: posture, companion pairing (phone) and the audit trail. */
export function SecurityCard() {
  const status = useSecurity((s) => s.status);
  const setStatus = useSecurity((s) => s.setStatus);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const inbox = useCompanionInbox((s) => s.alerts);
  const load = () => void securityApi.auditRecent(40).then(setAudit).catch(() => undefined);
  useEffect(load, []);
  if (!isTauri() || !status) return null;
  const pair = async () => {
    setBusy(true);
    setMsg(null);
    try {
      setStatus(await securityApi.companionStoreKey(key.trim()));
      setKey("");
      setMsg("Paired: this device can now approve desktop unlocks.");
    } catch (e) {
      setMsg(describeSecurityError(e));
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

      {status.platform !== "android" && status.platform !== "ios" && !status.companionDevice && <DevicesCard />}

      <TimeoutEditor
        current={{ idleLockMinutes: status.idleLockMinutes, reauthMinutes: status.reauthMinutes, elevationIdleMinutes: status.elevationIdleMinutes, elevationMaxMinutes: status.elevationMaxMinutes, persistAcrossRestarts: status.persistAcrossRestarts ?? false }}
        onSaved={setStatus}
      />

      {(status.platform === "android" || status.platform === "ios" || status.companionDevice) && (
        <div className="mt-3 flex gap-2">
          <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Pairing key from `gabagool-cli pair-companion`" className="font-mono" autoComplete="off" aria-label="Companion pairing key" />
          <button className="pill-glass" disabled={busy || key.trim().length < 32} onClick={() => void pair()}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} />} Pair
          </button>
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

      <h3 className="label-caps mt-4 text-ink-3">Audit trail (security_audit.jsonl)</h3>
      <ul className="mt-2 max-h-72 space-y-1 overflow-y-auto font-mono text-[10.5px]">
        {audit.map((e) => (
          <li key={`${e.seq}-${e.ts}`} className={TONE[e.severity]}>
            {e.ts.slice(0, 19).replace("T", " ")} · {e.event}
            {e.module ? ` [${e.module}]` : ""} · {e.outcome} · {e.source}
          </li>
        ))}
        {!audit.length && <li className="text-ink-3">No entries yet.</li>}
      </ul>
    </Card>
  );
}

const TIMEOUT_FIELDS: { key: Exclude<keyof SessionTimeouts, "persistAcrossRestarts">; label: string; min: number; max: number; hint: string }[] = [
  { key: "idleLockMinutes", label: "Lock after idle", min: 1, max: 120, hint: "No input (or talk with Tony) for this long locks the app" },
  { key: "reauthMinutes", label: "Re-verify every", min: 5, max: 240, hint: "Locks after this long since you last unlocked, even while active" },
  { key: "elevationIdleMinutes", label: "Step-up unused", min: 1, max: 30, hint: "Trading / Finance / Settings go back to read-only after this long without activity" },
  { key: "elevationMaxMinutes", label: "Step-up max", min: 1, max: 60, hint: "…and after this long in any case" },
];

/** The four timeouts, editable (a Settings PIN step-up confirms the change; Rust clamps it). */
function TimeoutEditor({ current, onSaved }: { current: SessionTimeouts; onSaved: (s: Awaited<ReturnType<typeof securityApi.setTimeouts>>) => void }) {
  const [draft, setDraft] = useState<SessionTimeouts>(current);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => setDraft(current), [current.idleLockMinutes, current.reauthMinutes, current.elevationIdleMinutes, current.elevationMaxMinutes, current.persistAcrossRestarts]);
  const dirty = TIMEOUT_FIELDS.some((f) => draft[f.key] !== current[f.key]) || draft.persistAcrossRestarts !== current.persistAcrossRestarts;
  const save = async () => {
    setBusy(true);
    setNote(null);
    try {
      let s;
      try {
        s = await securityApi.setTimeouts(draft);
      } catch (e) {
        // security_* commands don't retry on their own: open the PIN modal, then try once more.
        if (typeof e === "string" && e.startsWith("STEP_UP_REQUIRED") && (await onSecurityRefusal(e))) s = await securityApi.setTimeouts(draft);
        else throw e;
      }
      onSaved(s);
      setNote("Saved.");
    } catch (e) {
      setNote(describeSecurityError(e));
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
            {f.label}
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
      <div className="mt-2 flex items-center gap-2">
        <button className="pill-glass !h-8 text-[11px]" disabled={busy || !dirty} onClick={() => void save()}>
          {busy ? <Loader2 size={12} className="animate-spin" /> : <ShieldCheck size={12} />} Save timeouts
        </button>
        {note && <span className="text-[11px] text-ink-3">{note}</span>}
      </div>
    </div>
  );
}
