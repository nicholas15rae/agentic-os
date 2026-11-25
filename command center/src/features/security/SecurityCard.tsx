import { useEffect, useState } from "react";
import { Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { Card, Input } from "@/components/ui";
import { isTauri } from "@/lib/platform";
import { describeSecurityError, securityApi, type AuditEntry } from "./api";
import { useSecurity } from "./store";
import { useCompanionInbox } from "./SecurityGate";

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
      hint={`App lock after ${status.idleLockMinutes} min idle and every ${status.reauthMinutes} min regardless; Trading, Finance and Settings are read-only until a PIN step-up (${status.elevationIdleMinutes} min idle, ${status.elevationMaxMinutes} min max). Tunables: data/security/security.config.json. Admin: gabagool-cli.`}
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
