import { useEffect, useRef, useState } from "react";
import { Fingerprint, KeyRound, Loader2, Lock, ShieldAlert, Smartphone, Terminal } from "lucide-react";
import { describeSecurityError, parseSecurityError, securityApi, type SecurityStatus } from "./api";
import { useSecurity } from "./store";

const REASON: Record<string, string> = {
  startup: "Sign in to open the Command Center.",
  idle: "Locked after inactivity.",
  reauth: "Hourly re-verification.",
  manual: "Locked.",
  revoked: "Your session was revoked.",
  "hard-lock": "HARD LOCKED by the remote failsafe.",
};

/**
 * The app entry gate. Replaces the whole app while locked (nothing underneath stays mounted).
 * Cold start: PIN (or biometrics alone). After idle / hourly / manual lock: DOUBLE verification,
 * biometric or companion approval first, then the PIN.
 */
export function LockScreen({ status }: { status: SecurityStatus }) {
  const setStatus = useSecurity((s) => s.setStatus);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState<"pin" | "bio" | "companion" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<{ id: string; expiresAt: number } | null>(null);
  const [, tick] = useState(0);
  const pinRef = useRef<HTMLInputElement>(null);
  const s = status.session;
  const hard = status.hardLocked || s.reason === "hard-lock";
  const lockoutLeft = s.lockoutUntil ? Math.max(0, Math.ceil(s.lockoutUntil - Date.now() / 1000)) : 0;
  const secondDone = !!s.secondFactor;
  const needSecond = s.needsSecondFactor && !secondDone;

  useEffect(() => {
    if (!lockoutLeft) return;
    const t = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [lockoutLeft]);

  // Companion: poll the verdict until it lands or expires.
  useEffect(() => {
    if (!waiting) return;
    let alive = true;
    const run = async () => {
      while (alive && Date.now() / 1000 < waiting.expiresAt) {
        try {
          const r = await securityApi.companionPoll(waiting.id);
          if (r.state !== "pending") {
            if (r.state === "approved") {
              setStatus(await securityApi.status());
              pinRef.current?.focus();
            } else setError(r.state === "denied" ? "Denied on your phone." : "The phone didn't answer in time.");
            break;
          }
        } catch (e) {
          setError(describeSecurityError(e));
          break;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (alive) {
        setWaiting(null);
        setBusy(null);
      }
    };
    void run();
    return () => {
      alive = false;
    };
  }, [waiting, setStatus]);

  const unlock = async () => {
    if (!pin || busy) return;
    setBusy("pin");
    setError(null);
    try {
      setStatus(await securityApi.unlockPin(pin));
    } catch (e) {
      setError(describeSecurityError(e));
      if (parseSecurityError(e)?.code === "LOCKED_OUT") setStatus(await securityApi.status());
    } finally {
      setPin("");
      setBusy(null);
    }
  };

  const biometric = async () => {
    setBusy("bio");
    setError(null);
    try {
      setStatus(await securityApi.biometric());
      pinRef.current?.focus();
    } catch (e) {
      if (parseSecurityError(e)?.code !== "BIOMETRIC_CANCELLED") setError(describeSecurityError(e));
    } finally {
      setBusy(null);
    }
  };

  const companion = async () => {
    setBusy("companion");
    setError(null);
    try {
      setWaiting(await securityApi.companionRequest());
    } catch (e) {
      setError(describeSecurityError(e));
      setBusy(null);
    }
  };

  return (
    // Flex, not grid + place-items: an auto grid track grew to the card's max-w-sm (384px) and
    // pushed it off a 360px phone screen.
    <div className="flex h-dvh items-center justify-center overflow-y-auto bg-[#0b0d11] p-4" role="main" aria-label="Command Center locked">
      <div className="glass w-full max-w-sm rounded-[22px] p-6 text-center">
        <div className={`mx-auto grid h-14 w-14 place-items-center rounded-full ${hard ? "bg-alert/20 text-alert" : "bg-teal/15 text-teal"}`}>
          {hard ? <ShieldAlert size={26} /> : <Lock size={24} />}
        </div>
        <h1 className="mt-3 text-lg font-semibold text-ink">{hard ? "Hard locked" : "Command Center locked"}</h1>
        <p className="mt-1 text-xs leading-relaxed text-ink-3">{REASON[s.reason ?? "startup"] ?? "Locked."}</p>

        {hard ? (
          <div className="mt-4 space-y-2 text-left text-xs leading-relaxed text-ink-2">
            {status.hardLockReason && <p className="text-ink-3">Reason: {status.hardLockReason}</p>}
            <p>Every session and token was revoked and trading execution is locked. This can't be undone from the app. In a terminal on this PC:</p>
            <code className="block rounded-lg bg-black/40 px-3 py-2 font-mono text-[11px] text-amber-light">gabagool-cli clear-lock</code>
          </div>
        ) : !status.pinSet && (status.platform === "android" || status.platform === "ios") ? (
          <PinSetup minLength={status.pinMinLength} />
        ) : !status.pinSet ? (
          <div className="mt-4 space-y-2 text-left text-xs leading-relaxed text-ink-2">
            <p className="flex items-center gap-1.5 text-amber-soft">
              <Terminal size={13} /> No PIN set yet. In a terminal:
            </p>
            <code className="block rounded-lg bg-black/40 px-3 py-2 font-mono text-[11px] text-amber-light">gabagool-cli init{"\n"}gabagool-cli set-pin</code>
            <button className="pill-glass mt-2 w-full justify-center" onClick={() => void useSecurity.getState().refresh()}>
              Check again
            </button>
          </div>
        ) : (
          <>
            {s.needsSecondFactor || secondDone ? (
              <ol className="mt-4 space-y-1 text-left text-[11px] text-ink-3">
                <li className={secondDone ? "text-teal" : "text-ink-2"}>1 · {secondDone ? `Confirmed (${s.secondFactor})` : "Biometrics or your phone"}</li>
                <li className={secondDone ? "text-ink-2" : ""}>2 · Your PIN</li>
              </ol>
            ) : null}

            {(needSecond || (s.reason === "startup" && !secondDone)) && (
              <div className="mt-3 flex flex-col gap-2">
                {status.biometricAvailable && (
                  <button className="pill-glass w-full justify-center" disabled={!!busy || lockoutLeft > 0} onClick={() => void biometric()}>
                    {busy === "bio" ? <Loader2 size={14} className="animate-spin" /> : <Fingerprint size={14} />}
                    {status.platform === "windows" ? "Windows Hello" : "Fingerprint"}
                  </button>
                )}
                {needSecond && status.companionEnabled && status.companionPaired && (
                  <button className="pill-glass w-full justify-center" disabled={!!busy || lockoutLeft > 0} onClick={() => void companion()}>
                    {busy === "companion" ? <Loader2 size={14} className="animate-spin" /> : <Smartphone size={14} />}
                    {waiting ? "Waiting for your phone…" : "Approve on my phone"}
                  </button>
                )}
                {needSecond && !status.biometricAvailable && !status.companionPaired && (
                  <p className="text-[11px] text-ink-3">No biometrics or paired phone here: the PIN alone resumes (audited and alerted).</p>
                )}
              </div>
            )}

            <form
              className="mt-4 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void unlock();
              }}
            >
              <input
                ref={pinRef}
                type="password"
                inputMode="numeric"
                autoComplete="off"
                autoFocus
                aria-label="PIN"
                placeholder="PIN"
                maxLength={32}
                value={pin}
                disabled={lockoutLeft > 0 || busy === "pin"}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
                className="glass-thin h-11 min-w-0 flex-1 rounded-full px-4 text-center font-mono tracking-[0.4em] text-ink outline-none"
              />
              <button type="submit" className="pill-glass !h-11" disabled={!pin || !!busy || lockoutLeft > 0} aria-label="Unlock">
                {busy === "pin" ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />}
              </button>
            </form>
            {lockoutLeft > 0 && <p className="mt-2 text-[11px] text-alert">Locked out — try again in {lockoutLeft}s.</p>}
          </>
        )}
        {error && <p className="mt-3 text-[11px] text-alert" role="alert">{error}</p>}
        <p className="mt-4 font-mono text-[10px] text-ink-3">{status.deviceId}</p>
      </div>
    </div>
  );
}

/** Phone / tablet first run: there is no gabagool-cli there, so the first PIN is set here (Rust
 * refuses this on the desktop and once a PIN exists). */
function PinSetup({ minLength }: { minLength: number }) {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (a.length < minLength) return setError(`Use at least ${minLength} digits.`);
    if (a !== b) return setError("The two PINs don't match.");
    setBusy(true);
    setError(null);
    try {
      useSecurity.getState().setStatus(await securityApi.pinSetup(a));
    } catch (e) {
      setError(describeSecurityError(e));
    } finally {
      setBusy(false);
    }
  };
  const field = (v: string, set: (x: string) => void, label: string) => (
    <input
      type="password"
      inputMode="numeric"
      autoComplete="off"
      aria-label={label}
      placeholder={label}
      maxLength={32}
      value={v}
      onChange={(e) => set(e.target.value.replace(/\D/g, ""))}
      className="glass-thin h-11 w-full rounded-full px-4 text-center font-mono tracking-[0.4em] text-ink outline-none"
    />
  );
  return (
    <form
      className="mt-4 space-y-2 text-left text-xs text-ink-2"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <p>Set a PIN for this phone ({minLength}+ digits). You'll use it with your fingerprint to approve desktop unlocks.</p>
      {field(a, setA, "New PIN")}
      {field(b, setB, "Repeat PIN")}
      {error && <p className="text-[11px] text-alert">{error}</p>}
      <button type="submit" className="pill-glass w-full justify-center" disabled={busy || !a || !b}>
        {busy ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />} Set PIN
      </button>
    </form>
  );
}
