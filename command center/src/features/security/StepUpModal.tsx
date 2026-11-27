import { useEffect, useRef, useState } from "react";
import { KeyRound, Loader2, ShieldCheck, Smartphone } from "lucide-react";
import { describeSecurityError, MODULE_LABEL, securityApi } from "./api";
import { useSecurity } from "./store";

/**
 * Step-up PIN modal: a refused mutation in a Read-Only module opens it; a correct PIN (or an
 * approval on the paired phone, its own fingerprint) gets a short-lived Rust elevation and the
 * original action is retried. z-[88]: above every modal
 * (z-80 / z-85) that can raise it, below the ConfirmCard (z-90, see lib/layers.test.ts).
 */
export function StepUpModal() {
  const stepUp = useSecurity((s) => s.stepUp);
  const status = useSecurity((s) => s.status);
  const finish = useSecurity((s) => s.finishStepUp);
  const refresh = useSecurity((s) => s.refresh);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phone, setPhone] = useState<"idle" | "waiting">("idle");
  const [code, setCode] = useState<string | null>(null);
  const ticket = useRef<string | null>(null);
  // A new / closed step-up abandons any phone request still waiting.
  useEffect(() => {
    ticket.current = null;
    setPhone("idle");
  }, [stepUp]);
  if (!stepUp) return null;
  const canPhone = !!status?.companionPaired && !status.companionDevice;
  const label = MODULE_LABEL[stepUp.module] ?? stepUp.module;
  const mins = status?.elevationIdleMinutes ?? 15;

  const close = (ok: boolean) => {
    ticket.current = null;
    setPin("");
    setError(null);
    finish(ok);
  };
  const askPhone = async () => {
    setError(null);
    try {
      const t = await securityApi.companionRequest(stepUp.module);
      ticket.current = t.id;
      setCode(t.code);
      setPhone("waiting");
      while (ticket.current === t.id && Date.now() / 1000 < t.expiresAt + 2) {
        await new Promise((r) => setTimeout(r, 1500));
        if (ticket.current !== t.id) return;
        const r = await securityApi.companionPoll(t.id);
        if (r.state === "approved") {
          await refresh();
          close(true);
          return;
        }
        if (r.state === "denied" || r.state === "expired") {
          setError(r.state === "denied" ? "Denied on the phone." : "The phone didn't answer in time. Use the PIN.");
          break;
        }
      }
    } catch (e) {
      setError(describeSecurityError(e));
    }
    if (ticket.current) ticket.current = null;
    setPhone("idle");
  };
  const submit = async () => {
    if (!pin || busy) return;
    setBusy(true);
    setError(null);
    try {
      await securityApi.elevate(stepUp.module, pin);
      await refresh();
      close(true);
    } catch (e) {
      setError(describeSecurityError(e));
      setPin("");
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[88] grid place-items-center bg-black/60 p-3" role="dialog" aria-modal="true" aria-label={`Unlock ${label} changes`} onClick={() => !busy && close(false)}>
      <form
        className="glass w-full max-w-xs r-22 p-5"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="flex items-center gap-2 text-amber-soft">
          <ShieldCheck size={16} />
          <h2 className="label-caps">{label} is read-only</h2>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-ink-3">
          Enter your PIN{canPhone ? " or approve on your phone" : ""} to allow changes. It reverts to Read-Only after {mins} min without use.
        </p>
        <input
          type="password"
          inputMode="numeric"
          autoComplete="off"
          autoFocus
          aria-label="PIN"
          placeholder="PIN"
          maxLength={32}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
          onKeyDown={(e) => e.key === "Escape" && !busy && close(false)}
          className="glass-thin mt-3 h-11 w-full rounded-full px-4 text-center font-mono tracking-[0.4em] text-ink outline-none"
        />
        {error && (
          <p className="mt-2 fs-11 text-alert" role="alert">
            {error}
          </p>
        )}
        {phone === "waiting" && (
          <p className="mt-2 fs-11 text-ink-2">
            On your phone, type <b className="font-mono text-base text-amber-light">{code}</b> and approve with your fingerprint.
          </p>
        )}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          {canPhone && (
            <button type="button" className="pill-glass" disabled={busy || phone === "waiting"} onClick={() => void askPhone()}>
              {phone === "waiting" ? <Loader2 size={13} className="animate-spin" /> : <Smartphone size={13} />} Phone
            </button>
          )}
          <button type="button" className="pill-glass" disabled={busy} onClick={() => close(false)}>
            Cancel
          </button>
          <button type="submit" className="pill-glass !text-amber-light" disabled={!pin || busy}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <KeyRound size={13} />} Unlock
          </button>
        </div>
      </form>
    </div>
  );
}
